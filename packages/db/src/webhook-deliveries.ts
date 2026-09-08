import { requireTenant } from '@coord/core'
import { z } from 'zod'

import type { Queryable } from './queryable.js'

/**
 * Deduplicacion de entregas de webhook.
 *
 * La garantia NO la da este fichero: la da la restriccion unica
 * `webhook_deliveries_delivery_id_key` de la migracion 0006. Aqui solo se
 * traduce "cuantas filas ha afectado el INSERT" a "es nueva o es una
 * reentrega".
 *
 * Por que no un SELECT previo: entre el SELECT y el INSERT cabe la otra
 * entrega. GitHub reintenta y los balanceadores duplican; dos peticiones
 * simultaneas con el mismo GUID ganarian esa carrera sin esfuerzo y el trabajo
 * se encolaria dos veces. Con `ON CONFLICT DO NOTHING` la segunda transaccion
 * espera a que la primera confirme y despues no inserta: no hay ventana.
 */

export const webhookDeliveryInputSchema = z.object({
  /** GUID de la cabecera `x-github-delivery`. */
  deliveryId: z.string().min(1).max(200),
  /** Nombre del evento (`x-github-event`): issues, push, installation... */
  event: z.string().min(1).max(100),
})
export type WebhookDeliveryInput = z.input<typeof webhookDeliveryInputSchema>

/**
 * Registra la entrega para el tenant activo.
 *
 * Devuelve `true` si la fila es NUEVA (hay que seguir: encolar el trabajo) y
 * `false` si el GUID ya estaba (reentrega: responder 200 y no encolar).
 */
export async function recordWebhookDelivery(
  db: Queryable,
  input: WebhookDeliveryInput,
): Promise<boolean> {
  const { tenantId } = requireTenant()
  const parsed = webhookDeliveryInputSchema.parse(input)

  const result = await db.query(
    `INSERT INTO webhook_deliveries (tenant_id, delivery_id, event)
     VALUES ($1, $2, $3)
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING id`,
    [tenantId, parsed.deliveryId, parsed.event],
  )
  return result.rows.length > 0
}

/**
 * Borra la marca de una entrega. Es la COMPENSACION del listener: la fila y el
 * job no se pueden escribir en la misma transaccion (la cola tiene su propio
 * pool), asi que si el encolado falla despues de marcar la entrega hay que
 * deshacer la marca. Si no, la reentrega de GitHub se descartaria por duplicada
 * y el evento se perderia para siempre — un fallo silencioso, justo lo que la
 * constitucion prohibe (CLAUDE.md 5).
 *
 * Devuelve `true` si habia marca que borrar.
 */
export async function forgetWebhookDelivery(db: Queryable, deliveryId: string): Promise<boolean> {
  const { tenantId } = requireTenant()
  const parsed = webhookDeliveryInputSchema.shape.deliveryId.parse(deliveryId)

  const result = await db.query(
    `DELETE FROM webhook_deliveries
      WHERE tenant_id = $1 AND delivery_id = $2
      RETURNING id`,
    [tenantId, parsed],
  )
  return result.rows.length > 0
}
