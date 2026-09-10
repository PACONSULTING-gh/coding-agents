import { ValidationError } from '@coord/core'
import { z } from 'zod'

/**
 * El shortlist de routing (epic 03 / T02): la forma de la sugerencia y su
 * validacion.
 *
 * Puro y sin LLM a proposito. Lo que vive aqui es LA DEFENSA QUE NO DEPENDE DEL
 * MODELO, igual que la comprobacion de citas del Verifier (T04 del epic 05):
 * la salida de un modelo es texto en una frontera de confianza, y "el esquema
 * tiene un campo llamado evidencia" no garantiza que la evidencia exista.
 *
 * ===========================================================================
 * LAS TRES MENTIRAS QUE UN ROUTER PUEDE CONTAR, Y COMO SE CAZAN AQUI
 * ===========================================================================
 * 1. INVENTARSE A UNA PERSONA. Sugerir a alguien que no estaba entre los
 *    candidatos. Se comprueba contra la lista que se le dio: si el id no
 *    estaba, se rechaza el shortlist entero.
 * 2. INVENTARSE LA EVIDENCIA. Citar `src/pagos.ts` cuando esa ruta no aparece
 *    en la tarea ni en las señales. El epic exige "citando ficheros
 *    concretos", y un fichero inventado es peor que ninguno: parece
 *    justificacion.
 * 3. RELLENAR. Sugerir a alguien porque hay que sugerir a alguien. Por eso
 *    existe `no_match` como resultado de primera clase, con permiso explicito
 *    en el prompt: un router que siempre sugiere no esta razonando.
 */

/** Cuantos candidatos tiene que traer un shortlist util. */
export const MIN_CANDIDATES = 2
export const MAX_CANDIDATES = 4

/**
 * Longitud minima del razonamiento por candidato.
 *
 * Mismo argumento que `MIN_ROUTING_REASONING_LENGTH` en el Verifier: un `min(1)` deja
 * pasar "ok" y produce un shortlist formalmente valido y completamente inutil.
 * No mide calidad —eso no lo mide un `length`— es un piso.
 */
export const MIN_ROUTING_REASONING_LENGTH = 60

/** Una persona que se puede sugerir, con las señales ya calculadas (T01). */
export interface RoutingCandidate {
  /** Identidad estable. La misma que usan ownership y carga. */
  readonly id: string
  readonly label: string
  /** Ficheros donde tiene evidencia de autoria, con su cifra. */
  readonly ownership: readonly {
    readonly path: string
    readonly lines: number
    readonly commits: number
  }[]
  /** Unidades de trabajo en curso. */
  readonly workload: number
  /**
   * `false` cuando la carga esta INCOMPLETA porque no se pudieron leer los
   * issues abiertos. Viaja hasta el prompt: el modelo tiene que saber que "0"
   * puede significar "no lo se" en vez de "esta libre".
   */
  readonly workloadIsComplete: boolean
}

export interface RoutingInput {
  readonly taskRef: string
  readonly taskTitle: string
  readonly taskBody?: string
  /** Ficheros que la tarea va a tocar, segun el grafo. */
  readonly files: readonly string[]
  readonly candidates: readonly RoutingCandidate[]
}

export interface ShortlistEntry {
  readonly rank: number
  readonly candidateId: string
  /** Por que este candidato, en prosa. */
  readonly reasoning: string
  /**
   * Ficheros concretos que sostienen la sugerencia. Se comprueba que existen
   * de verdad en la entrada: es la defensa que no depende del modelo.
   */
  readonly evidenceFiles: readonly string[]
  /** Que señal condujo esta posicion. El epic lo exige explicitamente. */
  readonly leadingSignal: LeadingSignal
}

/**
 * Que inclino la balanza. No es decoracion: el criterio de aceptacion dice
 * "puedo saber que señal condujo cada posicion SIN ABRIR EL CODIGO".
 */
export const LEADING_SIGNALS = ['ownership', 'workload', 'both'] as const
export type LeadingSignal = (typeof LEADING_SIGNALS)[number]

export type RoutingSuggestion =
  | { readonly kind: 'shortlist'; readonly entries: readonly ShortlistEntry[] }
  /** Sin match claro. Es una respuesta legitima y esperada, no un fallo. */
  | { readonly kind: 'no_match'; readonly reason: string }

// ---------------------------------------------------------------------------
// El esquema que se le pide al modelo
// ---------------------------------------------------------------------------

export const ROUTING_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['shortlist', 'no_match'],
      description: 'Usa `no_match` si ningun candidato encaja. Es una respuesta valida.',
    },
    noMatchReason: {
      type: 'string',
      description: 'Obligatorio con `no_match`: por que ninguno encaja.',
    },
    candidates: {
      type: 'array',
      description: `Entre ${String(MIN_CANDIDATES)} y ${String(MAX_CANDIDATES)} candidatos con \`shortlist\`.`,
      items: {
        type: 'object',
        additionalProperties: false,
        // El orden de las claves es el orden de generacion: primero el
        // razonamiento, despues la evidencia, y el puesto AL FINAL. Es
        // deliberado, igual que en el Verifier: si el puesto se generase
        // primero, el razonamiento seria una justificacion a posteriori.
        required: ['candidateId', 'reasoning', 'evidenceFiles', 'leadingSignal', 'rank'],
        properties: {
          candidateId: {
            type: 'string',
            description: 'Id EXACTO de la lista dada. No lo inventes.',
          },
          reasoning: {
            type: 'string',
            description: 'Por que este candidato, antes de decidir su puesto.',
          },
          evidenceFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Rutas EXACTAS de los ficheros que sostienen la sugerencia.',
          },
          leadingSignal: { type: 'string', enum: [...LEADING_SIGNALS] },
          rank: { type: 'number', description: '1 es el mas recomendado.' },
        },
      },
    },
  },
}

