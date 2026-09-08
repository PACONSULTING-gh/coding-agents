import type { TenantQuery } from '@coord/db'

import type { BuildProjectRef, BuildTool } from './types.js'

/**
 * SQL de la ingesta de build, sobre `TenantQuery` de `@coord/db` (este paquete
 * no abre pool, igual que `queries.ts` e `ingest/store.ts`). Por lotes con
 * `unnest`, mismo motivo que `ingest/store.ts`: un proyecto de Nx/Turbo puede
 * tener decenas de dependencias, y una sentencia por fila no escala.
 */
const CHUNK = 2000

function* chunks<T>(items: readonly T[], size = CHUNK): Generator<readonly T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size)
  }
}

/**
 * Nodos `target`: uno por proyecto/paquete del grafo de build. UPSERT sobre la
 * clave natural (tenant_id, repo_id, kind, path, name), igual que los nodos
 * `file`: conserva el `id` entre pasadas para que las aristas que otros
 * ficheros tienen hacia el no se rompan en cada reingesta.
 */
export async function upsertTargetNodes(
  tx: TenantQuery,
  repoId: string,
  projects: readonly BuildProjectRef[],
): Promise<Map<string, string>> {
  const byName = new Map<string, string>()
  for (const batch of chunks(projects)) {
    const result = await tx.query<{ id: string; name: string }>(
      `INSERT INTO graph_nodes (tenant_id, repo_id, kind, path, name, language, metadata)
       SELECT $1, $2, 'target', p.path, p.name, NULL, p.metadata::jsonb
         FROM unnest($3::text[], $4::text[], $5::text[]) AS p(path, name, metadata)
       ON CONFLICT ON CONSTRAINT graph_nodes_natural_key
       DO UPDATE SET metadata = EXCLUDED.metadata
       RETURNING id, name`,
      [
        tx.tenantId,
        repoId,
        batch.map((project) => project.path),
        batch.map((project) => project.name),
        batch.map((project) => JSON.stringify({ projectType: project.projectType })),
      ],
    )
    for (const row of result.rows) byName.set(row.name, row.id)
  }
  return byName
}

/**
 * Borra las aristas `build` de ESTA herramienta antes de reinsertar el grafo
 * completo. A diferencia de la ingesta estatica (incremental, fichero a
 * fichero), Nx/Turbo entregan el grafo COMPLETO en cada llamada: no hay un
 * "solo lo que cambio" que resolver aqui, asi que la forma correcta de no
 * acumular aristas fantasma de proyectos que dejaron de depender entre si es
 * sustituir el conjunto entero. Se filtra por herramienta (`metadata->>
 * 'buildTool'`) para que Nx y Turborepo, si algun dia coexisten en el mismo
 * repo, no se borren las aristas el uno al otro.
 */
export async function deleteBuildEdges(
  tx: TenantQuery,
  repoId: string,
  tool: BuildTool,
): Promise<void> {
  await tx.query(
    `DELETE FROM graph_edges
      WHERE tenant_id = $1 AND repo_id = $2 AND source = 'build'
        AND metadata ->> 'buildTool' = $3`,
    [tx.tenantId, repoId, tool],
  )
}

export interface BuildEdgeInput {
  readonly from: string
  readonly to: string
  readonly tool: BuildTool
  readonly dependencyType: string
}

/**
 * Aristas `imports`/`build`: un proyecto DEPENDE de otro, tal y como lo dice
 * la herramienta de build. Peso fijo 1.0 (migracion 0007: "1.0 para las
 * aristas estaticas y de build, o esta o no esta"; la frecuencia solo tiene
 * sentido para `cochange`).
 */
export async function insertBuildEdges(
  tx: TenantQuery,
  repoId: string,
  edges: readonly BuildEdgeInput[],
): Promise<number> {
  let inserted = 0
  for (const batch of chunks(edges)) {
    const result = await tx.query(
      `INSERT INTO graph_edges (tenant_id, repo_id, from_node_id, to_node_id, kind, source, weight, metadata)
       SELECT $1, $2, e.from_id, e.to_id, 'imports', 'build', 1.0, e.metadata::jsonb
         FROM unnest($3::uuid[], $4::uuid[], $5::text[]) AS e(from_id, to_id, metadata)
       ON CONFLICT ON CONSTRAINT graph_edges_natural_key DO NOTHING`,
      [
        tx.tenantId,
        repoId,
        batch.map((edge) => edge.from),
        batch.map((edge) => edge.to),
        batch.map((edge) =>
          JSON.stringify({ buildTool: edge.tool, dependencyType: edge.dependencyType }),
        ),
      ],
    )
    inserted += result.rowCount ?? 0
  }
  return inserted
}
