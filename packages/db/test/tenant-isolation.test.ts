import { randomUUID } from 'node:crypto'

import { runWithTenant } from '@coord/core'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { appendAuditEntry, readAuditLog } from '../src/audit.js'
import { DOMAIN_TABLES } from '../src/schema.js'

import { startDatabase, type StartedDatabase } from './support/database.js'

/**
 * Tests de aislamiento entre tenants contra un PostgreSQL DE VERDAD levantado
 * con testcontainers. Nada aqui esta mockeado a proposito: lo que se esta
 * comprobando es el comportamiento del motor (RLS forzada, grants, triggers),
 * asi que un doble de prueba comprobaria unicamente que el doble hace lo que le
 * hemos dicho (CLAUDE.md 5).
 *
 * El montaje reproduce el despliegue real, incluida la separacion de roles:
 *   1. Un rol con privilegios (el superusuario del contenedor) aplica SOLO la
 *      migracion 0001, que crea `app_migrator` y `app_runtime`.
 *   2. Se les asigna contrasena fuera de banda (aqui: aleatoria por ejecucion;
 *      en produccion: desde variables de entorno).
 *   3. El resto de migraciones las aplica `app_migrator`, que por tanto es el
 *      DUENO de las tablas. Esto es lo que da valor al FORCE ROW LEVEL
 *      SECURITY: sin FORCE, el dueno se saltaria las politicas y media suite
 *      pasaria por casualidad.
 *   4. Las consultas de los tests van como `app_runtime`.
 */

/** Tablas cuyo discriminante es `tenant_id` (todas menos la raiz `tenants`). */
const TENANT_SCOPED_TABLES = DOMAIN_TABLES.filter((table) => table !== 'tenants')

/** Contador de ids de instalacion de GitHub para los fixtures (unicos globalmente). */
let nextInstallationId = 900_000_000

interface TenantFixture {
  id: string
  slug: string
  userIds: [string, string]
  teamId: string
  skillId: string
  /** Id de instalacion de GitHub del fixture. Unico globalmente, como en GitHub. */
  installationId: number
}

let db: StartedDatabase
let runtime: Client
let migrator: Client
let superuser: Client
let tenantA: TenantFixture
let tenantB: TenantFixture

/**
 * Ejecuta `fn` dentro de una transaccion con `app.tenant_id` fijado. `set_config`
 * con `is_local = true` limita el ajuste a la transaccion: al terminar, la
 * conexion vuelve a no tener contexto, que es lo que exige un pool compartido.
 */
