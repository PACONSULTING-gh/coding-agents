import { randomUUID } from 'node:crypto'

import { runWithTenant } from '@coord/core'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenantConnection } from '../src/client.js'
import {
  deleteInstallation,
  findInstallationRouting,
  updateInstallationState,
  upsertInstallation,
} from '../src/github-installations.js'
import { closeDatabase, configureDatabase } from '../src/pool.js'
import { recordWebhookDelivery, forgetWebhookDelivery } from '../src/webhook-deliveries.js'
import { startDatabase, type StartedDatabase } from './support/database.js'

/**
 * `github_installations` es la unica tabla del esquema con una politica de RLS
 * ADEMAS de `tenant_isolation`: el carve-out de enrutado de la migracion 0006.
 * Estos tests existen para que ese carve-out no se convierta en una puerta
 * trasera sin que nadie se entere.
 *
 * Lo que se comprueba no es que el codigo llame a las funciones correctas: es
 * que el MOTOR no deja pasar lo que no debe. Por eso hay consultas crudas con
 * `pg` ademas de las que van por la capa de acceso.
 */

let database: StartedDatabase
let runtime: Client
let tenantA: string
let tenantB: string

const INSTALLATION_A = 11_000_001
const INSTALLATION_B = 22_000_002

async function createTenant(slug: string): Promise<string> {
  const id = randomUUID()
  await runWithTenant({ tenantId: id }, () =>
    withTenantConnection((tx) =>
      tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        id,
        slug,
        `${slug}-${id.slice(0, 8)}`,
      ]),
    ),
  )
  return id
}

beforeAll(async () => {
  database = await startDatabase()
  configureDatabase({
    connectionString: database.runtimeUrl,
    applicationName: 'coord-db-github-test',
    allowExitOnIdle: true,
  })
  runtime = new Client({ connectionString: database.runtimeUrl })
  await runtime.connect()

  tenantA = await createTenant('tenant-a')
  tenantB = await createTenant('tenant-b')

  await runWithTenant({ tenantId: tenantA }, () =>
    withTenantConnection((tx) =>
      upsertInstallation(tx, {
        installationId: INSTALLATION_A,
        accountLogin: 'cliente-a',
        accountType: 'Organization',
        repositorySelection: 'all',
      }),
    ),
  )
  await runWithTenant({ tenantId: tenantB }, () =>
    withTenantConnection((tx) =>
      upsertInstallation(tx, {
        installationId: INSTALLATION_B,
        accountLogin: 'cliente-b',
        accountType: 'User',
        repositorySelection: 'selected',
      }),
    ),
  )
}, 180_000)

afterAll(async () => {
  await runtime?.end()
  await closeDatabase()
  await database?.stop()
})

describe('1. aislamiento normal de github_installations', () => {
  it('cada tenant solo ve su propia instalacion', async () => {
    const seenByA = await runWithTenant({ tenantId: tenantA }, () =>
      withTenantConnection((tx) =>
        tx.query<{ installation_id: string }>('SELECT installation_id FROM github_installations'),
      ),
    )
    expect(seenByA.rows.map((row) => Number(row.installation_id))).toEqual([INSTALLATION_A])

    const seenByB = await runWithTenant({ tenantId: tenantB }, () =>
      withTenantConnection((tx) =>
        tx.query<{ installation_id: string }>('SELECT installation_id FROM github_installations'),
      ),
    )
    expect(seenByB.rows.map((row) => Number(row.installation_id))).toEqual([INSTALLATION_B])
  })

  it('un tenant no puede reclamar la instalacion de otro', async () => {
    await expect(
      runWithTenant({ tenantId: tenantB }, () =>
        withTenantConnection((tx) =>
          upsertInstallation(tx, {
            installationId: INSTALLATION_A,
            accountLogin: 'cliente-b',
            accountType: 'Organization',
            repositorySelection: 'all',
          }),
        ),
      ),
      // El `ON CONFLICT (installation_id) DO UPDATE` encuentra la fila del otro
      // tenant y la clausula USING de `tenant_isolation` corta la actualizacion:
      // Postgres lanza. Es el fallo ruidoso que se busca, no un silencio.
    ).rejects.toThrow(/row-level security/i)

    // Y la fila del tenant A sigue intacta.
    const routing = await findInstallationRouting(INSTALLATION_A)
    expect(routing?.tenantId).toBe(tenantA)
    expect(routing?.accountLogin).toBe('cliente-a')
  })

  it('un tenant no puede borrar ni tocar la instalacion de otro', async () => {
    await expect(
      runWithTenant({ tenantId: tenantB }, () =>
        withTenantConnection((tx) => deleteInstallation(tx, INSTALLATION_A)),
      ),
    ).resolves.toBe(false)

    await expect(
      runWithTenant({ tenantId: tenantB }, () =>
        withTenantConnection((tx) =>
          updateInstallationState(tx, { installationId: INSTALLATION_A, suspendedAt: new Date() }),
        ),
      ),
    ).resolves.toBeUndefined()

    expect((await findInstallationRouting(INSTALLATION_A))?.suspendedAt).toBeNull()
  })
})

