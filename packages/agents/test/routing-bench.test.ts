import { LlmRefusalError, ValidationError, type LlmPort, type LlmResult } from '@coord/core'
import { describe, expect, it } from 'vitest'

import {
  runRoutingBench,
  formatRoutingBenchReport,
  type RoutingBenchCase,
} from '../src/routing/bench.js'
import type { RoutingCandidate, RoutingInput } from '../src/routing/shortlist.js'

import { ROUTING_BENCH_CASES } from './fixtures/routing/index.js'

/**
 * El banco de routing: que el INSTRUMENTO cuenta bien, y que los casos no se
 * pueden ganar haciendo trampa.
 *
 * NINGUNO DE ESTOS TESTS DICE NADA SOBRE LO BIEN QUE RANQUEA UN MODELO. Aqui no
 * hay modelo: los `LlmPort` de este fichero son ESTRATEGIAS ESCRITAS A MANO,
 * routers degenerados que juegan una regla fija. Estan para demostrar que el
 * banco los suspende, que es la unica forma de saber que la cifra que salga
 * cuando se corra contra Claude significa algo.
 *
 * (No son mocks de nada que no controlemos: `LlmPort` es nuestro. Lo que no se
 * dobla nunca es el proveedor — eso va contra el doble HTTP de `routing.test.ts`.)
 */

// ---------------------------------------------------------------------------
// Routers degenerados
// ---------------------------------------------------------------------------

/** Suma de lineas de autoria de un candidato, mire donde mire. */
function lineasTotales(candidate: RoutingCandidate): number {
  return candidate.ownership.reduce((total, o) => total + o.lines, 0)
}

function resultado(structured: unknown): LlmResult {
  return {
    text: '',
    structured,
    reasoningSummary: undefined,
    stopReason: 'end_turn',
    model: 'router-de-mentira',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
    },
  }
}

/**
 * Un `LlmPort` que responde segun una estrategia fija, sabiendo de antemano por
 * que caso va. El banco los recorre en orden, asi que basta con un contador: no
 * hay que adivinar el caso a partir del prompt.
 */
function estrategia(
  cases: readonly RoutingBenchCase[],
  decidir: (benchCase: RoutingBenchCase) => unknown,
): LlmPort {
  let siguiente = 0
  return {
    complete: (): Promise<LlmResult> => {
      const benchCase = cases[siguiente]
      siguiente += 1
      if (benchCase === undefined) throw new Error('el banco pidio mas casos de los que hay')
      return Promise.resolve(resultado(decidir(benchCase)))
    },
  }
}

/** El shortlist que acierta el caso, con la señal que se le diga. */
function acierto(benchCase: RoutingBenchCase, signal: string): unknown {
  if (benchCase.kind === 'sin_match') {
    return {
      outcome: 'no_match',
      noMatchReason:
        'Nadie de la lista tiene autoria sobre ninguno de los ficheros que esta tarea toca.',
    }
  }
  const candidates = benchCase.input.candidates
  const primero = candidates.find((c) => c.id === benchCase.expectedTop)
  if (primero === undefined) throw new Error(`el caso ${benchCase.id} no trae a su esperado`)
  return shortlistDe(
    [primero, ...candidates.filter((c) => c !== primero)],
    signal,
    benchCase.input.files,
  )
}

const RAZON = 'Razonamiento de relleno, suficientemente largo para pasar el minimo exigido.'

function shortlistDe(
  ordenados: readonly RoutingCandidate[],
  signal: string,
  ficheros: readonly string[],
): unknown {
  return {
    outcome: 'shortlist',
    candidates: ordenados.slice(0, 2).map((candidate, indice) => ({
      candidateId: candidate.id,
      reasoning: RAZON,
      // Si no tiene autoria en ningun sitio, cita el fichero de la tarea: no es
      // evidencia, pero es lo que citaria un router que rellena. La validacion
      // lo dejara pasar y el banco lo puntuara como lo que es, un fallo de
      // ranking — que es distinto de una respuesta que no valida.
      evidenceFiles:
        candidate.ownership.length > 0
          ? candidate.ownership.map((o) => o.path)
          : [...ficheros].slice(0, 1),
      leadingSignal: signal,
      rank: indice + 1,
    })),
  }
}

