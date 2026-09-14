import { randomUUID } from 'node:crypto'

import {
  runWithTenant,
  type Claim,
  type EscalationNotice,
  type LlmPort,
  type LlmResult,
  type NotificationPort,
} from '@coord/core'
import {
  approveCriteria,
  closeDatabase,
  configureDatabase,
  readCriteria,
  setCriteria,
  withTenantConnection,
} from '@coord/db'
import type { GithubWebhookJob } from '@coord/github'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { runVerificationTrigger } from '../src/verification-trigger-run.js'

import { startDatabase, type StartedDatabase } from '../../../packages/db/test/support/database.js'

/**
 * El disparador de la verificacion (epic 05).
 *
 * Lo que se comprueba aqui es lo que la decision pura no puede: que un PR de
 * una tarea SIN criterios aprobados se omita en vez de reventar, y que cuando
 * si los tiene, la maquinaria entera se ponga en marcha.
 */

const logger = pino({ level: 'silent' })
let database: StartedDatabase
let tenantId: string
let actorId: string
const REPO_ID = randomUUID()
const SHA = 'b'.repeat(40)

class NotificadorDePrueba implements NotificationPort {
  readonly avisos: EscalationNotice[] = []
  async notifyEscalation(notice: EscalationNotice): Promise<void> {
    this.avisos.push(notice)
    return Promise.resolve()
  }
}

beforeAll(async () => {
  database = await startDatabase()
  configureDatabase({ connectionString: database.runtimeUrl })
  tenantId = randomUUID()
  actorId = randomUUID()
  await runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      await tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        'trigger',
        `trigger-${tenantId.slice(0, 8)}`,
      ])
      await tx.query(
        'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
        [actorId, tenantId, `lead-${actorId.slice(0, 8)}@ejemplo.test`, 'Lead'],
      )
    }),
  )
}, 120_000)

afterAll(async () => {
  await closeDatabase()
  await database?.stop()
})

let siguientePr = 5000
function prAbierto(): { job: GithubWebhookJob; taskRef: string } {
  siguientePr += 1
  return {
    taskRef: String(siguientePr),
    job: {
      deliveryId: randomUUID(),
      event: 'pull_request',
      action: 'opened',
      installationId: 1,
      payload: {
        pull_request: {
          number: siguientePr,
          state: 'open',
          draft: false,
          head: { sha: SHA },
          base: { ref: 'main' },
        },
        repository: { full_name: 'liberion-labs/crm' },
      },
    } as unknown as GithubWebhookJob,
  }
}

const CRITERIO = {
  given: 'un pago rechazado',
  when: 'se reintenta',
  then: 'queda registrado el intento',
} as const

async function criteriosAprobados(taskRef: string): Promise<string> {
  return runWithTenant({ tenantId, actorId }, async () => {
    await setCriteria({ taskRef, criteria: [CRITERIO] })
    await approveCriteria({ taskRef })
    const { criteria } = await readCriteria(taskRef)
    return criteria[0]?.id ?? ''
  })
}

