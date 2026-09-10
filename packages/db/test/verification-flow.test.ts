import { randomUUID } from 'node:crypto'

import { runWithTenant } from '@coord/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readAuditLog } from '../src/audit.js'
import { withTenantConnection } from '../src/client.js'
import { closeDatabase, configureDatabase } from '../src/pool.js'
import {
  readVerificationFlow,
  recordVerificationOutcome,
  VERIFICATION_FLOW_ACTION,
} from '../src/verification-flow.js'

import { startDatabase, type StartedDatabase } from './support/database.js'

/**
 * El estado del flujo de verificacion (T06, ADR 0008) contra un Postgres DE
 * VERDAD, porque lo que se comprueba aqui —el aislamiento por tenant con RLS
 * forzada, el upsert por (tenant, tarea) y la entrada en el log append-only—
 * es comportamiento del motor (CLAUDE.md 5).
 *
 * La REGLA (cuantos intentos, a donde va cada modo de fallo) NO se prueba aqui:
 * es pura y vive en `packages/core/src/verification-flow.test.ts`, sin
 * contenedor. Lo que se prueba aqui es que lo que la regla decide queda
 * ESCRITO, y que no se filtra entre clientes.
 */

let database: StartedDatabase
let tenantId: string
let otroTenantId: string

async function crearTenant(nombre: string): Promise<string> {
  const id = randomUUID()
  await runWithTenant({ tenantId: id }, () =>
    withTenantConnection((tx) =>
      tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        id,
        nombre,
        `${nombre}-${id.slice(0, 8)}`,
      ]),
    ),
  )
  return id
}

beforeAll(async () => {
  database = await startDatabase()
  configureDatabase({ connectionString: database.runtimeUrl })
  tenantId = await crearTenant('flujo')
  otroTenantId = await crearTenant('ajeno')
}, 120_000)

afterAll(async () => {
  await closeDatabase()
  await database?.stop()
})

describe('lo que la regla decide queda escrito', () => {
  it('la primera entrega fallida crea la fila con un intento consumido', async () => {
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    const { decision, row } = await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({
        taskRef,
        outcome: 'verifier_fail',
        headSha: 'a'.repeat(40),
        responsible: { kind: 'agent', id: 'agente-1', label: 'Agente 1' },
      }),
    )

    expect(decision.destination).toBe('same_agent')
    expect(row.attempts).toBe(1)
    expect(row.state).toBe('same_agent')
    expect(row.lastOutcome).toBe('verifier_fail')
    expect(row.lastHeadSha).toBe('a'.repeat(40))
    expect(row.responsible).toEqual({ kind: 'agent', id: 'agente-1', label: 'Agente 1' })
  })

  it('la segunda entrega fallida escala, y sigue habiendo UNA fila por tarea', async () => {
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'gate_failed' }),
    )
    const { row } = await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'gate_failed' }),
    )

    expect(row.attempts).toBe(2)
    expect(row.state).toBe('human')

    // Es ESTADO, no bitacora: la restriccion unica lo garantiza.
    const filas = await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) =>
        tx.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM verification_flow WHERE task_ref = $1',
          [taskRef],
        ),
      ),
    )
    expect(filas.rows[0]?.n).toBe('1')
  })

  it('un fallo de infraestructura no gasta el intento, y eso llega a la fila', async () => {
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'verifier_fail' }),
    )
    const { row } = await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'verifier_unavailable' }),
    )

    // Sigue en 1: el rechazo del modelo no le come el intento que le queda.
    expect(row.attempts).toBe(1)
    expect(row.state).toBe('human')
    expect(row.lastOutcome).toBe('verifier_unavailable')
  })

  it('el recuento de SIN_EVIDENCIA por criterio se acumula entre pasadas', async () => {
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({
        taskRef,
        outcome: 'verifier_no_evidence',
        noEvidenceCriteria: ['tc01-imposible'],
      }),
    )
    const { decision, row } = await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({
        taskRef,
        outcome: 'verifier_no_evidence',
        noEvidenceCriteria: ['tc01-imposible'],
      }),
    )

    expect(row.noEvidenceByCriterion).toEqual({ 'tc01-imposible': 2 })
    expect(row.state).toBe('criteria_phase')
    // Quien llama tiene que revocar la aprobacion: esta capa no lo hace, para
    // no atar la persistencia a T01.
    expect(decision.revokesCriteriaApproval).toBe(true)
  })

  it('el responsable no se borra cuando una pasada posterior no trae ninguno', async () => {
    // Perderlo dejaria la tarea sin dueño por un dato que falta, no por un
    // cambio: el aviso saldria sin mencion a nadie sin que nada haya cambiado.
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({
        taskRef,
        outcome: 'verifier_fail',
        responsible: { kind: 'user', id: 'u-1', label: 'Javier' },
      }),
    )
    const { row } = await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'verifier_unavailable' }),
    )

    expect(row.responsible).toEqual({ kind: 'user', id: 'u-1', label: 'Javier' })
  })
})

