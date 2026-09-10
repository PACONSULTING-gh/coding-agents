import { LlmRefusalError, ValidationError } from '@coord/core'
import { afterEach, describe, expect, it } from 'vitest'

import { AnthropicLlm } from '../src/anthropic.js'
import {
  ROUTER_EFFORT,
  ROUTER_MODEL,
  suggestAssignees,
  taskMessage,
} from '../src/routing/router.js'
import {
  MAX_CANDIDATES,
  MIN_CANDIDATES,
  MIN_ROUTING_REASONING_LENGTH,
  parseRoutingSuggestion,
  type RoutingInput,
} from '../src/routing/shortlist.js'
import {
  startFakeApi,
  streamResponse,
  throwawayApiKey,
  type FakeApi,
} from './support/fake-anthropic-api.js'

/**
 * T02 — el agente de routing. Los cuatro criterios de aceptacion del issue #32.
 *
 * TRES DE LOS CUATRO SE PUEDEN AFIRMAR AQUI: la forma del shortlist, el permiso
 * para decir "sin match", y que la señal que condujo cada puesto se lee sin
 * abrir el codigo. Todos son propiedades del CONTRATO, y por eso se comprueban
 * contra el doble HTTP local (`support/fake-anthropic-api.ts`) y contra la
 * validacion pura.
 *
 * EL CUARTO NO. "Cuando el mas libre no es el mas adecuado, la evidencia pesa
 * mas que la carga" es una afirmacion sobre el JUICIO DEL MODELO, y ningun
 * doble puede sostenerla: el doble responde lo que este fichero le dicte. Se
 * mide aparte, contra el modelo de verdad, igual que la `trap-suite` del
 * Verifier. Que estos tests esten en verde NO dice nada sobre si el router
 * ranquea bien (CLAUDE.md 6).
 */

let api: FakeApi | undefined

afterEach(async () => {
  await api?.close()
  api = undefined
})

async function routerAgainstFake(): Promise<{ llm: AnthropicLlm; fake: FakeApi }> {
  const fake = await startFakeApi()
  api = fake
  return {
    fake,
    llm: new AnthropicLlm({ apiKey: throwawayApiKey(), baseURL: fake.baseUrl, maxRetries: 0 }),
  }
}

/**
 * El caso que da nombre al epic: bruno es el que MENOS carga tiene y el que
 * MENOS sabe del fichero que la tarea toca. Si el ranking se hiciera por carga,
 * bruno seria el primero.
 */
const ENTRADA: RoutingInput = {
  taskRef: '#77',
  taskTitle: 'El reintento de cobro duplica el cargo cuando la pasarela tarda',
  taskBody: 'Reportado por dos clientes. Toca la logica de reintento.',
  files: ['packages/billing/src/retry.ts'],
  candidates: [
    {
      id: 'ana',
      label: 'Ana Ruiz',
      ownership: [{ path: 'packages/billing/src/retry.ts', lines: 412, commits: 9 }],
      workload: 4,
      workloadIsComplete: true,
    },
    {
      id: 'bruno',
      label: 'Bruno Diaz',
      ownership: [],
      workload: 0,
      workloadIsComplete: true,
    },
    {
      id: 'carla',
      label: 'Carla Gil',
      ownership: [{ path: 'packages/billing/src/gateway.ts', lines: 130, commits: 4 }],
      workload: 1,
      workloadIsComplete: true,
    },
  ],
}

const RAZON = 'Escribio la mayor parte de la logica de reintento que esta tarea toca.'

type Crudo = Record<string, unknown>

function shortlistCrudo(candidates: readonly Crudo[]): Crudo {
  return { outcome: 'shortlist', candidates }
}

const ANA: Crudo = {
  candidateId: 'ana',
  reasoning: RAZON,
  evidenceFiles: ['packages/billing/src/retry.ts'],
  leadingSignal: 'ownership',
  rank: 1,
}

const CARLA: Crudo = {
  candidateId: 'carla',
  reasoning: 'Conoce la pasarela contra la que se reintenta, aunque no el reintento en si.',
  evidenceFiles: ['packages/billing/src/gateway.ts'],
  leadingSignal: 'both',
  rank: 2,
}

const DOS_BUENOS: readonly Crudo[] = [ANA, CARLA]

