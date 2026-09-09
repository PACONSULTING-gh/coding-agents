import { access } from 'node:fs/promises'

import { requireTenant, type JobEnvelope, type QueuePort } from '@coord/core'
import type { GithubWebhookJob } from '@coord/github'
import { indexRepository, resolveCheckoutPath } from '@coord/graph'
import type { Logger } from 'pino'

import type { DomainEventHandler } from './github-events.js'

/**
 * Enganche de la ingesta del grafo (epic 02, T02 y T03) al evento `push`.
 *
 * ---------------------------------------------------------------------------
 * POR QUE DOS SALTOS Y NO UNO
 * ---------------------------------------------------------------------------
 * El handler del webhook NO indexa: encola. Indexar un repositorio tarda
 * segundos y el handler de `push` corre dentro de la transaccion del tenant que
 * escribe la entrada de auditoria; hacerlo ahi tendria esa transaccion abierta
 * durante toda la ingesta. Se encola un job propio, con su cola, sus reintentos
 * y su arriendo. Es el mismo reparto que ya hace apps/webhook con el listener.
 *
 * ---------------------------------------------------------------------------
 * DE DONDE SALE EL CODIGO
 * ---------------------------------------------------------------------------
 * De un directorio de trabajo local (`GRAPH_CHECKOUT_ROOT`), con la forma
 * `<raiz>/<owner>/<repo>`. Clonar y actualizar checkouts NO es de esta tarea:
 * si la raiz no esta configurada, el enganche NO se registra y se dice por el
 * log. Es una decision explicita y visible, no un fallo silencioso.
 *
 * ---------------------------------------------------------------------------
 * LAS TRES CAPAS DEL GRAFO SE INGIEREN EN EL MISMO JOB
 * ---------------------------------------------------------------------------
 * `ingestRepository` (T02, aristas estaticas de tree-sitter), `ingestBuildGraph`
 * (T03, Nx/Turborepo, `source: 'build'`) e `ingestCochange` (T03, historial de
 * git, `source: 'git'`). Las tres con el MISMO `repoId` derivado de
 * `(tenantId, owner/repo)`, que es lo que hace que las tres senales convivan en
 * el mismo grafo y salgan por las mismas consultas de T01.
 *
 * Van en orden y en el mismo job a proposito: las aristas de build y de
 * co-cambio se resuelven contra los nodos `file`/`target` que acaba de escribir
 * la ingesta estatica, asi que correrlas antes seria inutil.
 *
 * Si alguna de las dos falla, el job falla: NO se traga el error (CLAUDE.md 5).
 * "No hay Nx ni Turborepo en este repo" no es un fallo —`detectBuildTools`
 * devuelve una lista vacia y no se ejecuta nada—, pero "hay `nx.json` y `nx`
 * revienta" si lo es, y hay que enterarse.
 */

export const GRAPH_INGEST_QUEUE = 'graph.ingest'

export interface GraphIngestJob {
  /** `owner/repo`, tal cual lo manda GitHub. */
  readonly repository: string
  readonly commitSha: string
}

/**
 * Handler de dominio del evento `push`. Solo encola: nada de logica de dominio
 * extra (el alcance de T02 termina aqui).
 */
export function createPushIngestionHandler(queue: QueuePort, logger: Logger): DomainEventHandler {
  return async (_tx, job: GithubWebhookJob): Promise<void> => {
    const payload = describePush(job)
    if (payload === undefined) {
      // Un push de borrado de rama (o sin repositorio) no tiene nada que
      // indexar. Se dice en el log en vez de desaparecer sin dejar rastro.
      logger.debug({ deliveryId: job.deliveryId }, 'push sin nada que indexar en el grafo')
      return
    }
    await queue.enqueue<GraphIngestJob>(GRAPH_INGEST_QUEUE, payload, {
      // Una ingesta de un repo grande tarda; sin un arriendo holgado la cola la
      // daria por abandonada y la relanzaria encima de si misma.
      expireInSeconds: 900,
      retryLimit: 3,
      retryBackoff: true,
    })
  }
}

/**
 * `repository.full_name` y `after` vienen de GitHub: frontera de confianza. Se
 * comprueban antes de usarlos. Un `push` de borrado de rama trae `after` a
 * ceros y no hay nada que indexar.
 */
function describePush(job: GithubWebhookJob): GraphIngestJob | undefined {
  const repository = job.payload['repository']
  const fullName =
    typeof repository === 'object' && repository !== null
      ? (repository as Record<string, unknown>)['full_name']
      : undefined
  const after = job.payload['after']

  if (typeof fullName !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) return undefined
  if (typeof after !== 'string' || !/^[0-9a-f]{7,40}$/.test(after)) return undefined
  if (/^0+$/.test(after)) return undefined

  return { repository: fullName, commitSha: after }
}

function assertIngestJob(payload: unknown): GraphIngestJob {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('El job de ingesta del grafo no es un objeto.')
  }
  const candidate = payload as Record<string, unknown>
  const repository = candidate['repository']
  const commitSha = candidate['commitSha']
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('El job de ingesta del grafo no trae un repositorio valido.')
  }
  if (typeof commitSha !== 'string' || !/^[0-9a-f]{7,40}$/.test(commitSha)) {
    throw new Error('El job de ingesta del grafo no trae un commit valido.')
  }
  return { repository, commitSha }
}

/**
 * `resolveCheckoutPath` vive en `@coord/graph` (packages/graph/src/checkout.ts):
 * la necesita tambien `packages/graph/src/mcp/` (T05, `who_last_touched`), y
 * la comprobacion de path traversal no se duplica. Se re-exporta desde aqui
 * para no romper a quien la importaba de este modulo.
 */
export { resolveCheckoutPath } from '@coord/graph'

export function createGraphIngestJobHandler(options: {
  checkoutRoot: string
  logger: Logger
}): (envelope: JobEnvelope<unknown>) => Promise<void> {
  return async (envelope: JobEnvelope<unknown>): Promise<void> => {
    const job = assertIngestJob(envelope.payload)
    const repoPath = resolveCheckoutPath(options.checkoutRoot, job.repository)
    await access(repoPath)

    const { tenantId } = requireTenant()

    // La secuencia vive en @coord/graph y la comparte con el comando manual
    // (`graph:index`). Si se anade una cuarta senal, entra por un solo sitio.
    const {
      repoId,
      static: result,
      build,
      cochange,
    } = await indexRepository({
      repository: job.repository,
      repoPath,
      commitSha: job.commitSha,
    })

    options.logger.info(
      {
        jobId: envelope.id,
        tenantId,
        repoId,
        repository: job.repository,
        ...result,
        build,
        cochange,
      },
      'Ingesta del grafo terminada',
    )
  }
}

/** Registra el procesador de la cola de ingesta. */
export async function registerGraphIngestionHandlers(
  queue: QueuePort,
  logger: Logger,
  options: { checkoutRoot: string },
): Promise<void> {
  await queue.process(
    GRAPH_INGEST_QUEUE,
    createGraphIngestJobHandler({ checkoutRoot: options.checkoutRoot, logger }),
  )
}
