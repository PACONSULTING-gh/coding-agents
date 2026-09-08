import type { TenantQuery } from '@coord/db'

import type { CochangePairStat } from './mine.js'

const CHUNK = 2000

function* chunks<T>(items: readonly T[], size = CHUNK): Generator<readonly T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size)
  }
}

/**
 * Resuelve rutas a nodos `file` YA existentes. A proposito NO crea nodos: un
 * fichero que aparece en el historial de git pero nunca lo indexo T02 (un
 * README, un `.yml`, cualquier cosa que no atienda ningun `LanguageParser`) no
 * pertenece al grafo de codigo, y crearle un nodo aqui seria inventar
 * estructura que el analisis estatico decidio, correctamente, no crear. Un
 * par cuyos dos lados no resuelven a un nodo `file` existente se descarta y se
 * cuenta (`unresolvedPairs` en `ingest.ts`), igual que un import sin resolver
 * en `ingest/store.ts`.
 */
export async function resolveFileNodeIds(
  tx: TenantQuery,
  repoId: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const byPath = new Map<string, string>()
  for (const batch of chunks(paths)) {
    const result = await tx.query<{ id: string; path: string }>(
      `SELECT id, path FROM graph_nodes
        WHERE tenant_id = $1 AND repo_id = $2 AND kind = 'file' AND path = ANY($3::text[])`,
      [tx.tenantId, repoId, batch],
    )
    for (const row of result.rows) byPath.set(row.path, row.id)
  }
  return byPath
}

/** Sustituye TODAS las aristas de co-cambio del repo: cada pasada mina el grafo entero. */
export async function deleteCochangeEdges(tx: TenantQuery, repoId: string): Promise<void> {
  await tx.query(
    `DELETE FROM graph_edges
      WHERE tenant_id = $1 AND repo_id = $2 AND source = 'git' AND kind = 'cochange'`,
    [tx.tenantId, repoId],
  )
}

/**
 * Inserta las aristas de co-cambio EN LOS DOS SENTIDOS: el co-cambio es
 * simetrico por naturaleza (A y B cambiaron juntos; no hay una direccion de
 * "A depende de B" mas real que "B depende de A"), y `graph_edges` es
 * dirigida. Insertar los dos sentidos es lo que hace que el fichero aparezca
 * como afectado busque quien busque desde cualquiera de los dos — que es
 * literalmente la pregunta que este grafo existe para responder.
 */
export async function insertCochangeEdges(
  tx: TenantQuery,
  repoId: string,
  pairs: readonly { fromId: string; toId: string; stat: CochangePairStat }[],
): Promise<number> {
  let inserted = 0
  for (const batch of chunks(pairs)) {
    const result = await tx.query(
      `INSERT INTO graph_edges (tenant_id, repo_id, from_node_id, to_node_id, kind, source, weight, metadata)
       SELECT $1, $2, e.from_id, e.to_id, 'cochange', 'git', e.weight, e.metadata::jsonb
         FROM unnest($3::uuid[], $4::uuid[], $5::real[], $6::text[]) AS e(from_id, to_id, weight, metadata)
       ON CONFLICT ON CONSTRAINT graph_edges_natural_key DO NOTHING`,
      [
        tx.tenantId,
        repoId,
        batch.map((edge) => edge.fromId),
        batch.map((edge) => edge.toId),
        batch.map((edge) => edge.stat.weight),
        batch.map((edge) => JSON.stringify({ cochangeCount: edge.stat.cochangeCount })),
      ],
    )
    inserted += result.rowCount ?? 0
  }
  return inserted
}