describe('el historico va al audit_log, que es append-only', () => {
  it('cada transicion deja su entrada con el motivo y los intentos', async () => {
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'verifier_fail' }),
    )

    const page = await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) => readAuditLog(tx, { actions: [VERIFICATION_FLOW_ACTION] })),
    )
    const entrada = page.entries.find((row) => row.resourceId === taskRef)

    expect(entrada, 'la transicion no quedo registrada').toBeDefined()
    expect(entrada?.metadata['outcome']).toBe('verifier_fail')
    expect(entrada?.metadata['destination']).toBe('same_agent')
    expect(entrada?.metadata['attemptsBefore']).toBe(0)
    expect(entrada?.metadata['attemptsAfter']).toBe(1)
    // El motivo viaja entero: es lo que se lee cuando alguien pregunta "por que
    // escalo esto", meses despues.
    expect(String(entrada?.metadata['reason'])).toContain('FAIL')
  })
})

describe('aislamiento entre tenants', () => {
  it('el estado de una tarea no se ve desde otro tenant', async () => {
    // Este estado dice que tareas de un cliente estan atascadas y en manos de
    // quien. No cruza la frontera.
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'verifier_fail' }),
    )

    expect(await runWithTenant({ tenantId }, () => readVerificationFlow(taskRef))).toBeDefined()
    expect(
      await runWithTenant({ tenantId: otroTenantId }, () => readVerificationFlow(taskRef)),
    ).toBeUndefined()
  })

  it('dos tenants pueden tener la MISMA tarea sin pisarse', async () => {
    // La restriccion unica es (tenant_id, task_ref): si fuera solo task_ref,
    // el issue 42 de un cliente colisionaria con el 42 de otro.
    const taskRef = 'issue-42'

    const mio = await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'verifier_fail' }),
    )
    const suyo = await runWithTenant({ tenantId: otroTenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'gate_failed' }),
    )

    expect(mio.row.lastOutcome).toBe('verifier_fail')
    expect(suyo.row.lastOutcome).toBe('gate_failed')
    expect(suyo.row.attempts).toBe(1)
  })
})

describe('la frontera de entrada: lo que no cuadra no se escribe', () => {
  it('un SHA que no es un sha se rechaza en vez de guardarse', async () => {
    // Guardar cualquier cosa aqui haria que el aviso citara un commit que no
    // existe, y quien lo leyera iria a buscar codigo que nadie escribio.
    for (const headSha of ['no-es-un-sha', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40)]) {
      await expect(
        runWithTenant({ tenantId }, () =>
          recordVerificationOutcome({ taskRef: 'issue-1', outcome: 'gate_failed', headSha }),
        ),
      ).rejects.toThrow()
    }
  })

  it('un responsable sin id o sin nombre legible se rechaza', async () => {
    // Sin `label` no se le puede nombrar en el aviso, y un `id` en blanco no
    // identifica a nadie: seria un responsable de mentira.
    for (const responsible of [
      { kind: 'user' as const, id: '   ', label: 'Javier' },
      { kind: 'user' as const, id: 'u-1', label: '' },
    ]) {
      await expect(
        runWithTenant({ tenantId }, () =>
          recordVerificationOutcome({
            taskRef: 'issue-1',
            outcome: 'gate_failed',
            responsible,
          }),
        ),
      ).rejects.toThrow()
    }
  })

  it('un tope de cero intentos se rechaza', async () => {
    await expect(
      runWithTenant({ tenantId }, () =>
        recordVerificationOutcome({
          taskRef: 'issue-1',
          outcome: 'gate_failed',
          maxAttempts: 0,
        }),
      ),
    ).rejects.toThrow()
  })
})

