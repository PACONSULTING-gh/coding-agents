import type { TenantQuery } from '@coord/db'

import type { EdgeKind } from '../queries.js'

import { parseCheckpoint, type IngestionCheckpoint } from './checkpoint.js'

/**
 * Todo el SQL de la ingesta, en un solo sitio y siempre sobre un `TenantQuery`
 * de `@coord/db`: este paquete no abre pool ni toca `pg` (fitness function
 * `pg-solo-en-db`). El filtro explicito `tenant_id = $1` que llevan las
 * sentencias NO es la defensa —la defensa es la RLS forzada— sino una segunda
 * capa y una constante en la columna lider de los indices, igual que en
 * `queries.ts`.
 *
 * Todo va POR LOTES con `unnest`. Un fichero medio produce entre 5 y 40 filas;
 * con una sentencia por fichero, una indexacion inicial de unos miles de
 * ficheros son decenas de miles de idas y vueltas a la base, y el criterio de
 * los 30 segundos se pierde en el viaje, no en el trabajo.
 */

/** Filas por sentencia. Amortiza el viaje sin construir arrays gigantes. */
const CHUNK = 2000

function* chunks<T>(items: readonly T[], size = CHUNK): Generator<readonly T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size)
  }
}

// ---------------------------------------------------------------------------
// graph_ingestions
// ---------------------------------------------------------------------------

export interface ResumableIngestion {
  readonly id: string
  readonly checkpoint: IngestionCheckpoint
}

/**
 * Ingesta del MISMO commit que quedo a medias. Incluye `failed` a proposito: un
 * fallo transitorio (la base se cayo, el proceso murio) no deberia obligar a
 * reindexar el repo entero.
 *
 * `FOR UPDATE` para que dos ingestas simultaneas del mismo repo no reanuden la
 * misma fila a la vez: la segunda espera y, al ver el estado ya avanzado, sigue
 * desde donde la dejo la primera en vez de duplicar el trabajo.
 */
export async function findResumableIngestion(
  tx: TenantQuery,
  repoId: string,
  commitSha: string,
): Promise<ResumableIngestion | undefined> {
  const result = await tx.query<{ id: string; checkpoint: unknown }>(
    `SELECT id, checkpoint
       FROM graph_ingestions
      WHERE tenant_id  = $1
        AND repo_id    = $2
        AND commit_sha = $3
        AND status IN ('pending', 'running', 'failed')
      ORDER BY created_at DESC
      LIMIT 1
        FOR UPDATE`,
    [tx.tenantId, repoId, commitSha],
  )
  const row = result.rows[0]
  if (row === undefined) return undefined

  const checkpoint = row.checkpoint
  // `{}` es el DEFAULT de la columna: la fila existe pero nunca llego a
  // planificar. No hay nada que reanudar.
  if (typeof checkpoint !== 'object' || checkpoint === null || !('version' in checkpoint)) {
    return undefined
  }
  return { id: row.id, checkpoint: parseCheckpoint(checkpoint) }
}

export async function createIngestion(
  tx: TenantQuery,
  repoId: string,
  commitSha: string,
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO graph_ingestions (tenant_id, repo_id, commit_sha, status, started_at)
     VALUES ($1, $2, $3, 'running', now())
     RETURNING id`,
    [tx.tenantId, repoId, commitSha],
  )
  const row = result.rows[0]
  if (row === undefined) throw new Error('No se pudo crear la fila de ingesta.')
  return row.id
}

/** Reanudar: vuelve a `running` y limpia el error de la caida anterior. */
export async function resumeIngestion(tx: TenantQuery, ingestionId: string): Promise<void> {
  await tx.query(
    `UPDATE graph_ingestions
        SET status = 'running', error = NULL, started_at = COALESCE(started_at, now())
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, ingestionId],
  )
}

export async function saveCheckpoint(
  tx: TenantQuery,
  ingestionId: string,
  checkpoint: IngestionCheckpoint,
): Promise<void> {
  const finished = checkpoint.phase === 'completed'
  await tx.query(
    `UPDATE graph_ingestions
        SET checkpoint  = $3::jsonb,
            status      = CASE WHEN $4 THEN 'completed' ELSE 'running' END,
            finished_at = CASE WHEN $4 THEN now() ELSE finished_at END
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, ingestionId, JSON.stringify(checkpoint), finished],
  )
}

/**
 * Deja constancia del fallo CON su motivo. Un `failed` sin explicacion obliga a
 * reproducir la ingesta entera para saber que paso (el CHECK de la migracion
 * 0007 ni siquiera lo permite).
 */
export async function failIngestion(
  tx: TenantQuery,
  ingestionId: string,
  message: string,
): Promise<void> {
  await tx.query(
    `UPDATE graph_ingestions
        SET status = 'failed', error = $3, finished_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, ingestionId, message.slice(0, 4000)],
  )
}

