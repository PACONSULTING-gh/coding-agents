import { randomUUID } from 'node:crypto'

import {
  CLAIM_HOLDER_KINDS,
  CLAIM_SUBJECT_KINDS,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  requireTenant,
  uuidSchema,
  type Claim,
  type ClaimConflict,
  type ClaimHolder,
  type ClaimSubject,
  type ClaimSubjectKind,
  type QueuePort,
} from '@coord/core'
import { withTenantConnection, type TenantQuery } from '@coord/db'
import { z } from 'zod'

import { findDependencies, findDependents, findNodesByPath } from './queries.js'

/**
 * Claims y leases sobre issues y ficheros (T04 del epic 02).
 *
 * Responde a "este issue / este fichero, ¿lo esta tocando ya alguien?" y lo
 * responde de forma que dos agentes de dos personas distintas no puedan
 * quedarselo a la vez.
 *
 * ===========================================================================
 * EL DISENO, Y POR QUE NO ES EL QUE PONE EL EPIC. LEE ESTO ANTES DE TOCAR NADA.
 * ===========================================================================
 * El epic 02 pide "advisory locks de Postgres, transaccionales y con TTL". Eso
 * es contradictorio y no se puede implementar tal cual:
 *
 *   * `pg_advisory_xact_lock` se suelta en el COMMIT. No puede sostener una
 *     reserva que dura minutos, ni tener TTL.
 *   * `pg_advisory_lock` (de SESION) si persiste entre transacciones, pero NO
 *     funciona detras de PgBouncer en modo transaccion, que es decision cerrada
 *     en CLAUDE.md 3: la conexion logica no esta atada a un backend fisico, asi
 *     que el lock se quedaria pegado en un backend que despues sirve a otro
 *     tenant. Es el mismo motivo por el que la capa de acceso usa
 *     `set_config(..., true)` y no un `SET` de sesion — ver la cabecera de
 *     `packages/db/src/client.ts`.
 *
 * La discrepancia esta registrada en `docs/adr/0004-claims-como-lease-en-tabla.md`
 * (CLAUDE.md 7: un spec imposible se reporta, no se arregla en silencio).
 *
 * Lo que se implementa:
 *
 *   1. LA FUENTE DE VERDAD ES LA TABLA `claims` (migracion 0008). Un claim esta
 *      vivo si `released_at IS NULL AND expires_at > now()`. CADUCA SOLO: si el
 *      agente muere, nadie tiene que hacer nada para que el issue se libere, y
 *      NINGUNA parte de la correccion depende de que corra la purga.
 *
 *   2. `pg_advisory_xact_lock` se usa SOLO para serializar la operacion de
 *      reclamar dentro de UNA transaccion: segar caducados, comprobar y
 *      insertar son tres pasos y sin el habria ventanas entre ellos. Como es
 *      transaccional, se suelta en el COMMIT y NO QUEDA NINGUN LOCK RETENIDO
 *      entre transacciones — el criterio de `pg_locks` de T04 se cumple por
 *      construccion, no por disciplina.
 *
 *   3. El indice unico parcial `claims_live_subject_idx` es la red del motor
 *      por si el codigo se equivoca. No puede llevar `now()` en el predicado
 *      (tiene que ser inmutable), y por eso el paso de segado del punto 2
 *      materializa la caducidad en `released_at`. Esta explicado entero en la
 *      cabecera de la migracion 0008.
 *
 * ===========================================================================
 * QUIEN PUEDE RENOVAR Y LIBERAR
 * ===========================================================================
 * Solo el titular. La identidad del llamante sale del `actorId` del contexto
 * (`runWithTenant`), no de un parametro: un parametro seria una declaracion del
 * propio llamante y no serviria de nada. Por eso `claim()` EXIGE que
 * `holder.id === actorId`: si se pudiera reclamar en nombre de otro, "otro no
 * puede renovar el claim ajeno" seria imposible de sostener.
 *
 * No hay override para humanos todavia: un claim atascado se suelta solo al
 * vencer su TTL. Darle a un supervisor la potestad de liberar el claim de otro
 * es RBAC (existe la tabla, no la comprobacion) y merece decision humana
 * explicita (CLAUDE.md 2.1), no una opcion `force` colada aqui.
 */

/** Un arriendo de un segundo ya es un arriendo; uno de cero no lo es. */
export const MIN_CLAIM_TTL_SECONDS = 1
/**
 * 24 horas. Un TTL sin techo convierte el claim en un bloqueo permanente y
 * derrota el objetivo de la tarea: que los claims se liberen solos.
 */