async function withTenantSession<T>(
  client: Client,
  tenantId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN')
  try {
    if (tenantId !== null) {
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId])
    }
    const result = await fn()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function seedTenant(client: Client, slug: string): Promise<TenantFixture> {
  const id = randomUUID()
  const userIds: [string, string] = [randomUUID(), randomUUID()]
  const teamId = randomUUID()
  const skillId = randomUUID()
  // Los ids de instalacion de GitHub son enteros y unicos en todo el sistema:
  // se reparte uno por fixture, no aleatorio, para que el test sea reproducible.
  nextInstallationId += 1
  const installationId = nextInstallationId
  const repoId = randomUUID()

  await withTenantSession(client, id, async () => {
    await client.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
      id,
      `Tenant ${slug}`,
      slug,
    ])

    for (const [index, userId] of userIds.entries()) {
      await client.query(
        'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
        [userId, id, `user${String(index)}@${slug}.example`, `Usuario ${String(index)} de ${slug}`],
      )
    }

    await client.query('INSERT INTO teams (id, tenant_id, name, slug) VALUES ($1, $2, $3, $4)', [
      teamId,
      id,
      `Equipo ${slug}`,
      `equipo-${slug}`,
    ])

    for (const userId of userIds) {
      await client.query(
        'INSERT INTO team_members (tenant_id, team_id, user_id) VALUES ($1, $2, $3)',
        [id, teamId, userId],
      )
    }

    await client.query('INSERT INTO skills (id, tenant_id, name) VALUES ($1, $2, $3)', [
      skillId,
      id,
      `TypeScript ${slug}`,
    ])
    await client.query(
      'INSERT INTO user_skills (tenant_id, user_id, skill_id, level) VALUES ($1, $2, $3, $4)',
      [id, userIds[0], skillId, 4],
    )

    // Los roles y permisos base los ha sembrado ya el trigger de la migracion
    // 0005 al insertar el tenant; aqui solo se asigna uno.
    await client.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_id)
       SELECT $1, $2, r.id FROM roles r WHERE r.tenant_id = $1 AND r.key = 'owner'`,
      [id, userIds[0]],
    )

    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, resource_type, resource_id)
       VALUES ($1, $2, 'user', 'tenant.created', 'tenant', $3)`,
      [id, userIds[0], id],
    )

    // Integracion con GitHub (migracion 0006). El `installation_id` es unico
    // GLOBALMENTE, no por tenant, asi que cada fixture usa el suyo.
    await client.query(
      `INSERT INTO github_installations
         (tenant_id, installation_id, account_login, account_type, repository_selection)
       VALUES ($1, $2, $3, 'Organization', 'all')`,
      [id, installationId, `org-${slug}`],
    )
    await client.query(
      'INSERT INTO webhook_deliveries (tenant_id, delivery_id, event) VALUES ($1, $2, $3)',
      [id, randomUUID(), 'issues'],
    )

    // Grafo de dependencias (migracion 0007). Los dos fixtures usan A PROPOSITO
    // las MISMAS rutas: si el aislamiento del grafo dependiera de que las claves
    // naturales no chocan, el test pasaria por casualidad. Lo que tiene que
    // aislar es la RLS.
    const [fromNodeId, toNodeId] = [randomUUID(), randomUUID()]
    for (const [nodeId, path] of [
      [fromNodeId, 'src/app.ts'],
      [toNodeId, 'src/lib.ts'],
    ] as const) {
      await client.query(
        `INSERT INTO graph_nodes (id, tenant_id, repo_id, kind, path, language)
         VALUES ($1, $2, $3, 'file', $4, 'typescript')`,
        [nodeId, id, repoId, path],
      )
    }
    await client.query(
      `INSERT INTO graph_edges (tenant_id, repo_id, from_node_id, to_node_id, kind, source)
       VALUES ($1, $2, $3, $4, 'imports', 'static')`,
      [id, repoId, fromNodeId, toNodeId],
    )
    await client.query(
      `INSERT INTO graph_files (tenant_id, repo_id, path, content_hash, language)
       VALUES ($1, $2, 'src/app.ts', repeat('a', 40), 'typescript')`,
      [id, repoId],
    )
    await client.query(
      `INSERT INTO graph_ingestions (tenant_id, repo_id, commit_sha, status)
       VALUES ($1, $2, repeat('b', 40), 'completed')`,
      [id, repoId],
    )

    // Claims (migracion 0008). Los dos fixtures reclaman A PROPOSITO el MISMO
    // issue del MISMO repo: el indice unico de claims vivos es por tenant, asi
    // que si el aislamiento dependiera de que las claves no chocan, esto
    // reventaria en vez de pasar por casualidad.
    const claimGroupId = randomUUID()
    await client.query(
      `INSERT INTO claims
         (id, tenant_id, claim_group_id, repo_id, subject_kind, subject_key,
          holder_kind, holder_id, holder_label, expires_at)
       VALUES ($1, $2, $1, $3, 'issue', '15', 'user', $4, $5, now() + interval '1 hour')`,
      [claimGroupId, id, repoId, userIds[0], `Dev ${slug}`],
    )

    // Criterios de aceptacion y su aprobacion (migracion 0010). Igual que con
    // los claims, los dos fixtures usan A PROPOSITO el MISMO `task_ref`: la
    // unicidad de (tenant_id, task_ref, ordinal) es por tenant, asi que si el
    // aislamiento dependiera de que las claves no chocan, esto reventaria en
    // vez de pasar por casualidad.
    await client.query(
      `INSERT INTO acceptance_criteria
         (tenant_id, task_ref, ordinal, given_text, when_text, then_text, created_by)
       VALUES ($1, '15', 1, $2, 'un agente intenta reclamar el issue 15',
               'el claim se concede y aparece en la vista de claims activos', $3)`,
      [id, `el issue #15 de ${slug}`, `agente-${slug}`],
    )
    await client.query(
      `INSERT INTO acceptance_criteria_approvals
         (tenant_id, task_ref, content_hash, approved_by)
       VALUES ($1, '15', $2, $3)`,
      // El hash de verdad lo calcula computeCriteriaContentHash; aqui basta un
      // valor con la forma correcta, porque lo que se prueba en este fichero es
      // el aislamiento, no la caducidad (eso esta en acceptance-criteria.test.ts).
      [id, 'f'.repeat(64), userIds[0]],
    )

    // Estado del flujo de verificacion (migracion 0011). Mismo `task_ref` en
    // los dos fixtures, por el mismo motivo: la unicidad es por tenant, y si el
    // aislamiento dependiera de que las claves no chocan, esto reventaria en
    // vez de pasar por casualidad. Este estado dice que tareas de un cliente
    // estan atascadas y en manos de quien: no cruza la frontera.
    await client.query(
      `INSERT INTO verification_flow
         (tenant_id, task_ref, attempts, state, last_outcome, responsible)
       VALUES ($1, '15', 1, 'same_agent', 'verifier_fail', $2)`,
      [id, JSON.stringify({ kind: 'agent', id: `agente-${slug}`, label: `Agente ${slug}` })],
    )

    // Sugerencias del router (migracion 0012). Mismo `task_ref` en los dos
    // fixtures, por el mismo motivo que las demas: la unicidad es por tenant.
    // Esto dice a quien se le sugiere el trabajo de un cliente y quien lo acaba
    // cogiendo, asi que no cruza la frontera.
    await client.query(
      `INSERT INTO routing_suggestions
         (tenant_id, task_ref, suggested_first, entries, model)
       VALUES ($1, '15', $2, $3, 'claude-opus-5')`,
      [
        id,
        `dev-${slug}`,
        JSON.stringify([{ rank: 1, candidateId: `dev-${slug}`, leadingSignal: 'ownership' }]),
      ],
    )

    // Agentes y su cola de comandos (migracion 0013). Mismo `agent_key` en los
    // dos fixtures, como en el resto: la unicidad es por tenant. Esto dice
    // quien tiene un agente corriendo, en que tarea y como va — y si cruzara,
    // un cliente veria el trabajo en curso de otro.
    const agentResult = await client.query<{ id: string }>(
      `INSERT INTO agents (tenant_id, agent_key, label, token_hash)
       VALUES ($1, 'dev-1', $2, $3)
       RETURNING id`,
      [id, `Dev de ${slug}`, `hash-${slug}-${'0'.repeat(40)}`],
    )
    const agentId = agentResult.rows[0]?.id
    await client.query(
      `INSERT INTO agent_commands (tenant_id, agent_id, kind, payload)
       VALUES ($1, $2, 'nudge', $3::jsonb)`,
      [id, agentId, JSON.stringify({ texto: `para ${slug}` })],
    )
  })

  return { id, slug, userIds, teamId, skillId, installationId }
}

