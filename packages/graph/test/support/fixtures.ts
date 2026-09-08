import { randomUUID } from 'node:crypto'

import { runWithTenant } from '@coord/core'
import { withTenantConnection } from '@coord/db'

import type { EdgeKind, EdgeSource } from '../../src/queries.js'

/**
 * Altas de datos para los tests, siempre por la MISMA via que usa el producto:
 * `runWithTenant` + `withTenantConnection`. Ningun fixture se cuela por debajo
 * de la RLS, porque si lo hiciera estaria montando un escenario que en
 * produccion no puede existir.
 */

export async function createTenant(slug: string): Promise<string> {
  const id = randomUUID()
  await runWithTenant({ tenantId: id }, () =>
    withTenantConnection(async (tx) => {
      await tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        id,
        `Tenant ${slug}`,
        slug,
      ])
    }),
  )
  return id
}

/** Crea un nodo de tipo `file` por ruta y devuelve el mapa ruta -> id. */
export async function createFileNodes(
  tenantId: string,
  repoId: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  return runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      const result = await tx.query<{ id: string; path: string }>(
        `INSERT INTO graph_nodes (tenant_id, repo_id, kind, path, language)
         SELECT $1, $2, 'file', p, 'typescript' FROM unnest($3::text[]) AS p
         RETURNING id, path`,
        [tenantId, repoId, paths],
      )
      const byPath = new Map<string, string>()
      for (const row of result.rows) {
        byPath.set(row.path, row.id)
      }
      if (byPath.size !== paths.length) {
        throw new Error(
          `Se pidieron ${String(paths.length)} nodos y se crearon ${String(byPath.size)}.`,
        )
      }
      return byPath
    }),
  )
}

/** Da de alta un usuario del tenant. Lo necesita `who_last_touched` (T05) para cruzar el correo del autor de git. */
export async function createUser(
  tenantId: string,
  input: { email: string; displayName: string },
): Promise<string> {
  return runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, input.email, input.displayName],
      )
      const row = result.rows[0]
      if (row === undefined) {
        throw new Error('El INSERT de users no devolvio ninguna fila.')
      }
      return row.id
    }),
  )
}

export interface EdgeSpec {
  /** El nodo que DEPENDE. */
  from: string
  /** El nodo del que se depende. */
  to: string
  kind?: EdgeKind
  source?: EdgeSource
  weight?: number
}

export async function createEdges(
  tenantId: string,
  repoId: string,
  edges: readonly EdgeSpec[],
): Promise<void> {
  await runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      for (const edge of edges) {
        await tx.query(
          `INSERT INTO graph_edges (tenant_id, repo_id, from_node_id, to_node_id, kind, source, weight)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            tenantId,
            repoId,
            edge.from,
            edge.to,
            edge.kind ?? 'imports',
            edge.source ?? 'static',
            edge.weight ?? 1.0,
          ],
        )
      }
    }),
  )
}

/** Percentil por interpolacion de rango mas cercano sobre una muestra ya medida. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) {
    throw new Error('No hay muestras: la medicion no llego a ejecutarse.')
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1
  const value = sorted[index]
  if (value === undefined) {
    throw new Error(`Indice de percentil fuera de rango: ${String(index)}`)
  }
  return value
}
