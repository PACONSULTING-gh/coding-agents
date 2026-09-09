import { randomUUID } from 'node:crypto'

import { ConflictError, runWithTenant } from '@coord/core'
import {
  AcceptanceCriteriaNotApprovedError,
  approveCriteria,
  closeDatabase,
  configureDatabase,
  criteriaApprovalState,
  setCriteria,
  withTenantConnection,
} from '@coord/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { activeClaims, claim } from '../src/claims.js'

import { startDatabase, type StartedDatabase } from './support/database.js'
import { createTenant, createUser } from './support/fixtures.js'

/**
 * EL CRITERIO CENTRAL DE T01 (epic 05), contra Postgres DE VERDAD:
 *
 *   "Dada una tarea sin criterios aprobados, cuando un agente intenta
 *    reclamarla, entonces el claim se rechaza."
 *
 * Se prueban los TRES estados, no dos, porque el intermedio es el que se cuela
 * en una implementacion perezosa:
 *
 *   a) sin ningun criterio            -> rechazado
 *   b) con criterios SIN aprobar      -> rechazado   <- el que importa
 *   c) con criterios aprobados        -> concedido
 *
 * Y ademas el cuarto, que es el que demuestra que el mecanismo no depende de la
 * disciplina de nadie:
 *
 *   d) aprobados y luego CAMBIADOS, sin revocar nada -> vuelve a rechazarse.
 *
 * Nada mockeado (CLAUDE.md 5): el claim se hace por la misma via que el
 * producto, contra la misma base de datos, con la RLS forzada en pie.
 */

let db: StartedDatabase

beforeAll(async () => {
  db = await startDatabase()
  configureDatabase({ connectionString: db.runtimeUrl, max: 8, allowExitOnIdle: true })
}, 300_000)

afterAll(async () => {
  await closeDatabase()
  await db?.container.stop()
})

interface Actor {
  readonly id: string
  readonly label: string
}

function actor(label: string): Actor {
  return { id: randomUUID(), label }
}

async function as<T>(tenantId: string, who: Actor, fn: () => Promise<T>): Promise<T> {
  return runWithTenant({ tenantId, actorId: who.id }, fn)
}

const CRITERIO_CONCEDE = {
  given: 'una tarea con criterios de aceptacion aprobados',
  when: 'un agente la reclama',
  then: 'el claim se concede y aparece en `activeClaims`',
}
const CRITERIO_RECHAZA = {
  given: 'una tarea sin criterios aprobados',
  when: 'un agente la reclama',
  then: 'se lanza `AcceptanceCriteriaNotApprovedError` y no se crea ninguna fila en `claims`',
}
const CRITERIOS = [CRITERIO_CONCEDE, CRITERIO_RECHAZA]

