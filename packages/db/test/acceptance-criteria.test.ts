import { randomUUID } from 'node:crypto'

import { ConflictError, NotFoundError, ValidationError, runWithTenant } from '@coord/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  approveCriteria,
  computeCriteriaContentHash,
  criteriaApprovalState,
  normalizeCriterionText,
  readCriteria,
  revokeCriteriaApproval,
  setCriteria,
} from '../src/acceptance-criteria.js'
import { readAuditLog } from '../src/audit.js'
import { closeDatabase, configureDatabase } from '../src/pool.js'
import { withTenantConnection } from '../src/client.js'

import { startDatabase, type StartedDatabase } from './support/database.js'

/**
 * Criterios de aceptacion de T01 (epic 05) que se pueden comprobar en la capa
 * de datos, contra Postgres DE VERDAD. Nada mockeado (CLAUDE.md 5): lo que se
 * comprueba —que la RLS forzada aisla las dos tablas nuevas, que la clave ajena
 * compuesta impide aprobar en nombre de un usuario de otro cliente, que el
 * `audit_log` recoge quien y cuando— es comportamiento del motor.
 *
 * El criterio central de T01 ("un claim sobre una tarea sin criterios aprobados
 * se rechaza") NO esta aqui: vive en `packages/graph/test/acceptance-criteria-claims.test.ts`,
 * porque `claim()` esta en `@coord/graph`.
 *
 *   1. El hash: que es estable ante lo que no cambia el significado y sensible
 *      ante lo que si.
 *   2. Caducidad por hash SIN llamar a ninguna revocacion.
 *   3. Auditoria: cada cambio y cada aprobacion dejan fila con quien.
 *   4. Aislamiento entre tenants, con el MISMO task_ref en los dos.
 *   5. Validacion: vacios y sin nada observable se rechazan; uno bien formado
 *      se acepta.
 */

let db: StartedDatabase

beforeAll(async () => {
  db = await startDatabase()
  configureDatabase({ connectionString: db.runtimeUrl, max: 8, allowExitOnIdle: true })
}, 300_000)

afterAll(async () => {
  await closeDatabase()
  await db?.stop()
})

/** Un tenant nuevo, dado de alta por la misma via que usa el producto. */
async function createTenant(slug: string): Promise<string> {
  const id = randomUUID()
  await runWithTenant({ tenantId: id }, () =>
    withTenantConnection(async (tx) => {
      await tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        id,
        `Tenant ${slug}`,
        `${slug}-${id.slice(0, 8)}`,
      ])
    }),
  )
  return id
}