describe('2. el carve-out de enrutado esta acotado a UNA fila', () => {
  it('resuelve cada instalacion a su tenant sin contexto de tenant', async () => {
    await expect(findInstallationRouting(INSTALLATION_A)).resolves.toMatchObject({
      tenantId: tenantA,
      accountLogin: 'cliente-a',
    })
    await expect(findInstallationRouting(INSTALLATION_B)).resolves.toMatchObject({
      tenantId: tenantB,
      accountLogin: 'cliente-b',
    })
  })

  it('sin declarar la instalacion, no se ve NADA', async () => {
    // Sin `app.tenant_id` y sin `app.github_installation_lookup`: cero filas.
    const result = await runtime.query('SELECT * FROM github_installations')
    expect(result.rows).toEqual([])
  })

  it('declarando una instalacion, un SELECT sin WHERE devuelve SOLO esa fila', async () => {
    // Este es el test que da valor al carve-out: aunque el codigo se equivoque y
    // pida la tabla entera, la politica solo deja pasar la fila declarada.
    await runtime.query('BEGIN')
    try {
      await runtime.query('SELECT set_config($1, $2, true)', [
        'app.github_installation_lookup',
        String(INSTALLATION_A),
      ])
      const result = await runtime.query<{ installation_id: string; tenant_id: string }>(
        'SELECT installation_id, tenant_id FROM github_installations',
      )
      expect(result.rows).toHaveLength(1)
      expect(Number(result.rows[0]?.installation_id)).toBe(INSTALLATION_A)
      expect(result.rows[0]?.tenant_id).toBe(tenantA)
    } finally {
      await runtime.query('COMMIT')
    }
  })

  it('el ajuste es LOCAL: al cerrar la transaccion no queda nada pegado', async () => {
    const result = await runtime.query('SELECT * FROM github_installations')
    expect(result.rows).toEqual([])
  })

  it('el carve-out no permite escribir, solo leer', async () => {
    await runtime.query('BEGIN')
    try {
      await runtime.query('SELECT set_config($1, $2, true)', [
        'app.github_installation_lookup',
        String(INSTALLATION_A),
      ])
      // La politica de enrutado es FOR SELECT: un UPDATE no encuentra fila que
      // tocar (la clausula USING de `tenant_isolation` tampoco deja pasar).
      const updated = await runtime.query(
        'UPDATE github_installations SET account_login = $1 WHERE installation_id = $2',
        ['secuestrada', INSTALLATION_A],
      )
      expect(updated.rowCount).toBe(0)
    } finally {
      await runtime.query('COMMIT')
    }

    expect((await findInstallationRouting(INSTALLATION_A))?.accountLogin).toBe('cliente-a')
  })

  it('con contexto de tenant activo el carve-out no amplia lo que se ve', async () => {
    await runtime.query('BEGIN')
    try {
      await runtime.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantB])
      await runtime.query('SELECT set_config($1, $2, true)', [
        'app.github_installation_lookup',
        String(INSTALLATION_A),
      ])
      const result = await runtime.query<{ installation_id: string }>(
        'SELECT installation_id FROM github_installations',
      )
      // Solo la suya: la politica de enrutado exige que NO haya tenant activo.
      expect(result.rows.map((row) => Number(row.installation_id))).toEqual([INSTALLATION_B])
    } finally {
      await runtime.query('COMMIT')
    }
  })
})

describe('3. deduplicacion de entregas', () => {
  it('la primera vez inserta y la segunda no', async () => {
    const deliveryId = randomUUID()

    await runWithTenant({ tenantId: tenantA }, async () => {
      await expect(
        withTenantConnection((tx) => recordWebhookDelivery(tx, { deliveryId, event: 'issues' })),
      ).resolves.toBe(true)
      await expect(
        withTenantConnection((tx) => recordWebhookDelivery(tx, { deliveryId, event: 'issues' })),
      ).resolves.toBe(false)
    })
  })

  it('el GUID es unico en todo el sistema: otro tenant tampoco lo reutiliza', async () => {
    const deliveryId = randomUUID()

    await runWithTenant({ tenantId: tenantA }, () =>
      withTenantConnection((tx) => recordWebhookDelivery(tx, { deliveryId, event: 'push' })),
    )
    await expect(
      runWithTenant({ tenantId: tenantB }, () =>
        withTenantConnection((tx) => recordWebhookDelivery(tx, { deliveryId, event: 'push' })),
      ),
    ).resolves.toBe(false)
  })

  it('dos inserciones simultaneas del mismo GUID: solo una gana', async () => {
    const deliveryId = randomUUID()

    const results = await runWithTenant({ tenantId: tenantA }, () =>
      Promise.all([
        withTenantConnection((tx) => recordWebhookDelivery(tx, { deliveryId, event: 'issues' })),
        withTenantConnection((tx) => recordWebhookDelivery(tx, { deliveryId, event: 'issues' })),
      ]),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('la compensacion borra la marca para que la reentrega vuelva a contar', async () => {
    const deliveryId = randomUUID()

    await runWithTenant({ tenantId: tenantA }, async () => {
      await withTenantConnection((tx) => recordWebhookDelivery(tx, { deliveryId, event: 'issues' }))
      await expect(
        withTenantConnection((tx) => forgetWebhookDelivery(tx, deliveryId)),
      ).resolves.toBe(true)
      await expect(
        withTenantConnection((tx) => recordWebhookDelivery(tx, { deliveryId, event: 'issues' })),
      ).resolves.toBe(true)
    })
  })

  it('un tenant no puede borrar la marca de otro', async () => {
    const deliveryId = randomUUID()

    await runWithTenant({ tenantId: tenantA }, () =>
      withTenantConnection((tx) => recordWebhookDelivery(tx, { deliveryId, event: 'issues' })),
    )
    await expect(
      runWithTenant({ tenantId: tenantB }, () =>
        withTenantConnection((tx) => forgetWebhookDelivery(tx, deliveryId)),
      ),
    ).resolves.toBe(false)
  })
})
