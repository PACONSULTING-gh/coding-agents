import { z } from 'zod'

import {
  DEFAULT_TRAVERSAL_DEPTH,
  MAX_TRAVERSAL_DEPTH,
  findDependencies,
  findDependents,
  type TraversalHit,
} from '../../queries.js'
import { repositorySchema } from '../../checkout.js'
import { fetchRankedPage, type RankedPage } from '../budget.js'
import { nodeRefSchema, resolveNodeId, resolveRepoId, type NodeRefInput } from '../resolve.js'

/**
 * `find_dependents` y `find_dependencies` (T05): comparten TODO menos el
 * sentido del recorrido, que ya decide `queries.ts` (T01). Un solo modulo
 * evita que las dos herramientas puedan divergir en como validan, resuelven
 * el nodo de partida o aplican el presupuesto de contexto.
 *
 * ---------------------------------------------------------------------------
 * RANKING: por que este orden
 * ---------------------------------------------------------------------------
 * El orden lo fija la consulta SQL de T01 (`ORDER BY distance ASC, weight
 * DESC, path ASC`) y esta funcion no lo toca:
 *   1. DISTANCIA ascendente -- lo mas cercano en el grafo es lo mas probable
 *      que se vea afectado de verdad; es la señal mas fuerte que hay.
 *   2. PESO descendente, a igualdad de distancia -- un import estatico o un
 *      co-cambio frecuente pesa mas que una arista debil, y eso importa mas
 *      que el orden alfabetico cuando hay que elegir que mostrar primero.
 *   3. RUTA ascendente como desempate estable, para que el contador de
 *      truncado ("mostrando N de M") sea reproducible entre llamadas.
 */

/** Cuanto se le pide al motor antes de aplicar el presupuesto de bytes. Ver `budget.ts`. */
const FETCH_LIMIT = 300

export const traversalInputShape = {
  repository: repositorySchema.describe('El repositorio, como "owner/repo".'),
  node: nodeRefSchema,
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_TRAVERSAL_DEPTH)
    .default(DEFAULT_TRAVERSAL_DEPTH)
    .describe(`Saltos maximos en el grafo (1-${String(MAX_TRAVERSAL_DEPTH)}).`),
}

export interface TraversalToolInput {
  readonly repository: string
  readonly node: NodeRefInput
  readonly depth?: number
}

export interface CompactTraversalHit {
  readonly path: string
  readonly name: string | null
  readonly kind: TraversalHit['kind']
  readonly distance: number
  /** Que senal produjo esta arista: `static` (import/llamada), `build` (Nx/Turborepo) o `git` (co-cambio). */
  readonly signal: TraversalHit['edgeSource']
  readonly via: TraversalHit['edgeKind']
  readonly weight: number
}

function toCompactHit(hit: TraversalHit): CompactTraversalHit {
  return {
    path: hit.path,
    name: hit.name,
    kind: hit.kind,
    distance: hit.distance,
    signal: hit.edgeSource,
    via: hit.edgeKind,
    weight: hit.weight,
  }
}

export type TraversalDirection = 'dependents' | 'dependencies'

export async function runTraversal(
  direction: TraversalDirection,
  input: TraversalToolInput,
): Promise<{
  startNode: { path: string; name: string | null; kind: string }
  page: RankedPage<CompactTraversalHit>
}> {
  const repoId = resolveRepoId(input.repository)
  const startNode = await resolveNodeId(repoId, input.node)
  const traverse = direction === 'dependents' ? findDependents : findDependencies

  const page = await fetchRankedPage({
    fetchLimit: FETCH_LIMIT,
    fetch: (limit) => traverse({ repoId, nodeId: startNode.nodeId, depth: input.depth, limit }),
    toOutput: toCompactHit,
  })

  return {
    startNode: { path: startNode.path, name: startNode.name, kind: startNode.kind },
    page,
  }
}