describe('el tope de intentos se puede ajustar por llamada', () => {
  it('con maxAttempts 1, el primer fallo ya escala', async () => {
    // El tope viaja hasta la regla. Si el paso se perdiera, se usaria siempre
    // el de por defecto y una politica sin segunda oportunidad no existiria.
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    const { row } = await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'verifier_fail', maxAttempts: 1 }),
    )

    expect(row.attempts).toBe(1)
    expect(row.state).toBe('human')
  })
})

describe('sin responsable, la columna queda vacia', () => {
  it('no se escribe un JSON con undefined dentro', async () => {
    // La alternativa —guardar algo cuando no hay nada— haria que el aviso
    // creyera tener destinatario y no lo dijera en voz alta.
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    const { row } = await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'gate_failed' }),
    )

    expect(row.responsible).toBeUndefined()
    const [fila] = (
      await runWithTenant({ tenantId }, () =>
        withTenantConnection((tx) =>
          tx.query<{ responsible: unknown }>(
            'SELECT responsible FROM verification_flow WHERE task_ref = $1',
            [taskRef],
          ),
        ),
      )
    ).rows
    expect(fila?.responsible).toBeNull()
  })
})

describe('el camino feliz tambien se persiste', () => {
  it('un `passed` deja la tarea en done sin gastar intento', async () => {
    // No estaba probado en esta capa: se probaba todo lo que falla y nada de lo
    // que sale bien, que es el estado en el que acaba la mayoria de las tareas.
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'verifier_fail' }),
    )
    const { row } = await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'passed', headSha: 'd'.repeat(40) }),
    )

    expect(row.state).toBe('done')
    expect(row.lastOutcome).toBe('passed')
    // El intento que gasto el fallo anterior no se borra: el historico de lo
    // que costo llegar aqui es informacion.
    expect(row.attempts).toBe(1)
  })
})

describe('lo que queda escrito en el audit_log', () => {
  /**
   * El log es lo que se lee meses despues, cuando ya no queda nadie que
   * recuerde por que escalo aquella tarea. Su contenido es contrato.
   */
  it('sin datos opcionales, no se inventan claves', async () => {
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({ taskRef, outcome: 'gate_failed' }),
    )

    const page = await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) => readAuditLog(tx, { actions: [VERIFICATION_FLOW_ACTION] })),
    )
    const entrada = page.entries.find((row) => row.resourceId === taskRef)

    expect(Object.keys(entrada?.metadata ?? {}).sort()).toEqual([
      'attemptsAfter',
      'attemptsBefore',
      'consumesAttempt',
      'destination',
      'notifiesHuman',
      'outcome',
      'reason',
      'revokesCriteriaApproval',
    ])
  })

  it('con SHA y responsable, los dos quedan registrados', async () => {
    const taskRef = `issue-${String(Math.floor(Math.random() * 100_000))}`

    await runWithTenant({ tenantId }, () =>
      recordVerificationOutcome({
        taskRef,
        outcome: 'gate_failed',
        headSha: 'e'.repeat(40),
        responsible: { kind: 'agent', id: 'a-1', label: 'Agente 1' },
      }),
    )

    const page = await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) => readAuditLog(tx, { actions: [VERIFICATION_FLOW_ACTION] })),
    )
    const entrada = page.entries.find((row) => row.resourceId === taskRef)

    expect(entrada?.metadata['headSha']).toBe('e'.repeat(40))
    expect(entrada?.metadata['responsible']).toEqual({
      kind: 'agent',
      id: 'a-1',
      label: 'Agente 1',
    })
  })
})
