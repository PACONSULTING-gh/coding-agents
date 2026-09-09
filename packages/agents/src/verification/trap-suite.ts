import { ValidationError, type LlmPort, type LlmUsage } from '@coord/core'

import {
  allCriteriaPass,
  verifyChanges,
  type CriterionVerdict,
  type CriterionVerdictValue,
  type EvidenceSource,
  type VerificationInput,
  type VerificationOptions,
} from './verifier.js'

/**
 * El banco de trampas del Verifier (cuarto criterio de aceptacion de T04).
 *
 * ===========================================================================
 * QUE MIDE ESTO Y QUE NO
 * ===========================================================================
 * El criterio dice: "dado un conjunto de diffs con trampas conocidas, cuando el
 * Verifier los evalua, entonces los detecta y su TASA DE FALSO APROBADO QUEDA
 * MEDIDA".
 *
 * "Queda medida" es la parte importante y la que hace falta decir en voz alta:
 * este modulo es el instrumento, no la medida. Ejecutarlo contra un doble HTTP
 * —que es lo que hacen los tests— comprueba que el instrumento cuenta bien; NO
 * dice nada sobre lo bueno que es el Verifier real. La cifra solo significa
 * algo cuando se corre contra `claude-opus-5` de verdad, y eso exige
 * credenciales.
 *
 * HOY LA TASA NO ESTA MEDIDA. Cualquiera que cite un numero de aqui sin decir
 * contra que modelo se obtuvo esta haciendo lo mismo que el epic 05 persigue:
 * presentar verde lo que nadie ha comprobado. Por eso `TrapSuiteReport` lleva
 * SIEMPRE el modelo que respondio, y `formatTrapSuiteReport` lo imprime arriba
 * del todo.
 *
 * ===========================================================================
 * POR QUE EL BANCO NECESITA CASOS LIMPIOS
 * ===========================================================================
 * Un Verifier que dijera FAIL a todo tendria tasa de falso aprobado 0 y seria
 * completamente inutil: bloquearia todos los PR buenos. Por eso
 * `runTrapSuite` EXIGE al menos un caso `limpio` y devuelve las dos tasas
 * juntas. Una sola de las dos siempre se puede maximizar haciendo trampa.
 *
 * ===========================================================================
 * POR QUE LAS TASAS SE CUENTAN POR CASO Y NO POR CRITERIO
 * ===========================================================================
 * Lo que un humano hace con el informe es aprobar o no aprobar UN cambio. Un
 * caso queda "aprobado" solo si todos sus criterios son PASS
 * (`allCriteriaPass`), asi que un falso aprobado es exactamente lo que suena:
 * el Verifier habria dejado pasar un cambio tramposo. Los desacuerdos por
 * criterio se conservan igual en `mismatches`, porque son lo que se mira para
 * entender POR QUE fallo, pero no son la tasa.
 */

// ---------------------------------------------------------------------------
// El caso
// ---------------------------------------------------------------------------

export const TRAP_CASE_KINDS = ['trampa', 'limpio'] as const
/**
 * `trampa`: el diff contiene una trampa conocida y NO debe aprobarse.
 * `limpio`: el diff cumple de verdad y SI debe aprobarse.
 */
export type TrapCaseKind = (typeof TRAP_CASE_KINDS)[number]

/**
 * Lo que se espera de un criterio concreto del caso.
 *
 * `evidenceHint` no es parte de la medida: es el fragmento del artefacto donde
 * se ve la trampa (o donde se ve el hueco). Esta aqui por dos razones, las dos
 * practicas:
 *
 *   1. Deja escrito en el propio fixture DONDE esta lo que hay que ver, que es
 *      lo unico que hace revisable un banco de trampas por un humano. Un
 *      fixture que solo dice "esto deberia ser FAIL" no se puede auditar.
 *   2. Alimenta al doble HTTP en los tests del instrumento, que necesita
 *      producir citas que existan de verdad en el artefacto.
 */
export interface TrapExpectation {
  readonly verdict: CriterionVerdictValue
  readonly evidenceSource: EvidenceSource
  /** Fragmento LITERAL del artefacto donde se ve (o donde falta) lo que el criterio pide. */
  readonly evidenceHint: string
}

export interface TrapCase {
  readonly id: string
  /** Que trampa es, en una linea. Se imprime en el informe. */
  readonly title: string
  readonly kind: TrapCaseKind
  readonly input: VerificationInput
  /** Veredicto esperado por criterio, indexado por `criterionId`. */
  readonly expected: Readonly<Record<string, TrapExpectation>>
}

// ---------------------------------------------------------------------------
// El resultado
// ---------------------------------------------------------------------------

