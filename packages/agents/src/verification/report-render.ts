import { ValidationError, type LlmUsage } from '@coord/core'

import { countVerdicts, type ConformanceReport, type VerdictCounts } from './report.js'
import type { CriterionVerdict, CriterionVerdictValue } from './verifier.js'

/**
 * T05 — los dos renderizados del informe de conformidad, desde la misma
 * estructura (`ConformanceReport` de `report.ts`).
 *
 * ===========================================================================
 * "CABE EN UNA PANTALLA" ES `DEFAULT_SCREEN_BUDGET`, NO UNA SENSACION
 * ===========================================================================
 * El epic pide que el informe "quepa en una pantalla" y eso no significa nada
 * si no se convierte en un numero comprobable. Aqui son dos: lineas y
 * caracteres. Ninguno pretende ser fisica exacta —no hay una "pantalla"
 * universal— pero los dos estan elegidos con una referencia concreta y son lo
 * bastante bajos para obligar a truncar en cuanto un cambio toca mas de un
 * puñado de criterios, que es el caso real:
 *
 *   - 80 LINEAS: un terminal maximizado en un portatil a tamaño de fuente
 *     por defecto ronda ese numero de filas, y es tambien aproximadamente lo
 *     que se ve en el primer pantallazo de un comentario de PR de GitHub antes
 *     de que la propia interfaz lo colapse tras "Load more".
 *   - 8000 CARACTERES: a ~80 columnas por linea, 80 lineas son 6400
 *     caracteres; el margen extra cubre lineas mas largas (una cita puede
 *     llegar a 4000 caracteres, ver `MIN_QUOTE_LENGTH`/`MAX_QUOTE_LENGTH` en
 *     `verifier.ts`) sin disparar el limite de lineas antes que el de
 *     caracteres.
 *
 * El test `report-render.test.ts` renderiza informes de 3 y de 40 criterios y
 * MIDE el resultado contra estas dos cifras: el limite no es una afirmacion en
 * un comentario, es una asercion que falla si deja de cumplirse.
 *
 * ===========================================================================
 * COMO SE TRUNCA
 * ===========================================================================
 * TRES pasadas, nunca mas de tres, y cada una recorta algo que se puede perder
 * sin perder informacion para decidir:
 *
 *   1. TODO EL DETALLE. Si cabe, se devuelve tal cual.
 *   2. LOS PASS A UNA LINEA CADA UNO (id + veredicto, sin razonamiento ni
 *      citas). Los FAIL y SIN_EVIDENCIA quedan intactos.
 *   3. LOS PASS AGRUPADOS, varios ids por linea. Sigue sin ocultarse ni un id:
 *      solo desaparecen los saltos de linea entre ellos.
 *
 * Que el paso 3 exista NO es un detalle: medido, un informe de 73 criterios
 * TODOS EN PASS salia a 81 lineas con el paso 2 y ya no cabia. Es decir, el
 * informe dejaba de caber ANTES por exceso de PASS que por FAIL, y quedaba una
 * via de compresion completamente inocua sin usar. La justificacion anterior
 * ("solo no cabe con muchos FAIL de razonamiento largo") era falsa.
 *
 * LO QUE NO SE RECORTA NUNCA, EN NINGUNA PASADA: los FAIL y los SIN_EVIDENCIA,
 * ni parcialmente. Es una decision binaria por veredicto, no una escala de
 * cuanto recortar cada uno, porque una vez que se admite "un FAIL algo mas
 * corto" ya no hay un sitio obvio donde parar. Si ni con la tercera pasada
 * cupiera, esta funcion NO sigue recortando: devuelve el informe con
 * `fitsOnScreen: false` en vez de fingir que cupo. Ocultar un FAIL para caber es
 * peor que un informe largo (CLAUDE.md 7): esta funcion nunca lo hace.
 */

export interface ScreenBudget {
  readonly maxLines: number
  readonly maxChars: number
}