describe('el shortlist que llega del modelo', () => {
  it('acepta un shortlist bien formado y lo devuelve ordenado por puesto', () => {
    // Llegan del reves a proposito: el orden del array no es el ranking.
    const sugerencia = parseRoutingSuggestion(shortlistCrudo([CARLA, ANA]), ENTRADA)

    expect(sugerencia.kind).toBe('shortlist')
    if (sugerencia.kind !== 'shortlist') throw new Error('no era un shortlist')
    expect(sugerencia.entries.map((e) => e.candidateId)).toEqual(['ana', 'carla'])
    expect(sugerencia.entries[0]?.rank).toBe(1)
  })

  it('cada entrada dice QUE SEÑAL condujo su puesto, que es lo que el humano lee', () => {
    const sugerencia = parseRoutingSuggestion(shortlistCrudo(DOS_BUENOS), ENTRADA)
    if (sugerencia.kind !== 'shortlist') throw new Error('no era un shortlist')

    // El criterio de aceptacion: "puedo saber que señal condujo cada posicion
    // sin abrir el codigo". Señal, razon y evidencia, por cada puesto.
    for (const entrada of sugerencia.entries) {
      expect(['ownership', 'workload', 'both']).toContain(entrada.leadingSignal)
      expect(entrada.reasoning.length).toBeGreaterThanOrEqual(MIN_ROUTING_REASONING_LENGTH)
      expect(entrada.evidenceFiles.length).toBeGreaterThan(0)
    }
  })

  it('acepta como evidencia un fichero que solo aparece en las señales, no en la tarea', () => {
    // `gateway.ts` no esta en `files`: viene del ownership de carla. Es
    // evidencia legitima y no puede tratarse como inventada.
    const sugerencia = parseRoutingSuggestion(shortlistCrudo(DOS_BUENOS), ENTRADA)
    if (sugerencia.kind !== 'shortlist') throw new Error('no era un shortlist')
    expect(sugerencia.entries[1]?.evidenceFiles).toEqual(['packages/billing/src/gateway.ts'])
  })

  it('rechaza a una persona que no estaba entre los candidatos', () => {
    const crudo = shortlistCrudo([{ ...ANA, candidateId: 'daniela' }, CARLA])
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(ValidationError)
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(/"daniela"/)
  })

  it('rechaza un fichero de evidencia que no existe en ninguna parte de la entrada', () => {
    // La mentira mas peligrosa: PARECE justificacion.
    const crudo = shortlistCrudo([
      { ...ANA, evidenceFiles: ['packages/billing/src/pagos.ts'] },
      CARLA,
    ])
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(/pagos\.ts/)
  })

  it('rechaza al mismo candidato dos veces', () => {
    const crudo = shortlistCrudo([ANA, { ...ANA, rank: 2 }])
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(/repitio/)
  })

  it('rechaza un razonamiento demasiado corto para poder anularlo con criterio', () => {
    const crudo = shortlistCrudo([{ ...ANA, reasoning: 'Encaja bien.' }, CARLA])
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(ValidationError)
  })

  it('rechaza el mismo puesto dos veces', () => {
    const crudo = shortlistCrudo([ANA, { ...CARLA, rank: 1 }])
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(/puesto 1 dos veces/)
  })

  it('rechaza puestos con huecos: significa que descarto a alguien y no lo dijo', () => {
    const crudo = shortlistCrudo([ANA, { ...CARLA, rank: 5 }])
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(/sin huecos/)
  })

  it(`rechaza menos de ${String(MIN_CANDIDATES)} candidatos: con uno no hay a quien comparar`, () => {
    const crudo = shortlistCrudo([ANA])
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(ValidationError)
  })

  it(`rechaza mas de ${String(MAX_CANDIDATES)} candidatos: deja de ser sugerencia y es el censo`, () => {
    const crudo = shortlistCrudo(
      [1, 2, 3, 4, 5].map((rank) => ({ ...ANA, candidateId: `p${String(rank)}`, rank })),
    )
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(ValidationError)
  })

  it('rechaza una respuesta que no encaja con el esquema pedido', () => {
    expect(() => parseRoutingSuggestion({ outcome: 'quiza' }, ENTRADA)).toThrow(ValidationError)
  })
})

