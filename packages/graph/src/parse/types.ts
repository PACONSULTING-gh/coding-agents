/**
 * Contrato comun de los parsers de lenguaje.
 *
 * ---------------------------------------------------------------------------
 * ANADIR UN LENGUAJE ES ANADIR UN FICHERO
 * ---------------------------------------------------------------------------
 * El motor de ingesta (`src/ingest/`) no sabe nada de tree-sitter ni de ningun
 * lenguaje concreto: solo consume `LanguageParser`. Un lenguaje nuevo se anade
 * escribiendo un modulo en `src/parse/` que exporte un `LanguageParser` y
 * registrandolo en `src/parse/index.ts`. No se toca el motor.
 *
 * Lo que devuelve un parser esta YA normalizado al esquema de la migracion
 * 0007 (nodos `file`/`symbol`/`package`, aristas `imports`/`contains`/`calls`/
 * `inherits`), pero SIN resolver a ids: la resolucion a nodos y el acceso a la
 * base de datos son del motor. Asi un parser se puede probar sin Postgres.
 */

/** Clase de simbolo. Informativa: viaja en `graph_nodes.metadata`. */
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum'

export interface ParsedSymbol {
  /** Nombre tal cual aparece en el codigo. Es parte de la clave natural del nodo. */
  readonly name: string
  readonly symbolKind: SymbolKind
}

/**
 * Como queda ligado en ESTE fichero un nombre que viene de otro modulo. Es lo
 * que permite resolver `foo()` a un simbolo de OTRO fichero sin adivinar.
 *
 *   - `named`      `import { a as b }` / `from m import a as b` -> `imported` es 'a'.
 *   - `default`    `import a from 'm'` -> no sabemos que nombre tiene 'a' en el
 *                  modulo de origen, asi que NO se resuelve a un simbolo.
 *   - `namespace`  `import * as ns` / `import a.b as ab` -> `ns.foo` se resuelve
 *                  buscando el simbolo `foo` en el modulo de origen.
 */
export interface ImportBinding {
  readonly local: string
  readonly imported: string | null
  readonly kind: 'named' | 'default' | 'namespace'
}

export interface ParsedImport {
  /** Especificador tal cual aparece en el codigo: './x.js', 'pg', '..pkg.sub'. */
  readonly specifier: string
  readonly bindings: readonly ImportBinding[]
}

/** Referencia a un nombre (una llamada, o una clase base). */
export interface ParsedReference {
  /**
   * Simbolo de nivel superior de este fichero desde el que sale la referencia.
   * `null` significa "a nivel de fichero" (fuera de cualquier declaracion).
   */
  readonly from: string | null
  /** Nombre referenciado. */
  readonly name: string
  /** Namespace por el que se accede (`ns` en `ns.foo()`), si lo hay. */
  readonly namespace: string | null
}

export interface ParsedFile {
  readonly symbols: readonly ParsedSymbol[]
  readonly imports: readonly ParsedImport[]
  readonly calls: readonly ParsedReference[]
  readonly inherits: readonly ParsedReference[]
}

/**
 * A que apunta un especificador de import.
 *
 * `unresolved` NO es un fallo del parser: es la respuesta correcta cuando no se
 * puede saber a que fichero apunta. El motor lo cuenta y NO crea arista. Un
 * grafo con aristas fantasma es peor que uno incompleto, porque nadie sabe
 * cuales creerse.
 */
export type ResolvedSpecifier =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'unresolved' }

export const UNRESOLVED: ResolvedSpecifier = { kind: 'unresolved' }

/** Conjunto de rutas (relativas a la raiz del repo, con `/`) que existen en el repo. */
export type RepoFileIndex = ReadonlySet<string>

export interface LanguageParser {
  /** Valor de `graph_nodes.language` / `graph_files.language`. Minusculas. */
  readonly language: string
  /** Extensiones que atiende, con punto y en minusculas. */
  readonly extensions: readonly string[]
  parse(source: string, path: string): ParsedFile
  /**
   * Resolucion de especificadores. Es especifica del lenguaje (las reglas de
   * Node no son las de Python) y por eso vive en el parser y no en el motor.
   */
  resolveSpecifier(specifier: string, fromPath: string, files: RepoFileIndex): ResolvedSpecifier
}