/** "ORDER BY lineas DESC". Ni mira la tarea. */
function porLineas(cases: readonly RoutingBenchCase[]): LlmPort {
  return estrategia(cases, ({ input }) =>
    shortlistDe(
      [...input.candidates].sort((a, b) => lineasTotales(b) - lineasTotales(a)),
      'ownership',
      input.files,
    ),
  )
}

/** "ORDER BY carga ASC". El atajo que da nombre al epic. */
function porCarga(cases: readonly RoutingBenchCase[]): LlmPort {
  return estrategia(cases, ({ input }) =>
    shortlistDe(
      [...input.candidates].sort((a, b) => a.workload - b.workload),
      'workload',
      input.files,
    ),
  )
}

/** El que nunca se moja. */
function siempreNoMatch(cases: readonly RoutingBenchCase[]): LlmPort {
  return estrategia(cases, () => ({
    outcome: 'no_match',
    noMatchReason: 'No me consta que nadie tenga evidencia suficiente sobre lo que la tarea toca.',
  }))
}

// ---------------------------------------------------------------------------

describe('el banco suspende a los routers degenerados', () => {
  it('el que ordena por lineas acierta todos los atajos y falla todo lo demas', async () => {
    // Este es EL argumento por el que el banco devuelve tres tasas y no una:
    // con solo la de atajo, este router puntuaria perfecto siendo inutil.
    const report = await runRoutingBench(porLineas(ROUTING_BENCH_CASES), ROUTING_BENCH_CASES)

    expect(report.loadShortcutRate).toBe(0)
    expect(report.tieBreakMissRate).toBe(1)
    expect(report.fillerRate).toBe(1)
    expect(report.invalidResponses).toBe(0)
  })

  it('el que ordena por carga es justo el fallo que el epic existe para evitar', async () => {
    const report = await runRoutingBench(porCarga(ROUTING_BENCH_CASES), ROUTING_BENCH_CASES)

    expect(report.loadShortcutRate).toBe(1)
    expect(report.fillerRate).toBe(1)
    // Ranquea mal, pero devuelve shortlists validos: equivocarse de persona y
    // contestar una guarrada son fallos distintos y no se mezclan.
    expect(report.invalidResponses).toBe(0)
  })

  it('el que nunca sugiere a nadie no comete relleno, y no sirve para nada', async () => {
    const report = await runRoutingBench(siempreNoMatch(ROUTING_BENCH_CASES), ROUTING_BENCH_CASES)

    expect(report.fillerRate).toBe(0)
    expect(report.loadShortcutRate).toBe(1)
    expect(report.tieBreakMissRate).toBe(1)
  })

  it('una respuesta que no valida se anota y el banco sigue, en vez de morirse', async () => {
    // Abortar ahi tiraria las llamadas ya pagadas de los casos anteriores por
    // un fallo que es justo lo que se quiere contar.
    const llm = estrategia(ROUTING_BENCH_CASES, () => ({
      outcome: 'shortlist',
      candidates: [
        {
          candidateId: 'fantasma',
          reasoning: RAZON,
          evidenceFiles: [],
          leadingSignal: 'ownership',
          rank: 1,
        },
      ],
    }))

    const report = await runRoutingBench(llm, ROUTING_BENCH_CASES)

    expect(report.invalidResponses).toBe(ROUTING_BENCH_CASES.length)
    expect(report.cases.every((outcome) => outcome.correct)).toBe(false)
    // No se reparte entre las tasas: no hubo ranking que valorar.
    expect(report.loadShortcutRate).toBe(0)
    expect(report.cases[0]?.invalidReason).toContain('candidatos')
  })

  it('una negativa del modelo SI mata la medida: no es una respuesta', async () => {
    // Un caso que no se ha podido preguntar no es un dato, y meterlo en el
    // denominador seria inventarse la cifra.
    const llm: LlmPort = {
      complete: () => Promise.reject(new LlmRefusalError({ category: 'reasoning_extraction' })),
    }

    await expect(runRoutingBench(llm, ROUTING_BENCH_CASES)).rejects.toBeInstanceOf(LlmRefusalError)
  })
})

