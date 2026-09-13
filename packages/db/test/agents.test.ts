import { randomUUID } from 'node:crypto'

import { NotFoundError, UnauthorizedError, runWithTenant } from '@coord/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  authenticateAgent,
  enqueueAgentCommand,
  readAgentStatuses,
  recordHeartbeat,
  registerAgent,
  revokeAgent,
} from '../src/agents.js'
import { withTenantConnection } from '../src/client.js'
import { closeDatabase, configureDatabase } from '../src/pool.js'

import { startDatabase, type StartedDatabase } from './support/database.js'

/**
 * Agentes, latidos y comandos contra un Postgres DE VERDAD (epic 04 / T01).
 *
 * Lo que se comprueba aqui es comportamiento del motor: que la RLS aisla, que
 * el latido y la lectura de comandos ocurren en la misma transaccion, y que un
 * token revocado deja de valer. Un doble solo demostraria que el doble hace lo
 * que le hemos dicho.
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
  tenantId = await crearTenant('agentes')
  otroTenantId = await crearTenant('ajeno')
}, 120_000)

afterAll(async () => {
  await closeDatabase()
  await database?.stop()
})

function nuevaClave(): string {
  return `agent-${String(Math.floor(Math.random() * 1_000_000))}`
}

describe('el token', () => {
  it('se devuelve UNA vez y lo que se guarda es su hash', async () => {
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Ana' }),
    )

    expect(agente.token).toContain('.')
    // Si esta tabla se filtra, lo que se lleva quien la lea no sirve para latir.
    const guardado = await runWithTenant({ tenantId }, () =>
      withTenantConnection(async (tx) => {
        const r = await tx.query<{ token_hash: string }>(
          'SELECT token_hash FROM agents WHERE tenant_id = $1 AND id = $2',
          [tx.tenantId, agente.id],
        )
        return r.rows[0]?.token_hash
      }),
    )

    expect(guardado).not.toContain(agente.token)
    expect(guardado).toMatch(/^[0-9a-f]{64}$/)
  })

  it('autentica y resuelve al agente sin que nadie diga el tenant', async () => {
    // El daemon no sabe de bases de datos: manda un token y ya. El prefijo del
    // token dice donde buscar, y el hash del token entero es lo que autentica.
    const agentKey = nuevaClave()
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey, label: 'Ana' }),
    )

    const autenticado = await authenticateAgent(agente.token)

    expect(autenticado.id).toBe(agente.id)
    expect(autenticado.tenantId).toBe(tenantId)
    expect(autenticado.agentKey).toBe(agentKey)
  })

  it('apuntar el prefijo a OTRO tenant no sirve de nada', async () => {
    // El prefijo es una pista para el scope, no una credencial: la busqueda va
    // por el hash del token ENTERO, asi que cambiarlo cambia el hash.
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Ana' }),
    )
    const secreto = agente.token.split('.')[1] ?? ''

    await expect(authenticateAgent(`${otroTenantId}.${secreto}`)).rejects.toThrow(UnauthorizedError)
  })

  it.each([
    ['vacio', ''],
    ['sin prefijo', 'solo-un-secreto'],
    ['prefijo que no es uuid', 'x.y'],
  ])('un token %s se rechaza', async (_caso, token) => {
    await expect(authenticateAgent(token)).rejects.toThrow(UnauthorizedError)
  })

  it('un token revocado deja de valer, y los demas siguen', async () => {
    // Segundo criterio de aceptacion de T01: la revocacion es INDIVIDUAL.
    const uno = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Ana' }),
    )
    const otro = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Bruno' }),
    )

    await runWithTenant({ tenantId }, () => revokeAgent(uno.id))

    await expect(authenticateAgent(uno.token)).rejects.toThrow(UnauthorizedError)
    expect((await authenticateAgent(otro.token)).id).toBe(otro.id)
  })

  it('el mensaje NO distingue "no existe" de "revocado"', async () => {
    // Distinguirlos le diria a quien prueba tokens cuales existieron alguna vez.
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Ana' }),
    )
    await runWithTenant({ tenantId }, () => revokeAgent(agente.id))

    const revocado = await authenticateAgent(agente.token).catch((e: unknown) => e)
    const inexistente = await authenticateAgent(`${tenantId}.${'0'.repeat(64)}`).catch(
      (e: unknown) => e,
    )

    expect((revocado as Error).message).toBe((inexistente as Error).message)
  })
})

describe('el latido', () => {
  it('trae los comandos pendientes EN LA MISMA respuesta', async () => {
    // El daemon no tiene otro canal: los comandos del hub viajan de vuelta en
    // la respuesta del propio latido.
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Ana' }),
    )
    await runWithTenant({ tenantId }, () =>
      enqueueAgentCommand({ agentId: agente.id, kind: 'nudge', payload: { texto: 'sigue' } }),
    )

    const resultado = await runWithTenant({ tenantId }, () =>
      recordHeartbeat({ agentId: agente.id, telemetry: { rama: 'entrega' } }),
    )

    expect(resultado.commands).toHaveLength(1)
    expect(resultado.commands[0]?.kind).toBe('nudge')
    expect(resultado.commands[0]?.payload).toEqual({ texto: 'sigue' })
  })

  it('un comando entregado NO se vuelve a entregar', async () => {
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Ana' }),
    )
    await runWithTenant({ tenantId }, () =>
      enqueueAgentCommand({ agentId: agente.id, kind: 'stop' }),
    )

    await runWithTenant({ tenantId }, () => recordHeartbeat({ agentId: agente.id }))
    const segundo = await runWithTenant({ tenantId }, () => recordHeartbeat({ agentId: agente.id }))

    expect(segundo.commands).toEqual([])
  })

  it('latir dos veces es idempotente: un portatil suspendido se reincorpora solo', async () => {
    // Cuarto criterio de aceptacion de T01. No hay nada que reactivar: latir ES
    // la reincorporacion.
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Ana' }),
    )
    const antiguo = new Date(Date.now() - 7_200_000)
    const reciente = new Date(Date.now() - 1_000)

    await runWithTenant({ tenantId }, () => recordHeartbeat({ agentId: agente.id, at: antiguo }))
    const vuelta = await runWithTenant({ tenantId }, () =>
      recordHeartbeat({ agentId: agente.id, at: reciente }),
    )

    expect(vuelta.lastBeatAt.toISOString()).toBe(reciente.toISOString())
  })

  it('un agente REVOCADO que sigue latiendo recibe un error, no un silencio', async () => {
    // Su daemon tiene que enterarse de que ya no cuenta, y el unico canal que
    // tiene es el error de esta llamada. Aceptarlo en silencio lo dejaria
    // latiendo para siempre contra un hub que lo ignora.
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Ana' }),
    )
    await runWithTenant({ tenantId }, () => revokeAgent(agente.id))

    await expect(
      runWithTenant({ tenantId }, () => recordHeartbeat({ agentId: agente.id })),
    ).rejects.toThrow(NotFoundError)
  })
})

describe('la vista de estado', () => {
  it('un agente que nunca ha latido NO figura como desaparecido', async () => {
    // "Nunca ha latido" y "lleva mucho sin latir" son cosas distintas: uno
    // acaba de darse de alta y el otro puede estar en problemas.
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Recien llegado' }),
    )

    const estados = await runWithTenant({ tenantId }, () => readAgentStatuses())
    const suyo = estados.find((e) => e.id === agente.id)

    expect(suyo?.lastBeatAt).toBeUndefined()
    expect(suyo?.liveness).toBeUndefined()
  })

  it('deriva el estado del tiempo desde el ultimo latido', async () => {
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Ana' }),
    )
    const cuando = new Date(Date.now() - 5_000)
    await runWithTenant({ tenantId }, () => recordHeartbeat({ agentId: agente.id, at: cuando }))

    const frescos = await runWithTenant({ tenantId }, () =>
      readAgentStatuses(new Date(cuando.getTime() + 1_000)),
    )
    const viejos = await runWithTenant({ tenantId }, () =>
      readAgentStatuses(new Date(cuando.getTime() + 600_000)),
    )

    expect(frescos.find((e) => e.id === agente.id)?.liveness).toBe('fresh')
    expect(viejos.find((e) => e.id === agente.id)?.liveness).toBe('stale')
  })

  it('los revocados siguen apareciendo, marcados', async () => {
    // Quitarlos haria desaparecer de la vista a un agente que alguien acaba de
    // apagar, y "ya no esta" y "nunca estuvo" se leen igual en una lista.
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Apagado' }),
    )
    await runWithTenant({ tenantId }, () => revokeAgent(agente.id))

    const estados = await runWithTenant({ tenantId }, () => readAgentStatuses())
    expect(estados.find((e) => e.id === agente.id)?.revoked).toBe(true)
  })
})

describe('aislamiento entre tenants', () => {
  it('los agentes de un cliente no se ven desde otro', async () => {
    const agente = await runWithTenant({ tenantId }, () =>
      registerAgent({ agentKey: nuevaClave(), label: 'Ana' }),
    )

    const ajenos = await runWithTenant({ tenantId: otroTenantId }, () => readAgentStatuses())
    expect(ajenos.some((e) => e.id === agente.id)).toBe(false)
  })
})
