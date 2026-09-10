import { describe, expect, it } from 'vitest'

import { ValidationError } from './errors.js'
import {
  decideVerificationFlow,
  DEFAULT_MAX_ATTEMPTS,
  type VerificationFlowInput,
  type VerificationFlowState,
} from './verification-flow.js'

/**
 * La regla de T06, probada sin infraestructura (ADR 0008).
 *
 * Es lo unico que hay que revisar cuando alguien discuta el flujo de fallo, y
 * corre en milisegundos porque la decision no sabe que existen ni la base de
 * datos ni GitHub.
 */

const LIMPIO: VerificationFlowState = { attempts: 0, noEvidenceByCriterion: {} }

function decidir(
  input: Partial<VerificationFlowInput> & { outcome: VerificationFlowInput['outcome'] },
) {
  return decideVerificationFlow({ state: LIMPIO, ...input })
}

describe('un fallo de infraestructura no es trabajo mal hecho', () => {
  it('`verifier_unavailable` escala a un humano SIN gastar intento', () => {
    // La mitad menos obvia del diseno. Si gastara intento, una racha de
    // rechazos del modelo —hoy reales, issue #27— escalaria todas las tareas
    // del dia como si todos los agentes hubieran fallado a la vez.
    const decision = decidir({
      outcome: 'verifier_unavailable',
      state: { attempts: 1, noEvidenceByCriterion: {} },
    })

    expect(decision.destination).toBe('human')
    expect(decision.consumesAttempt).toBe(false)
    expect(decision.attemptsAfter).toBe(1)
    expect(decision.notifiesHuman).toBe(true)
    expect(decision.revokesCriteriaApproval).toBe(false)
    // Y el motivo lo dice, porque quien reciba el aviso tiene que saber que NO
    // esta mirando trabajo mal hecho.
    expect(decision.reason).toContain('No es trabajo mal hecho')
  })

  it('no gasta intento ni cuando ya no quedaban', () => {
    const decision = decidir({
      outcome: 'verifier_unavailable',
      state: { attempts: DEFAULT_MAX_ATTEMPTS, noEvidenceByCriterion: {} },
    })
    expect(decision.attemptsAfter).toBe(DEFAULT_MAX_ATTEMPTS)
    expect(decision.consumesAttempt).toBe(false)
  })
})

describe('lo que si es trabajo mal hecho vuelve al agente, hasta agotar intentos', () => {
  it.each(['gate_failed', 'verifier_fail'] as const)(
    '%s en el primer intento vuelve al mismo agente y no molesta a nadie',
    (outcome) => {
      const decision = decidir({ outcome })

      expect(decision.destination).toBe('same_agent')
      expect(decision.consumesAttempt).toBe(true)
      expect(decision.attemptsAfter).toBe(1)
      // No se avisa a un humano por un fallo que el agente puede arreglar solo.
      expect(decision.notifiesHuman).toBe(false)
    },
  )

  it.each(['gate_failed', 'verifier_fail'] as const)(
    '%s en el segundo intento escala a un humano',
    (outcome) => {
      const decision = decidir({ outcome, state: { attempts: 1, noEvidenceByCriterion: {} } })

      expect(decision.destination).toBe('human')
      expect(decision.attemptsAfter).toBe(2)
      expect(decision.notifiesHuman).toBe(true)
      expect(decision.reason).toContain('2 intentos')
    },
  )

  it('el tope por defecto es 2, no 3', () => {
    // La constante es la decision. Si alguien la sube, se ve en un diff.
    expect(DEFAULT_MAX_ATTEMPTS).toBe(2)
  })

  it('el tope se puede subir por llamada, y entonces se aguanta un intento mas', () => {
    const decision = decidir({
      outcome: 'verifier_fail',
      state: { attempts: 1, noEvidenceByCriterion: {} },
      maxAttempts: 3,
    })
    expect(decision.destination).toBe('same_agent')
  })
})