export const MAX_CLAIM_TTL_SECONDS = 24 * 60 * 60
/** Ficheros por claim. Un PR que toque mas de esto no es un PR, es un rebuild. */
export const MAX_CLAIM_FILES = 200
/** Claims que devuelve `activeClaims` como maximo si no se pide otra cosa. */
export const DEFAULT_ACTIVE_CLAIMS_LIMIT = 200
export const MAX_ACTIVE_CLAIMS_LIMIT = 1000
/**
 * Cuantos claims ajenos se sondean contra el grafo en `checkOverlap`. El solape
 * EXACTO —que es el criterio de aceptacion literal— nunca se recorta; lo que se
 * acota es el extra de vecindad, que cuesta dos consultas por claim sondeado.
 * Si se trunca, se dice en el resultado: nunca en silencio.
 */
export const MAX_GRAPH_PROBES = 25
export const DEFAULT_OVERLAP_DEPTH = 2

// ---------------------------------------------------------------------------
// Fronteras de confianza. El numero de issue, la ruta y el titular llegan de
// fuera (MCP, HTTP, un job) y se validan ANTES de tocar la base de datos. La
// misma regla esta ademas como CHECK en la migracion 0008: dos capas, porque
// una ruta absoluta o con `..` en el grafo compartido filtra la maquina del
// desarrollador y de eso no se recorta ninguna capa (CLAUDE.md 2.4).
// ---------------------------------------------------------------------------

const issueKeySchema = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/, 'El sujeto `issue` se identifica por su numero, sin `#` ni ceros.')

const relativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) => path === path.trim(),
    'La ruta no puede llevar espacios al principio ni al final.',
  )
  .refine((path) => !path.startsWith('/'), 'La ruta tiene que ser RELATIVA a la raiz del repo.')
  .refine(
    (path) => !/^[A-Za-z]:[\\/]/.test(path),
    'La ruta tiene que ser RELATIVA a la raiz del repo.',
  )
  .refine((path) => !/(^|\/)\.\.(\/|$)/.test(path), 'La ruta no puede tener segmentos `..`.')

const claimSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issue'), key: issueKeySchema }),
  z.object({ kind: z.literal('file'), key: relativePathSchema }),
])

const claimHolderSchema = z.object({
  kind: z.enum(CLAIM_HOLDER_KINDS),
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
})

const ttlSchema = z.number().int().min(MIN_CLAIM_TTL_SECONDS).max(MAX_CLAIM_TTL_SECONDS)

const claimInputSchema = z.object({
  repoId: uuidSchema,
  subject: claimSubjectSchema,
  holder: claimHolderSchema,
  ttlSeconds: ttlSchema,
  files: z.array(relativePathSchema).max(MAX_CLAIM_FILES).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export type ClaimInput = z.input<typeof claimInputSchema>

const activeClaimsFilterSchema = z.object({
  repoId: uuidSchema.optional(),
  subjectKind: z.enum(CLAIM_SUBJECT_KINDS).optional(),
  subjectKeys: z.array(z.string().min(1)).min(1).max(MAX_CLAIM_FILES).optional(),
  holderId: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(MAX_ACTIVE_CLAIMS_LIMIT).default(DEFAULT_ACTIVE_CLAIMS_LIMIT),
})
export type ActiveClaimsFilter = z.input<typeof activeClaimsFilterSchema>

const checkOverlapInputSchema = z.object({
  repoId: uuidSchema,
  files: z.array(relativePathSchema).min(1).max(MAX_CLAIM_FILES),
  depth: z.number().int().min(1).max(5).default(DEFAULT_OVERLAP_DEPTH),
  /**
   * El aviso util no es solo "este fichero exacto esta cogido", es "esto toca
   * algo conectado con lo que tiene Ana". Se puede apagar para quedarse en el
   * criterio literal.
   */
  includeGraphNeighbourhood: z.boolean().default(true),
  /** Normalmente, uno mismo: chocar con tu propio claim no es informacion. */
  excludeHolderId: z.string().trim().min(1).max(200).optional(),
})
export type CheckOverlapInput = z.input<typeof checkOverlapInputSchema>

function parseInput<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    // La causa viaja entera: nunca se traga el detalle de por que fallo.
    throw new ValidationError(`Entrada invalida para ${what}: ${parsed.error.message}`, {
      cause: parsed.error,
    })
  }
  return parsed.data
}

// ---------------------------------------------------------------------------
// Rechazo
// ---------------------------------------------------------------------------

