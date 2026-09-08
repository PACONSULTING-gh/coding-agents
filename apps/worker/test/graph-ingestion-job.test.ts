import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { runWithTenant, type JobEnvelope } from '@coord/core'
import { closeDatabase, configureDatabase, withTenantConnection } from '@coord/db'
import { migrate } from '@coord/db/migrate'
import { repoIdForRepository } from '@coord/graph'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createGraphIngestJobHandler } from '../src/graph-ingestion.js'

/**
 * El JOB de ingesta del grafo, de extremo a extremo: Postgres real, checkout
 * git real, y las TRES capas que el handler encadena (T02 estatica, T03 build y
 * T03 co-cambio) escribiendo en el MISMO `repo_id`.
 *
 * Existe porque hasta ahora `ingestBuildGraph` e `ingestCochange` no los
 * llamaba nadie desde produccion: el handler solo invocaba `ingestRepository`,
 * asi que las dos senales que anade T03 nunca llegaban al grafo de un repo real
 * y la Definition of Done del epic ("dado un PR, el sistema puede decir que se
 * ve afectado") no podia apoyarse en ellas. Un test del enganche que no ejecuta
 * el enganche no lo habria detectado.
 *
 * Nada mockeado: la base es un contenedor de verdad y el repositorio es un
 * `git init` de verdad (CLAUDE.md 5).
 */

const run = promisify(execFile)
const logger = pino({ level: 'silent' })
const IDENTITY = [
  '-c',
  'user.email=tests@example.invalid',
  '-c',
  'user.name=Tests',
  '-c',
  'commit.gpgsign=false',
]

let container: StartedPostgreSqlContainer
let checkoutRoot: string
let repoPath: string
const repository = 'acme/widgets'

async function psql(text: string): Promise<void> {
  const result = await container.exec(
    [
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      container.getUsername(),
      '-d',
      container.getDatabase(),
      '-c',
      text,
    ],
    { env: { PGPASSWORD: container.getPassword() } },
  )
  if (result.exitCode !== 0) throw new Error(`psql fallo: ${result.stderr || result.output}`)
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()

  // Mismo montaje de roles que en produccion: `app_migrator` es el dueno y
  // `app_runtime` el que consulta. Conectarse como superusuario se saltaria la
  // RLS forzada por atributo de rol.
  await migrate({ databaseUrl: container.getConnectionUri(), direction: 'up', count: 1 })
  const migratorPassword = randomBytes(24).toString('hex')
  const runtimePassword = randomBytes(24).toString('hex')
  await psql(`ALTER ROLE app_migrator WITH PASSWORD '${migratorPassword}'`)
  await psql(`ALTER ROLE app_runtime  WITH PASSWORD '${runtimePassword}'`)
  const base = `${container.getHost()}:${String(container.getPort())}/${container.getDatabase()}`
  await migrate({
    databaseUrl: `postgres://app_migrator:${migratorPassword}@${base}`,
    direction: 'up',
  })
  configureDatabase({
    connectionString: `postgres://app_runtime:${runtimePassword}@${base}`,
    max: 8,
    allowExitOnIdle: true,
  })

  checkoutRoot = await mkdtemp(path.join(tmpdir(), 'coord-worker-checkout-'))
  repoPath = path.join(checkoutRoot, repository)
  await mkdir(repoPath, { recursive: true })
  await run('git', ['-C', repoPath, 'init', '-q', '-b', 'main'])

  // Cuatro commits que tocan SIEMPRE los dos ficheros: cruzan el umbral de
  // co-cambio (3) y ademas hay un import estatico entre ellos.
  for (let i = 0; i < 4; i += 1) {
    await mkdir(path.join(repoPath, 'src'), { recursive: true })
    await writeFile(
      path.join(repoPath, 'src/lib.ts'),
      `export function libFn(): number {\n  return ${String(i)}\n}\n`,
    )
    await writeFile(
      path.join(repoPath, 'src/app.ts'),
      `import { libFn } from './lib.js'\n\nexport function run(): number {\n  return libFn() + ${String(i)}\n}\n`,
    )
    await run('git', ['-C', repoPath, 'add', '-A'])
    await run('git', ['-C', repoPath, ...IDENTITY, 'commit', '-q', '-m', `cambio ${String(i)}`])
  }
}, 600_000)

afterAll(async () => {
  await rm(checkoutRoot, { recursive: true, force: true })
  await closeDatabase()
  await container?.stop()
})

describe('el job de ingesta del grafo encadena las tres capas sobre el mismo repo_id', () => {
  it('escribe aristas `static` y `git` para el repositorio del push', async () => {
    const tenantId = randomUUID()
    await runWithTenant({ tenantId }, () =>
      withTenantConnection(async (tx) => {
        await tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
          tenantId,
          'Tenant worker',
          `worker-${tenantId.slice(0, 8)}`,
        ])
      }),
    )

    const { stdout } = await run('git', ['-C', repoPath, 'rev-parse', 'HEAD'])
    const commitSha = stdout.trim()

    const envelope: JobEnvelope<unknown> = {
      id: randomUUID(),
      name: 'graph.ingest',
      payload: { repository, commitSha },
      tenantId,
    } as JobEnvelope<unknown>

    await runWithTenant({ tenantId }, () =>
      createGraphIngestJobHandler({ checkoutRoot, logger })(envelope),
    )

    const repoId = repoIdForRepository(tenantId, repository)
    const sources = await runWithTenant({ tenantId }, () =>
      withTenantConnection(async (tx) => {
        const result = await tx.query<{ source: string; total: string }>(
          `SELECT source, count(*) AS total FROM graph_edges
            WHERE tenant_id = $1 AND repo_id = $2 GROUP BY source ORDER BY source`,
          [tenantId, repoId],
        )
        return new Map(result.rows.map((row) => [row.source, Number(row.total)]))
      }),
    )

    // T02: los imports/contains/calls del analisis estatico.
    expect(sources.get('static')).toBeGreaterThan(0)
    // T03: el overlay de co-cambio, sobre el MISMO repo_id. Antes esta clave no
    // existia porque `ingestCochange` no lo llamaba nadie.
    expect(sources.get('git')).toBeGreaterThan(0)
    // No hay nx.json ni turbo.json en este checkout: la ingesta de build no
    // aporta aristas y eso NO es un error (criterio de T03).
    expect(sources.get('build')).toBeUndefined()
  }, 300_000)
})