describe('el banco cuenta lo que dice contar', () => {
  it('un router que acierta todo sale con las tres tasas a cero', async () => {
    const perfecto = estrategia(ROUTING_BENCH_CASES, (benchCase) =>
      acierto(benchCase, benchCase.expectedSignal ?? 'ownership'),
    )

    const report = await runRoutingBench(perfecto, ROUTING_BENCH_CASES)

    expect(report.loadShortcutRate).toBe(0)
    expect(report.tieBreakMissRate).toBe(0)
    expect(report.fillerRate).toBe(0)
    expect(report.signalMismatches).toBe(0)
    expect(report.cases.every((outcome) => outcome.correct)).toBe(true)
  })

  it('acertar la persona declarando la señal que no la explica se cuenta aparte', async () => {
    // Ranquear bien y contar mal el motivo no es acertar: el criterio de
    // aceptacion dice que el humano tiene que poder saber que señal condujo
    // cada puesto, y si esa señal es falsa, lo que lee es falso.
    // Acierta a todo el mundo, pero declara siempre 'ownership' — incluidos
    // los dos desempates, que los decide la carga.
    const llm = estrategia(ROUTING_BENCH_CASES, (benchCase) => acierto(benchCase, 'ownership'))

    const report = await runRoutingBench(llm, ROUTING_BENCH_CASES)

    const desempates = ROUTING_BENCH_CASES.filter((c) => c.kind === 'desempate').length
    expect(report.signalMismatches).toBe(desempates)
    // Y sigue acertando a la persona: son dos fallos distintos y se cuentan aparte.
    expect(report.cases.every((outcome) => outcome.correct)).toBe(true)
  })

  it('suma el consumo de todas las llamadas: medir cuesta dinero y hay que verlo', async () => {
    const report = await runRoutingBench(porLineas(ROUTING_BENCH_CASES), ROUTING_BENCH_CASES)

    expect(report.usage.inputTokens).toBe(10 * ROUTING_BENCH_CASES.length)
    expect(report.usage.outputTokens).toBe(5 * ROUTING_BENCH_CASES.length)
    // Los del cache tambien: son los que dicen si el bloque estatico del prompt
    // se esta reutilizando, que es de donde sale casi todo el ahorro.
    expect(report.usage.cacheReadInputTokens).toBe(3 * ROUTING_BENCH_CASES.length)
    expect(report.usage.cacheCreationInputTokens).toBe(2 * ROUTING_BENCH_CASES.length)
  })

  it('el informe imprime las tasas en tanto por ciento, no en crudo', async () => {
    const report = await runRoutingBench(porCarga(ROUTING_BENCH_CASES), ROUTING_BENCH_CASES)

    expect(formatRoutingBenchReport(report)).toContain('Atajo de carga:      100.0%')
  })

  it('no se inventa un desacuerdo de señal cuando el caso no dice cual esperaba', async () => {
    const sinSeñal: readonly RoutingBenchCase[] = ROUTING_BENCH_CASES.map((c) => {
      if (c.kind === 'sin_match' || c.expectedTop === undefined) return c
      // Se quita `expectedSignal` y se deja el resto: el caso sigue diciendo a
      // quien espera, pero no que señal deberia explicarlo.
      return { id: c.id, title: c.title, kind: c.kind, input: c.input, expectedTop: c.expectedTop }
    })
    const llm = estrategia(sinSeñal, (benchCase) => acierto(benchCase, 'workload'))

    const report = await runRoutingBench(llm, sinSeñal)

    expect(report.signalMismatches).toBe(0)
  })

  it('el informe empieza diciendo contra que modelo se midio', async () => {
    const report = await runRoutingBench(porLineas(ROUTING_BENCH_CASES), ROUTING_BENCH_CASES)

    // Sin ese dato la cifra no es informacion, es ruido.
    expect(formatRoutingBenchReport(report).split('\n')[0]).toContain('router-de-mentira')
  })
})