export interface CriterionMismatch {
  readonly criterionId: string
  readonly expected: CriterionVerdictValue
  readonly actual: CriterionVerdictValue
}

export interface TrapCaseOutcome {
  readonly caseId: string
  readonly title: string
  readonly kind: TrapCaseKind
  /** Todos los criterios en PASS: el Verifier habria dejado pasar el cambio. */
  readonly approved: boolean
  /** Un caso `limpio` deberia aprobarse; una `trampa`, no. */
  readonly shouldBeApproved: boolean
  readonly verdicts: readonly CriterionVerdict[]
  /** Criterios cuyo veredicto no coincide con el esperado. */
  readonly mismatches: readonly CriterionMismatch[]
}

export interface TrapSuiteReport {
  /**
   * El modelo que respondio de verdad, tal como lo declaro el proveedor.
   * Sin este dato la tasa no significa nada: es lo que distingue "medido contra
   * claude-opus-5" de "medido contra un servidor de mentira en localhost".
   */
  readonly model: string
  readonly cases: readonly TrapCaseOutcome[]
  readonly trapCount: number
  readonly cleanCount: number
  /** Trampas que el Verifier habria aprobado. Lo que de verdad duele. */
  readonly falseApprovals: number
  /** `falseApprovals / trapCount`, en [0, 1]. */
  readonly falseApprovalRate: number
  /** Casos limpios que el Verifier NO habria aprobado. */
  readonly falseRejections: number
  /** `falseRejections / cleanCount`, en [0, 1]. */
  readonly falseRejectionRate: number
  /** Criterios con veredicto distinto al esperado, sumando todos los casos. */
  readonly criterionMismatches: number
  /** Consumo sumado de todas las llamadas. La verificacion cuesta dinero y hay que verlo. */
  readonly usage: LlmUsage
}

// ---------------------------------------------------------------------------
// La ejecucion
// ---------------------------------------------------------------------------

function assertSuiteIsUsable(cases: readonly TrapCase[]): void {
  if (cases.length === 0) {
    throw new ValidationError('El banco de trampas esta vacio: no hay nada que medir.')
  }
  const ids = new Set(cases.map((trapCase) => trapCase.id))
  if (ids.size !== cases.length) {
    throw new ValidationError(
      'Hay casos con el mismo id en el banco de trampas: las tasas se contarian sobre casos ' +
        'que no se pueden distinguir.',
    )
  }
  if (!cases.some((trapCase) => trapCase.kind === 'trampa')) {
    throw new ValidationError(
      'El banco no tiene ninguna trampa: la tasa de falso aprobado no se puede calcular.',
    )
  }
  if (!cases.some((trapCase) => trapCase.kind === 'limpio')) {
    throw new ValidationError(
      'El banco no tiene ningun caso limpio. Sin al menos uno, un Verifier que dijera FAIL a ' +
        'todo puntuaria perfecto, y esa cifra seria una mentira con forma de metrica.',
    )
  }
  for (const trapCase of cases) {
    const expectedIds = new Set(Object.keys(trapCase.expected))
    for (const criterion of trapCase.input.criteria) {
      if (!expectedIds.has(criterion.id)) {
        throw new ValidationError(
          `El caso ${trapCase.id} no dice que se espera del criterio "${criterion.id}". Un ` +
            'criterio sin veredicto esperado no mide nada.',
        )
      }
      expectedIds.delete(criterion.id)
    }
    if (expectedIds.size > 0) {
      throw new ValidationError(
        `El caso ${trapCase.id} espera veredicto para criterios que no tiene: ` +
          `${[...expectedIds].join(', ')}.`,
      )
    }
    // Coherencia interna: un caso limpio en el que se espera algo distinto de
    // PASS no es un caso limpio, y contaria mal en las tasas.
    const allPass = Object.values(trapCase.expected).every(
      (expectation) => expectation.verdict === 'PASS',
    )
    if (trapCase.kind === 'limpio' && !allPass) {
      throw new ValidationError(
        `El caso ${trapCase.id} esta marcado como "limpio" pero no espera PASS en todos sus ` +
          'criterios. O es una trampa, o el veredicto esperado esta mal.',
      )
    }
    if (trapCase.kind === 'trampa' && allPass) {
      throw new ValidationError(
        `El caso ${trapCase.id} esta marcado como "trampa" pero espera PASS en todos sus ` +
          'criterios: entonces aprobarlo seria correcto y no seria una trampa.',
      )
    }
  }
}

function mismatchesOf(
  trapCase: TrapCase,
  verdicts: readonly CriterionVerdict[],
): readonly CriterionMismatch[] {
  const mismatches: CriterionMismatch[] = []
  for (const verdict of verdicts) {
    const expectation = trapCase.expected[verdict.criterionId]
    if (expectation === undefined) continue
    if (expectation.verdict !== verdict.verdict) {
      mismatches.push({
        criterionId: verdict.criterionId,
        expected: expectation.verdict,
        actual: verdict.verdict,
      })
    }
  }
  return mismatches
}