/**
 * Rechazo de un claim. NO es un booleano a proposito: el criterio de aceptacion
 * exige decir QUIEN lo tiene y DESDE CUANDO, y eso hay que poder leerlo tanto en
 * el mensaje (para un humano) como en `conflicts` (para el que lo renderiza).
 *
 * Extiende `ConflictError` de `@coord/core`, asi que `instanceof ConflictError`
 * sigue siendo cierto y su `code` sigue siendo `CONFLICT`. Vive aqui y no en
 * core porque core solo guarda el vocabulario del dominio.
 */
export class ClaimConflictError extends ConflictError {
  public readonly conflicts: readonly ClaimConflict[]

  constructor(conflicts: readonly ClaimConflict[], options?: { cause?: unknown }) {
    super(
      conflicts.length === 0
        ? 'No se pudo reclamar: otra transaccion se adelanto sobre el mismo sujeto. ' +
            'Consulta `activeClaims` para saber quien lo tiene.'
        : `No se pudo reclamar: ${conflicts.map(describeConflict).join('; ')}.`,
      options,
    )
    this.conflicts = conflicts
  }
}

export function describeSubject(subject: ClaimSubject): string {
  return subject.kind === 'issue' ? `el issue #${subject.key}` : `el fichero ${subject.key}`
}

export function describeConflict(conflict: ClaimConflict): string {
  const who = `${conflict.holder.label} (${conflict.holder.kind})`
  const since = `desde ${conflict.claimedAt.toISOString()}`
  const until = `hasta ${conflict.expiresAt.toISOString()}`
  const how =
    conflict.signal === 'exact'
      ? ''
      : ` — no es el mismo fichero, pero el grafo lo conecta a ${conflict.relatedFiles.join(', ')} ` +
        `a ${String(conflict.distance)} salto(s)`
  return `${describeSubject(conflict.subject)} lo tiene ${who} ${since} y ${until}${how}`
}

// ---------------------------------------------------------------------------
// Lectura de filas
// ---------------------------------------------------------------------------

const claimRowSchema = z.object({
  id: uuidSchema,
  claim_group_id: uuidSchema,
  repo_id: uuidSchema,
  subject_kind: z.enum(CLAIM_SUBJECT_KINDS),
  subject_key: z.string().min(1),
  holder_kind: z.enum(CLAIM_HOLDER_KINDS),
  holder_id: z.string().min(1),
  holder_label: z.string().min(1),
  claimed_at: z.date(),
  expires_at: z.date(),
  released_at: z.date().nullable(),
  released_reason: z.enum(['released', 'expired']).nullable(),
  metadata: z.record(z.string(), z.unknown()),
})

/** Columnas de `claims` en el orden que espera `claimRowSchema`. */
const CLAIM_COLUMNS = `id, claim_group_id, repo_id, subject_kind, subject_key,
       holder_kind, holder_id, holder_label, claimed_at, expires_at,
       released_at, released_reason, metadata`

function toClaim(row: unknown): Claim {
  const parsed = claimRowSchema.parse(row)
  return {
    claimId: parsed.id,
    groupId: parsed.claim_group_id,
    repoId: parsed.repo_id,
    subject: { kind: parsed.subject_kind, key: parsed.subject_key },
    holder: { kind: parsed.holder_kind, id: parsed.holder_id, label: parsed.holder_label },
    claimedAt: parsed.claimed_at,
    expiresAt: parsed.expires_at,
    releasedAt: parsed.released_at,
    releasedReason: parsed.released_reason,
    metadata: parsed.metadata,
  }
}

function toConflict(claim: Claim): ClaimConflict {
  return {
    subject: claim.subject,
    holder: claim.holder,
    claimedAt: claim.claimedAt,
    expiresAt: claim.expiresAt,
    claimId: claim.claimId,
    signal: 'exact',
    relatedFiles: claim.subject.kind === 'file' ? [claim.subject.key] : [],
    distance: 0,
  }
}

// ---------------------------------------------------------------------------
// El advisory lock: transaccional, y solo para serializar
// ---------------------------------------------------------------------------

/**
 * Toma el lock que serializa las reclamaciones de un repositorio. Es
 * `pg_advisory_xact_lock`, de TRANSACCION: Postgres lo suelta solo en el COMMIT
 * (o en el ROLLBACK), asi que entre transacciones no queda nada retenido y
 * funciona bajo PgBouncer en modo transaccion.
 *
 * El grano es el REPOSITORIO y no el sujeto, a proposito: con un lock por
 * sujeto habria que tomar N locks por claim y en un orden global para no
 * deadlockear, y reclamar no es una operacion de alta frecuencia (unas pocas
 * por persona y hora). Si algun dia la contencion se mide y molesta, bajar el
 * grano es un cambio local a esta funcion.
 */