describe('el banco se niega a medir con casos que no miden', () => {
  const soloDeUnTipo = (kind: RoutingBenchCase['kind']): readonly RoutingBenchCase[] =>
    ROUTING_BENCH_CASES.filter((c) => c.kind === kind)

  it('se niega con un banco vacio', async () => {
    await expect(runRoutingBench(porLineas([]), [])).rejects.toThrow(/esta vacio/)
  })

  it.each(['atajo', 'desempate', 'sin_match'] as const)(
    'se niega si solo hay casos de tipo %s, y dice cual falta',
    async (kind) => {
      const casos = soloDeUnTipo(kind)
      const error: unknown = await runRoutingBench(porLineas(casos), casos).catch(
        (caught: unknown) => caught,
      )
      expect(error).toBeInstanceOf(ValidationError)
      if (!(error instanceof ValidationError)) throw new Error('deberia haber lanzado')
      // Que diga QUE tipo falta, y no solo que falta algo: es la diferencia
      // entre un error accionable y uno que obliga a abrir el codigo.
      const faltan = ['atajo', 'desempate', 'sin_match'].filter((otro) => otro !== kind)
      expect(faltan.some((otro) => error.message.includes(`"${otro}"`))).toBe(true)
      expect(error.message).not.toContain(`"${kind}"`)
    },
  )

  it('se niega si un caso no trae candidatos suficientes para contestarlo bien', async () => {
    const roto: readonly RoutingBenchCase[] = ROUTING_BENCH_CASES.map((c) =>
      c.kind === 'atajo'
        ? { ...c, input: { ...c.input, candidates: c.input.candidates.slice(0, 1) } }
        : c,
    )
    await expect(runRoutingBench(porLineas(roto), roto)).rejects.toThrow(/candidato\(s\)/)
  })

  it('se niega si un caso no dice a quien espera primero', async () => {
    const roto: readonly RoutingBenchCase[] = ROUTING_BENCH_CASES.map((c) =>
      c.kind === 'atajo' ? { id: c.id, title: c.title, kind: c.kind, input: c.input } : c,
    )
    await expect(runRoutingBench(porLineas(roto), roto)).rejects.toThrow(/no dice a quien espera/)
  })

  it('se niega si un caso espera a alguien que no esta entre sus candidatos', async () => {
    const roto = ROUTING_BENCH_CASES.map((c) =>
      c.kind === 'atajo' ? { ...c, expectedTop: 'fantasma' } : c,
    )
    await expect(runRoutingBench(porLineas(roto), roto)).rejects.toThrow(/"fantasma"/)
  })

  it('se niega si un caso "sin_match" ademas dice a quien espera', async () => {
    const roto = ROUTING_BENCH_CASES.map((c) =>
      c.kind === 'sin_match' ? { ...c, expectedTop: 'nuria' } : c,
    )
    await expect(runRoutingBench(porLineas(roto), roto)).rejects.toThrow(
      /ademas dice a quien espera/,
    )
  })

  it('se niega si dos casos tienen el mismo id', async () => {
    const primero = ROUTING_BENCH_CASES[0]
    if (primero === undefined) throw new Error('el banco esta vacio')
    const roto = [...ROUTING_BENCH_CASES, primero]
    await expect(runRoutingBench(porLineas(roto), roto)).rejects.toThrow(/el mismo id/)
  })
})

describe('los casos son los que dicen ser', () => {
  const lineasEnLosFicherosDeLaTarea = (candidate: RoutingCandidate, input: RoutingInput): number =>
    candidate.ownership
      .filter((o) => input.files.includes(o.path))
      .reduce((total, o) => total + o.lines, 0)

  it.each(ROUTING_BENCH_CASES.filter((c) => c.kind === 'atajo'))(
    'en el caso atajo $id el esperado NO es el mas libre',
    ({ input, expectedTop }) => {
      // Si lo fuera, el caso lo acertaria un `ORDER BY carga` y no estaria
      // midiendo nada.
      const cargaMinima = Math.min(...input.candidates.map((c) => c.workload))
      const esperado = input.candidates.find((c) => c.id === expectedTop)
      expect(esperado?.workload).toBeGreaterThan(cargaMinima)
    },
  )

  it.each(ROUTING_BENCH_CASES.filter((c) => c.kind === 'desempate'))(
    'en el caso desempate $id el esperado NO es el de mas evidencia',
    ({ input, expectedTop }) => {
      // Si lo fuera, el caso lo acertaria un `ORDER BY lineas` y no estaria
      // midiendo el desempate.
      const maximo = Math.max(
        ...input.candidates.map((c) => lineasEnLosFicherosDeLaTarea(c, input)),
      )
      const esperado = input.candidates.find((c) => c.id === expectedTop)
      expect(lineasEnLosFicherosDeLaTarea(esperado as RoutingCandidate, input)).toBeLessThan(maximo)
    },
  )

  it.each(ROUTING_BENCH_CASES.filter((c) => c.kind === 'sin_match'))(
    'en el caso sin_match $id nadie tiene autoria sobre lo que la tarea toca',
    ({ input }) => {
      // Si alguien la tuviera, "sin match" no seria la respuesta correcta y el
      // caso estaria penalizando al modelo por acertar.
      for (const candidate of input.candidates) {
        expect(lineasEnLosFicherosDeLaTarea(candidate, input)).toBe(0)
      }
    },
  )
})
