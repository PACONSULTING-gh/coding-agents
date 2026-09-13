import type { LlmPort } from '@coord/core'
import { suggestAssignees, type RoutingCandidate, type RoutingSuggestion } from '@coord/agents'
import { recordRoutingSuggestion } from '@coord/db'
import { decideRoutingTrigger, type GithubWebhookJob, type RoutableIssue } from '@coord/github'
import type { Logger } from 'pino'

/**
 * El disparador del router (epic 03 / T03).
 *
 * Hasta ahora `decideRoutingTrigger` decidia CUANDO hay que sugerir,
 * `suggestAssignees` sabia sugerir y `recordRoutingSuggestion` sabia guardarlo,
 * y NADIE llamaba a ninguno. Esto es lo que los ata a un issue recien abierto.
 *
 * ===========================================================================
 * SE PUBLICA ANTES DE REGISTRAR, Y NO ES CAPRICHO
 * ===========================================================================
 * El orden decide que significa la metrica de T04.
 *
 * Si se registrara primero y la publicacion fallara, quedaria una sugerencia
 * que NADIE VIO contando en el denominador de "cuantas se aceptaron". Como
 * nadie pudo aceptarla, bajaria la tasa para siempre y el numero diria que el
 * router acierta peor de lo que acierta.
 *
 * Publicando primero, lo que se pierde cuando falla el registro es un dato
 * —malo, pero honesto—: el denominador solo cuenta sugerencias sobre las que un
 * humano pudo decidir de verdad.
 *
 * ===========================================================================
 * SIN CANDIDATOS NO SE LLAMA AL MODELO
 * ===========================================================================
 * Si nadie ha tocado nunca los ficheros de la tarea, la unica respuesta posible
 * es `no_match`. Gastar una llamada con esfuerzo alto para que el modelo diga
 * lo que ya se sabe es tirar limites de suscripcion. Se registra el `no_match`
 * igual, porque es un dato: T04 lo cuenta aparte y NO como fallo.
 */

export type RoutingRunOutcome =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'no_match'; readonly reason: string }
  | { readonly kind: 'suggested'; readonly first: string; readonly candidates: number }

export interface RoutingRunDeps {
  readonly llm: LlmPort
  /** Que ficheros va a tocar la tarea. Del grafo, o de donde sea. */
  readonly filesForIssue: (issue: RoutableIssue) => Promise<readonly string[]>
  /** Los candidatos con sus señales de autoria y carga, ya calculadas. */
  readonly candidatesFor: (files: readonly string[]) => Promise<readonly RoutingCandidate[]>
  /** Publica el shortlist donde lo vea un humano. */
  readonly publishComment: (issueNumber: number, body: string) => Promise<void>
  readonly logger: Logger
}

/**
 * El comentario que ve la persona.
 *
 * Lleva la señal que condujo cada puesto porque el criterio de aceptacion lo
 * exige con esas palabras: "puedo saber que señal condujo cada posicion SIN
 * ABRIR EL CODIGO". Y dice, arriba del todo, que esto se confirma asignando —
 * un shortlist que no se presenta como sugerencia se lee como una decision
 * tomada, y entonces nadie lo discute.
 */
export function renderShortlistComment(suggestion: RoutingSuggestion): string {
  if (suggestion.kind === 'no_match') {
    return [
      '### Sin sugerencia de asignación',
      '',
      suggestion.reason,
      '',
      '_No es un fallo: decir "no hay match claro" es una respuesta válida. Asigna a quien creas._',
    ].join('\n')
  }

  const lineas = [
    '### Sugerencia de asignación',
    '',
    '**Esto es una sugerencia, no una decisión.** Se confirma asignando el issue a alguien.',
    '',
  ]

  for (const entrada of suggestion.entries) {
    lineas.push(
      `**${String(entrada.rank)}. ${entrada.candidateId}** — señal: \`${entrada.leadingSignal}\``,
      '',
      entrada.reasoning,
      '',
      entrada.evidenceFiles.length === 0
        ? '_Sin ficheros citados._'
        : `Ficheros: ${entrada.evidenceFiles.map((f) => `\`${f}\``).join(', ')}`,
      '',
    )
  }

  return lineas.join('\n')
}

export async function runRouting(
  job: GithubWebhookJob,
  deps: RoutingRunDeps,
): Promise<RoutingRunOutcome> {
  const decision = decideRoutingTrigger(job)
  if (decision.kind === 'skip') {
    deps.logger.debug({ deliveryId: job.deliveryId, reason: decision.reason }, 'Routing omitido')
    return { kind: 'skipped', reason: decision.reason }
  }

  const { issue } = decision
  const taskRef = String(issue.number)
  const files = await deps.filesForIssue(issue)
  const candidates = await deps.candidatesFor(files)

  if (candidates.length === 0) {
    const reason =
      'Nadie ha tocado los ficheros que parece que toca esta tarea, o no se ha podido ' +
      'determinar cuáles son. No se ha consultado al modelo.'
    await deps.publishComment(issue.number, renderShortlistComment({ kind: 'no_match', reason }))
    await recordRoutingSuggestion({ taskRef, noMatchReason: reason })
    return { kind: 'no_match', reason }
  }

  const suggestion = await suggestAssignees(deps.llm, {
    taskRef,
    taskTitle: issue.title,
    ...(issue.body === undefined ? {} : { taskBody: issue.body }),
    files,
    candidates,
  })

  // Publicar PRIMERO. Ver la cabecera.
  await deps.publishComment(issue.number, renderShortlistComment(suggestion))

  if (suggestion.kind === 'no_match') {
    await recordRoutingSuggestion({ taskRef, noMatchReason: suggestion.reason })
    return { kind: 'no_match', reason: suggestion.reason }
  }

  const primero = suggestion.entries.find((entrada) => entrada.rank === 1)
  if (primero === undefined) {
    // `parseRoutingSuggestion` ya garantiza que hay un puesto 1. Si llega aqui,
    // el invariante esta roto y NO se inventa un primero: registrar a otro como
    // "el sugerido" falsearia la metrica entera de T04.
    throw new Error(
      `El shortlist de ${taskRef} no trae puesto 1. La validacion deberia haberlo impedido: no se ` +
        'elige uno a mano, porque la metrica de acierto mide justo a quien iba primero.',
    )
  }

  await recordRoutingSuggestion({
    taskRef,
    suggestedFirst: primero.candidateId,
    entries: suggestion.entries.map((entrada) => ({
      rank: entrada.rank,
      candidateId: entrada.candidateId,
      leadingSignal: entrada.leadingSignal,
    })),
  })

  deps.logger.info(
    { taskRef, first: primero.candidateId, candidates: suggestion.entries.length },
    'Sugerencia de asignación publicada',
  )
  return { kind: 'suggested', first: primero.candidateId, candidates: suggestion.entries.length }
}
