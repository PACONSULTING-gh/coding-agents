import {
  decideVerificationFlow,
  type NoEvidenceTally,
  type Responsible,
  type VerificationFlowDecision,
  type VerificationOutcome,
} from '@coord/core'
import { z } from 'zod'

import { appendAuditEntry } from './audit.js'
import { withTenantConnection } from './client.js'
import { taskRefSchema } from './acceptance-criteria.js'

/**
 * Persistencia del estado del flujo de verificacion (epic 05 / T06, ADR 0008).
 *
 * La REGLA no esta aqui: esta en `packages/core/src/verification-flow.ts`, es
 * pura y se prueba sin base de datos. Este fichero solo lee el estado, se lo
 * da a la regla, y escribe lo que la regla decida — mas la entrada en
 * `audit_log`, que es el historico.
 *
 * La division importa: cuando alguien discuta el flujo de fallo, lo que hay que
 * revisar es el fichero de core, no este.
 */

/** Donde esta la tarea. `awaiting_verification` = entregada y sin juzgar. */
export const FLOW_STATES = [
  'awaiting_verification',
  'same_agent',
  'criteria_phase',
  'human',
  'done',
] as const
export type FlowState = (typeof FLOW_STATES)[number]

/** Accion del audit_log para cada transicion del flujo. */
export const VERIFICATION_FLOW_ACTION = 'verification_flow.transition'

const responsibleSchema = z.object({
  kind: z.enum(['user', 'agent']),
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
})

const recordOutcomeInputSchema = z.object({
  taskRef: taskRefSchema,
  outcome: z.enum([
    'gate_failed',
    'verifier_fail',
    'verifier_no_evidence',
    'verifier_unavailable',
    'passed',
  ]),
  /** Criterios SIN_EVIDENCIA de ESTA pasada. Lo exige la regla cuando toca. */
  noEvidenceCriteria: z.array(z.string().trim().min(1).max(200)).default([]),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  responsible: responsibleSchema.optional(),
  maxAttempts: z.number().int().min(1).optional(),
})
export type RecordOutcomeInput = z.input<typeof recordOutcomeInputSchema>

export interface VerificationFlowRow {
  readonly taskRef: string
  readonly attempts: number
  readonly state: FlowState
  readonly lastOutcome: VerificationOutcome | undefined
  readonly lastHeadSha: string | undefined
  readonly responsible: Responsible | undefined
  readonly noEvidenceByCriterion: NoEvidenceTally
  readonly updatedAt: Date
}

/** Lo que decidio la regla, mas la fila que quedo escrita. */
export interface RecordedOutcome {
  readonly decision: VerificationFlowDecision
  readonly row: VerificationFlowRow
}

const COLUMNS = `task_ref, attempts, state, last_outcome, last_head_sha,
                 responsible, no_evidence_by_criterion, updated_at`

interface RawRow {
  task_ref: string
  attempts: number
  state: FlowState
  last_outcome: VerificationOutcome | null
  last_head_sha: string | null
  responsible: unknown
  no_evidence_by_criterion: unknown
  updated_at: Date
}

function toRow(raw: RawRow): VerificationFlowRow {
  return {
    taskRef: raw.task_ref,
    attempts: raw.attempts,
    state: raw.state,
    lastOutcome: raw.last_outcome ?? undefined,
    lastHeadSha: raw.last_head_sha ?? undefined,
    responsible: (raw.responsible ?? undefined) as Responsible | undefined,
    noEvidenceByCriterion: (raw.no_evidence_by_criterion ?? {}) as NoEvidenceTally,
    updatedAt: raw.updated_at,
  }
}

/** El estado actual, o `undefined` si la tarea nunca se ha verificado. */
export async function readVerificationFlow(
  taskRef: string,
): Promise<VerificationFlowRow | undefined> {
  const ref = taskRefSchema.parse(taskRef)
  return withTenantConnection(async (tx) => {
    const result = await tx.query<RawRow>(
      `SELECT ${COLUMNS} FROM verification_flow WHERE tenant_id = $1 AND task_ref = $2`,
      [tx.tenantId, ref],
    )
    const raw = result.rows.at(0)
    return raw === undefined ? undefined : toRow(raw)
  })
}

