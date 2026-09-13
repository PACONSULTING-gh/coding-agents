import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  agentLiveness,
  runWithTenant,
  type AgentLiveness,
} from '@coord/core'
import { z } from 'zod'

import { withTenantConnection } from './client.js'

/**
 * Agentes, sus latidos y la cola de comandos (epic 04 / T01).
 *
 * ===========================================================================
 * POR QUE EL TOKEN LLEVA EL TENANT DELANTE
 * ===========================================================================
 * Un latido llega con un token y NADA MAS: el daemon no sabe de bases de datos.
 * Pero cada fila de este esquema esta bajo RLS forzada, asi que una busqueda
 * por hash sin contexto de tenant no veria ni una fila. El que la RLS funcione
 * es justo lo que impide autenticar.
 *
 * Se resuelve con un token de dos partes, `<tenantId>.<secreto>`:
 *
 *   1. El prefijo dice EN QUE TENANT buscar. Es una PISTA, no una credencial.
 *   2. El hash del token ENTERO es lo que autentica.
 *
 * Mentir en el prefijo no sirve de nada: la busqueda se hace por el hash del
 * token completo, asi que apuntar a otro tenant simplemente no encuentra nada.
 * Y no se puede reutilizar el secreto de un tenant en otro, porque cambiar el
 * prefijo cambia el hash.
 *
 * ===========================================================================
 * EL TOKEN NO SE GUARDA, SE GUARDA SU HASH
 * ===========================================================================
 * Se devuelve UNA sola vez, al dar de alta el agente, y no se puede volver a
 * leer. Si esta tabla se filtra, lo que se lleva quien la lea no sirve para
 * latir en nombre de nadie.
 */

/**
 * Mismo helper local que en `acceptance-criteria.ts` y en `claims.ts`. Se
 * repite a proposito en cada modulo en vez de compartirse: el mensaje de error
 * nombra la operacion, y un helper comun acabaria con una firma generica que no
 * dice cual fallo.
 */
function parseInput<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError(`Entrada invalida para ${what}: ${parsed.error.message}`, {
      cause: parsed.error,
    })
  }
  return parsed.data
}

const uuidSchema = z.string().uuid()

/** Longitud del secreto. 32 bytes = 256 bits, que es de sobra y no cuesta nada. */
const TOKEN_SECRET_BYTES = 32

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

const agentKeySchema = z.string().trim().min(1).max(200)

const registerAgentInputSchema = z.object({
  agentKey: agentKeySchema,
  label: z.string().trim().min(1).max(200),
})

export type RegisterAgentInput = z.input<typeof registerAgentInputSchema>

export interface RegisteredAgent {
  readonly id: string
  readonly agentKey: string
  readonly label: string
  /**
   * El token EN CLARO. Es la unica vez que existe: no se guarda, solo su hash.
   * Quien lo reciba tiene que guardarlo donde vaya a usarlo, y si lo pierde hay
   * que dar de alta otro.
   */
  readonly token: string
}

/**
 * Da de alta un agente y devuelve su token. Idempotente NO: llamar dos veces
 * con el mismo `agentKey` falla, porque generar un token nuevo en silencio
 * dejaria al daemon anterior latiendo con uno que ya no vale y nadie sabria por
 * que dejo de aparecer.
 */