/** Ver la cabecera de este fichero para la justificacion de estas dos cifras. */
export const DEFAULT_SCREEN_BUDGET: ScreenBudget = { maxLines: 80, maxChars: 8_000 }

export interface RenderedConformanceReport {
  readonly text: string
  readonly lineCount: number
  readonly charCount: number
  /** `false` solo si ni siquiera compactando todos los PASS entra en el presupuesto. */
  readonly fitsOnScreen: boolean
  /** Cuantos criterios PASS se redujeron. Cero si no hizo falta truncar. */
  readonly summarizedPassCount: number
  /** Que pasada se devolvio: 0 = detalle completo, 1 = PASS a una linea, 2 = PASS agrupados. */
  readonly compactionLevel: 0 | 1 | 2
}

const VERDICT_LABEL: Record<CriterionVerdictValue, string> = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  SIN_EVIDENCIA: 'SIN_EVIDENCIA',
}

const GLOBAL_VERDICT_LABEL = { apto: 'APTO', no_apto: 'NO APTO' } as const

// ---------------------------------------------------------------------------
// El plan: la misma estructura de contenido para los dos formatos
// ---------------------------------------------------------------------------

interface CriterionBlock {
  readonly ordinal: number
  readonly verdict: CriterionVerdictValue
  readonly criterionId: string
  /** `undefined` cuando el bloque esta resumido: solo se muestran veredicto e id. */
  readonly detail?: {
    readonly criterionQuote: string
    readonly evidenceSource: CriterionVerdict['evidenceSource']
    readonly evidenceQuote: string
    readonly reasoning: string
  }
}

type CompactionLevel = 0 | 1 | 2

interface ReportPlan {
  readonly taskRef: string
  readonly artifact: ConformanceReport['artifact']
  readonly model: string
  readonly globalVerdict: ConformanceReport['globalVerdict']
  readonly counts: VerdictCounts
  readonly usage: LlmUsage
  readonly blocks: readonly CriterionBlock[]
  readonly summarizedPassCount: number
  readonly level: CompactionLevel
}

function buildPlan(report: ConformanceReport, level: CompactionLevel): ReportPlan {
  let summarizedPassCount = 0
  const blocks: CriterionBlock[] = report.verdicts.map((verdict, index) => {
    const summarize = level > 0 && verdict.verdict === 'PASS'
    if (summarize) {
      summarizedPassCount += 1
      return { ordinal: index + 1, verdict: verdict.verdict, criterionId: verdict.criterionId }
    }
    return {
      ordinal: index + 1,
      verdict: verdict.verdict,
      criterionId: verdict.criterionId,
      detail: {
        criterionQuote: verdict.criterionQuote,
        evidenceSource: verdict.evidenceSource,
        evidenceQuote: verdict.evidenceQuote,
        reasoning: verdict.reasoning,
      },
    }
  })
  return {
    taskRef: report.taskRef,
    artifact: report.artifact,
    model: report.model,
    globalVerdict: report.globalVerdict,
    counts: countVerdicts(report.verdicts),
    usage: report.usage,
    blocks,
    summarizedPassCount,
    level,
  }
}

/**
 * Cuantos ids PASS caben por linea en la pasada 2. Ocho a ~14 caracteres de id
 * mas separador se queda holgadamente por debajo de las ~110 columnas: agrupar
 * mas ahorraria lineas a costa de una linea que no se lee de un vistazo, y el
 * informe existe justo para leerse de un vistazo.
 */
const GROUPED_PASS_PER_LINE = 8

/**
 * Las lineas de los bloques PASS, segun el nivel.
 *
 * Nivel 1: una linea por criterio. Nivel 2: agrupados. En los DOS aparecen
 * TODOS los ids — la compresion quita saltos de linea, nunca informacion.
 */
function passLines(ids: readonly string[], level: CompactionLevel, bullet: string): string[] {
  if (level < 2) return ids.map((id) => `${bullet} PASS · ${id}`)
  const lines: string[] = []
  for (let i = 0; i < ids.length; i += GROUPED_PASS_PER_LINE) {
    lines.push(`${bullet} PASS · ${ids.slice(i, i + GROUPED_PASS_PER_LINE).join(', ')}`)
  }
  return lines
}

