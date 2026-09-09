import { randomUUID } from 'node:crypto'

import { MissingTenantContextError, runWithTenant, ValidationError } from '@coord/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readAuditLog } from '../src/audit.js'
import {
  ClosedTransactionError,
  unsafeWithoutTenantScope,
  withTenantConnection,
  withTenantTransaction,
  type TenantQuery,
} from '../src/client.js'
import { closeDatabase, configureDatabase, getPoolStats } from '../src/pool.js'
import type { Queryable } from '../src/queryable.js'

import { startDatabase, type StartedDatabase } from './support/database.js'

/**
 * Tests de la capa de acceso a datos (T03) contra Postgres de verdad.
 *
 * Lo que se esta comprobando no es que el SQL este bien escrito, sino que
 * ningun desarrollador PUEDA equivocarse: que el tenant se fija solo, que sin
 * contexto la capa falla antes de consultar, y que el contexto no se queda
 * pegado en una conexion del pool que despues reutiliza otro tenant.
 *
 * PgBouncer no participa en este fichero (esta en pgbouncer.test.ts): aqui se
 * habla con Postgres directamente, porque para observar que una MISMA conexion
 * fisica no arrastra estado hace falta que la conexion fisica sea estable, y
 * `pg_backend_pid()` a traves de un pooler en modo transaccion no lo es.
 */

let db: StartedDatabase

interface TenantFixture {
  id: string
  slug: string
  userIds: readonly string[]
}

async function createTenant(slug: string, users = 2): Promise<TenantFixture> {
  const id = randomUUID()
  const userIds = Array.from({ length: users }, () => randomUUID())

  await runWithTenant({ tenantId: id }, () =>
    withTenantConnection(async (tx) => {
      await tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        id,
        `Tenant ${slug}`,
        slug,
      ])
      for (const [index, userId] of userIds.entries()) {
        await tx.query(
          'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
          [userId, id, `user${String(index)}@${slug}.example`, `Usuario ${String(index)}`],
        )
      }
    }),
  )

  return { id, slug, userIds }
}

interface SessionState {
  /** Backend de Postgres que atendio la consulta. Identifica la conexion fisica. */
  pid: number
  /** `app.tenant_id` tal cual lo ve el servidor. */
  tenant: string | null
  usuarios: string
}

/**
 * Lee, en una sola consulta, quien esta atendiendo y con que tenant. Acepta
 * `Queryable` para poder usarse tanto desde `withTenantConnection` como desde
 * la via administrativa, que no tiene tenant.
 */
async function leerEstado(db: Queryable): Promise<SessionState> {
  const result = await db.query(
    `SELECT pg_backend_pid() AS pid,
            current_setting('app.tenant_id', true) AS tenant,
            (SELECT count(*) FROM users)::text AS usuarios`,
  )
  const [row] = result.rows
  if (row === null || typeof row !== 'object') {
    throw new Error('La consulta de estado de sesion no devolvio ninguna fila.')
  }
  return row as SessionState
}

/** Ids de usuario visibles para el tenant activo, con SQL SIN filtro de tenant. */
async function visibleUserIds(): Promise<string[]> {
  return withTenantConnection(async (tx) => {
    const result = await tx.query<{ id: string }>('SELECT id FROM users')
    return result.rows.map((row) => row.id)
  })
}

let tenantA: TenantFixture
let tenantB: TenantFixture

beforeAll(async () => {
  db = await startDatabase()
  configureDatabase({
    connectionString: db.runtimeUrl,
    max: 8,
    allowExitOnIdle: true,
  })

  tenantA = await createTenant('alfa')
  tenantB = await createTenant('beta')
}, 180_000)

afterAll(async () => {
  await closeDatabase()
  await db?.stop()
})

