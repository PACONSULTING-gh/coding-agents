import { z } from 'zod'

import {
  DEFAULT_TRAVERSAL_DEPTH,
  MAX_TRAVERSAL_DEPTH,
  blastRadius,
  findNodesByPath,
  type BlastRadiusHit,
} from '../../queries.js'
import { repositorySchema } from '../../checkout.js'
import {
  MAX_RESPONSE_BYTES,
  fetchRankedPage,
  truncateToBudget,
  type RankedPage,
} from '../budget.js'
import { relativeFilePathSchema } from '../paths.js'
import { resolveRepoId } from '../resolve.js'

/**
 * `blast_radius` (T05): "voy a tocar estos ficheros, que MAS se ve afectado".
 * Union de dependientes transitivos de todos ellos a la vez, ranqueada igual
 * que `find_dependents` (ver `traversal.ts`) pero agregando TODAS las senales
 * que alcanzaron cada nodo, no solo una (es lo que da `blastRadius` en T01).
 */

const FETCH_LIMIT = 300
/** Mismo tope que `blastRadiusInputSchema` en `queries.ts`: no tiene sentido pedir mas. */
const MAX_FILES = 500

export const blastRadiusInputShape = {
  repository: repositorySchema.describe('El repositorio, como "owner/repo".'),
  files: z
    .array(relativeFilePathSchema)
    .min(1)
    .max(MAX_FILES)
    .describe('Rutas relativas de los ficheros que van a cambiar.'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_TRAVERSAL_DEPTH)
    .default(DEFAULT_TRAVERSAL_DEPTH)
    .describe(`Saltos maximos en el grafo (1-${String(MAX_TRAVERSAL_DEPTH)}).`),
}

export interface BlastRadiusToolInput {
  readonly repository: string
  /** No `readonly`: es el tipo real que produce el SDK al validar `files` (un `string[]` normal). */
  readonly files: string[]
  readonly depth?: number
}

export interface CompactBlastHit {
  readonly path: string
  readonly name: string | null
  readonly kind: BlastRadiusHit['kind']
  readonly distance: number
  /** TODAS las senales que alcanzaron este nodo: puede ser estatica Y de co-cambio a la vez. */
  readonly signals: readonly BlastRadiusHit['sources'][number][]
  readonly via: readonly BlastRadiusHit['edgeKinds'][number][]
  readonly weight: number
}

function toCompactHit(hit: BlastRadiusHit): CompactBlastHit {
  return {
    path: hit.path,
    name: hit.name,
    kind: hit.kind,
    distance: hit.distance,
    signals: hit.sources,
    via: hit.edgeKinds,
    weight: hit.weight,
  }
}

/**
 * Ficheros pedidos que NO tienen nodo en el grafo (repo sin indexar, fichero
 * nuevo sin commitear...). Se dice SIEMPRE, nunca en silencio: un
 * `blastRadius` vacio por "ninguno de tus ficheros esta indexado" no es lo
 * mismo que "no afectas a nada", y confundirlos es justo el "no respondas
 * 'todo' ni 'nada' por no tener contexto" de T05.
 *
 * ---------------------------------------------------------------------------
 * TAMBIEN PASA POR EL PRESUPUESTO DE BYTES
 * ---------------------------------------------------------------------------
 * Esta lista la escribe el LLAMANTE (hasta `MAX_FILES` rutas de hasta 1.024
 * caracteres). Devolverla entera hacia que una llamada perfectamente legal
 * —un PR de 200 ficheros contra un repo aun sin ingerir— produjera una
 * respuesta de cientos de miles de bytes frente a un presupuesto de 8 KiB, que
 * es exactamente el volcado que esta herramienta existe para evitar. Se recorta
 * con el mismo criterio de contador honesto que la lista de afectados: se dice
 * cuantos habia y que se ha recortado.
 */
export interface UnresolvedFiles {
  /** Las que caben en el presupuesto, en el orden en que se pidieron. */
  readonly files: readonly string[]
  /** Cuantas habia en total. Este numero SI es exacto: son las que pidio el llamante. */
  readonly total: number
  readonly truncated: boolean
}

export interface BlastRadiusResult {
  readonly page: RankedPage<CompactBlastHit>
  readonly unresolved: UnresolvedFiles
}

/**
 * Reparto del presupuesto entre las dos listas de la respuesta. La lista de
 * AFECTADOS es la respuesta a la pregunta, asi que se lleva la mayor parte; a
 * los no resueltos les basta una cuarta parte para nombrar unas cuantas decenas
 * de rutas, y lo que no gasten se lo queda la lista de afectados.
 */
const UNRESOLVED_BUDGET_BYTES = Math.floor(MAX_RESPONSE_BYTES / 4)

function budgetUnresolved(files: readonly string[]): {
  readonly unresolved: UnresolvedFiles
  readonly usedBytes: number
} {
  const budgeted = truncateToBudget(files, UNRESOLVED_BUDGET_BYTES)
  const usedBytes = budgeted.items.reduce(
    (total, file) => total + new TextEncoder().encode(JSON.stringify(file)).length + 1,
    0,
  )
  return {
    unresolved: { files: budgeted.items, total: files.length, truncated: budgeted.truncated },
    usedBytes,
  }
}

export async function runBlastRadius(input: BlastRadiusToolInput): Promise<BlastRadiusResult> {
  const repoId = resolveRepoId(input.repository)
  const nodes = await findNodesByPath({ repoId, paths: input.files, kind: 'file' })
  const foundPaths = new Set(nodes.map((node) => node.path))
  const { unresolved, usedBytes } = budgetUnresolved(
    input.files.filter((file) => !foundPaths.has(file)),
  )
  const remainingBytes = MAX_RESPONSE_BYTES - usedBytes

  if (nodes.length === 0) {
    return {
      page: { items: [], shown: 0, total: 0, truncated: false },
      unresolved,
    }
  }

  const page = await fetchRankedPage({
    fetchLimit: FETCH_LIMIT,
    maxBytes: remainingBytes,
    fetch: (limit) =>
      blastRadius({
        repoId,
        nodeIds: nodes.map((node) => node.nodeId),
        depth: input.depth,
        limit,
      }),
    toOutput: toCompactHit,
  })

  return { page, unresolved }
}
