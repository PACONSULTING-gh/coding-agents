import { ValidationError } from '@coord/core'
import { describe, expect, it } from 'vitest'

import {
  BASE_INTERVAL_MS,
  decideNextBeat,
  MAX_BACKOFF_MS,
  type BeatScheduleInput,
} from '../src/beat-schedule.js'

/**
 * Cuando toca el siguiente latido (epic 04 / T02).
 *
 * Lo que se fija aqui es la distincion que decide si el daemon es util o un
 * estorbo: SIN RED hay que seguir intentandolo, y CON EL TOKEN RECHAZADO hay
 * que parar. Las dos se ven igual desde fuera —no hay latido— y significan lo
 * contrario.
 */

function decidir(overrides: Partial<BeatScheduleInput> = {}) {
  return decideNextBeat({
    outcome: { kind: 'ok' },
    consecutiveFailures: 0,
    // Jitter fijo: el test no puede depender del azar.
    jitter: 0,
    ...overrides,
  })
}

describe('cuando todo va bien', () => {
  it('se late al ritmo normal y el contador de fallos se pone a cero', () => {
    const plan = decidir({ consecutiveFailures: 5 })
    expect(plan.waitMs).toBe(BASE_INTERVAL_MS)
    expect(plan.consecutiveFailures).toBe(0)
    expect(plan.stop).toBe(false)
  })
})

describe('sin red: seguir intentandolo', () => {
  it('el primer fallo espera el intervalo normal', () => {
    const plan = decidir({ outcome: { kind: 'unreachable', detail: 'ENOTFOUND' } })
    expect(plan.waitMs).toBe(BASE_INTERVAL_MS)
    expect(plan.consecutiveFailures).toBe(1)
    expect(plan.stop).toBe(false)
  })

  it('la espera crece con cada fallo', () => {
    const segundo = decidir({
      outcome: { kind: 'unreachable', detail: 'x' },
      consecutiveFailures: 1,
    })
    const tercero = decidir({
      outcome: { kind: 'unreachable', detail: 'x' },
      consecutiveFailures: 2,
    })

    expect(segundo.waitMs).toBe(BASE_INTERVAL_MS * 2)
    expect(tercero.waitMs).toBe(BASE_INTERVAL_MS * 4)
  })

  it('pero nunca pasa del tope', () => {
    const plan = decidir({
      outcome: { kind: 'unreachable', detail: 'x' },
      consecutiveFailures: 20,
    })
    expect(plan.waitMs).toBe(MAX_BACKOFF_MS)
  })

  it('un dia entero sin red no desborda a Infinity', () => {
    // Sin acotar el exponente ANTES de elevar, 2^2880 sale Infinity — y como
    // espera, eso es un daemon que no vuelve nunca. Un portatil apagado el fin
    // de semana llega aqui sin esfuerzo.
    const plan = decidir({
      outcome: { kind: 'unreachable', detail: 'x' },
      consecutiveFailures: 2_880,
    })
    expect(Number.isFinite(plan.waitMs)).toBe(true)
    expect(plan.waitMs).toBe(MAX_BACKOFF_MS)
  })

  it('el jitter reparte hacia ABAJO, nunca por encima del tope', () => {
    // Cinco daemons que pierden la red a la vez —los del banco de pruebas— con
    // una espera identica vuelven en bloque y tumban el hub justo cuando se
    // levanta. Restando se reparten. Y sumando se pasaria del tope.
    const conJitter = decidir({
      outcome: { kind: 'unreachable', detail: 'x' },
      consecutiveFailures: 20,
      jitter: 0.9,
    })

    expect(conJitter.waitMs).toBeLessThan(MAX_BACKOFF_MS)
    expect(conJitter.waitMs).toBeGreaterThanOrEqual(BASE_INTERVAL_MS)
  })

  it('el jitter nunca baja del intervalo normal', () => {
    // Repartir no puede convertirse en machacar: por debajo del ritmo normal,
    // fallar saldria mas rapido que ir bien.
    for (const jitter of [0, 0.3, 0.99]) {
      const plan = decidir({
        outcome: { kind: 'unreachable', detail: 'x' },
        consecutiveFailures: 1,
        jitter,
      })
      expect(plan.waitMs).toBeGreaterThanOrEqual(BASE_INTERVAL_MS)
    }
  })
})

describe('token rechazado: parar y decirlo', () => {
  it('no se reintenta, y el motivo explica que hacer', () => {
    // El hub SI se entero y dijo que no. Reintentar es ruido: no va a cambiar
    // de opinion, y latir para siempre contra un 401 llena dos logs con algo
    // que nadie va a arreglar mirando.
    const plan = decidir({ outcome: { kind: 'rejected', detail: '401 unauthorized' } })

    expect(plan.stop).toBe(true)
    expect(plan.waitMs).toBeUndefined()
    expect(plan.reason).toContain('PARA')
    expect(plan.reason).toContain('Da de alta el agente otra vez')
  })

  it('parar gana aunque se venga de una racha de fallos de red', () => {
    const plan = decidir({
      outcome: { kind: 'rejected', detail: '401' },
      consecutiveFailures: 7,
    })
    expect(plan.stop).toBe(true)
  })
})

describe('configuracion incoherente', () => {
  it.each([0, 999, -1, 1_500.5])('un intervalo de %s se rechaza', (baseIntervalMs) => {
    // Latir mas de una vez por segundo no da mas informacion y si molesta a la
    // persona que esta trabajando en esa maquina.
    expect(() => decidir({ baseIntervalMs })).toThrow(ValidationError)
  })

  it('un tope por debajo del intervalo se rechaza', () => {
    // Haria que fallar saliera MAS rapido que ir bien.
    expect(() => decidir({ baseIntervalMs: 60_000, maxBackoffMs: 30_000 })).toThrow(ValidationError)
  })

  it('un tope IGUAL al intervalo es valido: es "no crezcas"', () => {
    expect(() => decidir({ baseIntervalMs: 60_000, maxBackoffMs: 60_000 })).not.toThrow()
  })

  it.each([-0.1, 1, 1.5])('un jitter de %s se rechaza', (jitter) => {
    expect(() => decidir({ jitter })).toThrow(ValidationError)
  })

  it.each([-1, 1.5])('un contador de fallos de %s se rechaza', (consecutiveFailures) => {
    expect(() => decidir({ consecutiveFailures })).toThrow(ValidationError)
  })
})
