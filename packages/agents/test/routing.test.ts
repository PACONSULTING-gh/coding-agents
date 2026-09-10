import { LlmRefusalError, ValidationError } from '@coord/core'
import { afterEach, describe, expect, it } from 'vitest'

import { AnthropicLlm } from '../src/anthropic.js'
import {
  ROUTER_EFFORT,
  ROUTER_MODEL,
  ROUTING_OUTPUT_SCHEMA,
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

/**
 * Cinco candidatos DE VERDAD, para poder probar el limite de tamaño del
 * shortlist sin que salte antes otra comprobacion.
 *
 * Existe porque el mutation testing encontro que no: la primera version de esos
 * dos tests inventaba ids (`p1`..`p5`) que no estaban entre los candidatos, asi
 * que pasaban por la comprobacion de "persona inventada" y NO por la del
 * tamaño. Verdes los dos, y ninguno probaba lo que decia su nombre.
 */
const ENTRADA_ANCHA: RoutingInput = {
  ...ENTRADA,
  candidates: ['ana', 'bruno', 'carla', 'diego', 'elena'].map((id) => ({
    id,
    label: id,
    ownership: [{ path: 'packages/billing/src/retry.ts', lines: 100, commits: 2 }],
    workload: 1,
    workloadIsComplete: true,
  })),
}

/** Un shortlist de `cuantos` candidatos de `ENTRADA_ANCHA`, bien formado. */
function shortlistDe(cuantos: number): Crudo {
  return shortlistCrudo(
    ENTRADA_ANCHA.candidates.slice(0, cuantos).map((candidato, indice) => ({
      candidateId: candidato.id,
      reasoning: RAZON,
      evidenceFiles: ['packages/billing/src/retry.ts'],
      leadingSignal: 'ownership',
      rank: indice + 1,
    })),
  )
}

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

  it('rechaza una entrada que no cita ningun fichero', () => {
    // El otro lado de la evidencia inventada: si no citas nada, no hay nada que
    // comprobar. La entrada llega sin la clave siquiera.
    const crudo = shortlistCrudo([{ ...ANA, evidenceFiles: undefined }, CARLA])
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(/sin citar ningun fichero/)
  })

  it('normaliza los espacios de lo que llega, en vez de rechazarlo por un espacio', () => {
    // Un id o una ruta con espacios de mas es un descuido de formato, no una
    // mentira: rechazarlo seria tirar una respuesta correcta por la sangria.
    const crudo = shortlistCrudo([
      { ...ANA, candidateId: '  ana  ', evidenceFiles: ['  packages/billing/src/retry.ts  '] },
      CARLA,
    ])
    const sugerencia = parseRoutingSuggestion(crudo, ENTRADA)
    if (sugerencia.kind !== 'shortlist') throw new Error('no era un shortlist')
    expect(sugerencia.entries[0]?.candidateId).toBe('ana')
  })

  it('no vuelca el error entero de zod en el mensaje', () => {
    // Este mensaje acaba en un log y puede acabar en un comentario de PR. El
    // error de zod sobre veinte entradas rotas ocupa miles de caracteres.
    const roto = shortlistCrudo(Array.from({ length: 20 }, () => ({ candidateId: 42 })))
    const error = (() => {
      try {
        parseRoutingSuggestion(roto, ENTRADA)
      } catch (caught: unknown) {
        return caught as Error
      }
      throw new Error('deberia haber lanzado')
    })()
    expect(error.message.length).toBeLessThan(400)
  })

  it('rechaza al mismo candidato dos veces', () => {
    const crudo = shortlistCrudo([ANA, { ...ANA, rank: 2 }])
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(/repitio/)
  })

  it('rechaza un razonamiento demasiado corto para poder anularlo con criterio', () => {
    const crudo = shortlistCrudo([{ ...ANA, reasoning: 'Encaja bien.' }, CARLA])
    // El mensaje dice cuanto trajo y cuanto hace falta: un error que no dice
    // eso obliga a abrir el codigo para entenderlo.
    expect(() => parseRoutingSuggestion(crudo, ENTRADA)).toThrow(/tiene 12 caracteres/)
  })

  it('acepta un razonamiento de exactamente el minimo, y rechaza el de uno menos', () => {
    const justo = 'x'.repeat(MIN_ROUTING_REASONING_LENGTH)
    expect(() =>
      parseRoutingSuggestion(shortlistCrudo([{ ...ANA, reasoning: justo }, CARLA]), ENTRADA),
    ).not.toThrow()
    expect(() =>
      parseRoutingSuggestion(
        shortlistCrudo([{ ...ANA, reasoning: justo.slice(1) }, CARLA]),
        ENTRADA,
      ),
    ).toThrow(ValidationError)
  })

  it('el relleno no cuenta como razonamiento, y no se guarda', () => {
    // Un razonamiento de dos palabras con doscientos espacios detras pasa un
    // `length` ingenuo. Se mide lo que hay, no lo que ocupa.
    const relleno = `Encaja.${' '.repeat(200)}`
    expect(() =>
      parseRoutingSuggestion(shortlistCrudo([{ ...ANA, reasoning: relleno }, CARLA]), ENTRADA),
    ).toThrow(ValidationError)

    const conBordes = `  ${'x'.repeat(MIN_ROUTING_REASONING_LENGTH)}  `
    const sugerencia = parseRoutingSuggestion(
      shortlistCrudo([{ ...ANA, reasoning: conBordes }, CARLA]),
      ENTRADA,
    )
    if (sugerencia.kind !== 'shortlist') throw new Error('no era un shortlist')
    expect(sugerencia.entries[0]?.reasoning).toBe(conBordes.trim())
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
    expect(() => parseRoutingSuggestion(shortlistDe(1), ENTRADA_ANCHA)).toThrow(/devolvio 1/)
  })

  it(`rechaza mas de ${String(MAX_CANDIDATES)} candidatos: deja de ser sugerencia y es el censo`, () => {
    expect(() => parseRoutingSuggestion(shortlistDe(5), ENTRADA_ANCHA)).toThrow(/devolvio 5/)
  })

  it.each([MIN_CANDIDATES, MAX_CANDIDATES])('acepta exactamente %i candidatos', (cuantos) => {
    // Los dos extremos, que son justo donde una comparacion mal puesta —`<=` en
    // vez de `<`— dejaria de verse.
    const sugerencia = parseRoutingSuggestion(shortlistDe(cuantos), ENTRADA_ANCHA)
    expect(sugerencia.kind).toBe('shortlist')
  })

  it('rechaza una respuesta que no encaja con el esquema pedido', () => {
    expect(() => parseRoutingSuggestion({ outcome: 'quiza' }, ENTRADA)).toThrow(
      /no encaja con el esquema pedido/,
    )
  })
})