/** Coste de la verificacion, para que no sea un campo que se transporta y nadie ve. */
function usageLine(usage: LlmUsage): string {
  return (
    `Tokens: ${String(usage.inputTokens)} entrada` +
    ` (${String(usage.cacheReadInputTokens)} de cache)` +
    ` · ${String(usage.outputTokens)} salida`
  )
}

// ---------------------------------------------------------------------------
// Formato Markdown
// ---------------------------------------------------------------------------

function countsLine(counts: VerdictCounts): string {
  const total = counts.PASS + counts.FAIL + counts.SIN_EVIDENCIA
  return `PASS: ${String(counts.PASS)} · FAIL: ${String(counts.FAIL)} · SIN_EVIDENCIA: ${String(counts.SIN_EVIDENCIA)} · Total: ${String(total)}`
}

function summaryNote(plan: ReportPlan): string | undefined {
  if (plan.summarizedPassCount === 0) return undefined
  const how =
    plan.level < 2 ? 'se resumieron a una linea' : 'se resumieron y agrupados varios por linea'
  return (
    `_${String(plan.summarizedPassCount)} criterio(s) PASS ${how} para que el informe quepa en ` +
    'pantalla. Estan TODOS por su id; lo que se quita es el razonamiento y las citas de los ' +
    'PASS. Ningun FAIL ni SIN_EVIDENCIA se ha recortado._'
  )
}

/**
 * Emite los bloques en orden, agrupando las rachas consecutivas de PASS
 * resumidos para poder comprimirlas juntas. El ORDEN del informe no cambia: una
 * racha se sustituye por sus propias lineas, en su sitio.
 */
function renderBlocks(
  plan: ReportPlan,
  bullet: string,
  renderDetail: (block: CriterionBlock) => string[],
): string[] {
  const lines: string[] = []
  let run: string[] = []
  const flush = (): void => {
    if (run.length === 0) return
    lines.push(...passLines(run, plan.level, bullet))
    run = []
  }
  for (const block of plan.blocks) {
    if (block.detail === undefined) {
      run.push(block.criterionId)
      continue
    }
    if (run.length > 0) {
      flush()
      lines.push('')
    }
    lines.push(...renderDetail(block))
    lines.push('')
  }
  flush()
  return lines
}

function renderMarkdown(plan: ReportPlan): string {
  const lines: string[] = []
  lines.push(`# Informe de conformidad — ${plan.taskRef}`)
  lines.push('')
  lines.push(`**Veredicto global: ${GLOBAL_VERDICT_LABEL[plan.globalVerdict]}**`)
  lines.push('')
  // El SHA va en la cabecera y no al final: si el informe se queda pegado en un
  // PR al que despues se le empujan commits, lo primero que se ve es SOBRE QUE
  // codigo se emitio este veredicto.
  lines.push(`Commit verificado: \`${plan.artifact.headSha}\` (base \`${plan.artifact.baseSha}\`)`)
  lines.push('')
  lines.push(`Modelo: \`${plan.model}\` · ${countsLine(plan.counts)} · ${usageLine(plan.usage)}`)
  const note = summaryNote(plan)
  if (note !== undefined) {
    lines.push('')
    lines.push(note)
  }
  lines.push('')
  lines.push(
    ...renderBlocks(plan, '-', (block) => [
      `### ${String(block.ordinal)}. ${VERDICT_LABEL[block.verdict]} — ${block.criterionId}`,
      `**Criterio:** "${block.detail?.criterionQuote ?? ''}"`,
      `**Evidencia** (${String(block.detail?.evidenceSource)}): "${block.detail?.evidenceQuote ?? ''}"`,
      `**Razonamiento:** ${block.detail?.reasoning ?? ''}`,
    ]),
  )
  return lines.join('\n').trimEnd()
}

// ---------------------------------------------------------------------------
// Formato texto plano (CLI)
// ---------------------------------------------------------------------------

