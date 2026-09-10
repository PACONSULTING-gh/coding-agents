import { randomUUID } from 'node:crypto'

import { runWithTenant, type EscalationNotice, type NotificationPort } from '@coord/core'
import {
  approveCriteria,
  closeDatabase,
  configureDatabase,
  criteriaApprovalState,
  setCriteria,
  withTenantConnection,
} from '@coord/db'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { handleVerificationOutcome } from '../src/verification-flow.js'

import { startDatabase, type StartedDatabase } from '../../../packages/db/test/support/database.js'

/**
 * El flujo de fallo atado de punta a punta (T06, ADR 0008).
 *
 * Aqui se comprueba lo que NINGUNA de las otras dos capas puede comprobar sola:
 * que la decision se traduce en los EFECTOS correctos —revocar la aprobacion de
 * criterios, avisar o no avisar— y que se hacen en el orden correcto.
 *
 * La regla (cuantos intentos, a donde va cada modo) esta probada aparte y sin
 * base de datos en `packages/core`. No se repite aqui.
 */

const logger = pino({ level: 'silent' })

/** Doble del puerto: guarda lo que se le pidio enviar. */
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

beforeAll(async () => {
  database = await startDatabase()
  configureDatabase({ connectionString: database.runtimeUrl })

  tenantId = randomUUID()
  actorId = randomUUID()
  await runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      await tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        'flujo',
        `flujo-${tenantId.slice(0, 8)}`,
      ])
      // `approveCriteria` exige que quien aprueba sea un `users.id` del tenant.
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

describe('un fallo que el agente puede arreglar no molesta a nadie', () => {
  it('el primer FAIL vuelve al agente y NO se avisa', async () => {
    const notificaciones = new NotificadorDePrueba()
    const taskRef = nuevaTarea()

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      handleVerificationOutcome(
        { taskRef, outcome: 'verifier_fail' },
        { notifications: notificaciones, logger },
      ),
    )

    expect(resultado.row.state).toBe('same_agent')
    expect(resultado.notified).toBe(false)
    // Avisar aqui seria ruido: el agente tiene el informe y puede arreglarlo.
    expect(notificaciones.avisos).toEqual([])
  }, 90_000)
})

describe('cuando se agotan los intentos, alguien se entera', () => {
  it('el segundo FAIL avisa con el motivo, los intentos y a quien va', async () => {
    const notificaciones = new NotificadorDePrueba()
    const taskRef = nuevaTarea()

    await runWithTenant({ tenantId, actorId }, () =>
      handleVerificationOutcome(
        { taskRef, outcome: 'verifier_fail' },
        { notifications: notificaciones, logger },
      ),
    )
    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      handleVerificationOutcome(
        {
          taskRef,
          outcome: 'verifier_fail',
          headSha: 'b'.repeat(40),
          responsible: { kind: 'user', id: 'u-1', label: 'Javier' },
          mention: 'JVISERASS',
          reportMarkdown: '## Informe',
        },
        { notifications: notificaciones, logger },
      ),
    )

    expect(resultado.row.state).toBe('human')
    expect(resultado.notified).toBe(true)
    expect(notificaciones.avisos).toHaveLength(1)

    const aviso = notificaciones.avisos[0]
    expect(aviso?.taskRef).toBe(taskRef)
    expect(aviso?.destination).toBe('human')
    expect(aviso?.attempts).toBe(2)
    expect(aviso?.maxAttempts).toBe(2)
    expect(aviso?.mention).toBe('JVISERASS')
    expect(aviso?.headSha).toBe('b'.repeat(40))
    // El informe viaja con el aviso: sin el, quien lo recibe tiene que ir a
    // buscarlo, que es justo lo que el epic 05 existe para evitar.
    expect(aviso?.reportMarkdown).toBe('## Informe')
  }, 90_000)

  it('un fallo de infraestructura avisa SIN gastar intento', async () => {
    const notificaciones = new NotificadorDePrueba()
    const taskRef = nuevaTarea()

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      handleVerificationOutcome(
        { taskRef, outcome: 'verifier_unavailable' },
        { notifications: notificaciones, logger },
      ),
    )

    expect(resultado.row.attempts).toBe(0)
    expect(resultado.notified).toBe(true)
    expect(notificaciones.avisos[0]?.reason).toContain('No es trabajo mal hecho')
  }, 90_000)
})

