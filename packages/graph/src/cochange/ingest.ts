import { uuidSchema, ValidationError } from '@coord/core'
import { withTenantConnection } from '@coord/db'
import { z } from 'zod'

import { listCochangeCommits } from './git.js'
import { DEFAULT_MAX_FILES_PER_COMMIT, DEFAULT_MIN_COCHANGES, mineCochangePairs } from './mine.js'
import { deleteCochangeEdges, insertCochangeEdges, resolveFileNodeIds } from './store.js'

/** Meses de historial por defecto. Ver la cabecera de `git.ts`: ventana de tiempo, no de commits. */
export const DEFAULT_SINCE_MONTHS = 6

const inputSchema = z.object({
  repoId: uuidSchema,
  /** Directorio del repositorio en disco. Tiene que ser un repositorio git. */
  repoPath: z.string().min(1),
  minCochanges: z.number().int().min(1).default(DEFAULT_MIN_COCHANGES),
  maxFilesPerCommit: z.number().int().min(1).default(DEFAULT_MAX_FILES_PER_COMMIT),
  sinceMonths: z.number().int().min(1).default(DEFAULT_SINCE_MONTHS),
})

export type IngestCochangeInput = z.input<typeof inputSchema>

export interface CochangeIngestionResult {
  readonly commitsConsidered: number
  readonly commitsSkippedGiant: number
  readonly pairsFound: number
  readonly edgesInserted: number
  /** Pares cuyos dos ficheros (o uno de ellos) no tienen nodo `file` en el grafo. */
  readonly unresolvedPairs: number
}

/**
 * Overlay de co-cambio completo: git -> minado -> resolucion a nodos ->
 * escritura. Exige contexto de tenant activo, igual que `ingestRepository` de
 * T02 y por el mismo motivo: todo el acceso pasa por `withTenantConnection`.
 *
 * Depende, en la practica, de que T02 ya haya indexado el repo: solo crea
 * aristas entre ficheros que YA tienen nodo `file` (ver `store.ts`). Correrlo
 * antes de la primera ingesta estatica es inofensivo pero inutil: no habria
 * ningun nodo `file` contra el que resolver, y `unresolvedPairs` lo diria.
 */
export async function ingestCochange(input: IngestCochangeInput): Promise<CochangeIngestionResult> {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError(`Entrada invalida para ingestCochange: ${parsed.error.message}`, {
      cause: parsed.error,
    })
  }
  const { repoId, repoPath, minCochanges, maxFilesPerCommit, sinceMonths } = parsed.data

  const commits = await listCochangeCommits(repoPath, { sinceMonths })
  const mined = mineCochangePairs(commits, { minCochanges, maxFilesPerCommit })

  const paths = new Set<string>()
  for (const pair of mined.pairs) {
    paths.add(pair.a)
    paths.add(pair.b)
  }

  return withTenantConnection(async (tx) => {
    const nodeIds = await resolveFileNodeIds(tx, repoId, [...paths])
    await deleteCochangeEdges(tx, repoId)

    const edges: { fromId: string; toId: string; stat: (typeof mined.pairs)[number] }[] = []
    let unresolvedPairs = 0
    for (const pair of mined.pairs) {
      const idA = nodeIds.get(pair.a)
      const idB = nodeIds.get(pair.b)
      if (idA === undefined || idB === undefined) {
        unresolvedPairs += 1
        continue
      }
      // Los dos sentidos: ver "DECISION" en `store.ts` (co-cambio es simetrico).
      edges.push({ fromId: idA, toId: idB, stat: pair })
      edges.push({ fromId: idB, toId: idA, stat: pair })
    }

    const edgesInserted = await insertCochangeEdges(tx, repoId, edges)

    return {
      commitsConsidered: mined.commitsConsidered,
      commitsSkippedGiant: mined.commitsSkippedGiant,
      pairsFound: mined.pairs.length,
      edgesInserted,
      unresolvedPairs,
    }
  })
}