/**
 * Corre el banco entero y devuelve las dos tasas.
 *
 * SECUENCIAL a proposito. Podria paralelizarse, pero son llamadas a `xhigh`
 * sobre diffs enteros: lanzarlas a la vez es la forma mas rapida de comerse un
 * 429 y acabar midiendo la cola del proveedor en vez del Verifier.
 *
 * NO ATRAPA ERRORES. Si una llamada falla —429, negativa del modelo, una cita
 * inventada que el Verifier rechaza— el error sube y la medicion se da por no
 * hecha. Atrapar y seguir produciria un informe con menos casos de los que
 * dice, y una tasa calculada sobre un denominador que ya no es el que se
 * anuncio: exactamente la clase de numero que no se puede usar para decidir
 * nada (CLAUDE.md 5 y 7).
 */
export async function runTrapSuite(
  llm: LlmPort,
  cases: readonly TrapCase[],
  options: VerificationOptions = {},
): Promise<TrapSuiteReport> {
  assertSuiteIsUsable(cases)

  const outcomes: TrapCaseOutcome[] = []
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheCreation = 0
  const models = new Set<string>()

  for (const trapCase of cases) {
    const result = await verifyChanges(llm, trapCase.input, options)
    models.add(result.model)
    inputTokens += result.usage.inputTokens
    outputTokens += result.usage.outputTokens
    cacheRead += result.usage.cacheReadInputTokens
    cacheCreation += result.usage.cacheCreationInputTokens

    outcomes.push({
      caseId: trapCase.id,
      title: trapCase.title,
      kind: trapCase.kind,
      approved: allCriteriaPass(result),
      shouldBeApproved: trapCase.kind === 'limpio',
      verdicts: result.verdicts,
      mismatches: mismatchesOf(trapCase, result.verdicts),
    })
  }

  const traps = outcomes.filter((outcome) => outcome.kind === 'trampa')
  const cleans = outcomes.filter((outcome) => outcome.kind === 'limpio')
  const falseApprovals = traps.filter((outcome) => outcome.approved).length
  const falseRejections = cleans.filter((outcome) => !outcome.approved).length

  return {
    // Los denominadores no pueden ser cero: `assertSuiteIsUsable` exige al
    // menos una trampa y al menos un caso limpio.
    model: [...models].sort().join(', '),
    cases: outcomes,
    trapCount: traps.length,
    cleanCount: cleans.length,
    falseApprovals,
    falseApprovalRate: falseApprovals / traps.length,
    falseRejections,
    falseRejectionRate: falseRejections / cleans.length,
    criterionMismatches: outcomes.reduce((total, outcome) => total + outcome.mismatches.length, 0),
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
    },
  }
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

/**
 * Informe legible del banco. La primera linea dice contra QUE se midio, porque
 * es el dato que convierte el resto en informacion o en ruido.
 */
export function formatTrapSuiteReport(report: TrapSuiteReport): string {
  const lines: string[] = [
    `Banco de trampas del Verifier — medido contra: ${report.model}`,
    '',
    `Tasa de falso aprobado:  ${percent(report.falseApprovalRate)} ` +
      `(${String(report.falseApprovals)}/${String(report.trapCount)} trampas aprobadas)`,
    `Tasa de falso rechazo:   ${percent(report.falseRejectionRate)} ` +
      `(${String(report.falseRejections)}/${String(report.cleanCount)} casos limpios bloqueados)`,
    `Criterios en desacuerdo: ${String(report.criterionMismatches)}`,
    '',
    'Caso a caso:',
  ]
  for (const outcome of report.cases) {
    const ok = outcome.approved === outcome.shouldBeApproved && outcome.mismatches.length === 0
    lines.push(
      `  [${ok ? 'ok ' : 'MAL'}] ${outcome.caseId} (${outcome.kind}) — ${outcome.title}`,
      `        aprobado=${String(outcome.approved)} esperado=${String(outcome.shouldBeApproved)}`,
    )
    for (const mismatch of outcome.mismatches) {
      lines.push(
        `        criterio ${mismatch.criterionId}: esperado ${mismatch.expected}, ` +
          `obtenido ${mismatch.actual}`,
      )
    }
  }
  lines.push(
    '',
    `Consumo: ${String(report.usage.inputTokens)} tokens de entrada ` +
      `(${String(report.usage.cacheReadInputTokens)} desde cache), ` +
      `${String(report.usage.outputTokens)} de salida.`,
  )
  return lines.join('\n')
}