beforeAll(async () => {
  // El montaje —contenedor o servidor compartido, bootstrap en tres pasos y
  // separacion real de roles— vive en `support/database.ts` y lo comparten
  // todos los tests de integracion (ADR 0007). Antes estaba duplicado aqui, con
  // su propio contenedor y su propia generacion de contrasenas.
  db = await startDatabase()

  superuser = new Client({ connectionString: db.superUrl })
  await superuser.connect()

  migrator = new Client({ connectionString: db.migratorUrl })
  await migrator.connect()

  runtime = new Client({ connectionString: db.runtimeUrl })
  await runtime.connect()

  tenantA = await seedTenant(runtime, 'alfa')
  tenantB = await seedTenant(runtime, 'beta')
})

afterAll(async () => {
  await runtime?.end()
  await migrator?.end()
  await superuser?.end()
  await db?.stop()
})

describe('1. con el tenant A fijado solo se ven filas de A', () => {
  it('cada tabla con tenant_id devuelve exclusivamente filas del tenant activo', async () => {
    await withTenantSession(runtime, tenantA.id, async () => {
      for (const table of TENANT_SCOPED_TABLES) {
        const all = await runtime.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table}`)
        expect(all.rows.length, `${table} deberia tener filas del tenant A`).toBeGreaterThan(0)
        expect(
          all.rows.every((row) => row.tenant_id === tenantA.id),
          `${table} devolvio filas de otro tenant`,
        ).toBe(true)
      }
    })
  })

  it('tenants solo se ve a si mismo', async () => {
    await withTenantSession(runtime, tenantA.id, async () => {
      const result = await runtime.query<{ id: string }>('SELECT id FROM tenants')
      expect(result.rows.map((row) => row.id)).toEqual([tenantA.id])
    })
  })
})

describe('2. una consulta mal escrita sigue sin ver otros tenants', () => {
  it('un SELECT sin WHERE tenant_id no filtra nada del tenant B', async () => {
    const idsDeB = await withTenantSession(runtime, tenantB.id, async () => {
      const result = await runtime.query<{ id: string }>('SELECT id FROM users')
      return result.rows.map((row) => row.id)
    })
    expect(idsDeB.sort()).toEqual([...tenantB.userIds].sort())

    // Consulta deliberadamente mal escrita: sin filtro de tenant y sin LIMIT.
    // La defensa es la RLS, no la disciplina de quien escribio el SQL.
    await withTenantSession(runtime, tenantA.id, async () => {
      const leak = await runtime.query<{ id: string }>('SELECT id FROM users')
      const visibles = leak.rows.map((row) => row.id)
      expect(visibles.sort()).toEqual([...tenantA.userIds].sort())
      for (const idDeB of idsDeB) {
        expect(visibles).not.toContain(idDeB)
      }
    })
  })

  it('un JOIN sin condicion de tenant tampoco cruza datos', async () => {
    await withTenantSession(runtime, tenantA.id, async () => {
      const result = await runtime.query<{ tenant_id: string }>(
        'SELECT tm.tenant_id FROM team_members tm JOIN users u ON u.id = tm.user_id',
      )
      expect(result.rows.length).toBe(tenantA.userIds.length)
      expect(result.rows.every((row) => row.tenant_id === tenantA.id)).toBe(true)
    })
  })
})

describe('3. sin contexto de tenant no se ve nada (falla cerrado)', () => {
  it('todas las tablas devuelven cero filas', async () => {
    for (const table of DOMAIN_TABLES) {
      const result = await runtime.query<{ total: string }>(
        `SELECT count(*) AS total FROM ${table}`,
      )
      expect(result.rows[0]?.total, `${table} devolvio filas sin contexto de tenant`).toBe('0')
    }
  })

  it('tambien dentro de una transaccion sin set_config', async () => {
    await withTenantSession(runtime, null, async () => {
      const result = await runtime.query('SELECT id FROM users')
      expect(result.rows).toEqual([])
    })
  })

  it('un contexto de tenant inexistente no ve nada de los que si existen', async () => {
    await withTenantSession(runtime, randomUUID(), async () => {
      const result = await runtime.query('SELECT id FROM users')
      expect(result.rows).toEqual([])
    })
  })
})

describe('4. WITH CHECK impide escribir en otro tenant', () => {
  it('rechaza un INSERT con el tenant_id de B mientras el contexto es A', async () => {
    await expect(
      withTenantSession(runtime, tenantA.id, async () => {
        await runtime.query(
          'INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3)',
          [tenantB.id, 'intruso@beta.example', 'Intruso'],
        )
      }),
    ).rejects.toMatchObject({ code: '42501' })

    // Y no ha quedado rastro: el rollback y la politica dejan a B intacto.
    await withTenantSession(runtime, tenantB.id, async () => {
      const result = await runtime.query('SELECT id FROM users WHERE email = $1', [
        'intruso@beta.example',
      ])
      expect(result.rows).toEqual([])
    })
  })

  it('rechaza un UPDATE que intente mover una fila al tenant B', async () => {
    await expect(
      withTenantSession(runtime, tenantA.id, async () => {
        await runtime.query('UPDATE users SET tenant_id = $1 WHERE id = $2', [
          tenantB.id,
          tenantA.userIds[0],
        ])
      }),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('un UPDATE dirigido a una fila de B no afecta a ninguna fila', async () => {
    await withTenantSession(runtime, tenantA.id, async () => {
      const result = await runtime.query('UPDATE users SET display_name = $1 WHERE id = $2', [
        'secuestrado',
        tenantB.userIds[0],
      ])
      expect(result.rowCount).toBe(0)
    })
  })

  it('la clave ajena compuesta impide mezclar un equipo de A con un usuario de B', async () => {
    await expect(
      withTenantSession(runtime, tenantA.id, async () => {
        await runtime.query(
          'INSERT INTO team_members (tenant_id, team_id, user_id) VALUES ($1, $2, $3)',
          [tenantA.id, tenantA.teamId, tenantB.userIds[0]],
        )
      }),
    ).rejects.toMatchObject({ code: '23503' })
  })
})

describe('5. audit_log es append-only', () => {
  it('app_runtime no puede hacer UPDATE ni DELETE (privilegios)', async () => {
    for (const sql of ["UPDATE audit_log SET action = 'manipulado'", 'DELETE FROM audit_log']) {
      await expect(
        withTenantSession(runtime, tenantA.id, async () => {
          await runtime.query(sql)
        }),
      ).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('ni siquiera el dueno de la tabla puede hacerlo (trigger)', async () => {
    for (const sql of [
      "UPDATE audit_log SET action = 'manipulado'",
      'DELETE FROM audit_log',
      'TRUNCATE audit_log',
    ]) {
      await expect(
        withTenantSession(migrator, tenantA.id, async () => {
          await migrator.query(sql)
        }),
        `${sql} deberia estar prohibido tambien para app_migrator`,
      ).rejects.toThrow(/append-only/)
    }
  })

  it('el INSERT si esta permitido, y las filas anteriores siguen ahi', async () => {
    const antes = await withTenantSession(runtime, tenantA.id, async () => {
      const result = await runtime.query<{ total: string }>(
        'SELECT count(*) AS total FROM audit_log',
      )
      return Number(result.rows[0]?.total ?? '0')
    })

    await withTenantSession(runtime, tenantA.id, async () => {
      await runtime.query(
        `INSERT INTO audit_log (tenant_id, actor_type, action, resource_type)
         VALUES ($1, 'system', 'test.append', 'test')`,
        [tenantA.id],
      )
    })

    const despues = await withTenantSession(runtime, tenantA.id, async () => {
      const result = await runtime.query<{ total: string }>(
        'SELECT count(*) AS total FROM audit_log',
      )
      return Number(result.rows[0]?.total ?? '0')
    })

    expect(despues).toBe(antes + 1)
  })
})

describe('6. el catalogo confirma que ninguna tabla se ha quedado sin RLS forzada', () => {
  it('todas las tablas de public tienen RLS habilitada, forzada y con politica', async () => {
    const result = await superuser.query<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
      policies: string
    }>(
      `SELECT c.relname,
              c.relrowsecurity,
              c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    )

    // Si manana alguien anade una tabla al esquema, este test la ve: la lista
    // esperada es exacta, no un "al menos estas".
    // Se ordena en JS y no con ORDER BY: la collation del servidor coloca los
    // guiones bajos de otra forma y el test no debe depender de eso.
    expect(result.rows.map((row) => row.relname).sort()).toEqual([...DOMAIN_TABLES].sort())

    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname} sin ENABLE ROW LEVEL SECURITY`).toBe(true)
      expect(row.relforcerowsecurity, `${row.relname} sin FORCE ROW LEVEL SECURITY`).toBe(true)
      expect(Number(row.policies), `${row.relname} sin ninguna politica`).toBeGreaterThan(0)
    }
  })

  it('toda politica que permita escribir declara WITH CHECK', async () => {
    // "Tiene al menos una politica" es media RLS. `USING` filtra lo que se LEE
    // (y lo que un UPDATE/DELETE alcanza); `WITH CHECK` es lo que impide
    // ESCRIBIR una fila con el tenant_id de otro cliente. Una politica de
    // escritura sin WITH CHECK deja pasar ese INSERT y el resto de la suite
    // seguiria en verde, porque leer sigue estando bien filtrado.
    //
    // polcmd: '*' = ALL, 'a' = INSERT, 'w' = UPDATE. Son las tres que escriben.
    const result = await superuser.query<{
      relname: string
      polname: string
      polcmd: string
      tiene_with_check: boolean
    }>(
      `SELECT c.relname,
              p.polname,
              p.polcmd::text AS polcmd,
              (p.polwithcheck IS NOT NULL) AS tiene_with_check
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND p.polcmd IN ('*', 'a', 'w')`,
    )

    // Control: si esta consulta no devolviera nada, el bucle de abajo pasaria
    // sin comprobar nada.
    expect(result.rows.length, 'no hay ni una politica de escritura que revisar').toBe(
      DOMAIN_TABLES.length,
    )
    for (const row of result.rows) {
      expect(
        row.tiene_with_check,
        `la politica ${row.polname} de ${row.relname} permite escribir (polcmd=${row.polcmd}) sin WITH CHECK`,
      ).toBe(true)
    }
  })

  it('todo indice lleva tenant_id como primera columna, salvo las excepciones declaradas', async () => {
    /**
     * Excepciones deliberadas, documentadas tambien en la cabecera de la
     * migracion 0002. Esta lista es el contrato: ampliarla es un cambio visible
     * en el diff, que es justo lo que se quiere.
     *
     *   - Las claves primarias son `(id)`: el uuid ya es globalmente unico y las
     *     FK compuestas se apoyan en `UNIQUE (tenant_id, id)`, no en la PK.
     *   - Las tres claves naturales globales identifican cosas que asigna el
     *     mundo exterior y que deben ser unicas en TODO el despliegue.
     */
    const EXCEPCIONES = new Set<string>([
      ...DOMAIN_TABLES.map((table) => `${table}_pkey`),
      'tenants_slug_key',
      'github_installations_installation_id_key',
      'webhook_deliveries_delivery_id_key',
    ])

    const result = await superuser.query<{ tabla: string; indice: string; primera: string }>(
      `SELECT ct.relname AS tabla,
              ci.relname AS indice,
              a.attname  AS primera
         FROM pg_index i
         JOIN pg_class ci ON ci.oid = i.indexrelid
         JOIN pg_class ct ON ct.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = ct.relnamespace
         JOIN pg_attribute a ON a.attrelid = ct.oid AND a.attnum = i.indkey[0]
        WHERE n.nspname = 'public' AND ct.relkind = 'r'`,
    )

    expect(result.rows.length, 'no hay ni un indice que revisar').toBeGreaterThan(20)

    const infractores = result.rows
      .filter((row) => !EXCEPCIONES.has(row.indice))
      // `tenants` es la raiz: su discriminante es su propio `id`.
      .filter((row) => !(row.tabla === 'tenants' && row.primera === 'id'))
      .filter((row) => row.primera !== 'tenant_id')
      .map((row) => `${row.tabla}.${row.indice} empieza por ${row.primera}`)

    expect(infractores).toEqual([])
  })

  it('toda tabla salvo tenants tiene tenant_id uuid NOT NULL', async () => {
    const result = await superuser.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'tenant_id'
          AND data_type = 'uuid'
          AND is_nullable = 'NO'`,
    )
    expect(result.rows.map((row) => row.table_name).sort()).toEqual(
      [...TENANT_SCOPED_TABLES].sort(),
    )
  })

  it('ni app_runtime ni app_migrator pueden saltarse la RLS', async () => {
    const result = await superuser.query<{
      rolname: string
      rolsuper: boolean
      rolbypassrls: boolean
    }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
        WHERE rolname IN ('app_runtime', 'app_migrator') ORDER BY rolname`,
    )
    expect(result.rows.map((row) => row.rolname)).toEqual(['app_migrator', 'app_runtime'])
    for (const row of result.rows) {
      expect(row.rolsuper, `${row.rolname} es superusuario`).toBe(false)
      expect(row.rolbypassrls, `${row.rolname} tiene BYPASSRLS`).toBe(false)
    }
  })
})

describe('6b. el carve-out de enrutado de instalaciones no se puede ensanchar', () => {
  /**
   * `installation_routing_lookup` (migracion 0006) es la UNICA grieta por la
   * que se lee una fila de dominio sin declarar tenant: el listener de webhooks
   * necesita traducir installation_id -> tenant_id ANTES de saber de quien es
   * el evento. Estos dos tests fijan su radio exacto como contrato, para que si
   * alguien la relaja el test lo diga en vez de que pase inadvertido.
   */
  async function withInstallationLookup<T>(
    tenantId: string | null,
    installationId: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    await runtime.query('BEGIN')
    try {
      if (tenantId !== null) {
        await runtime.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId])
      }
      await runtime.query('SELECT set_config($1, $2, true)', [
        'app.github_installation_lookup',
        String(installationId),
      ])
      const result = await fn()
      await runtime.query('COMMIT')
      return result
    } catch (error) {
      await runtime.query('ROLLBACK')
      throw error
    }
  }

  it('sin contexto de tenant devuelve EXACTAMENTE la instalacion nombrada, ni una fila mas', async () => {
    const filas = await withInstallationLookup(null, tenantB.installationId, async () => {
      const result = await runtime.query<{ installation_id: string; tenant_id: string }>(
        'SELECT installation_id::text, tenant_id::text FROM github_installations',
      )
      return result.rows
    })

    // Una fila. No "las de B", no "todas": la nombrada.
    expect(filas).toHaveLength(1)
    expect(filas[0]?.installation_id).toBe(String(tenantB.installationId))
    expect(filas[0]?.tenant_id).toBe(tenantB.id)
  })

  it('con un tenant fijado, el lookup no sirve para ver la instalacion de otro', async () => {
    // Contexto de A + lookup apuntando a la instalacion de B. La politica exige
    // `app_current_tenant_id() IS NULL`, asi que no debe aportar nada, y la
    // politica de aislamiento normal deja ver solo lo de A.
    const filas = await withInstallationLookup(tenantA.id, tenantB.installationId, async () => {
      const result = await runtime.query<{ installation_id: string; tenant_id: string }>(
        'SELECT installation_id::text, tenant_id::text FROM github_installations',
      )
      return result.rows
    })

    expect(filas.map((row) => row.tenant_id)).not.toContain(tenantB.id)
    expect(filas.every((row) => row.tenant_id === tenantA.id)).toBe(true)
  })

  it('el carve-out es de solo lectura: no deja escribir sobre la instalacion ajena', async () => {
    const afectadas = await withInstallationLookup(null, tenantB.installationId, async () => {
      const result = await runtime.query(
        'UPDATE github_installations SET account_login = $1 WHERE installation_id = $2',
        ['secuestrada', tenantB.installationId],
      )
      return result.rowCount
    })
    expect(afectadas).toBe(0)
  })
})

describe('7. el modelo de permisos no usa booleanos', () => {
  it('no existe ninguna columna que empiece por is_admin', async () => {
    const result = await superuser.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE 'is\\_admin%'`,
    )
    expect(result.rows).toEqual([])
  })

  it('los permisos son filas recurso:accion agrupadas en los cuatro roles base', async () => {
    await withTenantSession(runtime, tenantA.id, async () => {
      const roles = await runtime.query<{ key: string }>('SELECT key FROM roles ORDER BY key')
      expect(roles.rows.map((row) => row.key)).toEqual([
        'contributor',
        'maintainer',
        'owner',
        'viewer',
      ])

      const permisos = await runtime.query<{ key: string }>('SELECT key FROM permissions')
      expect(permisos.rows.length).toBeGreaterThan(0)
      for (const row of permisos.rows) {
        expect(row.key).toMatch(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/)
      }

      // viewer solo lee, y ni siquiera la auditoria; owner lo puede todo.
      const porRol = await runtime.query<{ key: string; permisos: string }>(
        `SELECT r.key, count(rp.permission_id) AS permisos
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          GROUP BY r.key`,
      )
      const conteo = new Map(porRol.rows.map((row) => [row.key, Number(row.permisos)]))
      expect(conteo.get('owner')).toBe(permisos.rows.length)
      expect(conteo.get('viewer')).toBeLessThan(conteo.get('contributor') ?? 0)
      expect(conteo.get('contributor')).toBeLessThan(conteo.get('maintainer') ?? 0)

      const viewer = await runtime.query<{ key: string }>(
        `SELECT p.key FROM roles r
           JOIN role_permissions rp ON rp.role_id = r.id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE r.key = 'viewer'`,
      )
      expect(viewer.rows.every((row) => row.key.endsWith(':read'))).toBe(true)
      expect(viewer.rows.map((row) => row.key)).not.toContain('audit:read')
    })
  })
})

