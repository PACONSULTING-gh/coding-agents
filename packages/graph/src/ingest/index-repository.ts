import { requireTenant } from '@coord/core'

import { ingestBuildGraph, type BuildIngestionResult } from '../build/ingest.js'
import { ingestCochange, type CochangeIngestionResult } from '../cochange/ingest.js'

import { ingestRepository, type IngestionResult } from './ingest.js'
import { repoIdForRepository } from './repo-id.js'

/**
 * Indexar un repositorio entero: aristas estaticas, grafo de build y co-change.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTO EXISTE
 * ---------------------------------------------------------------------------
 * Habia DOS sitios que necesitaban "indexar un repo": el handler del job de
 * `apps/worker` (cuando llega un push) y el comando de linea que un
 * desarrollador corre a mano. Duplicar la secuencia significaba que el dia que
 * se anada una cuarta senal, una de las dos se quedaria atras sin que nadie se
 * entere — y la que se quedaria atras es siempre la que menos se usa.
 *
 * El `repo_id` se DERIVA del tenant y del `owner/repo` (ver `repo-id.ts`), no se
 * inventa: por eso el grafo que escribe el comando manual es exactamente el
 * mismo que consulta el servidor MCP, sin necesidad de pasarse ids a mano.
 *
 * El contexto de tenant lo toma de `requireTenant()`: llamar a esto fuera de
 * `runWithTenant` lanza, en vez de escribir un grafo huerfano.
 */
export interface IndexRepositoryInput {
  /** Identidad logica del repositorio, `owner/repo`. Es de donde sale el repo_id. */
  repository: string
  /** Directorio del checkout en disco. Tiene que ser un repositorio git. */
  repoPath: string
  /** Por defecto, HEAD del checkout. */
  commitSha?: string
}

export interface IndexRepositoryResult {
  /** Derivado de forma determinista; es el que usa el servidor MCP. */
  repoId: string
  /** Aristas estaticas de tree-sitter (`source: 'static'`). */
  static: IngestionResult
  /**
   * Un resultado por herramienta de build detectada. **Lista vacia es el caso
   * normal**: significa que el repositorio no usa Nx ni Turborepo, no que algo
   * haya fallado.
   */
  build: readonly BuildIngestionResult[]
  /** Aristas de co-cambio minadas del historial (`source: 'git'`). */
  cochange: CochangeIngestionResult
}

export async function indexRepository(input: IndexRepositoryInput): Promise<IndexRepositoryResult> {
  const { tenantId } = requireTenant()
  const repoId = repoIdForRepository(tenantId, input.repository)

  // Orden deliberado: las estaticas primero, porque son las que crean los nodos
  // de fichero contra los que se resuelven las otras dos senales.
  const staticResult = await ingestRepository({
    repoId,
    repoPath: input.repoPath,
    ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
  })
  const build = await ingestBuildGraph({ repoId, repoPath: input.repoPath })
  const cochange = await ingestCochange({ repoId, repoPath: input.repoPath })

  return { repoId, static: staticResult, build, cochange }
}
