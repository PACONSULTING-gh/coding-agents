import { randomUUID } from 'node:crypto'

import { runWithTenant, type JobEnvelope } from '@coord/core'
import {
  closeDatabase,
  configureDatabase,
  findInstallationRouting,
  readAuditLog,
  upsertInstallation,
  withTenantConnection,
} from '@coord/db'
import type { GithubWebhookJob } from '@coord/github'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createGithubEventHandler } from '../src/github-events.js'
import { startDatabase, type StartedDatabase } from '../../../packages/db/test/support/database.js'

/**
 * El worker se prueba contra un PostgreSQL DE VERDAD: lo que hace es escribir
 * en `audit_log` (append-only, bajo RLS) y actualizar `github_installations`,
 * y ambas cosas SON comportamiento del motor. Con un doble solo se comprobaria
 * que el doble hace lo que le hemos dicho (CLAUDE.md 5).
 *
 * El handler se invoca directamente dentro de `runWithTenant`, que es
 * exactamente lo que hace `QueuePort.process` antes de llamarlo (contrato
 * documentado en packages/core/src/ports/queue.ts). Asi el test mide el
 * comportamiento del handler sin arrastrar el ciclo de vida de la cola, que ya
 * tiene sus propios tests en packages/queue.
 */

const INSTALLATION_ID = 77_000_111
const logger = pino({ level: 'silent' })
const handle = createGithubEventHandler(logger)

let database: StartedDatabase
let tenantId: string
let otherTenantId: string

function envelope(payload: unknown, tenant: string): JobEnvelope<unknown> {
  return {
    id: randomUUID(),
    name: 'github.issues',
    payload,
    tenantId: tenant,
    retryCount: 0,
    createdAt: new Date(),
  }
}

function webhookJob(overrides: Partial<GithubWebhookJob> = {}): GithubWebhookJob {
  return {
    deliveryId: randomUUID(),
    event: 'issues',
    action: 'opened',
    installationId: INSTALLATION_ID,
    payload: {
      action: 'opened',
      repository: { full_name: 'PACONSULTING-gh/coord' },
      sender: { login: 'una-persona' },
      installation: { id: INSTALLATION_ID },
    },
    ...overrides,
  }
}

async function createTenant(name: string): Promise<string> {
  const id = randomUUID()
  await runWithTenant({ tenantId: id }, () =>
    withTenantConnection((tx) =>
      tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        id,
        name,
        `${name}-${id.slice(0, 8)}`,
      ]),
    ),
  )
  return id
}

beforeAll(async () => {
  database = await startDatabase()
  configureDatabase({
    connectionString: database.runtimeUrl,
    applicationName: 'coord-worker-test',
    allowExitOnIdle: true,
  })

  tenantId = await createTenant('liberion')
  otherTenantId = await createTenant('otro-cliente')

  await runWithTenant({ tenantId }, () =>
    withTenantConnection((tx) =>
      upsertInstallation(tx, {
        installationId: INSTALLATION_ID,
        accountLogin: 'PACONSULTING-gh',
        accountType: 'Organization',
        repositorySelection: 'all',
      }),
    ),
  )
}, 180_000)

afterAll(async () => {
  await closeDatabase()
  await database?.container.stop()
})

describe('1. persistencia del evento en audit_log', () => {
  it('escribe el evento en el tenant del job', async () => {
    const job = webhookJob()

    await runWithTenant({ tenantId }, () => handle(envelope(job, tenantId)))

    const page = await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) => readAuditLog(tx, { actions: ['github.webhook.issues'] })),
    )
    const entry = page.entries.find((row) => row.resourceId === job.deliveryId)
    expect(entry, 'no se registro el evento').toBeDefined()
    expect(entry?.tenantId).toBe(tenantId)
    expect(entry?.actorType).toBe('system')
    expect(entry?.requestId).toBe(job.deliveryId)
    expect(entry?.metadata).toMatchObject({
      event: 'issues',
      action: 'opened',
      installationId: INSTALLATION_ID,
      repository: 'PACONSULTING-gh/coord',
      sender: 'una-persona',
    })
  })

  it('ese registro NO lo ve otro tenant', async () => {
    const job = webhookJob()
    await runWithTenant({ tenantId }, () => handle(envelope(job, tenantId)))

    const page = await runWithTenant({ tenantId: otherTenantId }, () =>
      withTenantConnection((tx) => readAuditLog(tx, { actions: ['github.webhook.issues'] })),
    )
    expect(page.entries.some((row) => row.resourceId === job.deliveryId)).toBe(false)
  })

  it('rechaza un job mal formado en vez de procesarlo a medias', async () => {
    await expect(
      runWithTenant({ tenantId }, () => handle(envelope({ event: 'issues' }, tenantId))),
    ).rejects.toThrow(/deliveryId/i)

    await expect(
      runWithTenant({ tenantId }, () =>
        handle(envelope({ ...webhookJob(), event: 'gollum' }, tenantId)),
      ),
    ).rejects.toThrow(/evento no suscrito/i)
  })
})

describe('2. eventos de instalacion', () => {
  function installationJob(action: string, suspendedAt: string | null): GithubWebhookJob {
    return webhookJob({
      event: 'installation',
      action,
      payload: {
        action,
        installation: {
          id: INSTALLATION_ID,
          account: { login: 'PACONSULTING-gh', type: 'Organization' },
          repository_selection: 'all',
          suspended_at: suspendedAt,
        },
      },
    })
  }

  it('suspend marca la instalacion como suspendida y unsuspend la devuelve', async () => {
    const suspendedAt = '2026-09-08T09:30:00.000Z'

    await runWithTenant({ tenantId }, () =>
      handle(envelope(installationJob('suspend', suspendedAt), tenantId)),
    )
    expect((await findInstallationRouting(INSTALLATION_ID))?.suspendedAt).toEqual(
      new Date(suspendedAt),
    )

    await runWithTenant({ tenantId }, () =>
      handle(envelope(installationJob('unsuspend', null), tenantId)),
    )
    expect((await findInstallationRouting(INSTALLATION_ID))?.suspendedAt).toBeNull()
  })

  it('deleted borra el mapeo, y a partir de ahi la instalacion no enruta', async () => {
    const doomed = 88_000_222
    await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) =>
        upsertInstallation(tx, {
          installationId: doomed,
          accountLogin: 'cliente-que-se-va',
          accountType: 'Organization',
          repositorySelection: 'selected',
        }),
      ),
    )
    await expect(findInstallationRouting(doomed)).resolves.toBeDefined()

    await runWithTenant({ tenantId }, () =>
      handle(
        envelope(
          webhookJob({
            event: 'installation',
            action: 'deleted',
            installationId: doomed,
            payload: {
              action: 'deleted',
              installation: {
                id: doomed,
                account: { login: 'cliente-que-se-va', type: 'Organization' },
                repository_selection: 'selected',
                suspended_at: null,
              },
            },
          }),
          tenantId,
        ),
      ),
    )

    await expect(findInstallationRouting(doomed)).resolves.toBeUndefined()
  })
})