describe('1. aislamiento a traves de la capa: el tenant se fija sin intervencion manual', () => {
  it('dentro de runWithTenant(A) solo se ven datos de A, aunque el SQL no filtre', async () => {
    const vistosPorA = await runWithTenant({ tenantId: tenantA.id }, visibleUserIds)
    expect(vistosPorA.sort()).toEqual([...tenantA.userIds].sort())
    for (const idDeB of tenantB.userIds) {
      expect(vistosPorA).not.toContain(idDeB)
    }
  })

  it('el mismo codigo, bajo B, devuelve exactamente lo de B', async () => {
    const vistosPorB = await runWithTenant({ tenantId: tenantB.id }, visibleUserIds)
    expect(vistosPorB.sort()).toEqual([...tenantB.userIds].sort())
  })

  it('el servidor confirma que app.tenant_id es el del contexto, no otro', async () => {
    const enServidor = await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async (tx) => {
        const result = await tx.query<{ tenant: string | null }>(
          'SELECT app_current_tenant_id()::text AS tenant',
        )
        expect(tx.tenantId).toBe(tenantA.id)
        return result.rows[0]?.tenant
      }),
    )
    expect(enServidor).toBe(tenantA.id)
  })

  it('un JOIN sin condicion de tenant tampoco cruza datos', async () => {
    await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async (tx) => {
        const result = await tx.query<{ tenant_id: string }>(
          'SELECT u.tenant_id FROM users u JOIN tenants t ON true',
        )
        expect(result.rows.length).toBe(tenantA.userIds.length)
        expect(result.rows.every((row) => row.tenant_id === tenantA.id)).toBe(true)
      }),
    )
  })
})

describe('2. sin contexto de tenant: falla ruidosamente y sin tocar la base de datos', () => {
  it('lanza MissingTenantContextError y no llega a ejecutar ninguna consulta', async () => {
    // El pool se recrea desde cero para que su contador de clientes creados sea
    // una medida limpia: si la capa hubiera pedido conexion, `total` subiria.
    await closeDatabase()
    configureDatabase({ connectionString: db.runtimeUrl, max: 4, allowExitOnIdle: true })
    expect(getPoolStats().total).toBe(0)

    let callbackEjecutado = false
    await expect(
      withTenantConnection(async (tx) => {
        callbackEjecutado = true
        await tx.query('SELECT 1')
      }),
    ).rejects.toBeInstanceOf(MissingTenantContextError)

    expect(callbackEjecutado, 'el callback no debe llegar a ejecutarse').toBe(false)
    expect(
      getPoolStats().total,
      'no se debe haber creado ninguna conexion: la capa falla antes de tocar la base de datos',
    ).toBe(0)

    // Control: la metrica anterior solo vale si sabe subir. Una llamada CON
    // contexto crea conexion, luego el 0 de arriba significa algo.
    await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection((tx) => tx.query('SELECT 1')),
    )
    expect(getPoolStats().total).toBeGreaterThan(0)
  })

  it('un tenantId que no es uuid se rechaza en la frontera, no se manda al servidor', async () => {
    await expect(
      runWithTenant({ tenantId: "no-soy-un-uuid'; DROP TABLE users; --" }, () =>
        withTenantConnection((tx) => tx.query('SELECT 1')),
      ),
    ).rejects.toBeInstanceOf(ValidationError)

    // Y la tabla sigue ahi.
    const usuarios = await runWithTenant({ tenantId: tenantA.id }, visibleUserIds)
    expect(usuarios).toHaveLength(tenantA.userIds.length)
  })
})

describe('3. el contexto no se queda pegado en la conexion fisica', () => {
  /**
   * Con `max: 1` hay UNA sola conexion fisica, asi que las tres operaciones de
   * este bloque se ejecutan forzosamente sobre el mismo backend de Postgres:
   * es el escenario exacto en el que un `SET` de sesion filtraria datos de un
   * tenant a otro.
   */
  beforeAll(async () => {
    await closeDatabase()
    configureDatabase({ connectionString: db.runtimeUrl, max: 1, allowExitOnIdle: true })
  })

  afterAll(async () => {
    await closeDatabase()
    configureDatabase({ connectionString: db.runtimeUrl, max: 8, allowExitOnIdle: true })
  })

  it('A, luego B, luego sin contexto: ni rastro del tenant anterior', async () => {
    const estadoA = await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection((tx) => leerEstado(tx)),
    )
    expect(estadoA.tenant).toBe(tenantA.id)
    expect(Number(estadoA.usuarios)).toBe(tenantA.userIds.length)

    const estadoB = await runWithTenant({ tenantId: tenantB.id }, () =>
      withTenantConnection((tx) => leerEstado(tx)),
    )
    expect(estadoB.pid, 'el test necesita que sea la misma conexion fisica').toBe(estadoA.pid)
    expect(estadoB.tenant, 'la transaccion de B ha heredado el tenant de A').toBe(tenantB.id)
    expect(Number(estadoB.usuarios)).toBe(tenantB.userIds.length)

    // Tercera transaccion sobre la misma conexion, esta vez sin fijar tenant.
    const estadoSinContexto = await unsafeWithoutTenantScope(
      {
        operation: 'test.inspect_session_state',
        reason: 'Comprobar que app.tenant_id no sobrevive al COMMIT de la transaccion anterior.',
        auditTenantId: tenantA.id,
      },
      (conexion) => leerEstado(conexion),
    )

    expect(estadoSinContexto.pid, 'el test necesita que sea la misma conexion fisica').toBe(
      estadoA.pid,
    )
    // `set_config(..., true)` se revierte al terminar la transaccion. Postgres
    // deja la variable existiendo pero vacia, y `app_current_tenant_id()` la
    // convierte en NULL con NULLIF: en ningun caso queda el uuid anterior.
    expect(
      estadoSinContexto.tenant === null || estadoSinContexto.tenant === '',
      `app.tenant_id se quedo pegado con el valor ${String(estadoSinContexto.tenant)}`,
    ).toBe(true)
    // Y la consecuencia observable: sin contexto no se ve ni una fila.
    expect(estadoSinContexto.usuarios).toBe('0')
  })
})

