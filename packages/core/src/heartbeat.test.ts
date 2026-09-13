import { describe, expect, it } from 'vitest'

import { ValidationError } from './errors.js'
import {
  agentLiveness,
  classifyAgentActivity,
  MISSING_AFTER_MS,
  NUDGE_AFTER_IDLE_MS,
  STALE_AFTER_MS,
  STUCK_REPEAT_THRESHOLD,
  type AgentTelemetry,
} from './heartbeat.js'

/**
 * El estado de un agente sin mirar su terminal (epic 04).
 *
 * Dos cosas separadas y las dos faciles de estropear sin que se note:
 * cuanto hace del ultimo latido, y que esta haciendo. La primera decide si la
 * vista de equipo se llena de falsos muertos; la segunda, si alguien recibe un
 * empujon que no necesita o se queda atascado sin que nadie se entere.
 */

const AHORA = new Date('2026-09-13T12:00:00Z')

function haceMs(ms: number): Date {
  return new Date(AHORA.getTime() - ms)
}

describe('cuanto hace del ultimo latido', () => {
  it('recien latido es fresco', () => {
    expect(agentLiveness(haceMs(1_000), AHORA)).toBe('fresh')
  })

  it('un portatil suspendido media hora figura OBSOLETO, no muerto', () => {
    // Es el tercer criterio de aceptacion de T01, y el motivo de que existan
    // tres estados y no dos: colapsar `stale` en `missing` llenaria la vista de
    // falsos muertos cada vez que alguien cierra la tapa, y a la tercera vez
    // nadie se creeria ninguno.
    expect(agentLiveness(haceMs(STALE_AFTER_MS + 1), AHORA)).toBe('stale')
  })

  it('justo en el umbral ya es obsoleto', () => {
    // El borde importa: con `>` en vez de `>=` habria un instante en el que el
    // agente se considera fresco habiendo agotado el margen entero.
    expect(agentLiveness(haceMs(STALE_AFTER_MS), AHORA)).toBe('stale')
  })

  it('un milisegundo antes, todavia fresco', () => {
    expect(agentLiveness(haceMs(STALE_AFTER_MS - 1), AHORA)).toBe('fresh')
  })

  it('pasado el segundo umbral ya no se espera mas', () => {
    expect(agentLiveness(haceMs(MISSING_AFTER_MS), AHORA)).toBe('missing')
  })

  it('y justo antes sigue siendo obsoleto', () => {
    expect(agentLiveness(haceMs(MISSING_AFTER_MS - 1), AHORA)).toBe('stale')
  })

  it('un latido EXACTAMENTE de ahora es fresco, no un error', () => {
    // El borde del reloj: `silencio === 0` es lo que pasa cuando el latido y la
    // consulta caen en el mismo milisegundo. Con `<= 0` en vez de `< 0` eso
    // lanzaria, y un agente que acaba de latir daria error.
    expect(agentLiveness(AHORA, AHORA)).toBe('fresh')
  })

  it('un latido del FUTURO sale como `clock_skew`, no como fresco', () => {
    // Darlo por fresco esconderia un agente atascado detras de una fecha que
    // nunca envejece: el silencio saldria negativo y no cruzaria ningun umbral.
    expect(agentLiveness(new Date(AHORA.getTime() + 1), AHORA)).toBe('clock_skew')
  })

  it('y NO lanza, porque un reloj roto no puede tumbar la vista entera', () => {
    // Lo descubrio un test de integracion: con `agentLiveness` lanzando, un
    // solo agente con la hora mal reventaba la lectura de TODA la vista de
    // equipo. Lo que miras cuando algo va mal es lo que dejaba de funcionar.
    expect(() => agentLiveness(new Date(AHORA.getTime() + 86_400_000), AHORA)).not.toThrow()
  })

  it('los umbrales se pueden ajustar por llamada', () => {
    expect(agentLiveness(haceMs(5_000), AHORA, { staleAfterMs: 1_000 })).toBe('stale')
  })

  it.each([
    ['umbrales iguales', { staleAfterMs: 1_000, missingAfterMs: 1_000 }],
    ['el segundo por debajo del primero', { staleAfterMs: 5_000, missingAfterMs: 1_000 }],
    ['un umbral de cero', { staleAfterMs: 0 }],
  ])('%s se rechaza', (_caso, thresholds) => {
    // Con los dos umbrales iguales NO existiria el estado "obsoleto", y un
    // portatil suspendido saltaria directo a "no sabemos nada de el".
    expect(() => agentLiveness(haceMs(1), AHORA, thresholds)).toThrow(ValidationError)
  })
})

function telemetria(overrides: Partial<AgentTelemetry> = {}): AgentTelemetry {
  return {
    repeatedToolCalls: 0,
    finished: false,
    consecutiveFailures: 0,
    securityEvent: false,
    lastFileChangeAt: haceMs(1_000),
    ...overrides,
  }
}

function clasificar(overrides: Partial<AgentTelemetry> = {}) {
  return classifyAgentActivity({ telemetry: telemetria(overrides), now: AHORA })
}