async function lockRepository(tx: TenantQuery, repoId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `coord.claims:${tx.tenantId}:${repoId}`,
  ])
}

/**
 * Identidad del llamante. Sale del contexto y no de un parametro: un parametro
 * seria una declaracion del propio llamante, y entonces "otro no puede renovar
 * el claim ajeno" no significaria nada.
 */
function callerId(operation: string): string {
  const { actorId } = requireTenant()
  if (actorId === undefined || actorId.trim() === '') {
    throw new ValidationError(
      `\`${operation}\` necesita saber quien llama: pasa \`actorId\` en runWithTenant(). ` +
        'Sin actor no se puede comprobar que el claim es tuyo.',
    )
  }
  return actorId.trim()
}

/**
 * Traduce la violacion del indice unico a un error de dominio. No es un catch
 * silencioso: se reconoce UNA condicion concreta, se convierte en el error que
 * el llamante sabe tratar, y la causa viaja entera. Cualquier otro error se
 * vuelve a lanzar tal cual.
 */
function isLiveSubjectUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  return candidate.code === '23505' && candidate.constraint === 'claims_live_subject_idx'
}

// ---------------------------------------------------------------------------
// claim()
// ---------------------------------------------------------------------------

export interface ClaimLease {
  /** Identifica el arriendo entero: el issue y los ficheros que reservo. */
  readonly groupId: string
  /** La fila del sujeto principal. Es el id que se le pasa a `release`/`renew`. */
  readonly claimId: string
  readonly repoId: string
  readonly holder: ClaimHolder
  readonly claimedAt: Date
  readonly expiresAt: Date
  /** Todas las filas del arriendo, la del sujeto principal la primera. */
  readonly claims: readonly Claim[]
}

/**
 * Reserva un sujeto (y opcionalmente un conjunto de ficheros) para el titular,
 * durante `ttlSeconds`.
 *
 * Es ATOMICO sobre TODOS sus sujetos: si cualquiera de ellos —el issue o
 * cualquier fichero— esta ya reclamado y vivo, no se reserva nada y se lanza
 * `ClaimConflictError` diciendo quien lo tiene y desde cuando. Falla cerrado: la
 * alternativa (reservar lo que se pueda) dejaria al llamante creyendo que tiene
 * el conjunto entero, que es exactamente la colision que esto viene a evitar.
 */
