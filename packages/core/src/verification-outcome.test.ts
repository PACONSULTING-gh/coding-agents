import { describe, expect, it } from 'vitest'

import { ValidationError } from './errors.js'
import {
  classifyVerificationPass,
  type ClassifiableVerdict,
  type CriterionVerdictValue,
} from './verification-outcome.js'

/**
 * De lo que paso en una pasada a cual de los cuatro modos del ADR 0008 es.
 *
 * Aqui se fija DONDE cae cada situacion, que es donde una equivocacion no se
 * ve: clasificar mal no rompe ningun test de otro sitio, solo manda la tarea al
 * destino equivocado y le gasta un intento a quien no lo merece.
 */

function veredictos(...valores: CriterionVerdictValue[]): ClassifiableVerdict[] {
  return valores.map((verdict, i) => ({ criterionId: `tc0${String(i + 1)}`, verdict }))
}

describe('el gate manda, y corta antes de gastar una llamada', () => {
  it('un gate fallado es `gate_failed` y arrastra el motivo', () => {
    const clasificacion = classifyVerificationPass({
      gate: 'failed',
      detail: 'el manifiesto declara 3 tests y el arbol tiene 2',
    })

    expect(clasificacion.outcome).toBe('gate_failed')
    expect(clasificacion.reason).toContain('el manifiesto declara 3 tests')
    expect(clasificacion.noEvidenceCriteria).toEqual([])
  })
})

describe('cuando el Verifier no llega a opinar', () => {
  it('`unavailable` NO es un no: es que no hubo veredicto', () => {
    // La diferencia decide si se le gasta un intento al agente. Confundirlas
    // escalaria trabajo sano con un diagnostico falso.
    const clasificacion = classifyVerificationPass({
      gate: 'passed',
      verifier: { kind: 'unavailable', detail: 'el modelo se nego (reasoning_extraction)' },
    })

    expect(clasificacion.outcome).toBe('verifier_unavailable')
    expect(clasificacion.reason).toContain('reasoning_extraction')
    // Y no ensucia el contador por criterio. Nada se ha observado en esta
    // pasada, asi que nada tiene que apuntarse.
    expect(clasificacion.noEvidenceCriteria).toEqual([])
  })
})

describe('con veredictos delante', () => {
  it('todos PASS es `passed`, y no apunta ningun criterio', () => {
    // Lo segundo no es adorno: el contador por criterio es persistente. Un id
    // colado en una pasada BUENA haria que el siguiente SIN_EVIDENCIA sobre ese
    // criterio contara como el segundo y revocara una aprobacion humana.
    const clasificacion = classifyVerificationPass({
      gate: 'passed',
      verifier: { kind: 'verdicts', verdicts: veredictos('PASS', 'PASS') },
    })

    expect(clasificacion.outcome).toBe('passed')
    expect(clasificacion.noEvidenceCriteria).toEqual([])
  })

  it('un solo FAIL basta para `verifier_fail`', () => {
    expect(
      classifyVerificationPass({
        gate: 'passed',
        verifier: { kind: 'verdicts', verdicts: veredictos('PASS', 'FAIL', 'PASS') },
      }).outcome,
    ).toBe('verifier_fail')
  })

  it('sin FAIL pero con SIN_EVIDENCIA es `verifier_no_evidence`, y dice cuales', () => {
    const clasificacion = classifyVerificationPass({
      gate: 'passed',
      verifier: { kind: 'verdicts', verdicts: veredictos('PASS', 'SIN_EVIDENCIA') },
    })

    expect(clasificacion.outcome).toBe('verifier_no_evidence')
    expect(clasificacion.noEvidenceCriteria).toEqual(['tc02'])
  })

  it('FAIL GANA a SIN_EVIDENCIA cuando hay de los dos', () => {
    // Hay al menos un defecto CITADO, y eso el agente lo puede arreglar.
    // Mandar la tarea a la fase de criterios culparia al spec de un fallo del
    // codigo — y encima revocaria una aprobacion humana por el camino.
    const clasificacion = classifyVerificationPass({
      gate: 'passed',
      verifier: { kind: 'verdicts', verdicts: veredictos('SIN_EVIDENCIA', 'FAIL') },
    })

    expect(clasificacion.outcome).toBe('verifier_fail')
    // Y NO se apunta el SIN_EVIDENCIA: contarlo haria que dos rondas con FAIL
    // acabaran revocando los criterios sin que ninguno se repitiera solo.
    expect(clasificacion.noEvidenceCriteria).toEqual([])
  })

  it('un criterio repetido NO cuenta dos veces', () => {
    // El contador es por criterio y es lo que dispara la vuelta a la fase de
    // criterios. Un id duplicado lo dispararia sin que nada se repitiera de
    // verdad entre pasadas.
    const clasificacion = classifyVerificationPass({
      gate: 'passed',
      verifier: {
        kind: 'verdicts',
        verdicts: [
          { criterionId: 'tc01', verdict: 'SIN_EVIDENCIA' },
          { criterionId: 'tc01', verdict: 'SIN_EVIDENCIA' },
        ],
      },
    })

    expect(clasificacion.noEvidenceCriteria).toEqual(['tc01'])
  })
})

describe('cero veredictos NO es "todo bien"', () => {
  it('lanza en vez de aprobar', () => {
    // Con el gate en verde y cero veredictos, clasificarlo como `passed`
    // dejaria pasar cualquier cambio: es el unico desenlace que el epic 05
    // entero existe para impedir. Es un fallo del instrumento.
    expect(() =>
      classifyVerificationPass({ gate: 'passed', verifier: { kind: 'verdicts', verdicts: [] } }),
    ).toThrow(ValidationError)
  })

  it('y el mensaje explica por que no se aprueba', () => {
    expect(() =>
      classifyVerificationPass({ gate: 'passed', verifier: { kind: 'verdicts', verdicts: [] } }),
    ).toThrow(/no ha mirado nada/)
  })
})

describe('el motivo se lee sin abrir el codigo', () => {
  it('dice cuantos de cuantos incumplen', () => {
    const clasificacion = classifyVerificationPass({
      gate: 'passed',
      verifier: { kind: 'verdicts', verdicts: veredictos('FAIL', 'FAIL', 'PASS') },
    })
    expect(clasificacion.reason).toContain('2 de 3')
  })

  it('nombra los criterios sin evidencia', () => {
    const clasificacion = classifyVerificationPass({
      gate: 'passed',
      verifier: { kind: 'verdicts', verdicts: veredictos('SIN_EVIDENCIA', 'SIN_EVIDENCIA') },
    })
    expect(clasificacion.reason).toContain('tc01, tc02')
    expect(clasificacion.reason).toContain('2 de 2')
  })

  it('al aprobar, dice cuantos criterios se miraron', () => {
    const clasificacion = classifyVerificationPass({
      gate: 'passed',
      verifier: { kind: 'verdicts', verdicts: veredictos('PASS', 'PASS', 'PASS') },
    })
    expect(clasificacion.reason).toContain('3 criterios')
  })
})