// ---------------------------------------------------------------------------
// graph_files
// ---------------------------------------------------------------------------

export interface IndexedFileState {
  readonly hash: string
  /** Especificadores de import tal cual aparecen en el codigo. Ver migracion 0009. */
  readonly importSpecifiers: readonly string[]
}

export async function loadIndexedFiles(
  tx: TenantQuery,
  repoId: string,
): Promise<Map<string, IndexedFileState>> {
  const result = await tx.query<{
    path: string
    content_hash: string
    import_specifiers: string[] | null
  }>(
    `SELECT path, content_hash, import_specifiers
       FROM graph_files WHERE tenant_id = $1 AND repo_id = $2`,
    [tx.tenantId, repoId],
  )
  return new Map(
    result.rows.map((row) => [
      row.path,
      { hash: row.content_hash, importSpecifiers: row.import_specifiers ?? [] },
    ]),
  )
}

export interface IndexedFile {
  readonly path: string
  readonly hash: string
  readonly language: string
  /**
   * Especificadores de import de este fichero. Se persisten para poder
   * replanificarlo cuando el conjunto de rutas del repo cambia (migracion 0009):
   * el hash del fichero no cambia, pero la resolucion de sus imports si.
   */
  readonly importSpecifiers: readonly string[]
}

export async function upsertIndexedFiles(
  tx: TenantQuery,
  repoId: string,
  files: readonly IndexedFile[],
  commitSha: string,
): Promise<void> {
  for (const batch of chunks(files)) {
    // Un solo parametro `jsonb` en vez de cuatro arrays paralelos: los
    // especificadores son una lista POR FICHERO, y `unnest` de arrays paralelos
    // no sabe expresar "una lista dentro de cada fila".
    await tx.query(
      `INSERT INTO graph_files (tenant_id, repo_id, path, content_hash, language, indexed_at, indexed_commit, import_specifiers)
       SELECT $1, $2, f.path, f.hash, f.language, now(), $4,
              ARRAY(SELECT jsonb_array_elements_text(f.specifiers))
         FROM jsonb_to_recordset($3::jsonb)
              AS f(path text, hash text, language text, specifiers jsonb)
       ON CONFLICT (tenant_id, repo_id, path)
       DO UPDATE SET content_hash      = EXCLUDED.content_hash,
                     language          = EXCLUDED.language,
                     indexed_at        = EXCLUDED.indexed_at,
                     indexed_commit    = EXCLUDED.indexed_commit,
                     import_specifiers = EXCLUDED.import_specifiers`,
      [
        tx.tenantId,
        repoId,
        JSON.stringify(
          batch.map((file) => ({
            path: file.path,
            hash: file.hash,
            language: file.language,
            specifiers: file.importSpecifiers,
          })),
        ),
        commitSha,
      ],
    )
  }
}

/**
 * Un fichero que ya no esta en el repo desaparece del grafo: su nodo `file`,
 * sus nodos `symbol` y —por las claves ajenas ON DELETE CASCADE de la migracion
 * 0007— TODAS las aristas que lo tocan, tambien las que apuntaban HACIA el
 * desde otros ficheros. No quedan referencias colgando.
 */
export async function removeFiles(
  tx: TenantQuery,
  repoId: string,
  paths: readonly string[],
): Promise<void> {
  for (const batch of chunks(paths)) {
    await tx.query(
      `DELETE FROM graph_nodes
        WHERE tenant_id = $1 AND repo_id = $2
          AND kind IN ('file', 'symbol')
          AND path = ANY($3::text[])`,
      [tx.tenantId, repoId, batch],
    )
    await tx.query(
      `DELETE FROM graph_files
        WHERE tenant_id = $1 AND repo_id = $2 AND path = ANY($3::text[])`,
      [tx.tenantId, repoId, batch],
    )
  }
}

// ---------------------------------------------------------------------------
// graph_nodes
// ---------------------------------------------------------------------------

export interface FileNodeInput {
  readonly path: string
  readonly language: string
}

/**
 * Los nodos de fichero se crean ANTES de parsear nada, para TODOS los ficheros
 * de la pasada. Asi una arista de import hacia un fichero que aun no se ha
 * parseado se resuelve igual, y el grafo no depende del orden de los lotes.
 *
 * Es un UPSERT sobre la clave natural, NO un borrado y alta: el nodo conserva
 * su `id`, y con el todas las aristas que otros ficheros —que no han cambiado y
 * no se van a reparsear— tienen hacia el. Borrar y recrear haria que el grafo
 * se fuera vaciando solo, en silencio, a cada reindexacion.
 */