export async function claim(input: ClaimInput): Promise<ClaimLease> {
  const parsed = parseInput(claimInputSchema, input, 'claim')
  const actor = callerId('claim')
  if (parsed.holder.id !== actor) {
    throw new ValidationError(
      `No se puede reclamar en nombre de otro: el contexto dice que el actor es "${actor}" y ` +
        `el claim declara al titular "${parsed.holder.id}". Ejecuta dentro de ` +
        'runWithTenant({ actorId: <id del titular> }).',
    )
  }

  const subjects = collectSubjects(parsed.subject, parsed.files)
  const kinds = subjects.map((subject) => subject.kind)
  const keys = subjects.map((subject) => subject.key)

  return withTenantConnection(async (tx) => {
    await lockRepository(tx, parsed.repoId)

    // SEGADO. Materializa la caducidad en `released_at` para los sujetos que se
    // van a reclamar. Es un paso EN LINEA de esta transaccion, no un proceso de
    // fondo: por eso la correccion no depende de que corra ninguna purga.
    await tx.query(
      `UPDATE claims
          SET released_at = now(), released_reason = 'expired'
        WHERE tenant_id = $1
          AND repo_id   = $2
          AND released_at IS NULL
          AND expires_at <= now()
          AND (subject_kind, subject_key) IN (
                SELECT s.skind, s.skey FROM unnest($3::text[], $4::text[]) AS s(skind, skey))`,
      [tx.tenantId, parsed.repoId, kinds, keys],
    )

    const conflicting = await tx.query(
      `SELECT ${CLAIM_COLUMNS}
         FROM claims
        WHERE tenant_id = $1
          AND repo_id   = $2
          AND released_at IS NULL
          AND expires_at > now()
          AND (subject_kind, subject_key) IN (
                SELECT s.skind, s.skey FROM unnest($3::text[], $4::text[]) AS s(skind, skey))
        ORDER BY subject_kind, subject_key`,
      [tx.tenantId, parsed.repoId, kinds, keys],
    )
    if (conflicting.rows.length > 0) {
      throw new ClaimConflictError(conflicting.rows.map((row) => toConflict(toClaim(row))))
    }

    // El id del grupo se genera aqui (uuid v4 de la stdlib, peldano 3 de la
    // escalera) y la fila del sujeto principal (ord = 1) lo reutiliza como su
    // `id`. Asi `groupId` y el `claimId` del principal coinciden, y no hace
    // falta ni una consulta extra ni una segunda pasada para saber cual es cual.
    const groupId = randomUUID()

    const inserted = await tx
      .query(
        `INSERT INTO claims (id, tenant_id, claim_group_id, repo_id, subject_kind, subject_key,
                             holder_kind, holder_id, holder_label, expires_at, metadata)
         SELECT CASE WHEN s.ord = 1 THEN $3::uuid ELSE gen_random_uuid() END,
                $1, $3, $2, s.skind, s.skey, $4, $5, $6,
                now() + ($7::int * interval '1 second'), $8::jsonb
           FROM unnest($9::text[], $10::text[]) WITH ORDINALITY AS s(skind, skey, ord)
         RETURNING ${CLAIM_COLUMNS}`,
        [
          tx.tenantId,
          parsed.repoId,
          groupId,
          parsed.holder.kind,
          parsed.holder.id,
          parsed.holder.label,
          parsed.ttlSeconds,
          JSON.stringify(parsed.metadata),
          kinds,
          keys,
        ],
      )
      .catch((error: unknown) => {
        // La red del motor salto. Con el advisory lock tomado no deberia
        // ocurrir; si ocurre es un rechazo legitimo, y se convierte en el error
        // de dominio que el llamante ya sabe tratar CON LA CAUSA ENTERA. No es
        // un catch silencioso: cualquier otro error se relanza tal cual.
        if (!isLiveSubjectUniqueViolation(error)) throw error
        throw new ClaimConflictError([], { cause: error })
      })

    const claims = inserted.rows.map(toClaim)
    const principal = claims.find((row) => row.claimId === groupId)
    if (principal === undefined) {
      throw new Error('El INSERT de claims no devolvio la fila del sujeto principal.')
    }
    return {
      groupId,
      claimId: principal.claimId,
      repoId: principal.repoId,
      holder: principal.holder,
      claimedAt: principal.claimedAt,
      expiresAt: principal.expiresAt,
      claims: [principal, ...claims.filter((row) => row.claimId !== groupId)],
    }
  })
}

/**
 * Sujeto principal primero, ficheros despues, sin repetidos. Si el sujeto
 * principal ya es un fichero y aparece tambien en `files`, se cuenta una vez:
 * dos filas con el mismo sujeto chocarian contra el indice unico.
 */
function collectSubjects(
  subject: ClaimSubject,
  files: readonly string[],
): { kind: ClaimSubjectKind; key: string }[] {
  const seen = new Set<string>([`${subject.kind}:${subject.key}`])
  const subjects: { kind: ClaimSubjectKind; key: string }[] = [
    { kind: subject.kind, key: subject.key },
  ]
  for (const file of files) {
    const marker = `file:${file}`
    if (seen.has(marker)) continue
    seen.add(marker)
    subjects.push({ kind: 'file', key: file })
  }
  return subjects
}

// ---------------------------------------------------------------------------
// release() / renew()
// ---------------------------------------------------------------------------

interface ClaimGroupHead {
  readonly groupId: string
  readonly repoId: string
  readonly holderId: string
}

