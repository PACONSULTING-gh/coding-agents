import { describe, expect, it } from 'vitest'

import { MissingTenantContextError } from './errors.js'
import { currentTenant, requireTenant, runWithTenant } from './tenant.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('runWithTenant / currentTenant / requireTenant', () => {
  it('no hay contexto activo fuera de runWithTenant', () => {
    expect(currentTenant()).toBeUndefined()
  })

  it('requireTenant lanza MissingTenantContextError sin contexto activo', () => {
    expect(() => requireTenant()).toThrow(MissingTenantContextError)
  })

  it('expone el contexto dentro de runWithTenant', async () => {
    await runWithTenant({ tenantId: 'tenant-a' }, () => {
      expect(currentTenant()).toEqual({ tenantId: 'tenant-a' })
      expect(requireTenant()).toEqual({ tenantId: 'tenant-a' })
      return Promise.resolve()
    })
  })

  it('el contexto sobrevive a un await', async () => {
    await runWithTenant({ tenantId: 'tenant-b' }, async () => {
      await delay(10)
      expect(requireTenant().tenantId).toBe('tenant-b')
    })
  })

  it('el contexto no se filtra entre ejecuciones concurrentes', async () => {
    const results: string[] = []

    const runA = runWithTenant({ tenantId: 'tenant-a' }, async () => {
      await delay(20)
      results.push(requireTenant().tenantId)
    })

    const runB = runWithTenant({ tenantId: 'tenant-b' }, async () => {
      await delay(5)
      results.push(requireTenant().tenantId)
    })

    await Promise.all([runA, runB])

    // B termina antes (delay menor) pero cada una debe ver solo su propio tenant.
    expect(results.sort()).toEqual(['tenant-a', 'tenant-b'])
  })

  it('el contexto no esta disponible fuera del callback de runWithTenant', async () => {
    await runWithTenant({ tenantId: 'tenant-c' }, () => {
      expect(currentTenant()?.tenantId).toBe('tenant-c')
      return Promise.resolve()
    })
    expect(currentTenant()).toBeUndefined()
  })
})
