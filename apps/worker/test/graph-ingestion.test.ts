import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type { EnqueueOptions, QueuePort } from '@coord/core'
import type { TenantQuery } from '@coord/db'
import type { GithubWebhookJob } from '@coord/github'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'

import {
  GRAPH_INGEST_QUEUE,
  createPushIngestionHandler,
  resolveCheckoutPath,
} from '../src/graph-ingestion.js'

/**
 * Alcance de este test: el ENGANCHE. Que la ingesta de verdad funcione se
 * prueba en `packages/graph`, contra Postgres y repositorios git reales; aqui
 * lo unico que se comprueba es que un `push` acaba encolando el trabajo con el
 * payload correcto, que un `push` sin nada que indexar no encola nada, y que la
 * resolucion del checkout no deja escapar de su raiz.
 *
 * La cola se sustituye por un doble porque `QueuePort` es NUESTRO contrato, no
 * un sistema de terceros: lo que se mide es que este handler lo usa bien
 * (CLAUDE.md 5 prohibe mockear lo que no controlas, no lo que si).
 */

const logger = pino({ level: 'silent' })

interface Enqueued {
  readonly name: string
  readonly payload: unknown
  readonly options: EnqueueOptions | undefined
}

class RecordingQueue implements QueuePort {
  readonly enqueued: Enqueued[] = []

  enqueue<T>(name: string, payload: T, opts?: EnqueueOptions): Promise<string> {
    this.enqueued.push({ name, payload, options: opts })
    return Promise.resolve(randomUUID())
  }
  process(): Promise<void> {
    return Promise.resolve()
  }
  schedule(): Promise<void> {
    return Promise.resolve()
  }
  start(): Promise<void> {
    return Promise.resolve()
  }
  stop(): Promise<void> {
    return Promise.resolve()
  }
}

/** El handler de `push` solo encola: si tocase la base, este doble lo delata. */
const noTransaction: TenantQuery = {
  tenantId: randomUUID(),
  query: () => {
    throw new Error('El handler de push no debe consultar la base de datos: solo encola.')
  },
}

function pushJob(payload: Record<string, unknown>): GithubWebhookJob {
  return {
    deliveryId: randomUUID(),
    event: 'push',
    action: null,
    installationId: 12_345,
    payload,
  }
}

describe('el evento push encola una ingesta del grafo', () => {
  it('encola con el repositorio y el commit del payload', async () => {
    const queue = new RecordingQueue()
    await createPushIngestionHandler(queue, logger)(
      noTransaction,
      pushJob({
        repository: { full_name: 'PACONSULTING-gh/coding-agents' },
        after: 'a'.repeat(40),
      }),
    )

    expect(queue.enqueued).toHaveLength(1)
    expect(queue.enqueued[0]?.name).toBe(GRAPH_INGEST_QUEUE)
    expect(queue.enqueued[0]?.payload).toEqual({
      repository: 'PACONSULTING-gh/coding-agents',
      commitSha: 'a'.repeat(40),
    })
    // Una ingesta tarda: sin arriendo holgado la cola la daria por abandonada
    // y la relanzaria encima de si misma.
    expect(queue.enqueued[0]?.options?.expireInSeconds).toBeGreaterThanOrEqual(600)
  })

  it('un push de borrado de rama no encola nada', async () => {
    const queue = new RecordingQueue()
    await createPushIngestionHandler(queue, logger)(
      noTransaction,
      pushJob({
        repository: { full_name: 'PACONSULTING-gh/coding-agents' },
        after: '0'.repeat(40),
      }),
    )
    expect(queue.enqueued).toEqual([])
  })

  it('un payload sin repositorio reconocible no encola nada', async () => {
    const queue = new RecordingQueue()
    await createPushIngestionHandler(queue, logger)(
      noTransaction,
      pushJob({ repository: { full_name: 42 }, after: 'a'.repeat(40) }),
    )
    expect(queue.enqueued).toEqual([])
  })
})

describe('el checkout no puede salirse de su raiz', () => {
  it('resuelve owner/repo dentro de la raiz', () => {
    expect(resolveCheckoutPath('/srv/checkouts', 'owner/repo')).toBe(
      path.join('/srv/checkouts', 'owner', 'repo'),
    )
  })

  it('rechaza un nombre que escapa de la raiz', () => {
    expect(() => resolveCheckoutPath('/srv/checkouts', '../../etc/passwd')).toThrow(
      'caeria fuera de',
    )
  })
})
