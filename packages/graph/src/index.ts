/**
 * `@coord/graph` — el grafo de dependencias del codigo.
 *
 * Responde "si toco esto, que mas se ve afectado". Vive en el MISMO Postgres
 * que el resto del dominio (lista de adyacencia + CTEs recursivas): la decision
 * esta cerrada en CLAUDE.md 3 y 4, y una base de datos de grafos solo se
 * reconsidera con una p95 degradada Y MEDIDA delante.
 *
 * El esquema es la migracion `packages/db/migrations/0007_graph_nodes_and_edges.sql`;
 * todo el acceso pasa por `withTenantConnection` de `@coord/db`.
 *
 *   * `queries.ts`  — recorrido del grafo (T01).
 *   * `claims.ts`   — claims y leases sobre issues y ficheros (T04).
 *   * `parse/`      — un parser por lenguaje detras de `LanguageParser` (T02).
 *   * `ingest/`     — ingesta incremental y reanudable desde un repo git (T02).
 *   * `build/`      — grafo nativo de Nx/Turborepo, `source: 'build'` (T03).
 *   * `cochange/`   — overlay de co-cambio desde el historial de git, `source: 'git'` (T03).
 *   * `checkout.ts` — identidad `owner/repo` y resolucion segura del checkout local.
 *   * `mcp/`        — el grafo expuesto como servidor MCP (T05). No se reexporta
 *     aqui: el SDK de MCP vive solo en `mcp/` (fitness function
 *     `mcp-sdk-solo-en-graph-mcp`) y se arranca con `packages/graph/src/mcp/main.ts`,
 *     no importando `@coord/graph` desde otro paquete.
 */
export * from './queries.js'
export * from './claims.js'
export * from './parse/index.js'
export * from './ingest/index.js'
export * from './build/index.js'
export * from './cochange/index.js'
export * from './checkout.js'
export * from './ownership/index.js'
