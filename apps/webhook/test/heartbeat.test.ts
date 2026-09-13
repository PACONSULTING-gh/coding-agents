import { randomUUID } from 'node:crypto'

import { NotFoundError, runWithTenant } from '@coord/core'
import {
  closeDatabase,
  configureDatabase,
  enqueueAgentCommand,
  registerAgent,
  revokeAgent,
  withTenantConnection,
} from '@coord/db'
import Fastify from 'fastify'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  esAgenteQueYaNoEsta,
  handleHeartbeat,
  HEARTBEAT_PATH,
  MAX_HEARTBEAT_BYTES,
} from '../src/heartbeat-route.js'

import { startDatabase, type StartedDatabase } from '../../../packages/db/test/support/database.js'

/**
 * El endpoint de latidos contra un Postgres de verdad (epic 04 / T01).
 *
 * Lo que importa aqui no es que el camino feliz funcione: es que TODO lo que no
 * autentica salga igual. Un 404 donde deberia haber un 401 le confirma a quien
 * prueba tokens que ese token fue bueno alguna vez, y eso convierte una lista
 * de tokens viejos en un objetivo.
 */

let database: StartedDatabase
let tenantId: string
const logger = pino({ level: 'silent' })

const app = Fastify()
app.post(HEARTBEAT_PATH, { bodyLimit: MAX_HEARTBEAT_BYTES }, async (request, reply) =>
  handleHeartbeat(request, reply, { logger }),
)

beforeAll(async () => {
  database = await startDatabase()
  configureDatabase({ connectionString: database.runtimeUrl })
  tenantId = randomUUID()
  await runWithTenant({ tenantId }, () =>
    withTenantConnection((tx) =>
      tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        'latidos',
        `latidos-${tenantId.slice(0, 8)}`,
      ]),
    ),
  )
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app.close()
  await closeDatabase()
  await database?.stop()
})

function nuevaClave(): string {
  return `agent-${String(Math.floor(Math.random() * 1_000_000))}`
}

async function nuevoAgente(): Promise<{ id: string; token: string }> {
  return runWithTenant({ tenantId }, () =>
    registerAgent({ agentKey: nuevaClave(), label: 'Dev simulado' }),
  )
}

async function latir(token: string | undefined, body: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: HEARTBEAT_PATH,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    payload: body,
  })
}

describe('el camino feliz', () => {
  it('un latido valido se registra y trae los comandos pendientes', async () => {
    const agente = await nuevoAgente()
    await runWithTenant({ tenantId }, () =>
      enqueueAgentCommand({ agentId: agente.id, kind: 'nudge', payload: { texto: 'sigue' } }),
    )

    const respuesta = await latir(agente.token, { telemetry: { rama: 'entrega', tokens: 120 } })

    expect(respuesta.statusCode).toBe(200)
    const cuerpo = respuesta.json<{ lastBeatAt: string; commands: { kind: string }[] }>()
    expect(cuerpo.lastBeatAt).toMatch(/^\d{4}-/)
    // Los comandos viajan EN ESTA respuesta: es el unico canal de vuelta que
    // tiene el daemon, porque el hub no puede alcanzar su maquina.
    expect(cuerpo.commands).toHaveLength(1)
    expect(cuerpo.commands[0]?.kind).toBe('nudge')
  }, 120_000)

  it('sin comandos pendientes, la lista viene vacia y no falta', async () => {
    const agente = await nuevoAgente()
    const respuesta = await latir(agente.token)

    expect(respuesta.statusCode).toBe(200)
    expect(respuesta.json<{ commands: unknown[] }>().commands).toEqual([])
  }, 120_000)
})

describe('todo lo que no autentica sale IGUAL', () => {
  it.each([
    ['sin cabecera', undefined],
    ['token inventado', `${randomUUID()}.${'f'.repeat(64)}`],
    ['token con prefijo que no es uuid', 'noesunuuid.abc'],
  ])('%s da 401', async (_caso, token) => {
    const respuesta = await latir(token)
    expect(respuesta.statusCode).toBe(401)
    expect(respuesta.json()).toEqual({ error: 'unauthorized' })
  })

  it('un token REVOCADO da 401, no 404', async () => {
    // Un 404 afirmaria que el token era valido y el agente no existe, que es
    // mas de lo que nadie sin credencial tiene que poder averiguar.
    const agente = await nuevoAgente()
    await runWithTenant({ tenantId }, () => revokeAgent(agente.id))

    const respuesta = await latir(agente.token)

    expect(respuesta.statusCode).toBe(401)
    expect(respuesta.json()).toEqual({ error: 'unauthorized' })
  }, 120_000)

  it('un esquema que no es Bearer no vale', async () => {
    const agente = await nuevoAgente()
    const respuesta = await app.inject({
      method: 'POST',
      url: HEARTBEAT_PATH,
      headers: { authorization: `Basic ${agente.token}` },
      payload: {},
    })
    expect(respuesta.statusCode).toBe(401)
  })
})

