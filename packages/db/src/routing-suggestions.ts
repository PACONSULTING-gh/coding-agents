import { NotFoundError, type RoutingOutcomeRecord } from '@coord/core'
import { z } from 'zod'

import { taskRefSchema } from './acceptance-criteria.js'
import { withTenantConnection } from './client.js'

/**
 * Persistencia de las sugerencias del router y de lo que paso con ellas
 * (epic 03 / T04).
 *
 * AQUI NO SE DECIDE COMO SE CUENTA. La regla —que entra en el denominador,
 * cuando salta la alerta, que muestra minima hace falta— vive en
 * `packages/core/src/routing-accuracy.ts`, es pura y se prueba sin base de
 * datos. Esto solo guarda los hechos y los devuelve.
 *
 * LA FORMA QUE SE GUARDA ES NEUTRA a proposito. `RoutingSuggestion` vive en
 * `packages/agents`, y `packages/db` no puede importar de alli: las
 * dependencias apuntan hacia dentro (CLAUDE.md 5) y la capa de datos no debe
 * saber que existe un agente. Quien llama traduce.
 */

const suggestionInputSchema = z
  .object({
    taskRef: taskRefSchema,
    /** El candidato del PUESTO 1. Ausente cuando el router se rindio. */
    suggestedFirst: z.string().trim().min(1).max(200).optional(),
    /** Por que se rindio. Obligatorio si no hay candidato. */
    noMatchReason: z.string().trim().min(1).max(2_000).optional(),
    /** El shortlist entero, tal como se publico. Opaco para esta capa. */
    entries: z.array(z.record(z.string(), z.unknown())).default([]),
    model: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (v) => (v.suggestedFirst === undefined) !== (v.noMatchReason === undefined),
    // La misma coherencia que exige el CHECK de la tabla, comprobada antes de
    // llegar a ella para que el error diga algo util en vez de un 23514.
    {
      message:
        'Una sugerencia tiene O un candidato en el puesto 1 O un motivo de `no_match`, nunca ' +
        'las dos cosas ni ninguna: sin esa coherencia no se puede distinguir "el router se ' +
        'rindio" de "se perdio el candidato por el camino".',
    },
  )
export type RecordRoutingSuggestionInput = z.input<typeof suggestionInputSchema>

const assignmentInputSchema = z.object({
  taskRef: taskRefSchema,
  assignedTo: z.string().trim().min(1).max(200),
})
export type RecordRoutingAssignmentInput = z.input<typeof assignmentInputSchema>

export interface RoutingSuggestionRow {
  readonly taskRef: string
  readonly suggestedFirst: string | undefined
  readonly noMatchReason: string | undefined
  readonly entries: readonly Record<string, unknown>[]
  readonly model: string | undefined
  readonly suggestedAt: Date
  readonly assignedTo: string | undefined
  readonly assignedAt: Date | undefined
}

const COLUMNS = `task_ref, suggested_first, no_match_reason, entries, model,
                 suggested_at, assigned_to, assigned_at`

interface RawRow {
  task_ref: string
  suggested_first: string | null
  no_match_reason: string | null
  entries: unknown
  model: string | null
  suggested_at: Date
  assigned_to: string | null
  assigned_at: Date | null
}

function toRow(raw: RawRow): RoutingSuggestionRow {
  return {
    taskRef: raw.task_ref,
    suggestedFirst: raw.suggested_first ?? undefined,
    noMatchReason: raw.no_match_reason ?? undefined,
    entries: (raw.entries ?? []) as Record<string, unknown>[],
    model: raw.model ?? undefined,
    suggestedAt: raw.suggested_at,
    assignedTo: raw.assigned_to ?? undefined,
    assignedAt: raw.assigned_at ?? undefined,
  }
}

/**
 * Guarda lo que el router sugirio para una tarea.
 *
 * Si ya habia una sugerencia para esa tarea, la sustituye: lo que se mide es
 * "que se sugirio para esta tarea", no un historico de intentos. Y al
 * sustituirla se BORRA la asignacion anterior — una sugerencia nueva todavia
 * no ha sido ni aceptada ni anulada, y arrastrar la decision de la anterior
 * contaria como acierto algo que nadie ha vuelto a mirar.
 */
export async function recordRoutingSuggestion(
  input: RecordRoutingSuggestionInput,
): Promise<RoutingSuggestionRow> {
  const parsed = suggestionInputSchema.parse(input)

  return withTenantConnection(async (tx) => {
    const result = await tx.query<RawRow>(
      `INSERT INTO routing_suggestions (
         tenant_id, task_ref, suggested_first, no_match_reason, entries, model, suggested_at
       ) VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (tenant_id, task_ref) DO UPDATE SET
         suggested_first = EXCLUDED.suggested_first,
         no_match_reason = EXCLUDED.no_match_reason,
         entries = EXCLUDED.entries,
         model = EXCLUDED.model,
         suggested_at = now(),
         assigned_to = NULL,
         assigned_at = NULL
       RETURNING ${COLUMNS}`,
      [
        tx.tenantId,
        parsed.taskRef,
        parsed.suggestedFirst ?? null,
        parsed.noMatchReason ?? null,
        JSON.stringify(parsed.entries),
        parsed.model ?? null,
      ],
    )
    const raw = result.rows.at(0)
    if (raw === undefined) {
      throw new Error('routing_suggestions no devolvio fila tras el upsert: estado inconsistente.')
    }
    return toRow(raw)
  })
}

/**
 * Registra a quien se asigno la tarea DE VERDAD.
 *
 * Lanza `NotFoundError` si no hay sugerencia para esa tarea, y eso NO es un
 * caso raro: un issue que se asigna sin que el router haya opinado no es una
 * anulacion de nada. Devolver un exito silencioso aqui haria creer al llamante
 * que la decision quedo medida cuando no hay nada que medir.
 */
export async function recordRoutingAssignment(
  input: RecordRoutingAssignmentInput,
): Promise<RoutingSuggestionRow> {
  const parsed = assignmentInputSchema.parse(input)

  return withTenantConnection(async (tx) => {
    const result = await tx.query<RawRow>(
      `UPDATE routing_suggestions
          SET assigned_to = $3, assigned_at = now()
        WHERE tenant_id = $1 AND task_ref = $2
        RETURNING ${COLUMNS}`,
      [tx.tenantId, parsed.taskRef, parsed.assignedTo],
    )
    const raw = result.rows.at(0)
    if (raw === undefined) {
      throw new NotFoundError(
        `No hay ninguna sugerencia del router para ${parsed.taskRef}, asi que su asignacion no ` +
          'mide nada: no se puede aceptar ni anular una sugerencia que no existe.',
      )
    }
    return toRow(raw)
  })
}

const outcomesFilterSchema = z.object({
  /** Desde cuando. La metrica del criterio de aceptacion es "una semana de uso". */
  since: z.date().optional(),
  limit: z.number().int().min(1).max(5_000).default(1_000),
})
export type RoutingOutcomesFilter = z.input<typeof outcomesFilterSchema>

/**
 * Los hechos, en la forma que espera `summarizeRoutingAccuracy`.
 *
 * Se devuelven las FILAS y no una tasa ya calculada: quien decide como se
 * cuenta es el modulo puro de `packages/core`, y hacer aqui un `count(*)
 * FILTER (WHERE ...)` metería la regla dentro de una consulta SQL, donde nadie
 * la revisa y nadie la puede probar sin levantar Postgres.
 */
export async function readRoutingOutcomes(
  filter: RoutingOutcomesFilter = {},
): Promise<RoutingOutcomeRecord[]> {
  const parsed = outcomesFilterSchema.parse(filter)

  return withTenantConnection(async (tx) => {
    const result = await tx.query<RawRow>(
      `SELECT ${COLUMNS} FROM routing_suggestions
        WHERE tenant_id = $1 AND ($2::timestamptz IS NULL OR suggested_at >= $2)
        ORDER BY suggested_at DESC
        LIMIT $3`,
      [tx.tenantId, parsed.since ?? null, parsed.limit],
    )
    return result.rows.map((raw) => ({
      taskRef: raw.task_ref,
      ...(raw.suggested_first === null ? {} : { suggestedFirst: raw.suggested_first }),
      ...(raw.assigned_to === null ? {} : { assignedTo: raw.assigned_to }),
    }))
  })
}