describe('un criterio que nadie puede observar vuelve a la fase de criterios', () => {
  it('el segundo SIN_EVIDENCIA sobre el mismo criterio REVOCA la aprobacion', async () => {
    // Es el efecto que ninguna de las otras capas puede comprobar sola: la
    // regla dice que hay que revocar, la capa de datos no lo hace a proposito
    // (ataria la persistencia a T01), y es aqui donde tiene que ocurrir.
    const notificaciones = new NotificadorDePrueba()
    const taskRef = nuevaTarea()

    await runWithTenant({ tenantId, actorId }, async () => {
      await setCriteria({
        taskRef,
        // Pasa la heuristica de T01 —"devuelve" es un verbo de resultado— pero
        // sigue sin decir QUE mirar para darlo por cumplido. Esa es justo la
        // clase de criterio que llega hasta aqui: T01 caza lo burdo al
        // escribirlo, y lo sutil solo se descubre cuando el Verifier no
        // encuentra evidencia dos veces.
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
    expect(
      (await runWithTenant({ tenantId, actorId }, () => criteriaApprovalState(taskRef))).status,
    ).toBe('approved')

    // Dos pasadas: la primera avisa al agente, la segunda delata el criterio.
    for (let pasada = 0; pasada < 2; pasada += 1) {
      await runWithTenant({ tenantId, actorId }, () =>
        handleVerificationOutcome(
          {
            taskRef,
            outcome: 'verifier_no_evidence',
            noEvidenceCriteria: ['tc01-imposible'],
          },
          { notifications: notificaciones, logger },
        ),
      )
    }

    const estado = await runWithTenant({ tenantId, actorId }, () => criteriaApprovalState(taskRef))
    expect(estado.status).toBe('not_approved')

    const aviso = notificaciones.avisos.at(-1)
    expect(aviso?.destination).toBe('criteria_phase')
    expect(aviso?.reason).toContain('tc01-imposible')
  }, 120_000)

  it('el PRIMER SIN_EVIDENCIA no revoca nada: quiza solo falto evidencia', async () => {
    const notificaciones = new NotificadorDePrueba()
    const taskRef = nuevaTarea()

    await runWithTenant({ tenantId, actorId }, async () => {
      await setCriteria({
        taskRef,
        criteria: [
          {
            given: 'un tenant fijado',
            when: 'se consulta',
            then: 'la consulta devuelve sus filas',
          },
        ],
      })
      await approveCriteria({ taskRef })
    })

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      handleVerificationOutcome(
        { taskRef, outcome: 'verifier_no_evidence', noEvidenceCriteria: ['tc01-uno'] },
        { notifications: notificaciones, logger },
      ),
    )

    expect(resultado.criteriaApprovalRevoked).toBe(false)
    expect(
      (await runWithTenant({ tenantId, actorId }, () => criteriaApprovalState(taskRef))).status,
    ).toBe('approved')
  }, 120_000)
})

describe('un aviso que no sale no se da por enviado', () => {
  it('si el canal falla, el error se propaga en vez de tragarse', async () => {
    // Un escalado que nadie recibe no es un escalado. Descubrirlo por un log de
    // warning es descubrirlo tarde.
    const roto: NotificationPort = {
      notifyEscalation: () => Promise.reject(new Error('GitHub devolvio 503')),
    }
    const taskRef = nuevaTarea()

    await expect(
      runWithTenant({ tenantId, actorId }, () =>
        handleVerificationOutcome(
          { taskRef, outcome: 'verifier_unavailable' },
          { notifications: roto, logger },
        ),
      ),
    ).rejects.toThrow(/503/)
  }, 90_000)
})

describe('el aviso que sale por el puerto lleva exactamente lo que hay', () => {
  /**
   * La forma del `EscalationNotice` es el CONTRATO con los adaptadores: uno
   * puede preguntar `'headSha' in notice` en vez de comparar con `undefined`.
   * Mandar `{ headSha: undefined }` cuando no hay SHA no es lo mismo que no
   * mandar la clave, y la diferencia solo se ve desde el otro lado.
   */
  it('el motivo de "sin responsable" llega hasta el aviso', async () => {
    // Sin este reenvio, `resolveResponsible` podria distinguir perfectamente
    // "nadie" de "tres co-asignados" y el aviso seguiria diciendo lo mismo para
    // los dos. La distincion solo sirve si sobrevive el viaje.
    const notificaciones = new NotificadorDePrueba()
    const taskRef = nuevaTarea()

    await runWithTenant({ tenantId, actorId }, () =>
      handleVerificationOutcome(
        {
          taskRef,
          outcome: 'verifier_unavailable',
          unresolvedReason: 'el issue tiene 3 personas asignadas',
        },
        { notifications: notificaciones, logger },
      ),
    )

    expect(notificaciones.avisos[0]?.unresolvedReason).toBe('el issue tiene 3 personas asignadas')
  }, 90_000)

  it('sin datos opcionales, el aviso no lleva claves vacias', async () => {
    const notificaciones = new NotificadorDePrueba()
    const taskRef = nuevaTarea()

    await runWithTenant({ tenantId, actorId }, () =>
      handleVerificationOutcome(
        { taskRef, outcome: 'verifier_unavailable' },
        { notifications: notificaciones, logger },
      ),
    )

    const aviso = notificaciones.avisos[0]
    expect(Object.keys(aviso ?? {}).sort()).toEqual([
      'attempts',
      'destination',
      'maxAttempts',
      'reason',
      'taskRef',
    ])
  }, 90_000)

  it('con todos los datos, el aviso los lleva todos', async () => {
    const notificaciones = new NotificadorDePrueba()
    const taskRef = nuevaTarea()

    await runWithTenant({ tenantId, actorId }, () =>
      handleVerificationOutcome(
        {
          taskRef,
          outcome: 'verifier_unavailable',
          headSha: 'c'.repeat(40),
          responsible: { kind: 'user', id: 'u-1', label: 'Javier' },
          mention: 'JVISERASS',
          reportMarkdown: '## Informe',
        },
        { notifications: notificaciones, logger },
      ),
    )

    expect(Object.keys(notificaciones.avisos[0] ?? {}).sort()).toEqual([
      'attempts',
      'destination',
      'headSha',
      'maxAttempts',
      'mention',
      'reason',
      'reportMarkdown',
      'responsible',
      'taskRef',
    ])
  }, 90_000)

  it('el tope que se anuncia en el aviso es el que se uso de verdad', async () => {
    // Si se anunciara siempre el de por defecto, un aviso de una politica de un
    // solo intento diria "1 de 2" y quien lo leyera esperaria otra pasada que
    // no va a llegar.
    const notificaciones = new NotificadorDePrueba()
    const taskRef = nuevaTarea()

    await runWithTenant({ tenantId, actorId }, () =>
      handleVerificationOutcome(
        { taskRef, outcome: 'verifier_fail', maxAttempts: 1 },
        { notifications: notificaciones, logger },
      ),
    )

    expect(notificaciones.avisos[0]?.attempts).toBe(1)
    expect(notificaciones.avisos[0]?.maxAttempts).toBe(1)
  }, 90_000)
})