export async function registerAgent(input: RegisterAgentInput): Promise<RegisteredAgent> {
  const parsed = parseInput(registerAgentInputSchema, input, 'registerAgent')

  return withTenantConnection(async (tx) => {
    const token = `${tx.tenantId}.${randomBytes(TOKEN_SECRET_BYTES).toString('hex')}`
    const result = await tx.query<{ id: string }>(
      `INSERT INTO agents (tenant_id, agent_key, label, token_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [tx.tenantId, parsed.agentKey, parsed.label, hashToken(token)],
    )
    const row = result.rows.at(0)
    if (row === undefined) throw new Error('INSERT de agents no devolvio fila.')
    return { id: row.id, agentKey: parsed.agentKey, label: parsed.label, token }
  })
}

export interface AuthenticatedAgent {
  readonly id: string
  readonly tenantId: string
  readonly agentKey: string
  readonly label: string
}

/** Compara en tiempo constante. Dos hashes hex del mismo largo, siempre. */
function sameHash(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB)
}

/**
 * Resuelve un token a su agente.
 *
 * Lanza `UnauthorizedError` tanto si el token no existe como si esta revocado,
 * y con el MISMO mensaje: distinguirlos le diria a quien prueba tokens cuales
 * existieron alguna vez.
 */
export async function authenticateAgent(token: string): Promise<AuthenticatedAgent> {
  const [tenantId] = token.split('.')
  const parsedTenant = uuidSchema.safeParse(tenantId)
  if (!parsedTenant.success) {
    throw new UnauthorizedError('Token de agente no valido.')
  }

  const hash = hashToken(token)
  const fila = await runWithTenant({ tenantId: parsedTenant.data }, () =>
    withTenantConnection(async (tx) => {
      const result = await tx.query<{
        id: string
        agent_key: string
        label: string
        token_hash: string
        revoked_at: Date | null
      }>(
        `SELECT id, agent_key, label, token_hash, revoked_at
           FROM agents
          WHERE tenant_id = $1 AND token_hash = $2`,
        [tx.tenantId, hash],
      )
      return result.rows.at(0)
    }),
  )

  if (fila === undefined || !sameHash(fila.token_hash, hash) || fila.revoked_at !== null) {
    throw new UnauthorizedError('Token de agente no valido.')
  }

  return {
    id: fila.id,
    tenantId: parsedTenant.data,
    agentKey: fila.agent_key,
    label: fila.label,
  }
}

/** Revoca UN agente. Los demas siguen latiendo (T01, criterio 2). */
export async function revokeAgent(agentId: string): Promise<void> {
  const id = parseInput(uuidSchema, agentId, 'revokeAgent')
  const afectadas = await withTenantConnection(async (tx) => {
    const result = await tx.query(
      `UPDATE agents SET revoked_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [tx.tenantId, id],
    )
    return result.rowCount ?? 0
  })
  if (afectadas === 0) {
    throw new NotFoundError(`No hay agente vivo con id ${id} en este tenant.`)
  }
}

export const AGENT_COMMAND_KINDS = ['nudge', 'stop', 'message'] as const
export type AgentCommandKind = (typeof AGENT_COMMAND_KINDS)[number]

export interface AgentCommand {
  readonly id: string
  readonly kind: AgentCommandKind
  readonly payload: Readonly<Record<string, unknown>>
}

const enqueueCommandInputSchema = z.object({
  agentId: uuidSchema,
  kind: z.enum(AGENT_COMMAND_KINDS),
  payload: z.record(z.string(), z.unknown()).default({}),
})

export type EnqueueCommandInput = z.input<typeof enqueueCommandInputSchema>