describe('un agente atascado recibe el empujon EN EL SIGUIENTE latido', () => {
  it('no en el de ahora, que ya ha leido sus comandos', async () => {
    // T03, criterio 3. Meterlo en la respuesta de este mismo latido seria
    // contestarse a uno mismo: los comandos de esta respuesta ya se leyeron
    // antes de clasificar.
    const agente = await nuevoAgente()

    const primero = await latir(agente.token, {
      telemetry: { repeatedToolCalls: 5, lastToolCall: 'Bash(pnpm test)' },
    })
    expect(primero.statusCode).toBe(200)
    expect(primero.json<{ commands: unknown[] }>().commands).toEqual([])

    const segundo = await latir(agente.token, { telemetry: { repeatedToolCalls: 5 } })
    const comandos = segundo.json<{ commands: { kind: string }[] }>().commands
    expect(comandos).toHaveLength(1)
    expect(comandos[0]?.kind).toBe('nudge')
  }, 120_000)

  it('y NO se le empuja otra vez en cada latido', async () => {
    // El daemon late cada 45 segundos: sin enfriamiento serian veinte
    // empujones en un cuarto de hora.
    const agente = await nuevoAgente()
    const atascado = { telemetry: { repeatedToolCalls: 5 } }

    await latir(agente.token, atascado)
    await latir(agente.token, atascado)
    await latir(agente.token, atascado)
    const cuarto = await latir(agente.token, atascado)

    expect(cuarto.json<{ commands: unknown[] }>().commands).toEqual([])
  }, 120_000)

  it('un agente que va bien no recibe nada', async () => {
    const agente = await nuevoAgente()
    await latir(agente.token, { telemetry: { repeatedToolCalls: 0 } })
    const segundo = await latir(agente.token, { telemetry: { repeatedToolCalls: 0 } })

    expect(segundo.json<{ commands: unknown[] }>().commands).toEqual([])
  }, 120_000)
})

describe('la telemetria es entrada no confiable', () => {
  it.each([
    ['un array', { telemetry: [1, 2, 3] }],
    ['un numero', { telemetry: 42 }],
    ['una cadena', { telemetry: 'hola' }],
  ])('%s se rechaza con 400', async (_caso, body) => {
    // Dejaria la columna con una forma que ninguna consulta de la vista de
    // equipo puede leer.
    const agente = await nuevoAgente()
    const respuesta = await latir(agente.token, body)
    expect(respuesta.statusCode).toBe(400)
  })

  it('sin telemetria, el latido sigue valiendo', async () => {
    // Un daemon que todavia no tiene sesion de agente late igual: lo que
    // importa del latido es que llego.
    const agente = await nuevoAgente()
    expect((await latir(agente.token)).statusCode).toBe(200)
  }, 120_000)

  it('un cuerpo gigantesco se rechaza por tamaño', async () => {
    // Sin tope, un daemon con un bug —o alguien con un token robado— puede
    // llenar la tabla a base de latidos gordos.
    const agente = await nuevoAgente()
    const respuesta = await latir(agente.token, {
      telemetry: { relleno: 'x'.repeat(MAX_HEARTBEAT_BYTES + 1_000) },
    })
    expect(respuesta.statusCode).toBe(413)
  }, 120_000)
})

describe('la carrera: revocado ENTRE autenticar y latir', () => {
  it('un agente que ya no esta se trata como 401, no como error', () => {
    // La ventana son dos consultas y no se puede provocar a voluntad desde un
    // test de integracion, asi que la decision vive suelta y se prueba aqui.
    expect(esAgenteQueYaNoEsta(new NotFoundError('no hay agente'))).toBe(true)
  })

  it.each([
    ['una caida de la base de datos', new Error('connection terminated')],
    ['un fallo cualquiera', new TypeError('x is not a function')],
    ['algo que no es un Error', 'cadena suelta'],
  ])('%s NO se disfraza de 401', (_caso, error) => {
    // Registrar una caida de base de datos como "el agente ya no esta" mandaria
    // a quien lea el log a buscar una revocacion que nunca ocurrio. Y devolver
    // 401 le diria al daemon que su token es malo, con lo que dejaria de latir.
    expect(esAgenteQueYaNoEsta(error)).toBe(false)
  })
})