export async function upsertFileNodes(
  tx: TenantQuery,
  repoId: string,
  files: readonly FileNodeInput[],
): Promise<void> {
  for (const batch of chunks(files)) {
    await tx.query(
      `INSERT INTO graph_nodes (tenant_id, repo_id, kind, path, name, language)
       SELECT $1, $2, 'file', f.path, NULL, f.language
         FROM unnest($3::text[], $4::text[]) AS f(path, language)
       ON CONFLICT ON CONSTRAINT graph_nodes_natural_key
       DO UPDATE SET language = EXCLUDED.language`,
      [tx.tenantId, repoId, batch.map((file) => file.path), batch.map((file) => file.language)],
    )
  }
}

/**
 * Nodos `package`: dependencias que existen de verdad pero cuyo codigo no esta
 * en el repo (`pg`, `node:fs`, `os`). No es inventar un fichero, es decir la
 * verdad: este fichero depende de ese paquete.
 */
export async function upsertPackageNodes(
  tx: TenantQuery,
  repoId: string,
  names: readonly string[],
): Promise<Map<string, string>> {
  const byName = new Map<string, string>()
  for (const batch of chunks(names)) {
    const result = await tx.query<{ id: string; path: string }>(
      `INSERT INTO graph_nodes (tenant_id, repo_id, kind, path, name, language)
       SELECT $1, $2, 'package', p, NULL, NULL FROM unnest($3::text[]) AS p
       ON CONFLICT ON CONSTRAINT graph_nodes_natural_key
       DO UPDATE SET metadata = graph_nodes.metadata
       RETURNING id, path`,
      [tx.tenantId, repoId, batch],
    )
    for (const row of result.rows) byName.set(row.path, row.id)
  }
  return byName
}