describe('4. concurrencia: cada operacion ve solo lo suyo', () => {
  const TENANTS = 20
  const REPETICIONES = 5
  let tenants: TenantFixture[]

  beforeAll(async () => {
    tenants = []
    for (let i = 0; i < TENANTS; i += 1) {
      // Secuencial a proposito: crear los datos no es lo que se esta midiendo.
      tenants.push(await createTenant(`conc-${String(i)}`, 3))
    }
  }, 180_000)

  it('100 operaciones en paralelo de 20 tenants sobre el mismo pool no se cruzan', async () => {
    // El pool (max: 8) es mucho mas pequeno que el numero de operaciones, asi
    // que las conexiones se reutilizan sin parar. Este es el test que caza el
    // bug clasico: fijar el tenant a nivel de sesion "funciona" mientras no hay
    // concurrencia y filtra datos en cuanto la hay.
    const operaciones = Array.from({ length: TENANTS * REPETICIONES }, (_unused, index) => {
      const tenant = tenants[index % TENANTS]
      if (tenant === undefined) throw new Error('Fixture de tenant ausente.')
      return runWithTenant({ tenantId: tenant.id }, async () => {
        const vistos = await visibleUserIds()
        return { esperado: tenant, vistos }
      })
    })

    const resultados = await Promise.all(operaciones)

    expect(resultados).toHaveLength(TENANTS * REPETICIONES)
    for (const { esperado, vistos } of resultados) {
      expect(
        vistos.slice().sort(),
        `el tenant ${esperado.slug} vio usuarios que no son suyos`,
      ).toEqual([...esperado.userIds].sort())
    }
  }, 120_000)
})

