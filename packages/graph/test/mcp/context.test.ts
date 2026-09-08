import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { loadServerConfig } from '../../src/mcp/context.js'

/**
 * `loadServerConfig` (T05): de donde sale el contexto de tenant de un
 * servidor MCP, y que falle RUIDOSO si falta -- nunca "todo" por no tener
 * contexto (regla dura de la tarea y de CLAUDE.md 2.6). Puro, sin Postgres.
 */
describe('loadServerConfig', () => {
  it('sin GRAPH_MCP_TENANT_ID, falla ruidoso y no arranca', () => {
    expect(() => loadServerConfig({})).toThrow(/GRAPH_MCP_TENANT_ID/)
  })

  it('con un valor que no es un uuid, falla ruidoso', () => {
    expect(() => loadServerConfig({ GRAPH_MCP_TENANT_ID: 'no-es-un-uuid' })).toThrow(
      /no es un uuid/,
    )
  })

  it('con un uuid valido y sin GRAPH_CHECKOUT_ROOT, arranca sin checkout configurado', () => {
    const tenantId = randomUUID()
    const config = loadServerConfig({ GRAPH_MCP_TENANT_ID: tenantId })
    expect(config).toEqual({ tenantId, checkoutRoot: undefined })
  })

  it('GRAPH_CHECKOUT_ROOT vacio cuenta como no definido', () => {
    const tenantId = randomUUID()
    const config = loadServerConfig({ GRAPH_MCP_TENANT_ID: tenantId, GRAPH_CHECKOUT_ROOT: '   ' })
    expect(config.checkoutRoot).toBeUndefined()
  })

  it('con las dos variables definidas, las recoge tal cual', () => {
    const tenantId = randomUUID()
    const config = loadServerConfig({
      GRAPH_MCP_TENANT_ID: tenantId,
      GRAPH_CHECKOUT_ROOT: '/var/lib/coord/checkouts',
    })
    expect(config).toEqual({ tenantId, checkoutRoot: '/var/lib/coord/checkouts' })
  })
})
