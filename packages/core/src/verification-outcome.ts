import { ValidationError } from './errors.js'
import type { VerificationOutcome } from './verification-flow.js'

/**
 * De QUE PASO en una pasada de verificacion a CUAL de los cuatro modos del ADR
 * 0008 es. La otra mitad —que hacer con ese modo— es `decideVerificationFlow`.
 *
 * Estan separadas a proposito. Clasificar es mirar hechos de esta pasada;
 * decidir es mirar el historial de la tarea. Juntarlas obligaria a tener el
 * estado de la tarea delante para poder decir "el Verifier no contesto", que
 * es una afirmacion sobre esta pasada y sobre nada mas.
 *
 * ===========================================================================
 * POR QUE VIVE EN core Y NO EN agents
 * ===========================================================================
 * Porque el resultado de clasificar alimenta a la capa de datos y al worker, y
 * ninguno de los dos puede depender de `packages/agents`. Lo que entra aqui es
 * la forma MINIMA que hace falta para clasificar —un veredicto por criterio— y
 * no el `VerificationResult` entero, que lleva citas, consumo y modelo: cosas
 * que a esta decision no le incumben.
 */

/**
 * El veredicto de un criterio.
 *
 * Vive aqui y no en el Verifier porque es vocabulario del dominio: lo emite
 * `packages/agents`, lo clasifica esto y lo persiste `packages/db`. El Verifier
 * lo reexporta para que nada de dentro de `agents` tenga que cambiar.
 *
 * `SIN_EVIDENCIA` no es un tercer sabor de "casi": significa que el criterio no
 * se puede observar en el artefacto. Aprobar exige que TODOS sean `PASS`,
 * porque "no lo se" no es "si" (CLAUDE.md 2.1).
 */
export const CRITERION_VERDICTS = ['PASS', 'FAIL', 'SIN_EVIDENCIA'] as const
export type CriterionVerdictValue = (typeof CRITERION_VERDICTS)[number]

/** Lo minimo que hace falta de un veredicto para clasificar la pasada. */
export interface ClassifiableVerdict {
  readonly criterionId: string
  readonly verdict: CriterionVerdictValue
}

/**
 * Que hizo el Verifier.
 *
 * `unavailable` NO es "dijo que no": es que no llego a emitir veredicto —se
 * nego, se cayo la red, la respuesta no valido—. La diferencia decide si la
 * tarea le gasta un intento al agente, y confundirlas escalaria trabajo sano
 * con un diagnostico falso (ADR 0008, decision 1).
 */
export type VerifierOutcome =
  | { readonly kind: 'verdicts'; readonly verdicts: readonly ClassifiableVerdict[] }
  | { readonly kind: 'unavailable'; readonly detail: string }

/**
 * Los hechos de UNA pasada.
 *
 * Es un union discriminado y no un objeto con campos opcionales para que sea
 * IMPOSIBLE representar "el gate fallo, y aqui van los veredictos": si el gate
 * falla no se llama al Verifier, asi que ese estado no existe y el tipo no
 * deberia admitirlo.
 */
export type VerificationPassFacts =
  | { readonly gate: 'failed'; readonly detail: string }
  | { readonly gate: 'passed'; readonly verifier: VerifierOutcome }

export interface ClassifiedVerification {
  readonly outcome: VerificationOutcome
  /**
   * Criterios que salieron `SIN_EVIDENCIA`, sin repetidos.
   *
   * Alimenta el contador POR CRITERIO del flujo, que es lo que distingue "dos
   * criterios flojos" de "un criterio imposible de observar". Un id repetido
   * contaria doble y dispararia la vuelta a la fase de criterios sin que nada
   * se hubiera repetido de verdad.
   */
  readonly noEvidenceCriteria: readonly string[]
  /** Por que, en una frase. Acaba en el `audit_log` y en el aviso al humano. */
  readonly reason: string
}

function contar(verdicts: readonly ClassifiableVerdict[], valor: CriterionVerdictValue): number {
  return verdicts.filter((v) => v.verdict === valor).length
}

export function classifyVerificationPass(facts: VerificationPassFacts): ClassifiedVerification {
  if (facts.gate === 'failed') {
    // Ni se le pregunta al Verifier: sin gate no hay informe que juzgar, y
    // gastar una llamada cara para que diga lo que el gate ya dijo es tirar
    // dinero y tiempo.
    return {
      outcome: 'gate_failed',
      noEvidenceCriteria: [],
      reason: `El gate determinista fallo: ${facts.detail}`,
    }
  }

  if (facts.verifier.kind === 'unavailable') {
    return {
      outcome: 'verifier_unavailable',
      noEvidenceCriteria: [],
      reason: `El Verifier no pudo emitir veredicto: ${facts.verifier.detail}`,
    }
  }

  const { verdicts } = facts.verifier

  if (verdicts.length === 0) {
    // NO se clasifica como `passed`. Cero veredictos con el gate en verde
    // aprobaria cualquier cosa, que es el unico desenlace que este epic entero
    // existe para impedir. Es un fallo del instrumento y se reporta como tal.
    throw new ValidationError(
      'El Verifier devolvio CERO veredictos con el gate en verde. Eso no es "todo bien": es una ' +
        'verificacion que no ha mirado nada, y clasificarla como aprobada dejaria pasar ' +
        'cualquier cambio. Revisa por que la respuesta vino vacia.',
    )
  }

  const fallos = contar(verdicts, 'FAIL')
  if (fallos > 0) {
    // FAIL gana a SIN_EVIDENCIA aunque haya de los dos: hay al menos un defecto
    // CITADO, y eso el agente lo puede arreglar. Mandar la tarea a la fase de
    // criterios por un SIN_EVIDENCIA que venia acompañado de un FAIL culparia
    // al spec de un fallo del codigo.
    return {
      outcome: 'verifier_fail',
      noEvidenceCriteria: [],
      reason:
        `El Verifier encontro ${String(fallos)} de ${String(verdicts.length)} criterios ` +
        'incumplidos, con cita.',
    }
  }

  const sinEvidencia = [
    ...new Set(verdicts.filter((v) => v.verdict === 'SIN_EVIDENCIA').map((v) => v.criterionId)),
  ]
  if (sinEvidencia.length > 0) {
    return {
      outcome: 'verifier_no_evidence',
      noEvidenceCriteria: sinEvidencia,
      reason:
        `El Verifier no encontro evidencia de ${String(sinEvidencia.length)} de ` +
        `${String(verdicts.length)} criterios (${sinEvidencia.join(', ')}). No es un fallo ` +
        'citado: el criterio no se puede observar en el artefacto.',
    }
  }

  return {
    outcome: 'passed',
    noEvidenceCriteria: [],
    reason: `Los ${String(verdicts.length)} criterios pasan, con cita del criterio y de la evidencia.`,
  }
}