describe('5. anidamiento con SAVEPOINTs', () => {
  it('la llamada anidada comparte transaccion: ve lo que escribio la exterior', async () => {
    const userId = randomUUID()

    const visto = await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async (tx) => {
        await tx.query(
          'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
          [userId, tenantA.id, `anidado-${userId}@alfa.example`, 'Anidado'],
        )
        // Si esto pidiera una segunda conexion del pool, seria otra transaccion
        // y no veria la fila de arriba.
        return withTenantTransaction(async (nested) => {
          const result = await nested.query('SELECT id FROM users WHERE id = $1', [userId])
          return result.rows.length
        })
      }),
    )

    expect(visto).toBe(1)

    // Limpieza: la fila se queda; el resto de tests de este bloque no la miran.
    await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection((tx) => tx.query('DELETE FROM users WHERE id = $1', [userId])),
    )
  })

  it('un fallo dentro del SAVEPOINT deshace solo lo suyo, la exterior sobrevive', async () => {
    const bueno = randomUUID()
    const malo = randomUUID()

    await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async (tx) => {
        await tx.query(
          'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
          [bueno, tenantA.id, `bueno-${bueno}@alfa.example`, 'Bueno'],
        )

        await expect(
          withTenantTransaction(async (nested) => {
            await nested.query(
              'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
              [malo, tenantA.id, `malo-${malo}@alfa.example`, 'Malo'],
            )
            throw new Error('fallo deliberado dentro del savepoint')
          }),
        ).rejects.toThrow('fallo deliberado dentro del savepoint')

        // La transaccion exterior NO esta abortada: se puede seguir usando.
        const result = await tx.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1)', [
          [bueno, malo],
        ])
        expect(result.rows.map((row) => row.id)).toEqual([bueno])
      }),
    )

    // Y el COMMIT exterior confirmo solo la fila buena.
    const finales = await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async (tx) => {
        const result = await tx.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1)', [
          [bueno, malo],
        ])
        return result.rows.map((row) => row.id)
      }),
    )
    expect(finales).toEqual([bueno])

    await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection((tx) => tx.query('DELETE FROM users WHERE id = $1', [bueno])),
    )
  })

  it('dos anidadas CONCURRENTES: el fallo de una no se lleva por delante lo que escribio la otra', async () => {
    // Este es el patron mas normal del mundo —un Promise.all de dos operaciones
    // de repositorio dentro de una transaccion— y era una perdida de datos
    // SILENCIOSA: las dos anidadas compartian una unica pila de SAVEPOINTs, y
    // el `ROLLBACK TO SAVEPOINT` de la que fallaba deshacia tambien la
    // insercion de la que habia tenido exito, que ya habia devuelto "ok".
    const bueno = randomUUID()
    const malo = randomUUID()

    const resultados = await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async () =>
        Promise.allSettled([
          withTenantTransaction(async (nested) => {
            await nested.query(
              'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
              [bueno, tenantA.id, `conc-bueno-${bueno}@alfa.example`, 'Concurrente bueno'],
            )
            return 'ok'
          }),
          withTenantTransaction(async (nested) => {
            await nested.query(
              'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
              [malo, tenantA.id, `conc-malo-${malo}@alfa.example`, 'Concurrente malo'],
            )
            throw new Error('fallo deliberado en la anidada concurrente')
          }),
        ]),
      ),
    )

    expect(resultados[0]?.status).toBe('fulfilled')
    expect(resultados[1]?.status).toBe('rejected')

    // Lo que de verdad se comprueba: DESPUES del COMMIT exterior, la fila de la
    // anidada que dijo "ok" sigue ahi, y la de la que fallo no.
    const finales = await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async (tx) => {
        const result = await tx.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1)', [
          [bueno, malo],
        ])
        return result.rows.map((row) => row.id)
      }),
    )
    expect(finales, 'la anidada que devolvio ok perdio su fila en el COMMIT').toEqual([bueno])

    await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection((tx) => tx.query('DELETE FROM users WHERE id = $1', [bueno])),
    )
  })

  it('dos anidadas concurrentes que van bien: el COMMIT confirma las dos', async () => {
    // La variante gemela del bug anterior: si la primera liberaba antes, su
    // `RELEASE SAVEPOINT` destruia tambien el savepoint de la segunda y el
    // `RELEASE` de esta reventaba, abortando la transaccion exterior.
    const uno = randomUUID()
    const dos = randomUUID()

    await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async () => {
        await Promise.all(
          [uno, dos].map((id, index) =>
            withTenantTransaction((nested) =>
              nested.query(
                'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
                [id, tenantA.id, `par-${id}@alfa.example`, `Par ${String(index)}`],
              ),
            ),
          ),
        )
      }),
    )

    const finales = await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async (tx) => {
        const result = await tx.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1)', [
          [uno, dos],
        ])
        return result.rows.map((row) => row.id)
      }),
    )
    expect(finales.slice().sort()).toEqual([uno, dos].sort())

    await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection((tx) => tx.query('DELETE FROM users WHERE id = ANY($1)', [[uno, dos]])),
    )
  })

  it('cambiar de tenant dentro de una transaccion abierta se rechaza', async () => {
    await expect(
      runWithTenant({ tenantId: tenantA.id }, () =>
        withTenantConnection(() =>
          runWithTenant({ tenantId: tenantB.id }, () =>
            withTenantConnection((nested) => nested.query('SELECT 1')),
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('6. errores: se propaga el original y se deshace lo escrito', () => {
  it('un error dentro del callback provoca ROLLBACK y sale tal cual', async () => {
    const userId = randomUUID()
    const original = new Error('explota a mitad de la transaccion')

    await expect(
      runWithTenant({ tenantId: tenantA.id }, () =>
        withTenantConnection(async (tx) => {
          await tx.query(
            'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
            [userId, tenantA.id, `rollback-${userId}@alfa.example`, 'Rollback'],
          )
          throw original
        }),
      ),
    ).rejects.toBe(original)

    const sigue = await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async (tx) => {
        const result = await tx.query('SELECT id FROM users WHERE id = $1', [userId])
        return result.rows.length
      }),
    )
    expect(sigue).toBe(0)
  })

  it('el pool no se queda sin conexiones despues de muchos fallos', async () => {
    for (let i = 0; i < 20; i += 1) {
      await expect(
        runWithTenant({ tenantId: tenantA.id }, () =>
          withTenantConnection(() => Promise.reject(new Error(`fallo ${String(i)}`))),
        ),
      ).rejects.toThrow(`fallo ${String(i)}`)
    }

    // Si `release()` no estuviera en el finally, esto colgaria hasta el timeout.
    const vivos = await runWithTenant({ tenantId: tenantA.id }, visibleUserIds)
    expect(vivos).toHaveLength(tenantA.userIds.length)
    expect(getPoolStats().waiting).toBe(0)
  })
})

describe('7. unsafeWithoutTenantScope', () => {
  it('deja constancia en audit_log de cada uso', async () => {
    await unsafeWithoutTenantScope(
      {
        operation: 'test.count_domain_tables',
        reason: 'Inspeccion del catalogo para comprobar que el esquema se aplico entero.',
        auditTenantId: tenantB.id,
      },
      async (conexion) => {
        const result = await conexion.query(
          "SELECT count(*)::text AS total FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'",
        )
        expect(result.rows).toHaveLength(1)
      },
    )

    const page = await runWithTenant({ tenantId: tenantB.id }, () =>
      withTenantConnection((tx) =>
        readAuditLog(tx, { actions: ['db.unsafe_without_tenant_scope'], limit: 10 }),
      ),
    )

    const entrada = page.entries.find((row) => row.resourceId === 'test.count_domain_tables')
    expect(entrada, 'no quedo rastro del uso de unsafeWithoutTenantScope').toBeDefined()
    expect(entrada?.tenantId).toBe(tenantB.id)
    expect(entrada?.metadata['reason']).toContain('Inspeccion del catalogo')
  })

  it('sin tenant al que atribuir el uso, se niega a ejecutar', async () => {
    let ejecutado = false
    await expect(
      unsafeWithoutTenantScope(
        {
          operation: 'test.sin_atribucion',
          reason: 'Deberia rechazarse porque no hay tenant bajo el que registrar el uso.',
        },
        async () => {
          ejecutado = true
          return Promise.resolve()
        },
      ),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(ejecutado).toBe(false)
  })

  it('no se puede llamar dentro de una transaccion de tenant', async () => {
    await expect(
      runWithTenant({ tenantId: tenantA.id }, () =>
        withTenantConnection(() =>
          unsafeWithoutTenantScope(
            {
              operation: 'test.dentro_de_transaccion',
              reason: 'Deberia rechazarse porque la conexion ya tiene tenant fijado.',
            },
            () => Promise.resolve(),
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('8. el handle deja de valer al salir de su bloque', () => {
  it('una consulta con el tx guardado fuera del callback se rechaza, no devuelve cero filas', async () => {
    let fugado: TenantQuery | undefined

    await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async (tx) => {
        fugado = tx
        // Control: dentro del bloque el mismo handle SI funciona, luego el
        // rechazo de abajo no es que el handle nunca sirviera.
        const dentro = await tx.query('SELECT 1 AS uno')
        expect(dentro.rows).toHaveLength(1)
      }),
    )

    expect(fugado).toBeDefined()
    // Sin la invalidacion esto se ejecutaba de verdad sobre una conexion que ya
    // habia vuelto al pool: la RLS devolvia 0 filas y el llamante leia un cero
    // silencioso en lugar de un fallo.
    await expect(fugado?.query('SELECT count(*) FROM users')).rejects.toBeInstanceOf(
      ClosedTransactionError,
    )
  })

  it('el handle de una anidada tampoco sobrevive a su SAVEPOINT', async () => {
    let fugado: TenantQuery | undefined

    await runWithTenant({ tenantId: tenantA.id }, () =>
      withTenantConnection(async (tx) => {
        await withTenantTransaction((nested) => {
          fugado = nested
          return nested.query('SELECT 1')
        })

        await expect(fugado?.query('SELECT 1')).rejects.toBeInstanceOf(ClosedTransactionError)
        // Y la transaccion exterior sigue sana: el rechazo es del handle, no de
        // la conexion.
        const sigueViva = await tx.query('SELECT 1 AS uno')
        expect(sigueViva.rows).toHaveLength(1)
      }),
    )
  })

  it('el handle administrativo tambien se invalida al salir', async () => {
    let fugado: Queryable | undefined

    await unsafeWithoutTenantScope(
      {
        operation: 'test.handle_invalidado',
        reason: 'Comprobar que el handle administrativo deja de valer al cerrar la transaccion.',
        auditTenantId: tenantA.id,
      },
      async (conexion) => {
        fugado = conexion
        await conexion.query('SELECT 1')
      },
    )

    await expect(fugado?.query('SELECT 1')).rejects.toBeInstanceOf(ClosedTransactionError)
  })
})