describe('SIN_EVIDENCIA: la primera vez es del agente, la segunda es del spec', () => {
  it('el primer SIN_EVIDENCIA vuelve al agente: quiza solo no dejo evidencia', () => {
    const decision = decidir({
      outcome: 'verifier_no_evidence',
      noEvidenceCriteria: ['tc01-dead-letter'],
    })

    expect(decision.destination).toBe('same_agent')
    expect(decision.revokesCriteriaApproval).toBe(false)
    expect(decision.noEvidenceByCriterionAfter).toEqual({ 'tc01-dead-letter': 1 })
  })

  it('el segundo sobre el MISMO criterio va a la fase de criterios y revoca la aprobacion', () => {
    // Ya no es que el agente no dejara evidencia: es que el criterio no se
    // puede observar, y eso no lo arregla el agente por mucho que se le insista.
    const decision = decidir({
      outcome: 'verifier_no_evidence',
      state: { attempts: 1, noEvidenceByCriterion: { 'tc01-dead-letter': 1 } },
      noEvidenceCriteria: ['tc01-dead-letter'],
    })

    expect(decision.destination).toBe('criteria_phase')
    expect(decision.revokesCriteriaApproval).toBe(true)
    expect(decision.notifiesHuman).toBe(true)
    expect(decision.noEvidenceByCriterionAfter).toEqual({ 'tc01-dead-letter': 2 })
    expect(decision.reason).toContain('tc01-dead-letter')
  })

  it('dos criterios DISTINTOS con un SIN_EVIDENCIA cada uno NO son un spec ambiguo', () => {
    // Es la razon de que el contador sea por criterio y no por tarea. Contarlo
    // por tarea mandaria esto a la fase de criterios sin que nada lo justifique.
    const decision = decidir({
      outcome: 'verifier_no_evidence',
      state: { attempts: 0, noEvidenceByCriterion: { 'tc01-uno': 1 } },
      noEvidenceCriteria: ['tc02-otro'],
    })

    expect(decision.destination).toBe('same_agent')
    expect(decision.revokesCriteriaApproval).toBe(false)
    expect(decision.noEvidenceByCriterionAfter).toEqual({ 'tc01-uno': 1, 'tc02-otro': 1 })
  })

  it('con intentos agotados pero sin criterio reiterado, escala a un humano', () => {
    const decision = decidir({
      outcome: 'verifier_no_evidence',
      state: { attempts: 1, noEvidenceByCriterion: { 'tc01-uno': 1 } },
      noEvidenceCriteria: ['tc02-otro'],
    })

    expect(decision.destination).toBe('human')
    expect(decision.revokesCriteriaApproval).toBe(false)
  })

  it('un criterio reiterado GANA a los intentos agotados', () => {
    // El orden importa. Escalarlo como "el agente fallo dos veces" seria un
    // diagnostico falso y mandaria a la persona a mirar el sitio equivocado:
    // el defecto esta en un criterio que nadie puede observar.
    const decision = decidir({
      outcome: 'verifier_no_evidence',
      state: { attempts: 1, noEvidenceByCriterion: { 'tc01-imposible': 1 } },
      noEvidenceCriteria: ['tc01-imposible'],
    })

    expect(decision.destination).toBe('criteria_phase')
    expect(decision.revokesCriteriaApproval).toBe(true)
  })
})

describe('apto', () => {
  it('no devuelve nada a nadie ni toca el contador', () => {
    const decision = decidir({
      outcome: 'passed',
      state: { attempts: 1, noEvidenceByCriterion: { 'tc01-uno': 1 } },
    })

    expect(decision.destination).toBe('done')
    expect(decision.consumesAttempt).toBe(false)
    expect(decision.notifiesHuman).toBe(false)
    expect(decision.attemptsAfter).toBe(1)
    expect(decision.noEvidenceByCriterionAfter).toEqual({ 'tc01-uno': 1 })
  })
})

describe('entradas incoherentes: se lanza en vez de decidir sobre basura', () => {
  it('`verifier_no_evidence` sin decir QUE criterios', () => {
    // Tragarselo haria que el contador por criterio no subiera nunca y que un
    // spec ambiguo no se detectara jamas: el fallo mas silencioso posible.
    expect(() => decidir({ outcome: 'verifier_no_evidence' })).toThrow(ValidationError)
    expect(() => decidir({ outcome: 'verifier_no_evidence', noEvidenceCriteria: [] })).toThrow(
      /no se detecta nunca/,
    )
  })

  it.each([0, -1, 1.5])('un tope de %s intentos', (maxAttempts) => {
    expect(() => decidir({ outcome: 'verifier_fail', maxAttempts })).toThrow(ValidationError)
  })

  it.each([-1, 0.5])('un contador de intentos de %s', (attempts) => {
    expect(() =>
      decidir({ outcome: 'verifier_fail', state: { attempts, noEvidenceByCriterion: {} } }),
    ).toThrow(ValidationError)
  })
})