function renderPlainText(plan: ReportPlan): string {
  const lines: string[] = []
  lines.push(`INFORME DE CONFORMIDAD — ${plan.taskRef}`)
  lines.push('='.repeat(`INFORME DE CONFORMIDAD — ${plan.taskRef}`.length))
  lines.push('')
  lines.push(`VEREDICTO GLOBAL: ${GLOBAL_VERDICT_LABEL[plan.globalVerdict]}`)
  lines.push('')
  lines.push(`Commit verificado: ${plan.artifact.headSha} (base ${plan.artifact.baseSha})`)
  lines.push('')
  lines.push(`Modelo: ${plan.model} | ${countsLine(plan.counts)} | ${usageLine(plan.usage)}`)
  const note = summaryNote(plan)
  if (note !== undefined) {
    lines.push('')
    lines.push(note.replace(/^_|_$/g, ''))
  }
  lines.push('')
  lines.push(
    ...renderBlocks(plan, '-', (block) => [
      `${String(block.ordinal)}. ${VERDICT_LABEL[block.verdict]} — ${block.criterionId}`,
      `   Criterio: "${block.detail?.criterionQuote ?? ''}"`,
      `   Evidencia (${String(block.detail?.evidenceSource)}): "${block.detail?.evidenceQuote ?? ''}"`,
      `   Razonamiento: ${block.detail?.reasoning ?? ''}`,
    ]),
  )
  return lines.join('\n').trimEnd()
}

// ---------------------------------------------------------------------------
// Presupuesto de pantalla y las dos entradas publicas
// ---------------------------------------------------------------------------

function measure(text: string): { lineCount: number; charCount: number } {
  return { lineCount: text.split('\n').length, charCount: text.length }
}

function fitsBudget(text: string, budget: ScreenBudget): boolean {
  const { lineCount, charCount } = measure(text)
  return lineCount <= budget.maxLines && charCount <= budget.maxChars
}

function assertReportIsUsable(report: ConformanceReport): void {
  if (report.verdicts.length === 0) {
    throw new ValidationError(
      `El informe de ${report.taskRef} no trae ni un veredicto. Un informe vacio no es un ` +
        'informe: no hay nada con que decidir.',
    )
  }
}

function renderWithBudget(
  report: ConformanceReport,
  budget: ScreenBudget,
  format: (plan: ReportPlan) => string,
): RenderedConformanceReport {
  assertReportIsUsable(report)

  // Las tres pasadas, de menos a mas compresion. Se devuelve LA PRIMERA que
  // quepa: nunca se comprime mas de lo necesario.
  let last: RenderedConformanceReport | undefined
  for (const level of [0, 1, 2] as const) {
    const plan = buildPlan(report, level)
    const text = format(plan)
    const rendered: RenderedConformanceReport = {
      text,
      ...measure(text),
      fitsOnScreen: fitsBudget(text, budget),
      summarizedPassCount: plan.summarizedPassCount,
      compactionLevel: level,
    }
    if (rendered.fitsOnScreen) return rendered
    last = rendered
  }
  // Ni con la maxima compresion cabe: se devuelve ENTERO y se dice que no cabe.
  // Recortar un FAIL para caber seria la unica forma de mentir aqui.
  if (last === undefined) throw new Error('inalcanzable: el bucle de pasadas siempre asigna `last`')
  return last
}

/** Comentario de PR: se publica con `@coord/github` (ver `report-publisher.ts`). */
export function renderConformanceReportMarkdown(
  report: ConformanceReport,
  budget: ScreenBudget = DEFAULT_SCREEN_BUDGET,
): RenderedConformanceReport {
  return renderWithBudget(report, budget, renderMarkdown)
}

/** Salida de CLI. */
export function renderConformanceReportPlainText(
  report: ConformanceReport,
  budget: ScreenBudget = DEFAULT_SCREEN_BUDGET,
): RenderedConformanceReport {
  return renderWithBudget(report, budget, renderPlainText)
}
