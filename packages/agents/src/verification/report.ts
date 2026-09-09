import type { LlmUsage } from '@coord/core'

import {
  allCriteriaPass,
  CRITERION_VERDICTS,
  type CriterionVerdict,
  type CriterionVerdictValue,
  type VerificationResult,
  type VerifiedArtifact,
} from './verifier.js'

/**
 * T05 — el informe de conformidad (epic 05).
 *
 * ===========================================================================
 * ESTE FICHERO ES LA SALIDA QUE SUSTITUYE AL DIFF
 * ===========================================================================
 * Si esto no genera confianza real, el epic entero no sirve: se convierte en
 * otra notificacion que se aprueba sin leer, que es EXACTAMENTE el riesgo que
 * nombra el PRD. Por eso este modulo no inventa nada nuevo sobre lo que dijo
 * el Verifier (T04, `verifier.ts`): lo REEMPAQUETA para que un humano pueda
 * decidir, y nada mas.
 *
 * ===========================================================================
 * EL VEREDICTO GLOBAL ES BINARIO, Y LA REGLA ES `allCriteriaPass`
 * ===========================================================================
 * El epic pide "apto / no apto", nunca una puntuacion del 1 al 10: una
 * puntuacion invita a negociar consigo mismo ("un 7 esta bien, ¿no?"); un
 * binario obliga a decidir. La regla es "un solo FAIL o SIN_EVIDENCIA hace el
 * conjunto no apto" — que es exactamente lo que ya calcula `allCriteriaPass`
 * de `verifier.ts` (CLAUDE.md 2.4, peldaño 2: ya esta en el repo, se reutiliza,
 * no se reimplementa la regla dos veces con el riesgo de que un dia diverjan).
 *
 * ===========================================================================
 * "CABE EN UNA PANTALLA" SE MIDE, NO SE AFIRMA
 * ===========================================================================
 * Ver `report-render.ts`: el limite esta expresado en lineas y caracteres
 * concretos (`DEFAULT_SCREEN_BUDGET`), y hay un test que lo comprueba
 * renderizando, no leyendo el codigo y confiando en que "parece corto".
 * Cuando no cabe, se trunca por lo que menos importa: los PASS se resumen a
 * una linea, los FAIL y SIN_EVIDENCIA nunca pierden ni una palabra.
 *
 * ===========================================================================
 * LO QUE ESTE FICHERO NO PUEDE GARANTIZAR
 * ===========================================================================
 * El primer criterio de aceptacion de T05 dice "dado un PR verificado, cuando
 * el humano abre el informe, entonces puede decidir sin abrir el diff". Eso es
 * una propiedad de LA PERSONA que lee el informe, no del codigo: ningun test
 * puede demostrar que un humano concreto decidio bien. Lo que si se puede
 * garantizar, y se comprueba con test, es que el informe contiene TODO lo que
 * hace falta para decidir — cada criterio con su cita de evidencia, y los
 * SIN_EVIDENCIA destacados igual que los FAIL — y que ese contenido no se
 * pierde entre el veredicto del Verifier y el informe (`buildConformanceReport`
 * copia los veredictos tal cual, campo a campo, sin resumir ni reescribir).
 * Este criterio necesita ademas VALIDACION CON EL LEAD REAL DEL PILOTO, tal y
 * como reconoce el propio epic en "Huecos conocidos": eso no se automatiza
 * aqui.
 */

export const GLOBAL_VERDICTS = ['apto', 'no_apto'] as const
export type GlobalVerdict = (typeof GLOBAL_VERDICTS)[number]

/**
 * El informe de conformidad de una tarea.
 *
 * Deliberadamente NO tiene un campo de puntuacion ni de porcentaje: el epic
 * prohibe la escala 1-10, y un campo "score" que nadie usa hoy es la clase de
 * hueco por el que se cuela una manana ("total 8.7/10, apruebo").
 */
export interface ConformanceReport {
  readonly taskRef: string
  /**
   * SOBRE QUE CODIGO se emitio este veredicto.
   *
   * Sin esto, un comentario "APTO" en un PR no dice a que diff se refiere, y
   * sigue teniendo el mismo aspecto de vigente despues de que alguien empuje
   * tres commits mas. Cuando el humano decide SIN abrir el diff, ese es
   * exactamente el fallo que importa: confiar en un veredicto que puede
   * referirse a otro codigo. Se renderiza en la cabecera del informe, no se
   * transporta y se olvida.
   */
  readonly artifact: VerifiedArtifact
  /** Modelo que emitio el veredicto, tal como lo declaro el proveedor (T04). */
  readonly model: string
  readonly globalVerdict: GlobalVerdict
  /** Un veredicto por criterio, EN EL MISMO ORDEN Y CON LOS MISMOS CAMPOS que devolvio el Verifier. */
  readonly verdicts: readonly CriterionVerdict[]
  /** Coste de la verificacion. Se RENDERIZA en la cabecera: si no, seria un campo muerto. */
  readonly usage: LlmUsage
}

/**
 * Cuenta de veredictos por tipo. Se expone aparte porque el encabezado del
 * informe (los dos renderizados de `report-render.ts`) y varios tests la
 * necesitan, y una cuenta que cada uno recalculara a su manera es la forma
 * tipica en que dos sitios acaban diciendo numeros distintos.
 */
export type VerdictCounts = Readonly<Record<CriterionVerdictValue, number>>

export function countVerdicts(verdicts: readonly CriterionVerdict[]): VerdictCounts {
  const counts: Record<CriterionVerdictValue, number> = {
    PASS: 0,
    FAIL: 0,
    SIN_EVIDENCIA: 0,
  }
  for (const verdict of verdicts) {
    counts[verdict.verdict] += 1
  }
  // Se recorre `CRITERION_VERDICTS` en vez de `Object.keys` para que el orden
  // del objeto devuelto sea siempre el mismo, y con el `as const` del import
  // ademas queda documentado en un solo sitio cuales son los tres veredictos
  // posibles: si algun dia se añade un cuarto, esto no compila hasta que se
  // actualice aqui tambien.
  const ordered: Record<CriterionVerdictValue, number> = {} as Record<CriterionVerdictValue, number>
  for (const verdict of CRITERION_VERDICTS) {
    ordered[verdict] = counts[verdict]
  }
  return ordered
}

/**
 * Construye el informe a partir del veredicto del Verifier.
 *
 * No valida nada: `VerificationResult` ya salio de `verifyChanges`, que es
 * quien comprueba las citas contra el diff y la salida de tests. Revalidar
 * aqui seria desconfiar de la unica capa que tiene autoridad para decidirlo, y
 * el resultado real seria dos sitios con la misma logica que un dia divergen.
 */
export function buildConformanceReport(result: VerificationResult): ConformanceReport {
  return {
    taskRef: result.taskRef,
    artifact: result.artifact,
    model: result.model,
    globalVerdict: allCriteriaPass(result) ? 'apto' : 'no_apto',
    verdicts: result.verdicts,
    usage: result.usage,
  }
}