describe('lo que cada modo consume y lo que NO toca', () => {
  it.each([
    ['gate_failed', true],
    ['verifier_fail', true],
    ['verifier_unavailable', false],
  ] as const)('%s consume intento: %s', (outcome, consume) => {
    // Que un modo gaste o no gaste el presupuesto del agente es LA decision de
    // este flujo, y hasta ahora solo se comprobaba mirando `attemptsAfter`.
    expect(decidir({ outcome }).consumesAttempt).toBe(consume)
  })

  it('SIN_EVIDENCIA consume intento, tanto si vuelve al agente como si va a criterios', () => {
    expect(
      decidir({ outcome: 'verifier_no_evidence', noEvidenceCriteria: ['tc01'] }).consumesAttempt,
    ).toBe(true)
    expect(
      decidir({
        outcome: 'verifier_no_evidence',
        state: { attempts: 1, noEvidenceByCriterion: { tc01: 1 } },
        noEvidenceCriteria: ['tc01'],
      }).consumesAttempt,
    ).toBe(true)
  })

  it.each(['passed', 'gate_failed', 'verifier_fail', 'verifier_unavailable'] as const)(
    '%s NUNCA revoca la aprobacion de criterios',
    (outcome) => {
      // Si esto se invirtiera, un simple fallo de lint devolveria la tarea a la
      // fase de criterios y obligaria a un humano a re-aprobar un spec que
      // estaba perfectamente bien. Solo un SIN_EVIDENCIA reiterado revoca.
      expect(decidir({ outcome }).revokesCriteriaApproval).toBe(false)
    },
  )
})

describe('el motivo dice CUAL de los dos fallos fue', () => {
  it('distingue el gate determinista del FAIL del Verifier', () => {
    // No es cosmetico: quien lo lee tiene que saber si mirar el log del build o
    // el informe de conformidad. Son dos sitios distintos.
    expect(decidir({ outcome: 'gate_failed' }).reason).toContain('El gate determinista fallo')
    expect(decidir({ outcome: 'verifier_fail' }).reason).toContain(
      'El Verifier encontro al menos un criterio en FAIL',
    )
  })

  it('no confunde un fallo con la falta de evidencia', () => {
    expect(decidir({ outcome: 'gate_failed' }).reason).not.toContain('sin evidencia')
    expect(
      decidir({ outcome: 'verifier_no_evidence', noEvidenceCriteria: ['tc01'] }).reason,
    ).toContain('sin evidencia')
  })
})

describe('el tope de intentos, en su borde', () => {
  it('un tope de 1 es valido: hay proyectos sin segunda oportunidad', () => {
    // El limite es `>= 1`, no `> 1`. Con un solo intento, el primer fallo ya
    // escala — que es una politica legitima, no una entrada invalida.
    const decision = decidir({ outcome: 'verifier_fail', maxAttempts: 1 })

    expect(decision.destination).toBe('human')
    expect(decision.attemptsAfter).toBe(1)
  })
})

describe('cuando varios criterios se repiten a la vez', () => {
  it('nombra siempre el mismo, no uno al azar', () => {
    // El orden de `Object.entries` depende de como se construyo el objeto. Sin
    // un criterio de desempate, dos ejecuciones sobre el mismo estado podrian
    // culpar a criterios distintos, y el aviso dejaria de ser reproducible.
    const decision = decideVerificationFlow({
      outcome: 'verifier_no_evidence',
      state: { attempts: 1, noEvidenceByCriterion: { 'tc09-zeta': 1, 'tc02-alfa': 1 } },
      noEvidenceCriteria: ['tc09-zeta', 'tc02-alfa'],
    })

    expect(decision.destination).toBe('criteria_phase')
    expect(decision.reason).toContain('tc02-alfa')
    expect(decision.reason).not.toContain('tc09-zeta')
  })
})
