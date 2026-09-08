import { uuidSchema, ValidationError } from '@coord/core'
import { withTenantConnection, type TenantQuery } from '@coord/db'
import { z } from 'zod'

import { detectBuildTools } from './detect.js'
import { parseNxGraph } from './nx.js'
import { runNxGraph, runTurboQuery } from './runners.js'
import {
  deleteBuildEdges,
  insertBuildEdges,
  upsertTargetNodes,
  type BuildEdgeInput,
} from './store.js'
import { parseTurboGraph, TURBO_GRAPH_QUERY } from './turborepo.js'
import type { BuildTool, NormalizedBuildGraph } from './types.js'

/**
 * Fuera de alcance a proposito: unir el nodo `target` de un proyecto con el
 * nodo `package` que T02 crea para su nombre npm (`@coord/db`, ver
 * `src/parse/README` / `parse/index.ts`). Exigiria leer y resolver el
 * `package.json` de cada proyecto (nombre publicado vs. nombre de Nx/Turbo,
 * que no siempre coinciden) y no es criterio de aceptacion de T03. Los dos
 * nodos conviven sin fusionar: el `target` aporta la arista de build, el
 * `package` la de import estatico.
 */
export interface BuildIngestionResult {
  readonly tool: BuildTool
  readonly projectsUpserted: number
  readonly edgesInserted: number
  /** Dependencias cuyo origen o destino no aparece en `projects`: no se inventan. */
  readonly unresolvedDependencies: number
}

function parseGraph(tool: BuildTool, rawJson: unknown): NormalizedBuildGraph {
  return tool === 'nx' ? parseNxGraph(rawJson) : parseTurboGraph(rawJson)
}

async function writeBuildGraph(
  tx: TenantQuery,
  repoId: string,
  graph: NormalizedBuildGraph,
): Promise<BuildIngestionResult> {
  const nodeIds = await upsertTargetNodes(tx, repoId, graph.projects)
  await deleteBuildEdges(tx, repoId, graph.tool)

  const seen = new Set<string>()
  const edges: BuildEdgeInput[] = []
  let unresolvedDependencies = 0
  for (const dependency of graph.dependencies) {
    const fromId = nodeIds.get(dependency.from)
    const toId = nodeIds.get(dependency.to)
    if (fromId === undefined || toId === undefined || fromId === toId) {
      if (fromId === undefined || toId === undefined) unresolvedDependencies += 1
      continue
    }
    const key = `${fromId}|${toId}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({
      from: fromId,
      to: toId,
      tool: graph.tool,
      dependencyType: dependency.dependencyType,
    })
  }

  const inserted = await insertBuildEdges(tx, repoId, edges)
  return {
    tool: graph.tool,
    projectsUpserted: nodeIds.size,
    edgesInserted: inserted,
    unresolvedDependencies,
  }
}

const parsedInputSchema = z.object({
  repoId: uuidSchema,
  tool: z.enum(['nx', 'turborepo']),
})

export interface IngestParsedBuildGraphInput {
  readonly repoId: string
  readonly tool: BuildTool
  /** El JSON ya obtenido (de un fichero, de un fixture de test, de `runners.ts`...). */
  readonly rawJson: unknown
}

/**
 * Valida y escribe un grafo de build ya obtenido. Es el punto de entrada que
 * usan los tests con fixtures (la forma REAL del JSON de cada herramienta, no
 * un doble del comando que la produce) y el que usa `ingestBuildGraph` por
 * debajo tras ejecutar la CLI de verdad.
 *
 * La validacion ocurre ANTES de `withTenantConnection`: un JSON con la forma
 * equivocada no llega a abrir transaccion ni a tocar la base (CLAUDE.md 2.4,
 * "frontera de confianza" — falla ruidoso, no mete nada).
 */
export async function ingestParsedBuildGraph(
  input: IngestParsedBuildGraphInput,
): Promise<BuildIngestionResult> {
  const parsedInput = parsedInputSchema.safeParse(input)
  if (!parsedInput.success) {
    throw new ValidationError(
      `Entrada invalida para ingestParsedBuildGraph: ${parsedInput.error.message}`,
      { cause: parsedInput.error },
    )
  }
  const graph = parseGraph(parsedInput.data.tool, input.rawJson)
  return withTenantConnection((tx) => writeBuildGraph(tx, parsedInput.data.repoId, graph))
}

const ingestInputSchema = z.object({
  repoId: uuidSchema,
  repoPath: z.string().min(1),
})

export type IngestBuildGraphInput = z.input<typeof ingestInputSchema>

/**
 * Punto de entrada real: detecta que herramienta de build tiene el repo, la
 * ejecuta, y escribe lo que devuelva. Si no hay ninguna herramienta soportada,
 * no es un error: la ingesta de build simplemente no aporta aristas (criterio
 * de aceptacion de T03).
 */
export async function ingestBuildGraph(
  input: IngestBuildGraphInput,
): Promise<readonly BuildIngestionResult[]> {
  const parsed = ingestInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError(`Entrada invalida para ingestBuildGraph: ${parsed.error.message}`, {
      cause: parsed.error,
    })
  }
  const { repoId, repoPath } = parsed.data
  const tools = await detectBuildTools(repoPath)

  const results: BuildIngestionResult[] = []
  for (const tool of tools) {
    const rawJson =
      tool === 'nx' ? await runNxGraph(repoPath) : await runTurboQuery(repoPath, TURBO_GRAPH_QUERY)
    results.push(await ingestParsedBuildGraph({ repoId, tool, rawJson }))
  }
  return results
}
