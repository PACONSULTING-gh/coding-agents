import { randomUUID } from 'node:crypto'

import {
  runWithTenant,
  type Claim,
  type EscalationNotice,
  type NotificationPort,
} from '@coord/core'
import {
  approveCriteria,
  closeDatabase,
  configureDatabase,
  setCriteria,
  withTenantConnection,
} from '@coord/db'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { completeVerificationPass } from '../src/verification-pass.js'

import { startDatabase, type StartedDatabase } from '../../../packages/db/test/support/database.js'

/**
 * El lazo entero de T06: hechos de una pasada -> modo -> responsable ->
 * estado persistido y aviso.
 *
 * Lo que se comprueba aqui es lo que ninguna pieza puede comprobar sola: que la
 * clasificacion y la resolucion del responsable LLEGAN al aviso sin perderse
 * por el camino. Cada pieza tiene sus propios tests: la regla del flujo y la
 * clasificacion, puras en `packages/core`; la cadena de responsable, sin base
 * de datos en `responsible.test.ts`.
 */

const logger = pino({ level: 'silent' })

class NotificadorDePrueba implements NotificationPort {
  readonly avisos: EscalationNotice[] = []
  async notifyEscalation(notice: EscalationNotice): Promise<void> {
    this.avisos.push(notice)
    return Promise.resolve()
  }
}

let database: StartedDatabase
let tenantId: string
let actorId: string
const REPO_ID = randomUUID()