async function loadGroupHead(
  tx: TenantQuery,
  claimId: string,
  operation: string,
): Promise<ClaimGroupHead> {
  const result = await tx.query<{
    claim_group_id: string
    repo_id: string
    holder_id: string
  }>(
    `SELECT claim_group_id, repo_id, holder_id
       FROM claims WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, claimId],
  )
  const row = result.rows[0]
  if (row === undefined) {
    throw new NotFoundError(`claim ${claimId}`)
  }
  const actor = callerId(operation)
  if (row.holder_id !== actor) {
    throw new UnauthorizedError(
      `El claim ${claimId} no es tuyo: lo tiene "${row.holder_id}" y el actor del contexto es ` +
        `"${actor}". Un claim ajeno solo se suelta cuando vence su TTL.`,
    )
  }
  return { groupId: row.claim_group_id, repoId: row.repo_id, holderId: row.holder_id }
}

async function readGroup(tx: TenantQuery, groupId: string): Promise<Claim[]> {
  const result = await tx.query(
    `SELECT ${CLAIM_COLUMNS}
       FROM claims WHERE tenant_id = $1 AND claim_group_id = $2
      ORDER BY (id = claim_group_id) DESC, subject_kind, subject_key`,
    [tx.tenantId, groupId],
  )
  return result.rows.map(toClaim)
}

/**
 * Suelta el arriendo ENTERO (el issue y sus ficheros). Solo el titular.
 *
 * Es idempotente: soltar dos veces no es un error, porque el segundo intento
 * suele venir de un reintento tras una caida y hacerlo fallar solo aniade ruido.
 * Lo que si falla es soltar un claim que no existe (`NotFoundError`) o que es de
 * otro (`UnauthorizedError`).
 */
export async function release(claimId: string): Promise<Claim[]> {
  const id = parseInput(uuidSchema, claimId, 'release')
  return withTenantConnection(async (tx) => {
    const head = await loadGroupHead(tx, id, 'release')
    await lockRepository(tx, head.repoId)
    await tx.query(
      `UPDATE claims
          SET released_at = now(), released_reason = 'released'
        WHERE tenant_id = $1 AND claim_group_id = $2 AND released_at IS NULL`,
      [tx.tenantId, head.groupId],
    )
    return readGroup(tx, head.groupId)
  })
}

/**
 * Extiende el arriendo entero `ttlSeconds` mas, contados desde AHORA (no desde
 * el vencimiento anterior: si se sumaran, un agente que renueva a destiempo
 * acumularia arriendo sin estar trabajando).
 *
 * Solo el titular. Y un claim que ya vencio NO se renueva: en ese momento
 * cualquiera pudo haberlo reclamado, asi que resucitarlo seria darle al que
 * llega tarde algo que ya no era suyo. Se vuelve a reclamar con `claim()`.
 */
export async function renew(claimId: string, ttlSeconds: number): Promise<Claim[]> {
  const id = parseInput(uuidSchema, claimId, 'renew')
  const ttl = parseInput(ttlSchema, ttlSeconds, 'renew')
  return withTenantConnection(async (tx) => {
    const head = await loadGroupHead(tx, id, 'renew')
    await lockRepository(tx, head.repoId)

    const updated = await tx.query(
      `UPDATE claims
          SET expires_at = now() + ($3::int * interval '1 second')
        WHERE tenant_id = $1
          AND claim_group_id = $2
          AND released_at IS NULL
          AND expires_at > now()
        RETURNING ${CLAIM_COLUMNS}`,
      [tx.tenantId, head.groupId, ttl],
    )
    if (updated.rows.length === 0) {
      throw new ConflictError(
        `El claim ${id} ya no esta vivo (liberado o caducado): no se puede renovar. ` +
          'Vuelve a reclamarlo con claim().',
      )
    }
    return updated.rows.map(toClaim)
  })
}

// ---------------------------------------------------------------------------
// activeClaims()
// ---------------------------------------------------------------------------

export interface ActiveClaimsPage {
  readonly claims: readonly Claim[]
  /**
   * `true` si habia mas claims vivos de los que cabian en `limit`. Sin esto, un
   * supervisor que mira esta vista para saber quien tiene que ve una lista
   * recortada y cree que esta completa — la misma clase de mentira silenciosa
   * que el `truncated` de `queries.ts` existe para evitar.
   */
  readonly truncated: boolean
}

/**
 * Los claims VIVOS del tenant activo. "Vivo" es exactamente
 * `released_at IS NULL AND expires_at > now()`: un claim caducado desaparece de
 * aqui aunque nadie lo haya segado todavia.
 *
 * Se piden `limit + 1` filas y se devuelve `truncated` explicito, igual que en
 * las consultas del grafo (`queries.ts`).
 */
export async function activeClaims(filter: ActiveClaimsFilter = {}): Promise<ActiveClaimsPage> {
  const parsed = parseInput(activeClaimsFilterSchema, filter, 'activeClaims')
  return withTenantConnection(async (tx) => {
    const result = await tx.query(
      `SELECT ${CLAIM_COLUMNS}
         FROM claims
        WHERE tenant_id = $1
          AND released_at IS NULL
          AND expires_at > now()
          AND ($2::uuid   IS NULL OR repo_id      = $2::uuid)
          AND ($3::text   IS NULL OR subject_kind = $3::text)
          AND ($4::text[] IS NULL OR subject_key  = ANY($4::text[]))
          AND ($5::text   IS NULL OR holder_id    = $5::text)
        ORDER BY claimed_at DESC, subject_kind, subject_key
        LIMIT $6 + 1`,
      [
        tx.tenantId,
        parsed.repoId ?? null,
        parsed.subjectKind ?? null,
        parsed.subjectKeys ?? null,
        parsed.holderId ?? null,
        parsed.limit,
      ],
    )
    const truncated = result.rows.length > parsed.limit
    const rows = truncated ? result.rows.slice(0, parsed.limit) : result.rows
    return { claims: rows.map(toClaim), truncated }
  })
}

// ---------------------------------------------------------------------------
// checkOverlap()
// ---------------------------------------------------------------------------

export interface CheckOverlapResult {
  /** Vacio = nadie tiene nada que solape. Ordenados: primero los exactos. */
  readonly conflicts: readonly ClaimConflict[]
  /**
   * Habia mas claims de fichero de los que se pueden sondear contra el grafo
   * (`MAX_GRAPH_PROBES`), asi que la parte de vecindad esta incompleta. Los
   * solapes EXACTOS nunca se truncan: se consultan con su propia consulta,
   * acotada por los ficheros PEDIDOS (ver mas abajo).
   */
  readonly graphProbeTruncated: boolean
}

/**
 * "Voy a tocar estos ficheros, ¿piso a alguien?".
 *
 * Dos senales, y la segunda es la que hace util a la primera:
 *
 *   - `exact` — alguien tiene reclamado literalmente uno de esos ficheros. Es el
 *     criterio de aceptacion de T04 y NUNCA se recorta ni se trunca.
 *   - `graph` — nadie tiene ese fichero, pero el grafo de dependencias (T01-T03)
 *     conecta lo que vas a tocar con lo que tiene otro, en cualquiera de los dos
 *     sentidos: o tu cambio le llega a el, o el suyo te llega a ti. Es el aviso
 *     que evita la colision que no se ve mirando rutas.
 *
 * ---------------------------------------------------------------------------
 * POR QUE SON DOS CONSULTAS Y NO UNA
 * ---------------------------------------------------------------------------
 * La parte EXACTA se pide por `subjectKeys` (los ficheros preguntados, como
 * mucho `MAX_CLAIM_FILES`), asi que el `LIMIT` de `activeClaims` no puede
 * dejarse ninguna fuera — y se comprueba: si esa consulta dijera que ha
 * truncado, seria un fallo del propio invariante y se lanza en vez de devolver
 * un "no hay solape" que seria mentira.
 *
 * Traerse en su lugar TODOS los claims de fichero del repo y filtrar en memoria
 * —que es lo que se hacia antes— pierde solapes exactos en silencio en cuanto un
 * repo pasa del limite (alcanzable con 5 claims de 200 ficheros), y el llamante
 * no tiene forma de distinguir "no hay solape" de "no lo he mirado". En la
 * superficie que existe para avisar de colisiones, un falso negativo silencioso
 * es el peor fallo posible.
 *
 * La segunda consulta —la del sondeo contra el grafo— si esta acotada, y su
 * truncacion se reporta en `graphProbeTruncated`.
 *
 * No muta nada: es lo que se consulta ANTES de reclamar, o para pintar un aviso.
 */
export async function checkOverlap(input: CheckOverlapInput): Promise<CheckOverlapResult> {
  const parsed = parseInput(checkOverlapInputSchema, input, 'checkOverlap')
  const wanted = new Set(parsed.files)
  const mine = (claim: Claim): boolean =>
    parsed.excludeHolderId !== undefined && claim.holder.id === parsed.excludeHolderId

  return withTenantConnection(async () => {
    const exact = await activeClaims({
      repoId: parsed.repoId,
      subjectKind: 'file',
      subjectKeys: parsed.files,
      limit: MAX_ACTIVE_CLAIMS_LIMIT,
    })
    if (exact.truncated) {
      // No puede pasar: `files` esta acotado a MAX_CLAIM_FILES y un fichero solo
      // puede tener un claim vivo (indice unico parcial). Si pasara, callarselo
      // seria devolver "no hay solape" sin haberlo mirado.
      throw new ConflictError(
        'checkOverlap: la consulta de solapes exactos vino truncada, cosa que no deberia poder ' +
          'ocurrir. No se devuelve un resultado incompleto como si fuera completo.',
      )
    }

    const conflicts: ClaimConflict[] = exact.claims.filter((row) => !mine(row)).map(toConflict)

    if (!parsed.includeGraphNeighbourhood) {
      return { conflicts, graphProbeTruncated: false }
    }

    const live = await activeClaims({
      repoId: parsed.repoId,
      subjectKind: 'file',
      limit: MAX_ACTIVE_CLAIMS_LIMIT,
    })
    const rest = live.claims.filter((row) => !mine(row) && !wanted.has(row.subject.key))
    const probes = rest.slice(0, MAX_GRAPH_PROBES)
    const graphProbeTruncated = live.truncated || rest.length > probes.length
    if (probes.length === 0) {
      return { conflicts, graphProbeTruncated }
    }

    const nodes = await findNodesByPath({
      repoId: parsed.repoId,
      paths: probes.map((row) => row.subject.key),
      kind: 'file',
    })
    const nodeIdByPath = new Map(nodes.map((node) => [node.path, node.nodeId]))

    for (const candidate of probes) {
      const nodeId = nodeIdByPath.get(candidate.subject.key)
      // El fichero reclamado no esta en el grafo (repo sin indexar, fichero
      // nuevo). No hay senal que dar; no es un error.
      if (nodeId === undefined) continue

      const traversal = { repoId: parsed.repoId, nodeId, depth: parsed.depth }
      // Los dos sentidos, porque son cosas distintas: `dependents` = lo que se
      // rompe si el toca lo suyo; `dependencies` = de que depende lo suyo, que
      // es lo que se rompe si lo tocas tu.
      const reachable = [
        ...(await findDependents(traversal)).hits,
        ...(await findDependencies(traversal)).hits,
      ]

      const nearest = new Map<string, number>()
      for (const hit of reachable) {
        if (!wanted.has(hit.path)) continue
        const previous = nearest.get(hit.path)
        if (previous === undefined || hit.distance < previous) {
          nearest.set(hit.path, hit.distance)
        }
      }
      if (nearest.size === 0) continue

      conflicts.push({
        subject: candidate.subject,
        holder: candidate.holder,
        claimedAt: candidate.claimedAt,
        expiresAt: candidate.expiresAt,
        claimId: candidate.claimId,
        signal: 'graph',
        relatedFiles: [...nearest.keys()].sort(),
        distance: Math.min(...nearest.values()),
      })
    }

    return { conflicts, graphProbeTruncated }
  })
}

// ---------------------------------------------------------------------------
// Purga
// ---------------------------------------------------------------------------

/**
 * La purga NO forma parte de la correccion. Un claim caducado deja de contar por
 * la condicion de `expires_at`, y el segado de `claim()` mantiene limpio el
 * indice de unicidad. Esto solo recorta el HISTORICO para que la tabla no crezca
 * sin fin. Si deja de correr, el sistema sigue siendo correcto y solo se
 * acumulan filas.
 */
export const CLAIMS_PURGE_QUEUE = 'claims.purge'
export const DEFAULT_CLAIMS_RETENTION_DAYS = 30
/** De madrugada y a una hora no redonda, para no coincidir con todo lo demas. */
export const DEFAULT_CLAIMS_PURGE_CRON = '17 3 * * *'

const purgeInputSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).default(DEFAULT_CLAIMS_RETENTION_DAYS),
})
export type PurgeClaimsInput = z.input<typeof purgeInputSchema>

/** Borra los claims cuyo vencimiento quedo mas atras que la retencion. Devuelve cuantos. */
export async function purgeExpiredClaims(input: PurgeClaimsInput = {}): Promise<number> {
  const parsed = parseInput(purgeInputSchema, input, 'purgeExpiredClaims')
  return withTenantConnection(async (tx) => {
    const result = await tx.query(
      `DELETE FROM claims
        WHERE tenant_id  = $1
          AND expires_at < now() - ($2::int * interval '1 day')
        RETURNING id`,
      [tx.tenantId, parsed.retentionDays],
    )
    return result.rows.length
  })
}

/**
 * Registra el procesador de la cola de purga. Se llama UNA vez por proceso
 * worker: el handler recupera el tenant del envelope (lo hace `QueuePort`, ver
 * `packages/core/src/ports/queue.ts`), asi que sirve para todos.
 */
export async function registerClaimsPurgeProcessor(queue: QueuePort): Promise<void> {
  await queue.process(CLAIMS_PURGE_QUEUE, async (job) => {
    const payload = job.payload === null || job.payload === undefined ? {} : job.payload
    const parsed = parseInput(purgeInputSchema, payload, 'claims.purge')
    await purgeExpiredClaims(parsed)
  })
}

/**
 * Programa la purga para el tenant del contexto activo. Va por tenant y no por
 * proceso porque `QueuePort.schedule` congela el tenant al programar: cada
 * disparo del cron reproduce el contexto de quien lo creo.
 */
export async function scheduleClaimsPurge(
  queue: QueuePort,
  options: { cron?: string; retentionDays?: number } = {},
): Promise<void> {
  const parsed = parseInput(
    purgeInputSchema,
    { retentionDays: options.retentionDays },
    'scheduleClaimsPurge',
  )
  await queue.schedule(CLAIMS_PURGE_QUEUE, options.cron ?? DEFAULT_CLAIMS_PURGE_CRON, parsed)
}