describe('la puerta de T01: no se reclama una tarea sin criterios aprobados', () => {
  let tenantId: string
  let repoId: string
  let humano: string
  let agente: Actor

  beforeAll(async () => {
    tenantId = await createTenant('puerta-criterios')
    repoId = randomUUID()
    humano = await createUser(tenantId, {
      email: `humana-${randomUUID()}@example.test`,
      displayName: 'Humana que aprueba',
    })
    agente = actor('Agente implementador')
  })

  /** Cuantas filas de `claims` hay para ese issue. Cero = no se creo nada. */
  async function filasDeClaim(issue: string): Promise<number> {
    const result = await runWithTenant({ tenantId }, () =>
      withTenantConnection(async (tx) =>
        tx.query<{ total: string }>(
          `SELECT count(*)::text AS total FROM claims
            WHERE tenant_id = $1 AND subject_kind = 'issue' AND subject_key = $2`,
          [tenantId, issue],
        ),
      ),
    )
    return Number(result.rows[0]?.total ?? '-1')
  }

  async function reclamar(issue: string): Promise<unknown> {
    return as(tenantId, agente, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: issue },
        holder: { kind: 'agent', id: agente.id, label: agente.label },
        ttlSeconds: 600,
      }),
    ).catch((caught: unknown) => caught)
  }

  it('a) sin ningun criterio: se rechaza, y el motivo dice que faltan', async () => {
    const issue = '5001'
    const error = await reclamar(issue)

    expect(error).toBeInstanceOf(AcceptanceCriteriaNotApprovedError)
    // Sigue siendo un ConflictError de dominio: quien ya trataba conflictos de
    // claim no tiene que aprender un tipo nuevo para no romperse.
    expect(error).toBeInstanceOf(ConflictError)
    if (!(error instanceof AcceptanceCriteriaNotApprovedError)) throw new Error('no alcanzable')

    // El rechazo NO es un booleano: lleva el estado entero y dice que hacer.
    expect(error.state.status).toBe('no_criteria')
    expect(error.message).toContain('no tiene criterios de aceptacion')
    expect(error.message).toContain('apruebe')
    expect(error.message).toContain(issue)

    // Y no se ha creado ninguna reserva.
    expect(await filasDeClaim(issue)).toBe(0)
  })

  it('b) con criterios escritos pero SIN aprobar: se rechaza igual', async () => {
    const issue = '5002'
    await runWithTenant({ tenantId, actorId: agente.id }, () =>
      setCriteria({ taskRef: issue, criteria: CRITERIOS }),
    )

    // Control: los criterios existen de verdad.
    const estado = await runWithTenant({ tenantId }, () => criteriaApprovalState(issue))
    expect(estado.status).toBe('not_approved')

    const error = await reclamar(issue)
    expect(error).toBeInstanceOf(AcceptanceCriteriaNotApprovedError)
    if (!(error instanceof AcceptanceCriteriaNotApprovedError)) throw new Error('no alcanzable')
    expect(error.state.status).toBe('not_approved')
    expect(error.message).toContain('nadie los ha aprobado')
    expect(await filasDeClaim(issue)).toBe(0)
  })

  it('c) con criterios aprobados por un humano: el claim se concede', async () => {
    const issue = '5003'
    await runWithTenant({ tenantId, actorId: agente.id }, () =>
      setCriteria({ taskRef: issue, criteria: CRITERIOS }),
    )
    await runWithTenant({ tenantId, actorId: humano }, () => approveCriteria({ taskRef: issue }))

    const lease = await as(tenantId, agente, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: issue },
        holder: { kind: 'agent', id: agente.id, label: agente.label },
        ttlSeconds: 600,
      }),
    )
    expect(lease.claims).toHaveLength(1)
    expect(lease.holder.label).toBe(agente.label)

    const vivos = await runWithTenant({ tenantId }, () =>
      activeClaims({ repoId, subjectKind: 'issue', subjectKeys: [issue] }),
    )
    expect(vivos.claims).toHaveLength(1)
  })

  it('d) aprobados y luego cambiados SIN revocar nada: vuelve a rechazarse', async () => {
    const issue = '5004'
    await runWithTenant({ tenantId, actorId: agente.id }, () =>
      setCriteria({ taskRef: issue, criteria: CRITERIOS }),
    )
    await runWithTenant({ tenantId, actorId: humano }, () => approveCriteria({ taskRef: issue }))

    // Alguien —el propio agente, sin permiso de nadie— reescribe un criterio.
    // No se llama a ninguna revocacion en ningun punto de este test.
    await runWithTenant({ tenantId, actorId: agente.id }, () =>
      setCriteria({
        taskRef: issue,
        criteria: [
          { ...CRITERIO_CONCEDE, then: 'el claim se concede sin comprobar nada, y se registra' },
          CRITERIO_RECHAZA,
        ],
      }),
    )

    const error = await reclamar(issue)
    expect(error).toBeInstanceOf(AcceptanceCriteriaNotApprovedError)
    if (!(error instanceof AcceptanceCriteriaNotApprovedError)) throw new Error('no alcanzable')
    expect(error.state.status).toBe('stale')
    expect(error.message).toContain('cambiaron despues de aprobarse')
    expect(error.message).toContain('re-aprobarlos')
    expect(await filasDeClaim(issue)).toBe(0)

    // Re-aprobar vuelve a abrir la puerta: el flujo no queda atascado.
    await runWithTenant({ tenantId, actorId: humano }, () => approveCriteria({ taskRef: issue }))
    const lease = await as(tenantId, agente, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: issue },
        holder: { kind: 'agent', id: agente.id, label: agente.label },
        ttlSeconds: 600,
      }),
    )
    expect(lease.claims).toHaveLength(1)
  })

  it('la puerta es por tenant: aprobar en A no deja reclamar la misma tarea en B', async () => {
    const issue = '5005'
    const vecino = await createTenant('puerta-criterios-vecina')
    const agenteVecino = actor('Agente del vecino')

    await runWithTenant({ tenantId, actorId: agente.id }, () =>
      setCriteria({ taskRef: issue, criteria: CRITERIOS }),
    )
    await runWithTenant({ tenantId, actorId: humano }, () => approveCriteria({ taskRef: issue }))

    const error = await as(vecino, agenteVecino, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: issue },
        holder: { kind: 'agent', id: agenteVecino.id, label: agenteVecino.label },
        ttlSeconds: 600,
      }),
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AcceptanceCriteriaNotApprovedError)
    if (!(error instanceof AcceptanceCriteriaNotApprovedError)) throw new Error('no alcanzable')
    expect(error.state.status).toBe('no_criteria')
  })

  it('reclamar solo ficheros no pasa por la puerta: un fichero no es una tarea', async () => {
    // LIMITACION CONOCIDA, no un descuido: la puerta se aplica al sujeto
    // `issue`, que es lo que tiene criterios de aceptacion. Este test la fija
    // por escrito para que, si algun dia se decide cerrarla, el cambio de
    // comportamiento se vea en el diff en vez de descubrirse en produccion.
    const lease = await as(tenantId, agente, () =>
      claim({
        repoId,
        subject: { kind: 'file', key: 'src/sin-issue.ts' },
        holder: { kind: 'agent', id: agente.id, label: agente.label },
        ttlSeconds: 600,
      }),
    )
    expect(lease.claims).toHaveLength(1)
  })
})