/**
 * Registra el resultado de una pasada de verificacion y aplica la regla.
 *
 * Todo en UNA transaccion —leer estado, decidir, escribir estado, escribir el
 * audit_log— porque dos entregas concurrentes de la misma tarea leyendo el
 * mismo contador de intentos se lo gastarian una a la otra. El `FOR UPDATE`
 * serializa por fila, no por tabla.
 *
 * NO revoca la aprobacion de criterios ni publica el aviso: eso lo hace quien
 * llama, con `decision.revokesCriteriaApproval` y `decision.notifiesHuman`.
 * Meter aqui esas dos cosas ataria la persistencia a GitHub y a T01.
 */
export async function recordVerificationOutcome(
  input: RecordOutcomeInput,
): Promise<RecordedOutcome> {
  const parsed = recordOutcomeInputSchema.parse(input)

  return withTenantConnection(async (tx) => {
    const existente = await tx.query<RawRow>(
      `SELECT ${COLUMNS} FROM verification_flow
        WHERE tenant_id = $1 AND task_ref = $2 FOR UPDATE`,
      [tx.tenantId, parsed.taskRef],
    )
    const previo = existente.rows.at(0)
    const estadoPrevio = {
      attempts: previo?.attempts ?? 0,
      noEvidenceByCriterion: (previo?.no_evidence_by_criterion ?? {}) as NoEvidenceTally,
    }

    const decision = decideVerificationFlow({
      outcome: parsed.outcome,
      state: estadoPrevio,
      noEvidenceCriteria: parsed.noEvidenceCriteria,
      ...(parsed.maxAttempts === undefined ? {} : { maxAttempts: parsed.maxAttempts }),
    })

    const escrito = await tx.query<RawRow>(
      `INSERT INTO verification_flow (
         tenant_id, task_ref, attempts, state, last_outcome, last_head_sha,
         responsible, no_evidence_by_criterion, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (tenant_id, task_ref) DO UPDATE SET
         attempts = EXCLUDED.attempts,
         state = EXCLUDED.state,
         last_outcome = EXCLUDED.last_outcome,
         last_head_sha = EXCLUDED.last_head_sha,
         -- El responsable NO se borra si esta pasada no trae uno: perderlo
         -- dejaria la tarea sin dueño por un dato que falta, no por un cambio.
         responsible = COALESCE(EXCLUDED.responsible, verification_flow.responsible),
         no_evidence_by_criterion = EXCLUDED.no_evidence_by_criterion,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        tx.tenantId,
        parsed.taskRef,
        decision.attemptsAfter,
        decision.destination,
        parsed.outcome,
        parsed.headSha ?? null,
        parsed.responsible === undefined ? null : JSON.stringify(parsed.responsible),
        JSON.stringify(decision.noEvidenceByCriterionAfter),
      ],
    )
    const raw = escrito.rows.at(0)
    if (raw === undefined) {
      throw new Error('verification_flow no devolvio fila tras el upsert: estado inconsistente.')
    }

    // El historico. La tabla dice DONDE esta; esto dice QUE paso, y es
    // append-only: es lo que se lee cuando alguien pregunta "por que escalo".
    await appendAuditEntry(tx, {
      action: VERIFICATION_FLOW_ACTION,
      resourceType: 'verification_flow',
      resourceId: parsed.taskRef,
      metadata: {
        outcome: parsed.outcome,
        destination: decision.destination,
        reason: decision.reason,
        attemptsBefore: estadoPrevio.attempts,
        attemptsAfter: decision.attemptsAfter,
        consumesAttempt: decision.consumesAttempt,
        revokesCriteriaApproval: decision.revokesCriteriaApproval,
        notifiesHuman: decision.notifiesHuman,
        ...(parsed.headSha === undefined ? {} : { headSha: parsed.headSha }),
        ...(parsed.responsible === undefined ? {} : { responsible: parsed.responsible }),
      },
    })

    return { decision, row: toRow(raw) }
  })
}