export async function enqueueAgentCommand(input: EnqueueCommandInput): Promise<AgentCommand> {
  const parsed = parseInput(enqueueCommandInputSchema, input, 'enqueueAgentCommand')
  return withTenantConnection(async (tx) => {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO agent_commands (tenant_id, agent_id, kind, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id`,
      [tx.tenantId, parsed.agentId, parsed.kind, JSON.stringify(parsed.payload)],
    )
    const row = result.rows.at(0)
    if (row === undefined) throw new Error('INSERT de agent_commands no devolvio fila.')
    return { id: row.id, kind: parsed.kind, payload: parsed.payload }
  })
}

/**
 * Cuando se le encolo por ultima vez un comando de este tipo a un agente.
 *
 * Se mira `created_at` y NO `delivered_at` a proposito: lo que hay que espaciar
 * es cuantas veces se DECIDE molestar, no cuantas veces llega. Si se mirara la
 * entrega, un agente que no recoge sus comandos —porque esta atascado, que es
 * justo el caso— acumularia una cola de empujones y los recibiria todos de
 * golpe al volver.
 */
export async function lastCommandEnqueuedAt(
  agentId: string,
  kind: AgentCommandKind,
): Promise<Date | undefined> {
  const id = parseInput(uuidSchema, agentId, 'lastCommandEnqueuedAt')
  return withTenantConnection(async (tx) => {
    const result = await tx.query<{ created_at: Date }>(
      `SELECT created_at FROM agent_commands
        WHERE tenant_id = $1 AND agent_id = $2 AND kind = $3
        ORDER BY created_at DESC
        LIMIT 1`,
      [tx.tenantId, id, kind],
    )
    return result.rows.at(0)?.created_at
  })
}

export interface HeartbeatInput {
  readonly agentId: string
  readonly telemetry?: Readonly<Record<string, unknown>>
  /** Para poder fijar el instante en los tests. Por defecto, ahora. */
  readonly at?: Date
}

export interface HeartbeatResult {
  readonly lastBeatAt: Date
  /** Los comandos pendientes, YA marcados como entregados. */
  readonly commands: readonly AgentCommand[]
}

/**
 * Registra un latido y devuelve los comandos pendientes, EN LA MISMA
 * TRANSACCION.
 *
 * Las dos cosas juntas y no en dos llamadas porque el daemon solo tiene esta
 * respuesta para recibir ordenes: si el latido se guardara y la lectura de
 * comandos fallara despues, los comandos se quedarian pendientes hasta el
 * siguiente latido —un minuto perdido— o, peor, se marcarian entregados sin
 * llegar a viajar.
 *
 * Idempotente por naturaleza: latir dos veces solo mueve `last_beat_at`. Un
 * portatil que vuelve de suspension se reincorpora latiendo, sin que nadie
 * tenga que hacer nada (T01, criterio 4).
 */
export async function recordHeartbeat(input: HeartbeatInput): Promise<HeartbeatResult> {
  const agentId = parseInput(uuidSchema, input.agentId, 'recordHeartbeat')
  const at = input.at ?? new Date()

  return withTenantConnection(async (tx) => {
    const actualizado = await tx.query<{ last_beat_at: Date }>(
      `UPDATE agents
          SET last_beat_at = $3,
              telemetry    = $4::jsonb,
              updated_at   = now()
        WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
        RETURNING last_beat_at`,
      [tx.tenantId, agentId, at, JSON.stringify(input.telemetry ?? {})],
    )
    const fila = actualizado.rows.at(0)
    if (fila === undefined) {
      // O no existe, o esta revocado. Un agente revocado que sigue latiendo NO
      // se acepta en silencio: su daemon tiene que enterarse de que ya no
      // cuenta, y el unico canal que tiene es el error de esta llamada.
      throw new NotFoundError(`No hay agente vivo con id ${agentId} en este tenant.`)
    }

    const pendientes = await tx.query<{ id: string; kind: AgentCommandKind; payload: unknown }>(
      `UPDATE agent_commands
          SET delivered_at = now()
        WHERE tenant_id = $1 AND agent_id = $2 AND delivered_at IS NULL
        RETURNING id, kind, payload`,
      [tx.tenantId, agentId],
    )

    return {
      lastBeatAt: fila.last_beat_at,
      commands: pendientes.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        payload: (row.payload ?? {}) as Readonly<Record<string, unknown>>,
      })),
    }
  })
}

export interface AgentStatus {
  readonly id: string
  readonly agentKey: string
  readonly label: string
  /** `undefined` si nunca ha latido: NO es lo mismo que llevar mucho sin latir. */
  readonly lastBeatAt: Date | undefined
  /** `undefined` mientras no haya latido ni una vez. */
  readonly liveness: AgentLiveness | undefined
  readonly telemetry: Readonly<Record<string, unknown>>
  readonly revoked: boolean
}

/**
 * El estado de todos los agentes del tenant, para la vista de equipo (T05).
 *
 * Incluye los revocados, marcados: quitarlos haria desaparecer de la vista a un
 * agente que alguien acaba de apagar, y "ya no esta" y "nunca estuvo" se leen
 * igual cuando lo unico que ves es una lista.
 */
export async function readAgentStatuses(now: Date = new Date()): Promise<readonly AgentStatus[]> {
  return withTenantConnection(async (tx) => {
    const result = await tx.query<{
      id: string
      agent_key: string
      label: string
      last_beat_at: Date | null
      telemetry: unknown
      revoked_at: Date | null
    }>(
      `SELECT id, agent_key, label, last_beat_at, telemetry, revoked_at
         FROM agents
        WHERE tenant_id = $1
        ORDER BY label`,
      [tx.tenantId],
    )

    return result.rows.map((row) => ({
      id: row.id,
      agentKey: row.agent_key,
      label: row.label,
      lastBeatAt: row.last_beat_at ?? undefined,
      liveness: row.last_beat_at === null ? undefined : agentLiveness(row.last_beat_at, now),
      telemetry: (row.telemetry ?? {}) as Readonly<Record<string, unknown>>,
      revoked: row.revoked_at !== null,
    }))
  })
}

/** Se exporta solo para los tests del endpoint: no se usa en produccion. */
export function hashAgentTokenForTest(token: string): string {
  if (process.env['NODE_ENV'] === 'production') {
    throw new ValidationError('hashAgentTokenForTest no se puede usar en produccion.')
  }
  return hashToken(token)
}
