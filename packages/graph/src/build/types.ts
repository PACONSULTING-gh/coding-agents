/**
 * Esquema comun al que se normaliza CUALQUIER grafo nativo de build (Nx,
 * Turborepo, ...) antes de escribirlo. El motor de escritura (`store.ts`) y el
 * orquestador (`ingest.ts`) no saben nada de la forma real del JSON de cada
 * herramienta: eso vive en `nx.ts` / `turborepo.ts`, igual que `src/parse/`
 * mantiene el motor de ingesta estatica ajeno a tree-sitter.
 */

/** Herramientas de build soportadas. Bazel NO esta aqui: ver la cabecera de `detect.ts`. */
export const BUILD_TOOLS = ['nx', 'turborepo'] as const
export type BuildTool = (typeof BUILD_TOOLS)[number]

/**
 * Un proyecto/paquete del grafo de build. Se escribe como nodo `target`
 * (esquema de la migracion 0007): `path` es su directorio raiz dentro del
 * repo, `name` su nombre dentro de la herramienta de build.
 */
export interface BuildProjectRef {
  readonly name: string
  /** Raiz del proyecto, relativa a la raiz del repo. */
  readonly path: string
  /** Informativo (`app`/`lib`/`e2e` en Nx; `null` cuando la herramienta no lo distingue). */
  readonly projectType: string | null
}

/** `from` depende de `to`, igual que en `graph_edges`. */
export interface BuildDependency {
  readonly from: string
  readonly to: string
  /** Tal cual lo reporta la herramienta (`static`/`dynamic`/`implicit` en Nx...). Informativo. */
  readonly dependencyType: string
}

export interface NormalizedBuildGraph {
  readonly tool: BuildTool
  readonly projects: readonly BuildProjectRef[]
  readonly dependencies: readonly BuildDependency[]
}