function modeloQueAprueba(criterionId: string): LlmPort {
  return {
    complete: (): Promise<LlmResult> =>
      Promise.resolve({
        text: '',
        structured: {
          verdicts: [
            {
              criterionId,
              reasoning:
                'El criterio pide que quede registrado el intento; el diff introduce la llamada ' +
                'que lo registra y la salida de tests la ejercita.',
              criterionQuote: CRITERIO.then,
              evidenceSource: 'diff' as const,
              evidenceQuote: 'registrarIntento(pago)',
              verdict: 'PASS' as const,
            },
          ],
        },
        reasoningSummary: undefined,
        stopReason: 'end_turn' as const,
        model: 'modelo-de-prueba',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
  }
}

function deps(criterionId: string, overrides: Record<string, unknown> = {}) {
  const notifications = new NotificadorDePrueba()
  return {
    llm: modeloQueAprueba(criterionId),
    notifications,
    logger,
    checkoutRoot: '/tmp/checkouts',
    repoId: REPO_ID,
    testCommand: ['node', '-e', 'console.log("ok")'],
    prepareCheckout: vi.fn(() => Promise.resolve()),
    activeIssueClaims: vi.fn(() => Promise.resolve([] as Claim[])),
    issueAssignees: vi.fn(() => Promise.resolve([] as string[])),
    readDelivery: vi.fn(() =>
      Promise.resolve({
        baseSha: 'c'.repeat(40),
        headSha: SHA,
        diff: '+ registrarIntento(pago)\n',
        testRun: { command: 'node -e ...', exitCode: 0, output: '1 passed' },
      }),
    ),
    ...overrides,
  }
}

describe('sin criterios aprobados se OMITE, no se revienta', () => {
  it('y no se toca el checkout ni se llama al modelo', async () => {
    // Aqui llegan TODOS los PR del repositorio, y hoy casi ninguno viene de
    // una tarea que haya pasado por la fase de criterios. Convertir eso en
    // una excepcion por cada PR llenaria el log de errores que nadie puede
    // arreglar.
    const { job } = prAbierto()
    const d = deps('x')
    const espia = vi.spyOn(d.llm, 'complete')

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      runVerificationTrigger(job, d),
    )

    expect(resultado).toMatchObject({ kind: 'skipped' })
    expect(d.prepareCheckout).not.toHaveBeenCalled()
    expect(espia).not.toHaveBeenCalled()
  }, 120_000)

  it('con criterios escritos pero SIN aprobar, tambien se omite', async () => {
    const { job, taskRef } = prAbierto()
    await runWithTenant({ tenantId, actorId }, () => setCriteria({ taskRef, criteria: [CRITERIO] }))
    const d = deps('x')

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      runVerificationTrigger(job, d),
    )

    expect(resultado).toMatchObject({ kind: 'skipped', reason: 'criterios_not_approved' })
  }, 120_000)
})

describe('con criterios aprobados, se verifica de verdad', () => {
  it('se prepara el checkout y la tarea acaba hecha', async () => {
    const { job, taskRef } = prAbierto()
    const criterionId = await criteriosAprobados(taskRef)
    const d = deps(criterionId)

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      runVerificationTrigger(job, d),
    )

    expect(resultado).toMatchObject({ kind: 'verified', taskRef, state: 'done' })
    // El checkout se deja en la CABEZA del PR, no en la rama base.
    expect(d.prepareCheckout).toHaveBeenCalledWith(
      '/tmp/checkouts/liberion-labs/crm',
      expect.objectContaining({ headSha: SHA }),
    )
  }, 120_000)

  it('un borrador ni siquiera mira los criterios', async () => {
    const { job } = prAbierto()
    const conBorrador = {
      ...job,
      payload: {
        ...job.payload,
        pull_request: {
          ...(job.payload['pull_request'] as Record<string, unknown>),
          draft: true,
        },
      },
    } as unknown as GithubWebhookJob
    const d = deps('x')

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      runVerificationTrigger(conBorrador, d),
    )

    expect(resultado).toEqual({ kind: 'skipped', reason: 'draft' })
    expect(d.prepareCheckout).not.toHaveBeenCalled()
  }, 120_000)
})

describe('el checkout tiene que existir', () => {
  it('si prepararlo falla, se PROPAGA en vez de dar la tarea por no verificable', async () => {
    // Clonar no es de esta tarea. Un fallo de infraestructura no puede
    // convertirse en un veredicto sobre el trabajo de alguien.
    const { job, taskRef } = prAbierto()
    const criterionId = await criteriosAprobados(taskRef)
    const d = deps(criterionId, {
      prepareCheckout: () =>
        Promise.reject(new Error('no existe el checkout de liberion-labs/crm')),
    })

    await expect(
      runWithTenant({ tenantId, actorId }, () => runVerificationTrigger(job, d)),
    ).rejects.toThrow(/no existe el checkout/)
  }, 120_000)
})