/** Un humano del tenant. Es lo unico que la clave ajena de 0010 acepta como aprobador. */
async function createUser(tenantId: string, name: string): Promise<string> {
  return runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3) RETURNING id`,
        // El CHECK de `users` exige el correo en minusculas.
        [tenantId, `u-${randomUUID()}@example.test`, name],
      )
      const row = result.rows[0]
      if (row === undefined) throw new Error('El INSERT de users no devolvio ninguna fila.')
      return row.id
    }),
  )
}

/** Ejecuta como ese actor: la identidad de quien escribe y quien aprueba sale del contexto. */
async function as<T>(tenantId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenant({ tenantId, actorId }, fn)
}

const CRITERIO_BASE = {
  given: 'una tarea con criterios escritos',
  when: 'un agente intenta reclamarla',
  then: 'el claim se concede y `activeClaims` devuelve una fila',
}

// ===========================================================================
describe('1. el hash del conjunto: estable ante el ruido, sensible al significado', () => {
  it('la normalizacion no cambia el hash, pero una palabra distinta si', () => {
    const base = [{ ordinal: 1, ...CRITERIO_BASE }]
    const conRuido = [
      {
        ordinal: 1,
        given: '  una tarea con   criterios\n  escritos ',
        when: 'un agente intenta reclamarla',
        then: 'el claim se concede y `activeClaims` devuelve una fila',
      },
    ]
    expect(computeCriteriaContentHash(conRuido)).toBe(computeCriteriaContentHash(base))

    const otroTexto = [
      { ordinal: 1, ...CRITERIO_BASE, then: 'el claim se rechaza y no devuelve ninguna fila' },
    ]
    expect(computeCriteriaContentHash(otroTexto)).not.toBe(computeCriteriaContentHash(base))
  })

  it('el orden de los criterios entra en el hash', () => {
    const a = { ordinal: 1, ...CRITERIO_BASE }
    const b = { ordinal: 2, ...CRITERIO_BASE, then: 'se registra una fila en `audit_log`' }
    // Mismo conjunto, ordinales intercambiados: es otro conjunto.
    expect(computeCriteriaContentHash([a, b])).not.toBe(
      computeCriteriaContentHash([
        { ...a, ordinal: 2 },
        { ...b, ordinal: 1 },
      ]),
    )
  })

  it('el hash no depende del orden en que llegan las filas', () => {
    const a = { ordinal: 1, ...CRITERIO_BASE }
    const b = { ordinal: 2, ...CRITERIO_BASE, then: 'se registra una fila en `audit_log`' }
    expect(computeCriteriaContentHash([b, a])).toBe(computeCriteriaContentHash([a, b]))
  })

  it('un separador dentro del texto no puede fabricar una colision', () => {
    // Con una concatenacion ingenua ("given|when|then") estos dos conjuntos
    // producirian la misma cadena. Con JSON no.
    const uno = [{ ordinal: 1, given: 'a|b', when: 'c', then: 'devuelve d' }]
    const otro = [{ ordinal: 1, given: 'a', when: 'b|c', then: 'devuelve d' }]
    expect(computeCriteriaContentHash(uno)).not.toBe(computeCriteriaContentHash(otro))
  })

  it('normalizeCriterionText colapsa el espacio y respeta el contenido', () => {
    expect(normalizeCriterionText('  hola   \n  mundo ')).toBe('hola mundo')
  })
})

// ===========================================================================
describe('2. la aprobacion caduca sola cuando cambian los criterios', () => {
  let tenantId: string
  let autor: string
  let humano: string

  beforeAll(async () => {
    tenantId = await createTenant('caducidad-hash')
    autor = await createUser(tenantId, 'Autora de criterios')
    humano = await createUser(tenantId, 'Humana que aprueba')
  })

  it('aprobar y luego cambiar un criterio invalida la aprobacion SIN revocar nada', async () => {
    const taskRef = '4242'

    const escritos = await as(tenantId, autor, () =>
      setCriteria({ taskRef, criteria: [CRITERIO_BASE] }),
    )
    await as(tenantId, humano, () => approveCriteria({ taskRef }))

    const aprobado = await as(tenantId, autor, () => criteriaApprovalState(taskRef))
    expect(aprobado.status).toBe('approved')

    // Se cambia UNA palabra del `then`. No se llama a revokeCriteriaApproval ni
    // a nada parecido: nadie revoca nada en ningun momento de este test.
    await as(tenantId, autor, () =>
      setCriteria({
        taskRef,
        criteria: [{ ...CRITERIO_BASE, then: 'el claim se rechaza y no devuelve ninguna fila' }],
      }),
    )

    const despues = await as(tenantId, autor, () => criteriaApprovalState(taskRef))
    expect(despues.status).toBe('stale')
    if (despues.status !== 'stale') throw new Error('no alcanzable')
    expect(despues.approvedContentHash).toBe(escritos.contentHash)
    expect(despues.contentHash).not.toBe(escritos.contentHash)
    expect(despues.approvedBy).toBe(humano)

    // Y la fila de aprobacion sigue viva en la tabla: la caducidad no borra ni
    // marca nada, simplemente el hash deja de casar.
    const vivas = await runWithTenant({ tenantId }, () =>
      withTenantConnection(async (tx) =>
        tx.query<{ total: string }>(
          `SELECT count(*)::text AS total FROM acceptance_criteria_approvals
            WHERE tenant_id = $1 AND task_ref = $2 AND revoked_at IS NULL`,
          [tenantId, taskRef],
        ),
      ),
    )
    expect(vivas.rows[0]?.total).toBe('1')

    // Re-aprobar los criterios nuevos vuelve a abrir la puerta.
    await as(tenantId, humano, () => approveCriteria({ taskRef }))
    expect((await as(tenantId, autor, () => criteriaApprovalState(taskRef))).status).toBe(
      'approved',
    )
  })

  it('volver al texto exacto que se aprobo revive la aprobacion original', async () => {
    const taskRef = 'epic-05/t01-vuelta'
    await as(tenantId, autor, () => setCriteria({ taskRef, criteria: [CRITERIO_BASE] }))
    await as(tenantId, humano, () => approveCriteria({ taskRef }))

    await as(tenantId, autor, () =>
      setCriteria({
        taskRef,
        criteria: [{ ...CRITERIO_BASE, when: 'un humano intenta reclamarla' }],
      }),
    )
    expect((await as(tenantId, autor, () => criteriaApprovalState(taskRef))).status).toBe('stale')

    // Es una consecuencia deliberada de anclar la aprobacion al CONTENIDO: si
    // el texto vuelve a ser el que se aprobo, lo aprobado sigue siendo cierto.
    await as(tenantId, autor, () => setCriteria({ taskRef, criteria: [CRITERIO_BASE] }))
    expect((await as(tenantId, autor, () => criteriaApprovalState(taskRef))).status).toBe(
      'approved',
    )
  })

  it('la revocacion explicita tambien invalida, y es otra cosa que la caducidad', async () => {
    const taskRef = '4243'
    await as(tenantId, autor, () => setCriteria({ taskRef, criteria: [CRITERIO_BASE] }))
    await as(tenantId, humano, () => approveCriteria({ taskRef }))
    await as(tenantId, humano, () => revokeCriteriaApproval(taskRef))

    const estado = await as(tenantId, autor, () => criteriaApprovalState(taskRef))
    // Sin aprobacion viva: `not_approved`, no `stale`. Los criterios no han
    // cambiado; lo que falta es la aprobacion.
    expect(estado.status).toBe('not_approved')

    await expect(
      as(tenantId, humano, () => revokeCriteriaApproval(taskRef)),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('aprobar un hash que ya no es el actual se rechaza en vez de firmar a ciegas', async () => {
    const taskRef = '4244'
    const escritos = await as(tenantId, autor, () =>
      setCriteria({ taskRef, criteria: [CRITERIO_BASE] }),
    )
    await as(tenantId, autor, () =>
      setCriteria({
        taskRef,
        criteria: [{ ...CRITERIO_BASE, then: 'se registra una fila en `audit_log`' }],
      }),
    )
    await expect(
      as(tenantId, humano, () =>
        approveCriteria({ taskRef, expectedContentHash: escritos.contentHash }),
      ),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('aprobar dos veces el mismo contenido es idempotente', async () => {
    const taskRef = '4245'
    await as(tenantId, autor, () => setCriteria({ taskRef, criteria: [CRITERIO_BASE] }))
    const primera = await as(tenantId, humano, () => approveCriteria({ taskRef }))
    const segunda = await as(tenantId, humano, () => approveCriteria({ taskRef }))
    expect(segunda.id).toBe(primera.id)
  })

  it('no se puede aprobar una tarea sin criterios', async () => {
    await expect(
      as(tenantId, humano, () => approveCriteria({ taskRef: 'tarea-vacia' })),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect((await as(tenantId, autor, () => criteriaApprovalState('tarea-vacia'))).status).toBe(
      'no_criteria',
    )
  })

  it('un aprobador que no es un usuario del tenant no puede aprobar', async () => {
    const taskRef = '4246'
    await as(tenantId, autor, () => setCriteria({ taskRef, criteria: [CRITERIO_BASE] }))
    // Un uuid con la forma correcta pero que no esta en `users`: lo rechaza la
    // clave ajena compuesta de la migracion 0010, no el codigo.
    await expect(as(tenantId, randomUUID(), () => approveCriteria({ taskRef }))).rejects.toThrow()
  })
})

// ===========================================================================
describe('3. auditoria: quien y cuando, en cada cambio y en cada aprobacion', () => {
  let tenantId: string
  let autor: string
  let humano: string

  beforeAll(async () => {
    tenantId = await createTenant('auditoria-criterios')
    autor = await createUser(tenantId, 'Autor')
    humano = await createUser(tenantId, 'Aprobadora')
  })

  it('escribir, cambiar y aprobar dejan su fila en audit_log', async () => {
    const taskRef = '900'
    await as(tenantId, autor, () => setCriteria({ taskRef, criteria: [CRITERIO_BASE] }))
    await as(tenantId, humano, () => approveCriteria({ taskRef }))
    await as(tenantId, autor, () =>
      setCriteria({
        taskRef,
        criteria: [{ ...CRITERIO_BASE, then: 'devuelve 404 y no crea nada' }],
      }),
    )

    const pagina = await runWithTenant({ tenantId }, () =>
      withTenantConnection(async (tx) =>
        readAuditLog(tx, { resourceType: 'acceptance_criteria', resourceId: taskRef }),
      ),
    )
    const acciones = pagina.entries.map((entry) => entry.action)
    expect(acciones).toEqual([
      'acceptance_criteria.set',
      'acceptance_criteria.approved',
      'acceptance_criteria.set',
    ])

    const [ultimoCambio, aprobacion, primerCambio] = pagina.entries
    if (ultimoCambio === undefined || aprobacion === undefined || primerCambio === undefined) {
      throw new Error('no alcanzable')
    }

    // QUIEN: el autor en los cambios, la humana en la aprobacion.
    expect(primerCambio.actorId).toBe(autor)
    expect(aprobacion.actorId).toBe(humano)
    expect(aprobacion.actorType).toBe('user')
    expect(ultimoCambio.actorId).toBe(autor)

    // CUANDO: el instante lo pone el servidor y va en orden.
    expect(ultimoCambio.occurredAt.getTime()).toBeGreaterThanOrEqual(
      primerCambio.occurredAt.getTime(),
    )

    // Y el cambio POSTERIOR a la aprobacion se puede reconocer sin comparar
    // hashes a mano: lo dice la propia entrada.
    expect(ultimoCambio.metadata['replacedExistingCriteria']).toBe(true)
    expect(ultimoCambio.metadata['previousContentHash']).toBe(aprobacion.metadata['contentHash'])
    expect(ultimoCambio.metadata['contentHash']).not.toBe(aprobacion.metadata['contentHash'])
  })

  it('sin actor en el contexto, escribir criterios falla en voz alta', async () => {
    await expect(
      runWithTenant({ tenantId }, () => setCriteria({ taskRef: '901', criteria: [CRITERIO_BASE] })),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

// ===========================================================================
describe('4. aislamiento entre tenants con el MISMO task_ref', () => {
  let tenantA: string
  let tenantB: string
  let autorA: string
  let autorB: string
  let humanoA: string

  const TASK_REF = '777'

  beforeAll(async () => {
    tenantA = await createTenant('criterios-a')
    tenantB = await createTenant('criterios-b')
    autorA = await createUser(tenantA, 'Autor A')
    autorB = await createUser(tenantB, 'Autor B')
    humanoA = await createUser(tenantA, 'Aprobador A')
  })

  it('cada tenant ve solo sus criterios, y la aprobacion de A no aprueba la tarea de B', async () => {
    // MISMO task_ref en los dos a proposito: si el aislamiento dependiera de
    // que las claves no chocan, esto reventaria en vez de pasar por casualidad.
    await as(tenantA, autorA, () =>
      setCriteria({
        taskRef: TASK_REF,
        criteria: [{ ...CRITERIO_BASE, given: 'la tarea 777 del tenant A' }],
      }),
    )
    await as(tenantB, autorB, () =>
      setCriteria({
        taskRef: TASK_REF,
        criteria: [{ ...CRITERIO_BASE, given: 'la tarea 777 del tenant B' }],
      }),
    )

    const deA = await as(tenantA, autorA, () => readCriteria(TASK_REF))
    const deB = await as(tenantB, autorB, () => readCriteria(TASK_REF))
    expect(deA.criteria).toHaveLength(1)
    expect(deB.criteria).toHaveLength(1)
    expect(deA.criteria[0]?.given).toContain('tenant A')
    expect(deB.criteria[0]?.given).toContain('tenant B')
    expect(deA.contentHash).not.toBe(deB.contentHash)

    // A aprueba. B no queda aprobado por ello.
    await as(tenantA, humanoA, () => approveCriteria({ taskRef: TASK_REF }))
    expect((await as(tenantA, autorA, () => criteriaApprovalState(TASK_REF))).status).toBe(
      'approved',
    )
    expect((await as(tenantB, autorB, () => criteriaApprovalState(TASK_REF))).status).toBe(
      'not_approved',
    )
  })

  it('una consulta mal escrita, sin filtro de tenant, sigue sin ver al vecino', async () => {
    // La defensa es la RLS forzada, no el `WHERE tenant_id` del SQL.
    const filas = await runWithTenant({ tenantId: tenantB }, () =>
      withTenantConnection(async (tx) =>
        tx.query<{ tenant_id: string }>('SELECT tenant_id FROM acceptance_criteria'),
      ),
    )
    expect(filas.rows.length).toBeGreaterThan(0)
    expect(filas.rows.every((row) => row.tenant_id === tenantB)).toBe(true)

    const aprobaciones = await runWithTenant({ tenantId: tenantB }, () =>
      withTenantConnection(async (tx) =>
        tx.query<{ tenant_id: string }>('SELECT tenant_id FROM acceptance_criteria_approvals'),
      ),
    )
    expect(aprobaciones.rows).toEqual([])
  })
})

// ===========================================================================
describe('5. validacion: vacio y puramente subjetivo se rechazan', () => {
  let tenantId: string
  let autor: string

  beforeAll(async () => {
    tenantId = await createTenant('validacion-criterios')
    autor = await createUser(tenantId, 'Autor validacion')
  })

  it('un criterio bien formado se acepta (caso negativo del rechazo)', async () => {
    const guardados = await as(tenantId, autor, () =>
      setCriteria({
        taskRef: 'bien-formado',
        criteria: [
          CRITERIO_BASE,
          {
            given: 'un webhook con firma invalida',
            when: 'llega al endpoint',
            then: 'la respuesta es 401 y no se encola ningun job',
          },
          {
            given: 'un fichero tocado por dos agentes',
            when: 'el segundo reclama',
            then: 'se lanza `ClaimConflictError` con el titular dentro',
          },
        ],
      }),
    )
    expect(guardados.criteria.map((row) => row.ordinal)).toEqual([1, 2, 3])
    expect(guardados.criteria[0]?.createdBy).toBe(autor)
    expect(guardados.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('cualquiera de las tres partes en blanco se rechaza', async () => {
    for (const parte of ['given', 'when', 'then'] as const) {
      await expect(
        as(tenantId, autor, () =>
          setCriteria({
            taskRef: 'en-blanco',
            criteria: [{ ...CRITERIO_BASE, [parte]: '   \n  ' }],
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError)
    }
  })

  it('un conjunto vacio se rechaza: "sin criterios" no es un conjunto de criterios', async () => {
    await expect(
      as(tenantId, autor, () => setCriteria({ taskRef: 'sin-nada', criteria: [] })),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('un `then` puramente subjetivo se rechaza, y el mensaje dice por que', async () => {
    const error = await as(tenantId, autor, () =>
      setCriteria({
        taskRef: 'subjetivo',
        criteria: [
          {
            given: 'una tarea cualquiera',
            when: 'el agente la termina',
            then: 'la solucion es robusta y elegante',
          },
        ],
      }),
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ValidationError)
    if (!(error instanceof ValidationError)) throw new Error('no alcanzable')
    expect(error.message).toContain('no menciona nada observable')
    expect(error.message).toContain('robusta')
    // El mensaje admite lo que es: una heuristica de piso, no un juicio.
    expect(error.message).toContain('heuristica')

    // Y no se ha guardado nada.
    expect((await as(tenantId, autor, () => readCriteria('subjetivo'))).criteria).toEqual([])
  })

  it('el numero del criterio rechazado sale en el mensaje', async () => {
    const error = await as(tenantId, autor, () =>
      setCriteria({
        taskRef: 'segundo-malo',
        criteria: [CRITERIO_BASE, { ...CRITERIO_BASE, then: 'todo mucho mas limpio' }],
      }),
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    if (!(error instanceof ValidationError)) throw new Error('no alcanzable')
    expect(error.message).toContain('criterio 2')
  })

  it('un task_ref mal formado se rechaza antes de tocar la base de datos', async () => {
    for (const taskRef of [
      '',
      ' ',
      '../../etc/passwd',
      'con espacio',
      "1'; DROP TABLE users; --",
    ]) {
      await expect(
        as(tenantId, autor, () => setCriteria({ taskRef, criteria: [CRITERIO_BASE] })),
      ).rejects.toBeInstanceOf(ValidationError)
    }
  })
})
