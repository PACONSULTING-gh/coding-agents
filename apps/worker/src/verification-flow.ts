import { DEFAULT_MAX_ATTEMPTS, type NotificationPort, type Responsible } from '@coord/core'
import {
  recordVerificationOutcome,
  revokeCriteriaApproval,
  type RecordOutcomeInput,
  type VerificationFlowRow,
} from '@coord/db'
import type { Logger } from 'pino'

/**
 * El flujo de fallo de la verificacion, atado (T06, ADR 0008).
 *
 * Aqui NO hay ni una regla: la decision esta en `packages/core` y es pura, la
 * persistencia en `packages/db`. Esto es la raiz que las ata y ejecuta los dos
 * efectos que ninguna de las dos debe hacer por su cuenta:
 *
 *   1. Revocar la aprobacion de criterios cuando el spec resulta ser el
 *      problema (devuelve la tarea a `not_approved`, T01).
 *   2. Avisar a quien corresponda por el `NotificationPort`.
 *
 * Estan aqui y no en la capa de datos a proposito: meterlos alli ataria la
 * persistencia a T01 y a GitHub, y entonces no se podria probar la escritura
 * del estado sin levantar los dos.
 */

export interface HandleVerificationOutcomeInput extends RecordOutcomeInput {
  /**
   * Quien responde de la tarea. Se resuelve ANTES de llamar aqui, con
   * `resolveResponsible`: esta funcion no sabe de claims ni de GitHub.
   */
  readonly responsible?: Responsible
  /**
   * Como mencionar al responsable en el canal de destino. Lo aporta quien lo
   * resolvio, porque es el unico que sabe de donde salio: el adaptador NO lo
   * adivina (ver la cabecera de `escalation-notification.ts`).
   */
  readonly mention?: string
  /** El informe de conformidad, si esta pasada llego a producir uno. */
  readonly reportMarkdown?: string
}

export interface VerificationOutcomeResult {
  readonly row: VerificationFlowRow
  readonly notified: boolean
  readonly criteriaApprovalRevoked: boolean
}

/**
 * Registra el resultado de una pasada y ejecuta lo que la decision pida.
 *
 * El orden importa: primero se PERSISTE y solo despues se avisa. Si se avisara
 * antes, un fallo al escribir dejaria a alguien leyendo un comentario sobre un
 * estado que no existe.
 *
 * Los errores del aviso NO se tragan: se propagan. Un escalado que nadie recibe
 * no es un escalado, y descubrirlo por un log de warning es descubrirlo tarde.
 */
export async function handleVerificationOutcome(
  input: HandleVerificationOutcomeInput,
  deps: { notifications: NotificationPort; logger: Logger },
): Promise<VerificationOutcomeResult> {
  const { decision, row } = await recordVerificationOutcome(input)

  deps.logger.info(
    {
      taskRef: input.taskRef,
      outcome: input.outcome,
      destination: decision.destination,
      attempts: decision.attemptsAfter,
      consumesAttempt: decision.consumesAttempt,
    },
    decision.reason,
  )

  if (decision.revokesCriteriaApproval) {
    // El defecto esta en un criterio que nadie puede observar. La tarea vuelve
    // a `not_approved` y necesita que un humano reescriba y re-apruebe.
    // `revokeCriteriaApproval` solo toma la tarea: el porque queda en el
    // audit_log que ya escribio `recordVerificationOutcome`, con el motivo
    // entero, y en el aviso que sale justo despues.
    await revokeCriteriaApproval(input.taskRef)
  }

  if (decision.notifiesHuman) {
    await deps.notifications.notifyEscalation({
      taskRef: input.taskRef,
      destination: decision.destination,
      reason: decision.reason,
      attempts: decision.attemptsAfter,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      ...(input.responsible === undefined ? {} : { responsible: input.responsible }),
      ...(input.mention === undefined ? {} : { mention: input.mention }),
      ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
      ...(input.reportMarkdown === undefined ? {} : { reportMarkdown: input.reportMarkdown }),
    })
  }

  return {
    row,
    notified: decision.notifiesHuman,
    criteriaApprovalRevoked: decision.revokesCriteriaApproval,
  }
}
