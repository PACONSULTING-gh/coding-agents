import { ValidationError, type LlmPort, type LlmUsage } from '@coord/core'

import { suggestAssignees, type SuggestAssigneesOptions } from './router.js'
import {
  MIN_CANDIDATES,
  type LeadingSignal,
  type RoutingInput,
  type RoutingSuggestion,
} from './shortlist.js'

/**
 * El banco de routing (tercer criterio de aceptacion de T02).
 *
 * ===========================================================================
 * QUE MIDE ESTO Y QUE NO
 * ===========================================================================
 * El criterio dice: "dado un caso donde el mas libre NO es el mas adecuado,
 * cuando el agente decide, entonces la evidencia de skill pesa mas que la
 * carga". Eso es una afirmacion sobre el JUICIO DEL MODELO, y ningun doble
 * puede sostenerla: un doble responde lo que el test le dicte.
 *
 * Este modulo es el INSTRUMENTO, no la medida — exactamente igual que
 * `verification/trap-suite.ts`, y por el mismo motivo. Correrlo contra el doble
 * HTTP comprueba que el instrumento cuenta bien; la cifra solo significa algo
 * cuando se corre contra un modelo de verdad, y el informe lleva SIEMPRE el
 * modelo que respondio para que nadie pueda citar un numero sin decir contra
 * que se obtuvo.
 *
 * ===========================================================================
 * POR QUE NO BASTA CON CASOS DE "EL MAS LIBRE NO ES EL MEJOR"
 * ===========================================================================
 * Un router que ordenase SIEMPRE por lineas de autoria descendente acertaria el
 * 100% de esos casos y seria inutil por el otro lado: ignoraria la carga,
 * mandaria todo a la misma persona, y para eso tampoco hace falta un LLM —es un
 * `ORDER BY lineas`—. Es el mismo argumento por el que el banco de trampas
 * exige casos limpios: una sola tasa siempre se puede maximizar haciendo
 * trampa.
 *
 * Por eso el banco EXIGE los tres tipos de caso y devuelve las tres tasas
 * juntas:
 *
 *   `atajo`      la evidencia tiene que ganar a la carga.
 *   `desempate`  con evidencia comparable, la carga tiene que decidir.
 *   `sin_match`  sin evidencia de nadie, hay que decirlo en vez de rellenar.
 *
 * ===========================================================================
 * LA SEÑAL DECLARADA TAMBIEN SE MIDE
 * ===========================================================================
 * Acertar el primer puesto por el motivo equivocado no es acertar: el cuarto
 * criterio dice que un humano tiene que poder saber QUE SEÑAL condujo cada
 * posicion, y si el router ranquea bien pero declara la señal que no es, lo que
 * ese humano lee es falso. Se cuenta aparte, en `signalMismatches`, porque no
 * es el mismo fallo que equivocarse de persona.
 *
 * ===========================================================================
 * SI EL MODELO SE NIEGA, EL BANCO SE PARA
 * ===========================================================================
 * Una negativa (`LlmRefusalError`, que es lo que hoy hace `claude-opus-5` por
 * la ruta del CLI — issue #27) se propaga y aborta la medida. No se cuenta como
 * fallo ni como acierto: un caso que no se ha podido preguntar no es un dato, y
 * meterlo en el denominador seria inventarse la cifra.
 */

export const ROUTING_BENCH_KINDS = ['atajo', 'desempate', 'sin_match'] as const
export type RoutingBenchKind = (typeof ROUTING_BENCH_KINDS)[number]

export interface RoutingBenchCase {
  readonly id: string
  readonly title: string
  readonly kind: RoutingBenchKind
  readonly input: RoutingInput
  /**
   * Quien tiene que salir primero. Obligatorio en `atajo` y `desempate`,
   * prohibido en `sin_match` (ahi la respuesta correcta es no sugerir a nadie).
   */
  readonly expectedTop?: string
  /**
   * Que señal deberia declarar ese primer puesto. `both` se acepta siempre
   * como respuesta valida: decir que pesaron las dos cosas no es mentir, es
   * matizar.
   */
  readonly expectedSignal?: LeadingSignal
}

export interface RoutingBenchOutcome {
  readonly caseId: string
  readonly title: string
  readonly kind: RoutingBenchKind
  /** Que respondio: un shortlist o "sin match claro". */
  readonly answered: RoutingSuggestion['kind']
  /** Primer puesto, o `undefined` si dijo `no_match`. */
  readonly topCandidateId: string | undefined
  readonly expectedTop: string | undefined
  /** El caso salio como debia. */
  readonly correct: boolean
  readonly leadingSignal: LeadingSignal | undefined
  /** Acerto la persona pero declaro una señal que no la explica. */
  readonly signalMismatch: boolean
}