describe('el esquema que se le pide al modelo', () => {
  const item = ((ROUTING_OUTPUT_SCHEMA['properties'] as Record<string, Record<string, unknown>>)[
    'candidates'
  ]?.['items'] ?? {}) as Record<string, unknown>

  it('pide el puesto EL ULTIMO, despues del razonamiento y la evidencia', () => {
    // No es cosmetico: el orden de las claves es el orden de generacion. Si el
    // puesto se generase primero, el razonamiento seria una justificacion a
    // posteriori de una decision ya tomada. Mismo criterio que en el Verifier.
    const required = item['required'] as readonly string[]
    expect(required.at(-1)).toBe('rank')
    expect(required.indexOf('reasoning')).toBeLessThan(required.indexOf('rank'))
    expect(required.indexOf('evidenceFiles')).toBeLessThan(required.indexOf('rank'))
  })

  it('exige el resultado y no admite claves de mas', () => {
    expect(ROUTING_OUTPUT_SCHEMA['required']).toEqual(['outcome'])
    // Sin esto, un campo inventado por el modelo entraria sin que nadie lo mire.
    expect(ROUTING_OUTPUT_SCHEMA['additionalProperties']).toBe(false)
    expect(item['additionalProperties']).toBe(false)
  })

  it('ofrece no_match como una de las dos salidas posibles', () => {
    const outcome = (
      ROUTING_OUTPUT_SCHEMA['properties'] as Record<string, Record<string, unknown>>
    )['outcome']
    expect(outcome?.['enum']).toEqual(['shortlist', 'no_match'])
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

  it('acepta un no_match de exactamente el minimo, y rechaza el de uno menos', () => {
    const justo = 'y'.repeat(MIN_ROUTING_REASONING_LENGTH)
    expect(parseRoutingSuggestion({ outcome: 'no_match', noMatchReason: justo }, ENTRADA)).toEqual({
      kind: 'no_match',
      reason: justo,
    })
    expect(() =>
      parseRoutingSuggestion({ outcome: 'no_match', noMatchReason: justo.slice(1) }, ENTRADA),
    ).toThrow(ValidationError)
  })

  it('el relleno tampoco cuenta como explicacion de un no_match', () => {
    expect(() =>
      parseRoutingSuggestion(
        { outcome: 'no_match', noMatchReason: `Nadie.${' '.repeat(200)}` },
        ENTRADA,
      ),
    ).toThrow(ValidationError)
  })

  it('rechaza un no_match sin explicacion: quien reparte la tarea la reparte igual', () => {
    expect(() =>
      parseRoutingSuggestion({ outcome: 'no_match', noMatchReason: 'nadie' }, ENTRADA),
    ).toThrow(new RegExp(`minimo ${String(MIN_ROUTING_REASONING_LENGTH)} caracteres`))
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

  it('cada evidencia lleva su ruta, sus lineas y sus commits', () => {
    // Sin las tres cosas el modelo no puede distinguir a quien escribio el
    // fichero de quien lo visito: es la diferencia entre los casos 01 y 02 del
    // banco.
    expect(taskMessage(ENTRADA).content).toContain(
      'packages/billing/src/retry.ts — 412 lineas en 9 commit(s)',
    )
  })

  it('ordena la evidencia de cada candidato por lineas, de mas a menos', () => {
    const conDos: RoutingInput = {
      ...ENTRADA,
      candidates: ENTRADA.candidates.map((c) =>
        c.id === 'ana'
          ? {
              ...c,
              ownership: [
                { path: 'packages/billing/src/poco.ts', lines: 5, commits: 1 },
                ...c.ownership,
              ],
            }
          : c,
      ),
    }
    const texto = taskMessage(conDos).content
    expect(texto.indexOf('retry.ts — 412')).toBeLessThan(texto.indexOf('poco.ts — 5'))
  })

  it('lleva el cuerpo del issue cuando lo hay, y no inventa nada cuando no', () => {
    expect(taskMessage(ENTRADA).content).toContain('Reportado por dos clientes')

    const sinCuerpo: RoutingInput = {
      taskRef: ENTRADA.taskRef,
      taskTitle: ENTRADA.taskTitle,
      files: ENTRADA.files,
      candidates: ENTRADA.candidates,
    }
    expect(taskMessage(sinCuerpo).content).toContain(ENTRADA.taskTitle)
    expect(taskMessage(sinCuerpo).content).not.toContain('Reportado')
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
