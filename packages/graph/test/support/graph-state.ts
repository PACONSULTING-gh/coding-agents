import { runWithTenant } from '@coord/core'
import { withTenantConnection } from '@coord/db'

/**
 * Lecturas del grafo para los asserts de los tests, siempre por la misma via
 * que usa el producto (`runWithTenant` + `withTenantConnection`). Ningun test
 * mira los datos por debajo de la RLS: si lo hiciera, estaria comprobando algo
 * que en produccion nadie puede ver.
 */

export interface NodeRow {
  readonly kind: string
  readonly path: string
  readonly name: string | null
}

export interface EdgeRow {
  readonly kind: string
  readonly source: string
  readonly from: NodeRow
  readonly to: NodeRow
  /**
   * Peso PERSISTIDO. Se expone porque es criterio de aceptacion de T03 ("cada
   * arista lleva su peso") y sin esto solo se podia comprobar en memoria: un
   * fallo en la escritura (peso invertido, el conteo en vez del lift, o el
   * DEFAULT 1.0 de la columna) pasaba desapercibido.
   */
  readonly weight: number
  readonly metadata: Record<string, unknown>
}

export interface GraphFileRow {
  readonly path: string
  readonly contentHash: string
  readonly indexedCommit: string | null
  readonly updatedAt: string
}

export interface IngestionRow {
  readonly id: string
  readonly commitSha: string
  readonly status: string
  readonly error: string | null
  readonly checkpoint: unknown
}

export async function readNodes(tenantId: string, repoId: string): Promise<NodeRow[]> {
  return runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      const result = await tx.query<{ kind: string; path: string; name: string | null }>(
        `SELECT kind, path, name FROM graph_nodes
          WHERE tenant_id = $1 AND repo_id = $2
          ORDER BY kind, path, name NULLS FIRST`,
        [tenantId, repoId],
      )
      return result.rows.map((row) => ({ kind: row.kind, path: row.path, name: row.name }))
    }),
  )
}

export async function readEdges(tenantId: string, repoId: string): Promise<EdgeRow[]> {
  return runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      const result = await tx.query<{
        kind: string
        source: string
        weight: number
        metadata: Record<string, unknown>
        from_kind: string
        from_path: string
        from_name: string | null
        to_kind: string
        to_path: string
        to_name: string | null
      }>(
        `SELECT e.kind, e.source, e.weight::double precision AS weight, e.metadata,
                f.kind AS from_kind, f.path AS from_path, f.name AS from_name,
                t.kind AS to_kind,   t.path AS to_path,   t.name AS to_name
           FROM graph_edges e
           JOIN graph_nodes f ON f.id = e.from_node_id AND f.tenant_id = e.tenant_id
           JOIN graph_nodes t ON t.id = e.to_node_id   AND t.tenant_id = e.tenant_id
          WHERE e.tenant_id = $1 AND e.repo_id = $2
          ORDER BY e.kind, f.path, f.name NULLS FIRST, t.path, t.name NULLS FIRST`,
        [tenantId, repoId],
      )
      return result.rows.map((row) => ({
        kind: row.kind,
        source: row.source,
        weight: row.weight,
        metadata: row.metadata,
        from: { kind: row.from_kind, path: row.from_path, name: row.from_name },
        to: { kind: row.to_kind, path: row.to_path, name: row.to_name },
      }))
    }),
  )
}

/** `file:src/a.ts --imports--> file:src/b.ts`, legible en el mensaje de un fallo. */
export function describeEdge(edge: EdgeRow): string {
  return `${describeNode(edge.from)} --${edge.kind}--> ${describeNode(edge.to)}`
}

export function describeNode(node: NodeRow): string {
  return node.name === null ? `${node.kind}:${node.path}` : `${node.kind}:${node.path}#${node.name}`
}

export async function readGraphFiles(
  tenantId: string,
  repoId: string,
): Promise<Map<string, GraphFileRow>> {
  return runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      const result = await tx.query<{
        path: string
        content_hash: string
        indexed_commit: string | null
        updated_at: Date
      }>(
        `SELECT path, content_hash, indexed_commit, updated_at
           FROM graph_files WHERE tenant_id = $1 AND repo_id = $2 ORDER BY path`,
        [tenantId, repoId],
      )
      return new Map(
        result.rows.map((row) => [
          row.path,
          {
            path: row.path,
            contentHash: row.content_hash,
            indexedCommit: row.indexed_commit,
            updatedAt: row.updated_at.toISOString(),
          },
        ]),
      )
    }),
  )
}

export async function readIngestions(tenantId: string, repoId: string): Promise<IngestionRow[]> {
  return runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      const result = await tx.query<{
        id: string
        commit_sha: string
        status: string
        error: string | null
        checkpoint: unknown
      }>(
        `SELECT id, commit_sha, status, error, checkpoint
           FROM graph_ingestions WHERE tenant_id = $1 AND repo_id = $2
          ORDER BY created_at`,
        [tenantId, repoId],
      )
      return result.rows.map((row) => ({
        id: row.id,
        commitSha: row.commit_sha,
        status: row.status,
        error: row.error,
        checkpoint: row.checkpoint,
      }))
    }),
  )
}