export interface RoutingBenchReport {
  /**
   * El modelo que respondio de verdad. Sin este dato las tasas no significan
   * nada: es lo que distingue "medido contra claude-opus-5" de "medido contra
   * un servidor de mentira en localhost".
   */
  readonly model: string
  readonly cases: readonly RoutingBenchOutcome[]
  /** Casos `atajo` donde la carga gano a la evidencia. El fallo que da nombre al epic. */
  readonly loadShortcuts: number
  readonly loadShortcutRate: number
  /** Casos `desempate` donde la carga no desempato. El fallo contrario. */
  readonly tieBreakMisses: number
  readonly tieBreakMissRate: number
  /** Casos `sin_match` donde forzo un candidato en vez de decir que no hay. */
  readonly fillers: number
  readonly fillerRate: number
  /** Acerto la persona y declaro una señal que no la explica. */
  readonly signalMismatches: number
  readonly usage: LlmUsage
}

function assertBenchIsUsable(cases: readonly RoutingBenchCase[]): void {
  if (cases.length === 0) {
    throw new ValidationError('El banco de routing esta vacio: no hay nada que medir.')
  }
  const ids = new Set(cases.map((benchCase) => benchCase.id))
  if (ids.size !== cases.length) {
    throw new ValidationError(
      'Hay casos con el mismo id en el banco de routing: las tasas se contarian sobre casos que ' +
        'no se pueden distinguir.',
    )
  }
  for (const kind of ROUTING_BENCH_KINDS) {
    if (!cases.some((benchCase) => benchCase.kind === kind)) {
      throw new ValidationError(
        `El banco no tiene ningun caso "${kind}", y las tres tasas se devuelven juntas a ` +
          'proposito: con una sola, un router degenerado —el que ordena siempre por lineas, o el ' +
          'que nunca sugiere a nadie— puntuaria perfecto, y esa cifra seria una mentira con ' +
          'forma de metrica.',
      )
    }
  }
  for (const benchCase of cases) {
    if (benchCase.input.candidates.length < MIN_CANDIDATES) {
      throw new ValidationError(
        `El caso ${benchCase.id} trae ${String(benchCase.input.candidates.length)} candidato(s), y ` +
          `un shortlist valido necesita al menos ${String(MIN_CANDIDATES)}: el caso no se puede ` +
          'contestar bien ni haciendolo todo bien.',
      )
    }
    if (benchCase.kind === 'sin_match') {
      if (benchCase.expectedTop !== undefined) {
        throw new ValidationError(
          `El caso ${benchCase.id} es "sin_match" y ademas dice a quien espera primero. La ` +
            'respuesta correcta ahi es no sugerir a nadie.',
        )
      }
      continue
    }
    if (benchCase.expectedTop === undefined) {
      throw new ValidationError(
        `El caso ${benchCase.id} no dice a quien espera en el primer puesto: no mide nada.`,
      )
    }
    if (!benchCase.input.candidates.some((c) => c.id === benchCase.expectedTop)) {
      throw new ValidationError(
        `El caso ${benchCase.id} espera a "${benchCase.expectedTop}" en el primer puesto y esa ` +
          'persona no esta entre sus candidatos.',
      )
    }
  }
}

export async function runRoutingBench(
  llm: LlmPort,
  cases: readonly RoutingBenchCase[],
  options: SuggestAssigneesOptions = {},
): Promise<RoutingBenchReport> {
  assertBenchIsUsable(cases)

  const outcomes: RoutingBenchOutcome[] = []
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheCreation = 0
  const models = new Set<string>()

  for (const benchCase of cases) {
    // Se pregunta a traves de un `LlmPort` que cuenta lo que gasta, para que el
    // consumo del banco salga en el informe: medir cuesta dinero y hay que verlo.
    const contado = new CountingLlm(llm)
    const suggestion = await suggestAssignees(contado, benchCase.input, options)
    models.add(contado.model ?? '(el proveedor no lo declaro)')
    inputTokens += contado.usage.inputTokens
    outputTokens += contado.usage.outputTokens
    cacheRead += contado.usage.cacheReadInputTokens
    cacheCreation += contado.usage.cacheCreationInputTokens

    outcomes.push(scoreCase(benchCase, suggestion))
  }

  const porTipo = (kind: RoutingBenchKind): readonly RoutingBenchOutcome[] =>
    outcomes.filter((outcome) => outcome.kind === kind)

  const atajos = porTipo('atajo')
  const desempates = porTipo('desempate')
  const sinMatch = porTipo('sin_match')
  const loadShortcuts = atajos.filter((outcome) => !outcome.correct).length
  const tieBreakMisses = desempates.filter((outcome) => !outcome.correct).length
  const fillers = sinMatch.filter((outcome) => !outcome.correct).length

  return {
    // Ningun denominador puede ser cero: `assertBenchIsUsable` exige los tres tipos.
    model: [...models].sort().join(', '),
    cases: outcomes,
    loadShortcuts,
    loadShortcutRate: loadShortcuts / atajos.length,
    tieBreakMisses,
    tieBreakMissRate: tieBreakMisses / desempates.length,
    fillers,
    fillerRate: fillers / sinMatch.length,
    signalMismatches: outcomes.filter((outcome) => outcome.signalMismatch).length,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
    },
  }
}