describe('que esta haciendo el agente', () => {
  it('avanzando con normalidad', () => {
    expect(clasificar().activity).toBe('fine')
  })

  it('la misma llamada repetida N veces es ATASCADO, y es una CUENTA', () => {
    // "Definiciones operativas, no interpretaciones": esto no necesita un
    // modelo, y por eso el coste por invocacion es cero.
    const decision = clasificar({
      repeatedToolCalls: STUCK_REPEAT_THRESHOLD,
      lastToolCall: 'Bash(pnpm test)',
    })

    expect(decision.activity).toBe('stuck')
    expect(decision.reason).toContain('Bash(pnpm test)')
    expect(decision.queuesNudge).toBe(true)
  })

  it('una repeticion por debajo del umbral NO es atascado', () => {
    expect(clasificar({ repeatedToolCalls: STUCK_REPEAT_THRESHOLD - 1 }).activity).toBe('fine')
  })

  it('ATASCADO gana a la inactividad, porque un bucle parece actividad', () => {
    // Un agente en bucle hace llamadas sin parar, asi que por inactividad no
    // saltaria NUNCA. Si el orden fuera el contrario, los bucles serian
    // invisibles justo cuando mas queman.
    const decision = clasificar({
      repeatedToolCalls: STUCK_REPEAT_THRESHOLD,
      lastFileChangeAt: haceMs(NUDGE_AFTER_IDLE_MS * 2),
    })

    expect(decision.activity).toBe('stuck')
  })

  it('sin tocar un fichero en mucho rato, merece un empujon', () => {
    const decision = clasificar({ lastFileChangeAt: haceMs(NUDGE_AFTER_IDLE_MS) })
    expect(decision.activity).toBe('needs_nudge')
    expect(decision.queuesNudge).toBe(true)
  })

  it('un agente que acaba de empezar NO es un agente atascado', () => {
    // Sin ningun fichero tocado todavia. Marcarlo por inactividad haria saltar
    // un aviso en cada arranque, y un aviso que salta siempre deja de leerse.
    const sinFicheros: AgentTelemetry = {
      repeatedToolCalls: 0,
      finished: false,
      consecutiveFailures: 0,
      securityEvent: false,
    }
    const decision = classifyAgentActivity({ telemetry: sinFicheros, now: AHORA })
    expect(decision.activity).toBe('fine')
  })

  it('terminado es terminado, y no encola ningun empujon', () => {
    // Empujar a quien ya ha acabado es la clase de aviso que enseña al equipo a
    // ignorar los avisos.
    const decision = clasificar({ finished: true })
    expect(decision.activity).toBe('done')
    expect(decision.queuesNudge).toBe(false)
  })

  it('justo por debajo del margen de inactividad, todavia va bien', () => {
    expect(clasificar({ lastFileChangeAt: haceMs(NUDGE_AFTER_IDLE_MS - 1) }).activity).toBe('fine')
  })
})

describe('lo que escala a una persona', () => {
  it('un evento de seguridad, por encima incluso de "he terminado"', () => {
    // Un agente que intento algo que no debia Y ADEMAS dice que acabo es el
    // caso que menos conviene dejar pasar por bueno.
    const decision = clasificar({ securityEvent: true, finished: true })

    expect(decision.activity).toBe('escalate')
    expect(decision.queuesNudge).toBe(false)
  })

  it('fallar siempre igual no lo arregla un empujon', () => {
    const decision = clasificar({ consecutiveFailures: STUCK_REPEAT_THRESHOLD })
    expect(decision.activity).toBe('escalate')
    expect(decision.queuesNudge).toBe(false)
  })

  it('un fallo suelto no escala', () => {
    expect(clasificar({ consecutiveFailures: 1 }).activity).toBe('fine')
  })

  it('escalar gana a atascado', () => {
    const decision = clasificar({
      consecutiveFailures: STUCK_REPEAT_THRESHOLD,
      repeatedToolCalls: STUCK_REPEAT_THRESHOLD,
    })
    expect(decision.activity).toBe('escalate')
  })
})

describe('configuracion incoherente', () => {
  it.each([0, 1, -2, 2.5])('un umbral de repeticion de %s se rechaza', (stuckRepeatThreshold) => {
    // Con 1, la primera vez que un agente llama dos veces a la misma
    // herramienta —que es lo normal— quedaria marcado como atascado.
    expect(() =>
      classifyAgentActivity({ telemetry: telemetria(), now: AHORA, stuckRepeatThreshold }),
    ).toThrow(ValidationError)
  })

  it.each([0, -1, 1.5])('un margen de inactividad de %s se rechaza', (nudgeAfterIdleMs) => {
    expect(() =>
      classifyAgentActivity({ telemetry: telemetria(), now: AHORA, nudgeAfterIdleMs }),
    ).toThrow(ValidationError)
  })

  it('un umbral de repeticion de 2 es valido: es el minimo que significa algo', () => {
    expect(() =>
      classifyAgentActivity({ telemetry: telemetria(), now: AHORA, stuckRepeatThreshold: 2 }),
    ).not.toThrow()
  })
})