describe('"sin match claro" es una respuesta de primera clase', () => {
  it('acepta no_match cuando viene explicado', () => {
    const razon =
      'Ninguno de los tres ha tocado nunca el modulo de reintento ni nada que dependa de el.'
    const sugerencia = parseRoutingSuggestion(
      { outcome: 'no_match', noMatchReason: razon },
      ENTRADA,
    )

    expect(sugerencia).toEqual({ kind: 'no_match', reason: razon })
  })

  it('rechaza un no_match sin explicacion: quien reparte la tarea la reparte igual', () => {
    expect(() =>
      parseRoutingSuggestion({ outcome: 'no_match', noMatchReason: 'nadie' }, ENTRADA),
    ).toThrow(ValidationError)
    expect(() => parseRoutingSuggestion({ outcome: 'no_match' }, ENTRADA)).toThrow(ValidationError)
  })
})

describe('el mensaje que se le manda al modelo', () => {
  it('presenta a los candidatos por orden alfabetico, no por carga ni por evidencia', () => {
    // Anti-anclaje: presentarlos ya ordenados por una señal convierte el
    // ranking en "confirmar lo que le dimos hecho".
    const alReves: RoutingInput = { ...ENTRADA, candidates: [...ENTRADA.candidates].reverse() }
    expect(taskMessage(alReves).content).toBe(taskMessage(ENTRADA).content)

    const texto = taskMessage(ENTRADA).content
    expect(texto.indexOf('- ana')).toBeLessThan(texto.indexOf('- bruno'))
    expect(texto.indexOf('- bruno')).toBeLessThan(texto.indexOf('- carla'))
  })

  it('dice explicitamente que un candidato no tiene evidencia, en vez de callarlo', () => {
    // Si de bruno no se dijera nada, su ausencia de evidencia se leeria como
    // "no se sabe" en vez de como "no tiene".
    expect(taskMessage(ENTRADA).content).toContain('evidencia: NINGUNA')
  })

  it('marca la carga incompleta para que un 0 no se lea como "esta libre"', () => {
    const conCargaIncompleta: RoutingInput = {
      ...ENTRADA,
      candidates: ENTRADA.candidates.map((c) =>
        c.id === 'bruno' ? { ...c, workloadIsComplete: false } : c,
      ),
    }
    expect(taskMessage(conCargaIncompleta).content).toContain('INCOMPLETA')
  })

  it('dice cuando el grafo no sabe que ficheros toca la tarea', () => {
    const sinFicheros: RoutingInput = { ...ENTRADA, files: [] }
    expect(taskMessage(sinFicheros).content).toContain('ninguno identificado')
  })
})

describe('la peticion que sale por el cable', () => {
  it('pide el orden de razonamiento con la carga DESPUES de la evidencia', async () => {
    const { llm, fake } = await routerAgainstFake()
    fake.reply = streamResponse({ text: JSON.stringify(shortlistCrudo(DOS_BUENOS)) })

    await suggestAssignees(llm, ENTRADA)

    const system = JSON.stringify(fake.requests[0]?.body['system'])
    // El fallo de diseño que el epic entero existe para evitar: si la carga se
    // mirase antes que la evidencia, el router seria un `ORDER BY carga`.
    expect(system.indexOf('evidencia de autoria')).toBeLessThan(
      system.indexOf('SOLO ENTONCES mira la carga'),
    )
    expect(system).toContain('no_match')
  })

  it('va con extended thinking, esfuerzo xhigh, el modelo de produccion y cache del rol', async () => {
    const { llm, fake } = await routerAgainstFake()
    fake.reply = streamResponse({ text: JSON.stringify(shortlistCrudo(DOS_BUENOS)) })

    await suggestAssignees(llm, ENTRADA)

    const body = fake.requests[0]?.body ?? {}
    expect(body['model']).toBe(ROUTER_MODEL)
    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'omitted' })
    expect((body['output_config'] as { effort?: string } | undefined)?.effort).toBe(ROUTER_EFFORT)
    // El rol no cambia entre tareas: es exactamente lo que interesa cachear.
    const system = body['system'] as { cache_control?: unknown }[]
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('una negativa del modelo llega como negativa, NO como "no hay match"', async () => {
    const { llm, fake } = await routerAgainstFake()
    // Es lo que hoy hace claude-opus-5 por la ruta del CLI (issue #27).
    fake.reply = streamResponse({
      stopReason: 'refusal',
      stopDetails: { type: 'refusal', category: 'reasoning_extraction' },
    })

    const error = await suggestAssignees(llm, ENTRADA).catch((caught: unknown) => caught)

    // Confundir "no he podido preguntar" con "no hay nadie que encaje" es la
    // misma clase de mentira que el epic 05 persigue.
    expect(error).toBeInstanceOf(LlmRefusalError)
    expect((error as LlmRefusalError).category).toBe('reasoning_extraction')
  })
})