export async function fileNodeIds(
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

export interface SymbolNodeInput {
  readonly path: string
  readonly name: string
  readonly symbolKind: string
  readonly language: string
}

/**
 * Clave de un simbolo dentro de un repo. El separador es un caracter que no
 * puede aparecer ni en una ruta de git ni en un identificador.
 */
export function symbolKey(path: string, name: string): string {
  return `${path}\u0000${name}`
}

/**
 * Sincroniza los simbolos de un conjunto de ficheros: alta o actualizacion de
 * los que declara el codigo nuevo, y BORRADO de los que ese fichero ya no
 * declara (con lo que caen sus aristas, que es lo correcto: el simbolo dejo de
 * existir).
 *
 * Igual que con los ficheros, es un UPSERT: un simbolo que sigue llamandose
 * igual conserva su `id`, y con el las aristas entrantes de ficheros que no se
 * reparsean en esta pasada.
 */
export async function replaceSymbols(
  tx: TenantQuery,
  repoId: string,
  paths: readonly string[],
  symbols: readonly SymbolNodeInput[],
): Promise<Map<string, string>> {
  await tx.query(
    `DELETE FROM graph_nodes n
      WHERE n.tenant_id = $1 AND n.repo_id = $2 AND n.kind = 'symbol'
        AND n.path = ANY($3::text[])
        AND NOT EXISTS (
          SELECT 1 FROM unnest($4::text[], $5::text[]) AS s(path, name)
           WHERE s.path = n.path AND s.name = n.name)`,
    [
      tx.tenantId,
      repoId,
      paths,
      symbols.map((symbol) => symbol.path),
      symbols.map((symbol) => symbol.name),
    ],
  )

  const byKey = new Map<string, string>()
  for (const batch of chunks(symbols)) {
    const result = await tx.query<{ id: string; path: string; name: string }>(
      `INSERT INTO graph_nodes (tenant_id, repo_id, kind, path, name, language, metadata)
       SELECT $1, $2, 'symbol', s.path, s.name, s.language,
              jsonb_build_object('symbolKind', s.symbol_kind)
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[])
              AS s(path, name, symbol_kind, language)
       ON CONFLICT ON CONSTRAINT graph_nodes_natural_key
       DO UPDATE SET metadata = EXCLUDED.metadata, language = EXCLUDED.language
       RETURNING id, path, name`,
      [
        tx.tenantId,
        repoId,
        batch.map((symbol) => symbol.path),
        batch.map((symbol) => symbol.name),
        batch.map((symbol) => symbol.symbolKind),
        batch.map((symbol) => symbol.language),
      ],
    )
    for (const row of result.rows) byKey.set(symbolKey(row.path, row.name), row.id)
  }
  return byKey
}

/** Ids de los simbolos pedidos que EXISTEN. Los que no salgan, no se inventan. */
export async function lookupSymbolNodes(
  tx: TenantQuery,
  repoId: string,
  references: readonly { readonly path: string; readonly name: string }[],
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>()
  for (const batch of chunks(references)) {
    const result = await tx.query<{ id: string; path: string; name: string }>(
      `SELECT n.id, n.path, n.name
         FROM graph_nodes n
         JOIN unnest($3::text[], $4::text[]) AS r(path, name)
           ON r.path = n.path AND r.name = n.name
        WHERE n.tenant_id = $1 AND n.repo_id = $2 AND n.kind = 'symbol'`,
      [
        tx.tenantId,
        repoId,
        batch.map((reference) => reference.path),
        batch.map((reference) => reference.name),
      ],
    )
    for (const row of result.rows) byKey.set(symbolKey(row.path, row.name), row.id)
  }
  return byKey
}

// ---------------------------------------------------------------------------
// graph_edges
// ---------------------------------------------------------------------------

export interface EdgeInput {
  readonly from: string
  readonly to: string
  readonly kind: EdgeKind
}

/**
 * Borra las aristas ESTATICAS de los tipos indicados que produjo cada uno de
 * estos ficheros, para volver a generarlas con lo que diga el codigo nuevo.
 *
 * "Que produjo un fichero" = las que SALEN de su nodo o de alguno de sus
 * simbolos. Las que ENTRAN no se tocan: las escribio otro fichero, que puede no
 * haber cambiado, y borrarlas seria tirar informacion que nadie va a
 * regenerar. Las de origen `build` o `git` (T03) tampoco: no las produjo el
 * analisis estatico y no son de esta tarea.
 *
 * ---------------------------------------------------------------------------
 * POR QUE SON DOS SENTENCIAS Y NO UN JOIN. NO LO "SIMPLIFIQUES".
 * ---------------------------------------------------------------------------
 * La version anterior era un `DELETE ... USING graph_nodes n WHERE n.id =
 * e.from_node_id AND n.path = ANY(...)`. Leyendola parece lo mismo, pero el
 * planner no tiene ningun indice con el que resolver ese join: el unico indice
 * util de `graph_nodes` para el filtro es `(tenant_id, repo_id, path)`, que NO
 * lleva `id`, asi que `e.from_node_id = n.id` acaba como *Join Filter* de un
 * nested loop y la parte interna se re-escanea entera por cada arista del repo.
 *
 * Medido con `EXPLAIN (ANALYZE, BUFFERS)` sobre una ingesta inicial de 1.500
 * ficheros, en el lote que borra 750 aristas:
 *
 *     DELETE ... USING graph_nodes   4.305 ms   20.741.009 buffers
 *                                    (3.002.625 filas descartadas por el
 *                                     Join Filter: 7.050 aristas x 426 nodos)
 *     resolver ids + DELETE por id       2,7 ms      13.587 buffers
 *
 * Como el coste del nested loop crece con el numero de aristas YA escritas, el
 * coste por lote crecia con el lote: es exactamente la superlinealidad que
 * observo el verificador (1.000 ficheros 8,1 s -> 2.000 ficheros 62 s), y no
 * era el checkpoint ni el parseo, era esta sentencia.
 */
export async function deleteStaticEdgesFrom(
  tx: TenantQuery,
  repoId: string,
  paths: readonly string[],
  kinds: readonly EdgeKind[],
): Promise<void> {
  for (const batch of chunks(paths)) {
    const owners = await tx.query<{ id: string }>(
      `SELECT n.id FROM graph_nodes n
        WHERE n.tenant_id = $1 AND n.repo_id = $2
          AND n.kind IN ('file', 'symbol')
          AND n.path = ANY($3::text[])`,
      [tx.tenantId, repoId, batch],
    )
    const ownerIds = owners.rows.map((row) => row.id)
    if (ownerIds.length === 0) continue

    for (const ids of chunks(ownerIds)) {
      await tx.query(
        `DELETE FROM graph_edges e
          WHERE e.tenant_id = $1 AND e.repo_id = $2 AND e.source = 'static'
            AND e.kind = ANY($3::text[])
            AND e.from_node_id = ANY($4::uuid[])`,
        [tx.tenantId, repoId, kinds, ids],
      )
    }
  }
}

export async function insertEdges(
  tx: TenantQuery,
  repoId: string,
  edges: readonly EdgeInput[],
): Promise<number> {
  let inserted = 0
  for (const batch of chunks(edges)) {
    const result = await tx.query(
      `INSERT INTO graph_edges (tenant_id, repo_id, from_node_id, to_node_id, kind, source, weight)
       SELECT $1, $2, e.from_id, e.to_id, e.kind, 'static', 1.0
         FROM unnest($3::uuid[], $4::uuid[], $5::text[]) AS e(from_id, to_id, kind)
       ON CONFLICT ON CONSTRAINT graph_edges_natural_key DO NOTHING`,
      [
        tx.tenantId,
        repoId,
        batch.map((edge) => edge.from),
        batch.map((edge) => edge.to),
        batch.map((edge) => edge.kind),
      ],
    )
    inserted += result.rowCount ?? 0
  }
  return inserted
}