describe('API de lectura del audit_log', () => {
  it('appendAuditEntry y readAuditLog trabajan dentro del tenant activo', async () => {
    const [actorId] = tenantA.userIds
    const requestId = randomUUID()

    await withTenantSession(runtime, tenantA.id, async () => {
      await runWithTenant({ tenantId: tenantA.id, actorId, requestId }, async () => {
        for (let i = 0; i < 3; i += 1) {
          const entry = await appendAuditEntry(runtime, {
            action: 'issue.assigned',
            resourceType: 'issue',
            resourceId: `#${String(i)}`,
            metadata: { intento: i },
          })
          expect(entry.tenantId).toBe(tenantA.id)
          expect(entry.actorId).toBe(actorId)
          expect(entry.requestId).toBe(requestId)
          expect(entry.actorType).toBe('user')
        }

        const primera = await readAuditLog(runtime, { actions: ['issue.assigned'], limit: 2 })
        expect(primera.entries).toHaveLength(2)
        expect(primera.nextCursor).toBeDefined()
        expect(primera.entries.every((row) => row.tenantId === tenantA.id)).toBe(true)

        // Recorrido completo de pagina en pagina. Los tres eventos se han
        // insertado en la misma transaccion, asi que comparten `occurred_at`
        // hasta el microsegundo: si el cursor no conservara el instante exacto
        // o no desempatara por id, este bucle devolveria de menos o no
        // terminaria nunca.
        const vistos: string[] = []
        let cursor: string | undefined
        for (let pagina = 0; pagina < 10; pagina += 1) {
          const page = await readAuditLog(runtime, {
            actions: ['issue.assigned'],
            limit: 1,
            ...(cursor !== undefined ? { cursor } : {}),
          })
          vistos.push(...page.entries.map((row) => row.id))
          cursor = page.nextCursor
          if (cursor === undefined) break
        }
        expect(cursor).toBeUndefined()
        expect(vistos).toHaveLength(3)
        expect(new Set(vistos).size).toBe(3)
      })
    })
  })

  it('readAuditLog exige contexto de tenant', async () => {
    await expect(readAuditLog(runtime)).rejects.toThrow(/contexto de tenant/i)
  })

  it('no devuelve eventos de otro tenant aunque se pida su resource_id', async () => {
    await withTenantSession(runtime, tenantA.id, async () => {
      await runWithTenant({ tenantId: tenantA.id }, async () => {
        const page = await readAuditLog(runtime, { resourceId: tenantB.id })
        expect(page.entries).toEqual([])
      })
    })
  })
})
