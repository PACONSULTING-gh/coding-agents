import { requireTenant, ValidationError } from '@coord/core'
import { z } from 'zod'

import type { Queryable } from './queryable.js'
import { actorTypeSchema, auditLogRowSchema, type AuditLogRow } from './schema.js'

/**
 * API de lectura y escritura del registro de auditoria (CLAUDE.md 4: la tabla
 * append-only y su API de lectura se construyen ya, porque anadirlas despues
 * significa haber perdido el historial de todo lo anterior).
 *
 * Las dos funciones exigen contexto de tenant activo y ademas filtran por
 * `tenant_id` de forma explicita. Ese filtro NO es la defensa —la defensa es la
 * RLS forzada de la migracion 0003, que sigue en pie aunque este SQL este mal
 * escrito—; es una segunda capa, y hace que una consulta mal formada se note
 * porque devuelve vacio en vez de disparar la politica.
 */

/** Columnas del SELECT, ya renombradas a la forma que espera `auditLogRowSchema`. */
const AUDIT_COLUMNS = `
  id,
  tenant_id     AS "tenantId",
  occurred_at   AS "occurredAt",
  actor_id      AS "actorId",
  actor_type    AS "actorType",
  action,
  resource_type AS "resourceType",
  resource_id   AS "resourceId",
  metadata,
  request_id    AS "requestId"
`

/**
 * Igual, mas el instante en su representacion TEXTUAL de Postgres.
 *
 * Hace falta porque `timestamptz` guarda microsegundos y el `Date` de
 * JavaScript solo llega al milisegundo: si el cursor se construyera con el
 * `Date`, la comparacion de la pagina siguiente se haria contra un instante
 * distinto del almacenado y se perderian o repetirian eventos. Y solo cuando
 * los microsegundos no fuesen cero, es decir, de forma intermitente.
 */
const AUDIT_COLUMNS_WITH_CURSOR = `${AUDIT_COLUMNS}, occurred_at::text AS "occurredAtCursor"`

/**
 * Fila tal como la devuelve el SELECT paginado: la de dominio mas el instante
 * textual. El `transform` las separa en la misma pasada de validacion, para que
 * la fila que sale hacia el dominio no arrastre la columna auxiliar.
 */
const auditLogPagedRowSchema = auditLogRowSchema
  .extend({ occurredAtCursor: z.string().min(1) })
  .transform(({ occurredAtCursor, ...entry }) => ({ entry, cursorText: occurredAtCursor }))

/** Tope duro de pagina: evita que un filtro ausente se convierta en un volcado. */
export const AUDIT_LOG_MAX_PAGE_SIZE = 200
export const AUDIT_LOG_DEFAULT_PAGE_SIZE = 50

/**
 * Posicion desde la que continuar, como testigo OPACO. Se pagina por keyset y
 * no por OFFSET: con OFFSET, las paginas se solapan o se saltan filas en cuanto
 * entran eventos nuevos mientras se recorre, que es justo lo que hace un log
 * activo.
 *
 * Es opaco a proposito: quien consume la API no puede fabricar un cursor a
 * mano ni depender de su formato, y el instante viaja tal cual lo escribio
 * Postgres, sin pasar por un `Date` que le recortaria los microsegundos.
 */
export type AuditLogCursor = string

const cursorPayloadSchema = z.object({
  /** `occurred_at` en el texto exacto que devolvio Postgres. */
  t: z.string().min(1),
  i: z.string().uuid(),
})