function scoreCase(
  benchCase: RoutingBenchCase,
  suggestion: RoutingSuggestion,
): RoutingBenchOutcome {
  const base = {
    caseId: benchCase.id,
    title: benchCase.title,
    kind: benchCase.kind,
    expectedTop: benchCase.expectedTop,
  }

  if (suggestion.kind === 'no_match') {
    return {
      ...base,
      answered: 'no_match',
      topCandidateId: undefined,
      // Decir "no hay match" es correcto SOLO en los casos `sin_match`. En un
      // `atajo` es rendirse teniendo delante a alguien con evidencia clara.
      correct: benchCase.kind === 'sin_match',
      leadingSignal: undefined,
      signalMismatch: false,
    }
  }

  const primero = suggestion.entries[0]
  const correct = benchCase.kind !== 'sin_match' && primero?.candidateId === benchCase.expectedTop

  return {
    ...base,
    answered: 'shortlist',
    topCandidateId: primero?.candidateId,
    correct,
    leadingSignal: primero?.leadingSignal,
    // Solo se mira la señal cuando la persona es la correcta: si se equivoco de
    // persona, discutir la señal que declaro es discutir la justificacion de
    // una respuesta que ya esta mal. `both` se acepta siempre.
    signalMismatch:
      correct &&
      benchCase.expectedSignal !== undefined &&
      primero !== undefined &&
      primero.leadingSignal !== 'both' &&
      primero.leadingSignal !== benchCase.expectedSignal,
  }
}

/**
 * Envuelve un `LlmPort` para quedarse con el consumo y el modelo de la ultima
 * llamada, sin que el router tenga que devolverlos: el router devuelve una
 * sugerencia, que es su trabajo, y meterle un canal de telemetria solo para el
 * banco seria contaminar la produccion con la medida.
 */
class CountingLlm implements LlmPort {
  public usage: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
  public model: string | undefined

  constructor(private readonly inner: LlmPort) {}

  public complete: LlmPort['complete'] = async (request) => {
    const result = await this.inner.complete(request)
    this.usage = result.usage
    this.model = result.model
    return result
  }
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

/**
 * Informe legible. La primera linea dice contra QUE se midio, porque es el dato
 * que convierte el resto en informacion o en ruido.
 */
export function formatRoutingBenchReport(report: RoutingBenchReport): string {
  const lines: string[] = [
    `Banco de routing — medido contra: ${report.model}`,
    '',
    `Atajo de carga:      ${percent(report.loadShortcutRate)} ` +
      `(${String(report.loadShortcuts)} casos donde la carga gano a la evidencia)`,
    `Desempate fallado:   ${percent(report.tieBreakMissRate)} ` +
      `(${String(report.tieBreakMisses)} casos donde la carga no desempato)`,
    `Relleno:             ${percent(report.fillerRate)} ` +
      `(${String(report.fillers)} casos donde forzo un candidato sin haberlo)`,
    `Señal mal declarada: ${String(report.signalMismatches)}`,
    '',
    'Caso a caso:',
  ]
  for (const outcome of report.cases) {
    lines.push(
      `  [${outcome.correct ? 'ok ' : 'MAL'}] ${outcome.caseId} (${outcome.kind}) — ${outcome.title}`,
      `        respondio=${outcome.answered} primero=${outcome.topCandidateId ?? '(nadie)'} ` +
        `esperado=${outcome.expectedTop ?? '(nadie)'} señal=${outcome.leadingSignal ?? '-'}` +
        `${outcome.signalMismatch ? ' <- señal que no lo explica' : ''}`,
    )
  }
  lines.push(
    '',
    `Consumo: ${String(report.usage.inputTokens)} tokens de entrada ` +
      `(${String(report.usage.cacheReadInputTokens)} desde cache), ` +
      `${String(report.usage.outputTokens)} de salida.`,
  )
  return lines.join('\n')
}