const rawSchema = z.object({
  outcome: z.enum(['shortlist', 'no_match']),
  noMatchReason: z.string().optional(),
  candidates: z
    .array(
      z.object({
        candidateId: z.string().trim().min(1),
        reasoning: z.string().trim().min(1),
        evidenceFiles: z.array(z.string().trim().min(1)).default([]),
        leadingSignal: z.enum(LEADING_SIGNALS),
        rank: z.number().int().min(1),
      }),
    )
    .optional(),
})

// ---------------------------------------------------------------------------
// La validacion
// ---------------------------------------------------------------------------

/**
 * Convierte lo que devolvio el modelo en una sugerencia, o lanza.
 *
 * NO se "arregla" nada de lo que venga mal: ni se recorta a 4 candidatos, ni se
 * renumeran los puestos, ni se descartan los que no existen dejando el resto.
 * Un shortlist a medias es peor que ninguno, porque quien lo lee no sabe que
 * partes se cayeron.
 */
export function parseRoutingSuggestion(raw: unknown, input: RoutingInput): RoutingSuggestion {
  const parsed = rawSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError(
      `El router devolvio algo que no encaja con el esquema pedido: ${parsed.error.message.slice(0, 300)}`,
    )
  }
  const data = parsed.data

  if (data.outcome === 'no_match') {
    const reason = data.noMatchReason?.trim() ?? ''
    if (reason.length < MIN_ROUTING_REASONING_LENGTH) {
      // "No hay match" sin explicacion no le sirve a quien tiene que repartir
      // la tarea igualmente: necesita saber si es que falta gente con contexto
      // o que la tarea no toca codigo conocido.
      throw new ValidationError(
        `El router dijo "sin match claro" sin explicar por que (minimo ${String(MIN_ROUTING_REASONING_LENGTH)} caracteres).`,
      )
    }
    return { kind: 'no_match', reason }
  }

  const candidates = data.candidates ?? []
  if (candidates.length < MIN_CANDIDATES || candidates.length > MAX_CANDIDATES) {
    throw new ValidationError(
      `Un shortlist trae entre ${String(MIN_CANDIDATES)} y ${String(MAX_CANDIDATES)} candidatos, y ` +
        `devolvio ${String(candidates.length)}. Con uno solo no hay a quien comparar; con mas de ` +
        'cuatro, la lista deja de ser una sugerencia y pasa a ser el censo del equipo.',
    )
  }

  const conocidos = new Map(input.candidates.map((c) => [c.id, c]))
  const ficherosConocidos = new Set(input.files)
  for (const candidato of input.candidates) {
    for (const o of candidato.ownership) ficherosConocidos.add(o.path)
  }

  const puestos = new Set<number>()
  const vistos = new Set<string>()
  const entries: ShortlistEntry[] = []

  for (const candidato of candidates) {
    if (!conocidos.has(candidato.candidateId)) {
      // Mentira 1: se invento a alguien.
      throw new ValidationError(
        `El router sugirio a "${candidato.candidateId}", que no estaba entre los candidatos. ` +
          'Sugerir a alguien que no existe es peor que no sugerir a nadie.',
      )
    }
    if (vistos.has(candidato.candidateId)) {
      throw new ValidationError(`El router repitio a "${candidato.candidateId}" en el shortlist.`)
    }
    vistos.add(candidato.candidateId)

    if (candidato.reasoning.trim().length < MIN_ROUTING_REASONING_LENGTH) {
      throw new ValidationError(
        `El razonamiento de "${candidato.candidateId}" tiene ${String(candidato.reasoning.trim().length)} ` +
          `caracteres y el minimo son ${String(MIN_ROUTING_REASONING_LENGTH)}. Un shortlist que no se explica ` +
          'no se puede anular con criterio, que es justo lo que tiene que hacer el humano.',
      )
    }

    for (const fichero of candidato.evidenceFiles) {
      if (!ficherosConocidos.has(fichero)) {
        // Mentira 2: se invento la evidencia. Un fichero inventado es peor que
        // ninguno, porque PARECE justificacion.
        throw new ValidationError(
          `El router cito "${fichero}" como evidencia de "${candidato.candidateId}", y esa ruta no ` +
            'aparece ni en los ficheros de la tarea ni en las señales de ningun candidato.',
        )
      }
    }

    if (puestos.has(candidato.rank)) {
      throw new ValidationError(`El router uso el puesto ${String(candidato.rank)} dos veces.`)
    }
    puestos.add(candidato.rank)

    entries.push({
      rank: candidato.rank,
      candidateId: candidato.candidateId,
      reasoning: candidato.reasoning.trim(),
      evidenceFiles: candidato.evidenceFiles,
      leadingSignal: candidato.leadingSignal,
    })
  }

  // Los puestos tienen que ser 1..n sin huecos: un shortlist con los puestos 1,
  // 2 y 5 significa que el modelo descarto candidatos por el camino y no lo
  // dijo, y quien lo lea no sabra que le falta.
  for (let esperado = 1; esperado <= entries.length; esperado += 1) {
    if (!puestos.has(esperado)) {
      throw new ValidationError(
        `Los puestos del shortlist tienen que ser 1..${String(entries.length)} sin huecos, y falta el ` +
          `${String(esperado)}.`,
      )
    }
  }

  return { kind: 'shortlist', entries: [...entries].sort((a, b) => a.rank - b.rank) }
}