function encodeCursor(occurredAtText: string, id: string): AuditLogCursor {
  return Buffer.from(JSON.stringify({ t: occurredAtText, i: id }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: AuditLogCursor): { t: string; i: string } {
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch (error) {
    // El cursor llega de fuera: es frontera de confianza. Se rechaza con la
    // causa original enganchada, nunca se ignora para "seguir adelante".
    throw new ValidationError(
      'Cursor de audit_log invalido: no es un testigo generado por readAuditLog.',
      {
        cause: error,
      },
    )
  }
  return cursorPayloadSchema.parse(payload)
}

export const auditLogQuerySchema = z.object({
  /** Cualquiera de estas acciones (OR). Vacio o ausente: no filtra. */
  actions: z.array(z.string().min(1)).min(1).optional(),
  actorId: z.string().uuid().optional(),
  actorType: actorTypeSchema.optional(),
  resourceType: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  /** Inclusivo. */
  from: z.date().optional(),
  /** Exclusivo, para poder encadenar ventanas sin duplicar eventos. */
  until: z.date().optional(),
  limit: z.number().int().min(1).max(AUDIT_LOG_MAX_PAGE_SIZE).default(AUDIT_LOG_DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
})
export type AuditLogQuery = z.input<typeof auditLogQuerySchema>

export interface AuditLogPage {
  entries: AuditLogRow[]
  /** `undefined` cuando no hay mas paginas. */
  nextCursor: AuditLogCursor | undefined
}

/**
 * Lee el registro del tenant activo, del evento mas reciente al mas antiguo.
 * Lanza `MissingTenantContextError` si se llama fuera de `runWithTenant`.
 */
export async function readAuditLog(
  db: Queryable,
  query: AuditLogQuery = {},
): Promise<AuditLogPage> {
  const { tenantId } = requireTenant()
  const filters = auditLogQuerySchema.parse(query)

  const conditions: string[] = ['tenant_id = $1']
  const values: unknown[] = [tenantId]

  const bind = (value: unknown): string => {
    values.push(value)
    return `$${values.length}`
  }

  if (filters.actions !== undefined) conditions.push(`action = ANY(${bind(filters.actions)})`)
  if (filters.actorId !== undefined) conditions.push(`actor_id = ${bind(filters.actorId)}`)
  if (filters.actorType !== undefined) conditions.push(`actor_type = ${bind(filters.actorType)}`)
  if (filters.resourceType !== undefined) {
    conditions.push(`resource_type = ${bind(filters.resourceType)}`)
  }
  if (filters.resourceId !== undefined) conditions.push(`resource_id = ${bind(filters.resourceId)}`)
  if (filters.from !== undefined) conditions.push(`occurred_at >= ${bind(filters.from)}`)
  if (filters.until !== undefined) conditions.push(`occurred_at < ${bind(filters.until)}`)
  if (filters.cursor !== undefined) {
    // Comparacion de filas: coincide con el orden del indice
    // (tenant_id, occurred_at DESC, id DESC) y desempata por id, de modo que
    // dos eventos con el mismo instante no se pierden ni se repiten.
    const { t, i } = decodeCursor(filters.cursor)
    conditions.push(`(occurred_at, id) < (${bind(t)}::timestamptz, ${bind(i)}::uuid)`)
  }

  // Se pide una fila de mas para saber si hay pagina siguiente sin un COUNT.
  const limitPlusOne = bind(filters.limit + 1)

  const result = await db.query(
    `SELECT ${AUDIT_COLUMNS_WITH_CURSOR}
       FROM audit_log
      WHERE ${conditions.join(' AND ')}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${limitPlusOne}`,
    values,
  )

  const rows = z.array(auditLogPagedRowSchema).parse(result.rows)
  const hasMore = rows.length > filters.limit
  const page = hasMore ? rows.slice(0, filters.limit) : rows
  const last = page.at(-1)

  return {
    entries: page.map((row) => row.entry),
    nextCursor: hasMore && last ? encodeCursor(last.cursorText, last.entry.id) : undefined,
  }
}

export const auditEntryInputSchema = z.object({
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1).nullish(),
  actorType: actorTypeSchema.optional(),
  actorId: z.string().uuid().nullish(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  requestId: z.string().min(1).nullish(),
  /** Solo para importar historial; por defecto lo pone el servidor. */
  occurredAt: z.date().optional(),
})
export type AuditEntryInput = z.input<typeof auditEntryInputSchema>

/**
 * Anade un evento al registro del tenant activo. El actor y el request se
 * toman del contexto si no se pasan explicitamente, para que registrar sea mas
 * facil que no registrar.
 */
export async function appendAuditEntry(
  db: Queryable,
  input: AuditEntryInput,
): Promise<AuditLogRow> {
  const context = requireTenant()
  const entry = auditEntryInputSchema.parse(input)

  const actorId = entry.actorId ?? context.actorId ?? null
  // Si no hay actor identificado, el evento lo origina el propio sistema. Se
  // declara asi en vez de dejar el campo ambiguo.
  const actorType = entry.actorType ?? (actorId === null ? 'system' : 'user')
  const requestId = entry.requestId ?? context.requestId ?? null

  const result = await db.query(
    `INSERT INTO audit_log (
       tenant_id, occurred_at, actor_id, actor_type,
       action, resource_type, resource_id, metadata, request_id
     )
     VALUES ($1, COALESCE($2, now()), $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${AUDIT_COLUMNS}`,
    [
      context.tenantId,
      entry.occurredAt ?? null,
      actorId,
      actorType,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.metadata,
      requestId,
    ],
  )

  const [row] = result.rows
  if (row === undefined) {
    // Con RLS forzada, un INSERT que no devuelve fila significa que la politica
    // rechazo la escritura. Nunca se traga en silencio.
    throw new Error(
      'El INSERT en audit_log no devolvio ninguna fila: revisa que el contexto de tenant ' +
        'coincida con app.tenant_id en la conexion.',
    )
  }
  return auditLogRowSchema.parse(row)
}
