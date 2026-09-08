import type { TenantContext, TenantId } from '@coord/core'
import { uuidSchema } from '@coord/core'
import { z } from 'zod'

import { InvalidJobEnvelopeError } from './errors.js'

/**
 * Version del formato de envelope. Va dentro del propio payload para que un
 * worker desplegado con codigo nuevo sepa reconocer -y rechazar de forma
 * ruidosa- un job que dejo en la tabla un productor con formato viejo, en vez
 * de interpretarlo mal.
 */
export const ENVELOPE_VERSION = 1

/**
 * Lo que de verdad se serializa en la columna `data` del job: el payload del
 * llamante MAS el contexto de tenant en el que se encolo.
 *
 * El `tenantId` viaja aqui y no en una convencion de nombre de cola porque es
 * el dato que reconstruye el aislamiento al otro lado (CLAUDE.md 2.6): sin el,
 * el worker procesaria el job sin saber de quien es.
 */
export interface JobPayloadEnvelope<T> {
  v: typeof ENVELOPE_VERSION
  tenantId: TenantId
  actorId?: string
  requestId?: string
  payload: T
}

const envelopeSchema = z.object({
  v: z.literal(ENVELOPE_VERSION),
  tenantId: uuidSchema,
  actorId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  payload: z.unknown(),
})

/** Construye el envelope a partir del contexto de tenant activo. */
export function buildEnvelope<T>(ctx: TenantContext, payload: T): JobPayloadEnvelope<T> {
  return {
    v: ENVELOPE_VERSION,
    tenantId: ctx.tenantId,
    ...(ctx.actorId === undefined ? {} : { actorId: ctx.actorId }),
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
    payload,
  }
}

/**
 * Valida lo que viene de la base de datos antes de dejar que llegue a un
 * handler. Frontera de confianza: se lanza `InvalidJobEnvelopeError` en vez de
 * intentar reparar el dato "a ver si cuela".
 */
export function parseEnvelope<T>(data: unknown): JobPayloadEnvelope<T> {
  const result = envelopeSchema.safeParse(data)
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<raiz>'}: ${issue.message}`)
      .join('; ')
    throw new InvalidJobEnvelopeError(details, { cause: result.error })
  }
  const parsed = result.data
  return {
    v: parsed.v,
    tenantId: parsed.tenantId,
    ...(parsed.actorId === undefined ? {} : { actorId: parsed.actorId }),
    ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }),
    payload: parsed.payload as T,
  }
}

/** Contexto de tenant que hay que restaurar antes de invocar al handler. */
export function tenantContextFrom<T>(envelope: JobPayloadEnvelope<T>): TenantContext {
  return {
    tenantId: envelope.tenantId,
    ...(envelope.actorId === undefined ? {} : { actorId: envelope.actorId }),
    ...(envelope.requestId === undefined ? {} : { requestId: envelope.requestId }),
  }
}