beforeAll(async () => {
  database = await startDatabase()
  configureDatabase({ connectionString: database.runtimeUrl })

  tenantId = randomUUID()
  actorId = randomUUID()
  await runWithTenant({ tenantId, actorId }, () =>
    withTenantConnection(async (tx) => {
      await tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        'lazo',
        `lazo-${tenantId.slice(0, 8)}`,
      ])
      // Revocar la aprobacion de criterios exige un `users.id` del tenant: el
      // tercer criterio de T01 quiere saber QUIEN los toca.
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

function nuevaTarea(): string {
  return `issue-${String(Math.floor(Math.random() * 100_000))}`
}

function claimDe(taskRef: string, label: string): Claim {
  return {
    claimId: randomUUID(),
    groupId: randomUUID(),
    repoId: REPO_ID,
    subject: { kind: 'issue', key: taskRef },
    holder: { kind: 'user', id: randomUUID(), label },
    claimedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    releasedAt: null,
    releasedReason: null,
    metadata: {},
  }
}

function deps(overrides: {
  claims?: readonly Claim[]
  assignees?: readonly string[]
  notifications?: NotificadorDePrueba
}) {
  const notifications = overrides.notifications ?? new NotificadorDePrueba()
  return {
    notifications,
    logger,
    activeIssueClaims: vi.fn(() => Promise.resolve(overrides.claims ?? [])),
    issueAssignees: vi.fn(() => Promise.resolve(overrides.assignees ?? [])),
  }
}

describe('la clasificacion llega hasta el estado y el aviso', () => {
  it('dos FAIL seguidos: el segundo agota los intentos y avisa con el motivo del Verifier', async () => {
    const taskRef = nuevaTarea()
    const d = deps({ claims: [claimDe(taskRef, 'Ana')] })
    const facts = {
      gate: 'passed',
      verifier: {
        kind: 'verdicts',
        verdicts: [
          { criterionId: 'tc01', verdict: 'FAIL' },
          { criterionId: 'tc02', verdict: 'PASS' },
        ],
      },
    } as const

    await runWithTenant({ tenantId, actorId }, () =>
      completeVerificationPass({ taskRef, repoId: REPO_ID, facts }, d),
    )
    const segundo = await runWithTenant({ tenantId, actorId }, () =>
      completeVerificationPass({ taskRef, repoId: REPO_ID, facts }, d),
    )

    expect(segundo.row.attempts).toBe(2)
    expect(segundo.notified).toBe(true)
    // El motivo que llega al humano es el que salio de clasificar, no uno
    // generico: sin eso, el aviso no dice QUE fallo.
    expect(d.notifications.avisos.at(-1)?.detail).toContain('1 de 2 criterios')
    expect(d.notifications.avisos.at(-1)?.responsible?.label).toBe('Ana')
  }, 120_000)

  it('un fallo de infraestructura avisa YA y no gasta intento', async () => {
    const taskRef = nuevaTarea()
    const d = deps({ assignees: ['bruno'] })

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      completeVerificationPass(
        {
          taskRef,
          repoId: REPO_ID,
          facts: {
            gate: 'passed',
            verifier: { kind: 'unavailable', detail: 'se nego (reasoning_extraction)' },
          },
        },
        d,
      ),
    )

    expect(resultado.row.attempts).toBe(0)
    expect(resultado.row.state).toBe('human')
    // Y el aviso dice la causa concreta, que hoy es el issue #27.
    expect(d.notifications.avisos[0]?.detail).toContain('reasoning_extraction')
    expect(d.notifications.avisos[0]?.mention).toBe('bruno')
  }, 120_000)

  it('el SIN_EVIDENCIA repetido sobre el MISMO criterio vuelve a la fase de criterios', async () => {
    // Es la regla que solo funciona si `noEvidenceCriteria` sobrevive el
    // viaje. Si el lazo se olvidara de pasarlo, la tarea daria vueltas al
    // agente para siempre por un criterio que nadie puede observar.
    const taskRef = nuevaTarea()
    const d = deps({ claims: [claimDe(taskRef, 'Ana')] })
    // La tarea tiene criterios aprobados, como toda tarea que haya llegado a
    // verificarse: `claim()` no deja empezar sin ellos. Revocar una aprobacion
    // que no existe lanza, y con razon.
    await runWithTenant({ tenantId, actorId }, async () => {
      await setCriteria({
        taskRef,
        criteria: [
          {
            given: 'el sistema en marcha',
            when: 'llega una peticion',
            then: 'el endpoint devuelve una respuesta adecuada',
          },
        ],
      })
      await approveCriteria({ taskRef })
    })
    const facts = {
      gate: 'passed',
      verifier: {
        kind: 'verdicts',
        verdicts: [{ criterionId: 'tc-imposible', verdict: 'SIN_EVIDENCIA' }],
      },
    } as const

    const primero = await runWithTenant({ tenantId, actorId }, () =>
      completeVerificationPass({ taskRef, repoId: REPO_ID, facts }, d),
    )
    expect(primero.row.state).toBe('same_agent')

    const segundo = await runWithTenant({ tenantId, actorId }, () =>
      completeVerificationPass({ taskRef, repoId: REPO_ID, facts }, d),
    )
    expect(segundo.row.state).toBe('criteria_phase')
    expect(segundo.row.noEvidenceByCriterion).toEqual({ 'tc-imposible': 2 })
  }, 120_000)
})

describe('el responsable se resuelve tambien cuando todo va bien', () => {
  it('una pasada aprobada deja escrito quien responde, sin avisar a nadie', async () => {
    // Si solo se resolviera al fallar, la primera pasada mala no sabria a
    // quien avisar de una tarea que llevaba dias con dueño.
    const taskRef = nuevaTarea()
    const d = deps({ claims: [claimDe(taskRef, 'Ana')] })

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      completeVerificationPass(
        {
          taskRef,
          repoId: REPO_ID,
          facts: {
            gate: 'passed',
            verifier: { kind: 'verdicts', verdicts: [{ criterionId: 'tc01', verdict: 'PASS' }] },
          },
        },
        d,
      ),
    )

    expect(resultado.row.state).toBe('done')
    expect(resultado.notified).toBe(false)
    expect(resultado.row.responsible?.label).toBe('Ana')
    expect(resultado.responsible.source).toBe('claim')
  }, 120_000)
})

describe('el motivo de "sin responsable" no se pierde', () => {
  it('con varios co-asignados, el aviso lo dice en vez de afirmar que no hay nadie', async () => {
    const taskRef = nuevaTarea()
    const d = deps({ assignees: ['ana', 'bruno', 'carla'] })

    await runWithTenant({ tenantId, actorId }, () =>
      completeVerificationPass(
        {
          taskRef,
          repoId: REPO_ID,
          facts: { gate: 'failed', detail: 'el manifiesto no cuadra' },
          // Un gate fallado en el PRIMER intento vuelve al agente y no avisa.
          // Para ver el aviso hay que agotar los intentos.
          maxAttempts: 1,
        },
        d,
      ),
    )

    const aviso = d.notifications.avisos[0]
    expect(aviso?.responsible).toBeUndefined()
    expect(aviso?.unresolvedReason).toContain('3 personas asignadas')
    expect(aviso?.detail).toContain('el manifiesto no cuadra')
  }, 120_000)
})

describe('lo que NO viaja hacia el Verifier', () => {
  it('el informe va al humano y nunca de vuelta', async () => {
    // Sexto criterio de aceptacion de T06. Por este camino no hay ninguna
    // salida hacia el Verifier: `reportMarkdown` entra y acaba en el aviso.
    const taskRef = nuevaTarea()
    const d = deps({ claims: [claimDe(taskRef, 'Ana')] })

    await runWithTenant({ tenantId, actorId }, () =>
      completeVerificationPass(
        {
          taskRef,
          repoId: REPO_ID,
          reportMarkdown: '# Informe del intento anterior',
          facts: {
            gate: 'passed',
            verifier: { kind: 'verdicts', verdicts: [{ criterionId: 'tc01', verdict: 'FAIL' }] },
          },
          maxAttempts: 1,
        },
        d,
      ),
    )

    expect(d.notifications.avisos[0]?.reportMarkdown).toBe('# Informe del intento anterior')
  }, 120_000)
})

describe('lo opcional viaja si esta y no ensucia si no esta', () => {
  it('el SHA verificado llega al aviso', async () => {
    // Sin el, un aviso pegado a un issue al que despues se le empujan commits
    // no dice a que entrega se refiere — y quien lo lee decide sobre otro
    // codigo creyendo que es este.
    const taskRef = nuevaTarea()
    const d = deps({ claims: [claimDe(taskRef, 'Ana')] })
    const headSha = 'a'.repeat(40)

    await runWithTenant({ tenantId, actorId }, () =>
      completeVerificationPass(
        {
          taskRef,
          repoId: REPO_ID,
          headSha,
          maxAttempts: 1,
          facts: {
            gate: 'passed',
            verifier: { kind: 'verdicts', verdicts: [{ criterionId: 'tc01', verdict: 'FAIL' }] },
          },
        },
        d,
      ),
    )

    expect(d.notifications.avisos[0]?.headSha).toBe(headSha)
  }, 120_000)

  it('sin datos opcionales, el aviso no lleva las claves vacias', async () => {
    // La forma del aviso es el CONTRATO con los adaptadores: uno puede
    // preguntar `'headSha' in notice`. Mandar `{ headSha: undefined }` no es lo
    // mismo que no mandar la clave, y la diferencia solo se ve desde el otro
    // lado.
    const taskRef = nuevaTarea()
    const d = deps({ assignees: ['bruno'] })

    await runWithTenant({ tenantId, actorId }, () =>
      completeVerificationPass(
        {
          taskRef,
          repoId: REPO_ID,
          facts: {
            gate: 'passed',
            verifier: { kind: 'unavailable', detail: 'se cayo la red' },
          },
        },
        d,
      ),
    )

    const aviso = d.notifications.avisos[0]
    expect(Object.keys(aviso ?? {}).sort()).toEqual([
      'attempts',
      'destination',
      'detail',
      'maxAttempts',
      'mention',
      'reason',
      'responsible',
      'taskRef',
    ])
  }, 120_000)
})

describe('cero veredictos no se cuela como aprobado', () => {
  it('lanza, y no escribe estado', async () => {
    const taskRef = nuevaTarea()
    const d = deps({})

    await expect(
      runWithTenant({ tenantId, actorId }, () =>
        completeVerificationPass(
          {
            taskRef,
            repoId: REPO_ID,
            facts: { gate: 'passed', verifier: { kind: 'verdicts', verdicts: [] } },
          },
          d,
        ),
      ),
    ).rejects.toThrow(/no ha mirado nada/)

    expect(d.notifications.avisos).toEqual([])
  }, 120_000)
})
