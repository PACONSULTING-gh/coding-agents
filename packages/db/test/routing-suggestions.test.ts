import { randomUUID } from 'node:crypto'

import { NotFoundError, runWithTenant, summarizeRoutingAccuracy } from '@coord/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenantConnection } from '../src/client.js'
import { closeDatabase, configureDatabase } from '../src/pool.js'
import {
  readRoutingOutcomes,
  recordRoutingAssignment,
  recordRoutingSuggestion,
} from '../src/routing-suggestions.js'

import { startDatabase, type StartedDatabase } from './support/database.js'

/**
 * Las sugerencias del router y su desenlace (epic 03 / T04), contra un Postgres
 * DE VERDAD: lo que se comprueba —RLS forzada, las dos restricciones de
 * coherencia y el upsert por (tenant, tarea)— es comportamiento del motor.
 *
 * COMO SE CUENTA la tasa no se prueba aqui: es puro y vive en
 * `packages/core/src/routing-accuracy.test.ts`, sin contenedor.
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
  tenantId = await crearTenant('router')
  otroTenantId = await crearTenant('ajeno')
}, 120_000)

afterAll(async () => {
  await closeDatabase()
  await database?.stop()
})

function nuevaTarea(): string {
  return `issue-${String(Math.floor(Math.random() * 1_000_000))}`
}

describe('lo que se guarda de una sugerencia', () => {
  it('el candidato del puesto 1 y el shortlist entero', async () => {
    const taskRef = nuevaTarea()

    const fila = await runWithTenant({ tenantId }, () =>
      recordRoutingSuggestion({
        taskRef,
        suggestedFirst: 'ana',
        entries: [
          { rank: 1, candidateId: 'ana', leadingSignal: 'ownership' },
          { rank: 2, candidateId: 'bruno', leadingSignal: 'workload' },
        ],
        model: 'claude-opus-5',
      }),
    )

    expect(fila.suggestedFirst).toBe('ana')
    expect(fila.assignedTo).toBeUndefined()
    // El shortlist se guarda entero aunque la metrica solo mire el puesto 1: el
    // dia que alguien pregunte "¿y estaba el segundo?", reconstruirlo seria
    // imposible.
    expect(fila.entries).toHaveLength(2)
    // Y con que modelo, porque si no, comparar semanas mezcla cambios de modelo
    // con cambios de calidad.
    expect(fila.model).toBe('claude-opus-5')
  })

  it('un `no_match` se guarda con su motivo y sin candidato', async () => {
    const fila = await runWithTenant({ tenantId }, () =>
      recordRoutingSuggestion({
        taskRef: nuevaTarea(),
        noMatchReason: 'Nadie ha tocado nunca packages/graph/src/parse',
      }),
    )

    expect(fila.suggestedFirst).toBeUndefined()
    expect(fila.noMatchReason).toContain('Nadie ha tocado')
  })

  it.each([
    ['ni candidato ni motivo', {}],
    ['candidato Y motivo a la vez', { suggestedFirst: 'ana', noMatchReason: 'no se' }],
  ])('se rechaza una sugerencia con %s', async (_caso, extra) => {
    // Sin esa coherencia no se puede distinguir "el router se rindio" de "se
    // perdio el candidato por el camino", y son cosas muy distintas.
    await expect(
      runWithTenant({ tenantId }, () =>
        recordRoutingSuggestion({ taskRef: nuevaTarea(), ...extra }),
      ),
    ).rejects.toThrow()
  })
})

describe('el desenlace', () => {
  it('asignar a quien iba primero cuenta como aceptada', async () => {
    const taskRef = nuevaTarea()

    await runWithTenant({ tenantId }, () =>
      recordRoutingSuggestion({ taskRef, suggestedFirst: 'ana' }),
    )
    const fila = await runWithTenant({ tenantId }, () =>
      recordRoutingAssignment({ taskRef, assignedTo: 'ana' }),
    )

    expect(fila.assignedTo).toBe('ana')
    expect(fila.assignedAt).toBeInstanceOf(Date)
  })

  it('asignar la tarea de un issue sobre el que el router no opino LANZA', async () => {
    // No es un caso raro: la mayoria de los issues se asignan sin que el router
    // haya dicho nada. Un exito silencioso aqui haria creer que la decision
    // quedo medida cuando no hay nada que medir.
    await expect(
      runWithTenant({ tenantId }, () =>
        recordRoutingAssignment({ taskRef: nuevaTarea(), assignedTo: 'ana' }),
      ),
    ).rejects.toThrow(NotFoundError)
  })

  it('volver a sugerir sobre la misma tarea BORRA la decision anterior', async () => {
    // Una sugerencia nueva no ha sido ni aceptada ni anulada todavia. Arrastrar
    // la decision de la anterior contaria como acierto algo que nadie ha
    // vuelto a mirar.
    const taskRef = nuevaTarea()

    await runWithTenant({ tenantId }, () =>
      recordRoutingSuggestion({ taskRef, suggestedFirst: 'ana' }),
    )
    await runWithTenant({ tenantId }, () => recordRoutingAssignment({ taskRef, assignedTo: 'ana' }))

    const fila = await runWithTenant({ tenantId }, () =>
      recordRoutingSuggestion({ taskRef, suggestedFirst: 'bruno' }),
    )

    expect(fila.suggestedFirst).toBe('bruno')
    expect(fila.assignedTo).toBeUndefined()
    expect(fila.assignedAt).toBeUndefined()
  })
})

describe('los hechos salen en la forma que espera la regla', () => {
  it('readRoutingOutcomes alimenta a summarizeRoutingAccuracy sin traducir nada', async () => {
    // Las dos piezas encajan de verdad: la de datos devuelve filas y la pura
    // decide. Si la capa de datos calculara la tasa con un `count(*) FILTER`,
    // la regla viviria dentro de una consulta SQL donde nadie la revisa.
    const tenantAislado = await crearTenant('metrica')
    const marca = new Date()

    await runWithTenant({ tenantId: tenantAislado }, async () => {
      for (const [taskRef, quien] of [
        ['issue-1', 'ana'],
        ['issue-2', 'ana'],
      ] as const) {
        await recordRoutingSuggestion({ taskRef, suggestedFirst: 'ana' })
        await recordRoutingAssignment({ taskRef, assignedTo: quien })
      }
      await recordRoutingSuggestion({ taskRef: 'issue-3', suggestedFirst: 'ana' })
      await recordRoutingAssignment({ taskRef: 'issue-3', assignedTo: 'bruno' })
      // Una pendiente y un no_match, que NO deben entrar en el denominador.
      await recordRoutingSuggestion({ taskRef: 'issue-4', suggestedFirst: 'ana' })
      await recordRoutingSuggestion({ taskRef: 'issue-5', noMatchReason: 'sin match' })
    })

    const hechos = await runWithTenant({ tenantId: tenantAislado }, () =>
      readRoutingOutcomes({ since: marca }),
    )
    const resumen = summarizeRoutingAccuracy(hechos)

    expect(resumen.decided).toBe(3)
    expect(resumen.acceptedFirst).toBe(2)
    expect(resumen.pending).toBe(1)
    expect(resumen.noMatch).toBe(1)
    expect(resumen.acceptanceRate).toBeCloseTo(2 / 3)
    // Tres muestras no alertan por mucho que la tasa asuste.
    expect(resumen.alert).toBe(false)
  })

  it('`since` acota la ventana', async () => {
    const tenantVentana = await crearTenant('ventana')
    await runWithTenant({ tenantId: tenantVentana }, () =>
      recordRoutingSuggestion({ taskRef: 'issue-viejo', suggestedFirst: 'ana' }),
    )
    const despues = new Date(Date.now() + 1_000)

    expect(
      await runWithTenant({ tenantId: tenantVentana }, () =>
        readRoutingOutcomes({ since: despues }),
      ),
    ).toEqual([])
  })
})

describe('aislamiento entre tenants', () => {
  it('las sugerencias de un cliente no se ven desde otro', async () => {
    // Esto dice a quien se le sugiere el trabajo de un cliente y quien lo acaba
    // cogiendo. No cruza la frontera.
    const taskRef = nuevaTarea()
    await runWithTenant({ tenantId }, () =>
      recordRoutingSuggestion({ taskRef, suggestedFirst: 'ana' }),
    )

    const ajenas = await runWithTenant({ tenantId: otroTenantId }, () => readRoutingOutcomes({}))
    expect(ajenas.some((r) => r.taskRef === taskRef)).toBe(false)
  })

  it('dos tenants pueden tener la MISMA tarea sin pisarse', async () => {
    const taskRef = 'issue-42'

    const mia = await runWithTenant({ tenantId }, () =>
      recordRoutingSuggestion({ taskRef, suggestedFirst: 'ana' }),
    )
    const suya = await runWithTenant({ tenantId: otroTenantId }, () =>
      recordRoutingSuggestion({ taskRef, suggestedFirst: 'bruno' }),
    )

    expect(mia.suggestedFirst).toBe('ana')
    expect(suya.suggestedFirst).toBe('bruno')
  })
})

describe('la frontera de entrada', () => {
  it.each(['', '   '])('un candidato en blanco (%s) se rechaza', async (suggestedFirst) => {
    // Un candidato vacio pasaria por sugerencia y luego nunca coincidiria con
    // nadie: contaria como anulacion para siempre.
    await expect(
      runWithTenant({ tenantId }, () =>
        recordRoutingSuggestion({ taskRef: nuevaTarea(), suggestedFirst }),
      ),
    ).rejects.toThrow()
  })

  it.each(['', '   '])('asignar a nadie (%s) se rechaza', async (assignedTo) => {
    // Peor todavia: marcaria la sugerencia como resuelta y la meteria en el
    // denominador como anulada, sin que nadie haya decidido nada.
    const taskRef = nuevaTarea()
    await runWithTenant({ tenantId }, () =>
      recordRoutingSuggestion({ taskRef, suggestedFirst: 'ana' }),
    )
    await expect(
      runWithTenant({ tenantId }, () => recordRoutingAssignment({ taskRef, assignedTo })),
    ).rejects.toThrow()
  })

  it('el error de incoherencia EXPLICA por que importa', async () => {
    // Un "invalid input" pelado no le dice a nadie que el problema es que no se
    // puede distinguir una rendicion de un candidato perdido.
    await expect(
      runWithTenant({ tenantId }, () => recordRoutingSuggestion({ taskRef: nuevaTarea() })),
    ).rejects.toThrow(/se rindio/)
  })

  it('sin shortlist, se guarda una lista vacia y no un nulo', async () => {
    const fila = await runWithTenant({ tenantId }, () =>
      recordRoutingSuggestion({ taskRef: nuevaTarea(), suggestedFirst: 'ana' }),
    )
    expect(fila.entries).toEqual([])
  })
})
