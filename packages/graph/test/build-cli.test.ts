import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { runWithTenant } from '@coord/core'
import { closeDatabase, configureDatabase } from '@coord/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ingestBuildGraph } from '../src/build/ingest.js'

import { startDatabase, type StartedDatabase } from './support/database.js'
import { createTenant } from './support/fixtures.js'
import { readEdges, readNodes } from './support/graph-state.js'

/**
 * El camino de entrada COMPLETO de la ingesta de build: detectar la herramienta
 * -> ejecutar su CLI DE VERDAD -> parsear su salida real -> escribir en
 * Postgres. Nada mockeado, ni el comando ni la base.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTE FICHERO EXISTE, Y POR QUE NO CORRE POR DEFECTO
 * ---------------------------------------------------------------------------
 * Es el unico test que habria detectado los dos fallos que tenia T03: el
 * validador de Nx esperaba una forma que Nx no produce, y la consulta GraphQL
 * de Turborepo era invalida contra su esquema real. Los tests con fixture no
 * podian verlos porque los fixtures se habian escrito a imagen del validador.
 * `runners.ts` justificaba no tener test con que "harian falta Nx o Turborepo
 * instalados de verdad": ese era precisamente el coste que habia que pagar.
 *
 * No corre por defecto porque instala Nx y Turborepo con npm, y eso necesita
 * RED. Un test que depende de la red en cada `pnpm test` convierte un corte de
 * npm en un CI rojo que nadie sabe interpretar. Se activa a proposito:
 *
 *     GRAPH_BUILD_CLI_TESTS=1 pnpm --filter @coord/graph test build-cli
 *
 * El salto NO es silencioso: cuando la variable no esta, este fichero declara
 * un unico test que dice en voz alta que la comprobacion no se ha hecho y como
 * hacerla. Los fixtures que usan los demas tests (`test/fixtures/`) son la
 * salida LITERAL de estas mismas ejecuciones, no reconstrucciones.
 */

const HABILITADO = process.env['GRAPH_BUILD_CLI_TESTS'] === '1'

const run = promisify(execFile)
const NPM_TIMEOUT_MS = 10 * 60 * 1000

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** Workspace npm minimo de dos paquetes, uno dependiendo del otro. */
async function createWorkspace(
  prefix: string,
  extra: { file: string; content: unknown },
  tool: string,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `coord-graph-${prefix}-`))
  await writeJson(path.join(dir, 'package.json'), {
    name: `${prefix}-workspace`,
    private: true,
    version: '1.0.0',
    workspaces: ['packages/*'],
    // Turborepo se niega a resolver el workspace sin `packageManager`
    // ("Missing `devEngines.packageManager` or legacy `packageManager` field").
    // Nx no lo necesita, pero tenerlo en los dos mantiene el generador unico.
    packageManager: 'npm@10.0.0',
  })
  await writeJson(path.join(dir, extra.file), extra.content)
  await writeJson(path.join(dir, 'packages/app/package.json'), {
    name: '@probe/app',
    version: '1.0.0',
    main: 'index.js',
    dependencies: { '@probe/lib': '1.0.0' },
  })
  await writeJson(path.join(dir, 'packages/lib/package.json'), {
    name: '@probe/lib',
    version: '1.0.0',
    main: 'index.js',
  })
  await writeFile(path.join(dir, 'packages/app/index.js'), "require('@probe/lib')\n")
  await writeFile(path.join(dir, 'packages/lib/index.js'), 'module.exports = {}\n')

  // `--no-audit --no-fund`: ruido innecesario. Sin `--silent` a proposito: si
  // la instalacion falla, el motivo tiene que verse.
  await run('npm', ['install', '--no-audit', '--no-fund', tool], {
    cwd: dir,
    timeout: NPM_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  })
  return dir
}

describe.skipIf(!HABILITADO)('ingesta de build contra las CLI reales de Nx y Turborepo', () => {
  let db: StartedDatabase
  const dirs: string[] = []

  beforeAll(async () => {
    db = await startDatabase()
    configureDatabase({ connectionString: db.runtimeUrl, max: 8, allowExitOnIdle: true })
  }, 600_000)

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
    await closeDatabase()
    await db?.container.stop()
  })

  it('un workspace con Nx de verdad aporta aristas `build`', async () => {
    const repoPath = await createWorkspace('nx', { file: 'nx.json', content: {} }, 'nx@latest')
    dirs.push(repoPath)

    const tenantId = await createTenant(`nx-cli-${randomUUID().slice(0, 8)}`)
    const repoId = randomUUID()
    const results = await runWithTenant({ tenantId }, () => ingestBuildGraph({ repoId, repoPath }))

    expect(results.map((r) => r.tool)).toEqual(['nx'])
    expect(results[0]?.edgesInserted).toBe(1)

    const nombres = (await readNodes(tenantId, repoId)).map((n) => n.name).sort()
    expect(nombres).toEqual(['@probe/app', '@probe/lib'])

    const edges = await readEdges(tenantId, repoId)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      source: 'build',
      from: { name: '@probe/app' },
      to: { name: '@probe/lib' },
    })
  }, 900_000)

  it('un workspace con Turborepo de verdad aporta aristas `build`, sin el paquete raiz', async () => {
    const repoPath = await createWorkspace(
      'turbo',
      { file: 'turbo.json', content: { tasks: { build: { dependsOn: ['^build'] } } } },
      'turbo@latest',
    )
    dirs.push(repoPath)

    const tenantId = await createTenant(`turbo-cli-${randomUUID().slice(0, 8)}`)
    const repoId = randomUUID()
    const results = await runWithTenant({ tenantId }, () => ingestBuildGraph({ repoId, repoPath }))

    expect(results.map((r) => r.tool)).toEqual(['turborepo'])
    expect(results[0]?.edgesInserted).toBe(1)

    // El paquete raiz que reporta Turborepo (`//`, con `path` vacio) NO entra.
    const nombres = (await readNodes(tenantId, repoId)).map((n) => n.name).sort()
    expect(nombres).toEqual(['@probe/app', '@probe/lib'])

    const edges = await readEdges(tenantId, repoId)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      source: 'build',
      from: { name: '@probe/app' },
      to: { name: '@probe/lib' },
    })
  }, 900_000)
})

describe.skipIf(HABILITADO)(
  'aviso: la comprobacion contra las CLI reales no se ha ejecutado',
  () => {
    it('dice como ejecutarla, en vez de desaparecer del informe', () => {
      // No es un `it.skip`: un test saltado se lee como "no aplica". Esto se lee
      // como lo que es -- una comprobacion pendiente, con su comando delante.
      expect(HABILITADO).toBe(false)
      console.log(
        'test/build-cli.test.ts NO se ha ejecutado (necesita red para instalar Nx y Turborepo). ' +
          'Para ejecutarlo: GRAPH_BUILD_CLI_TESTS=1 pnpm --filter @coord/graph test build-cli',
      )
    })
  },
)
