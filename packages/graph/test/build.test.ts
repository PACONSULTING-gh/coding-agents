import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runWithTenant, ValidationError } from '@coord/core'
import { closeDatabase, configureDatabase } from '@coord/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { detectBuildTools } from '../src/build/detect.js'
import { ingestParsedBuildGraph } from '../src/build/ingest.js'

import { startDatabase, type StartedDatabase } from './support/database.js'
import { createTenant } from './support/fixtures.js'
import { readEdges, readNodes } from './support/graph-state.js'

/**
 * Criterios de aceptacion de T03, parte 1 (grafo nativo de build):
 *
 *   1. Deteccion: mira los ficheros de configuracion de la raiz, no ejecuta
 *      nada. Ausencia de Nx/Turbo -> ningun error.
 *   2. Un grafo de Nx con la forma REAL de `nx graph --file` produce nodos
 *      `target` y aristas `source: 'build'`.
 *   3. Lo mismo para la respuesta REAL de `turbo query`.
 *
 * ---------------------------------------------------------------------------
 * LOS FIXTURES SON SALIDA LITERAL DE LAS HERRAMIENTAS, NO RECONSTRUCCIONES
 * ---------------------------------------------------------------------------
 * `test/fixtures/nx-graph-23.2.0.json` es el fichero que escribio
 * `nx graph --file` en un workspace real de tres paquetes, y
 * `test/fixtures/turbo-query-2.10.12.json` la respuesta literal de
 * `turbo query` en otro de dos. Se guardan tal cual, con su version en el
 * nombre.
 *
 * Antes los fixtures se escribian a mano "con la forma real"... y no la tenian:
 * el de Nx era plano (`projects`/`dependencies` en la raiz) cuando la
 * herramienta anida todo bajo `graph` con `nodes` como MAPA, y el de Turborepo
 * tenia `directDependencies` como array cuando es un envoltorio con `items`. El
 * resultado fue un test en verde sobre una funcionalidad rota: contra un repo
 * real la ingesta de build no aportaba NI UNA arista. Un fixture inventado
 * prueba que el validador acepta al fixture, nada mas.
 *
 * El camino de entrada completo (detectar -> ejecutar la CLI -> parsear ->
 * escribir) se ejercita con las herramientas instaladas de verdad en
 * `test/build-cli.test.ts`.
 *   4. JSON con forma incorrecta falla ruidoso y no escribe nada.
 *   5. Una reingesta sustituye el grafo de build anterior (no lo acumula).
 */

describe('1. deteccion de herramienta de build: solo mira ficheros, no ejecuta nada', () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function tmpRepo(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'coord-graph-build-detect-'))
    dirs.push(dir)
    return dir
  }

  it('un repo sin nx.json ni turbo.json no detecta ninguna herramienta', async () => {
    const repo = await tmpRepo()
    await expect(detectBuildTools(repo)).resolves.toEqual([])
  })

  it('nx.json en la raiz detecta Nx', async () => {
    const repo = await tmpRepo()
    await writeFile(path.join(repo, 'nx.json'), '{}')
    await expect(detectBuildTools(repo)).resolves.toEqual(['nx'])
  })

  it('turbo.json en la raiz detecta Turborepo', async () => {
    const repo = await tmpRepo()
    await writeFile(path.join(repo, 'turbo.json'), '{}')
    await expect(detectBuildTools(repo)).resolves.toEqual(['turborepo'])
  })

  it('los dos ficheros presentes detectan las dos herramientas', async () => {
    const repo = await tmpRepo()
    await writeFile(path.join(repo, 'nx.json'), '{}')
    await writeFile(path.join(repo, 'turbo.json'), '{}')
    await expect(detectBuildTools(repo)).resolves.toEqual(['nx', 'turborepo'])
  })
})

describe('2-5. ingesta del grafo de build contra Postgres de verdad', () => {
  let db: StartedDatabase

  beforeAll(async () => {
    db = await startDatabase()
    configureDatabase({ connectionString: db.runtimeUrl, max: 8, allowExitOnIdle: true })
  }, 300_000)

  afterAll(async () => {
    await closeDatabase()
    await db?.container.stop()
  })

  const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

  async function fixture(name: string): Promise<unknown> {
    return JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8')) as unknown
  }

  /** Salida LITERAL de `nx graph --file` con Nx 23.2.0 (app1 -> lib1, lib2; lib1 -> lib2). */
  const nxFixture = (): Promise<unknown> => fixture('nx-graph-23.2.0.json')

  /** Respuesta LITERAL de `turbo query` con Turborepo 2.10.12 (@repo/web -> @repo/ui). */
  const turboFixture = (): Promise<unknown> => fixture('turbo-query-2.10.12.json')

  it('un grafo de Nx produce nodos `target` y aristas con source `build`', async () => {
    const tenantId = await createTenant('nx-fixture')
    const repoId = randomUUID()

    const rawJson = await nxFixture()
    const result = await runWithTenant({ tenantId }, () =>
      ingestParsedBuildGraph({ repoId, tool: 'nx', rawJson }),
    )
    expect(result.tool).toBe('nx')
    expect(result.projectsUpserted).toBe(3)
    expect(result.edgesInserted).toBe(3)
    expect(result.unresolvedDependencies).toBe(0)

    const nodes = await readNodes(tenantId, repoId)
    const byName = new Map(nodes.map((n) => [n.name, n]))
    expect(byName.get('app1')).toMatchObject({ kind: 'target', path: 'packages/app1' })
    expect(byName.get('lib1')).toMatchObject({ kind: 'target', path: 'packages/lib1' })
    expect(byName.get('lib2')).toMatchObject({ kind: 'target', path: 'packages/lib2' })

    const edges = await readEdges(tenantId, repoId)
    expect(edges).toHaveLength(3)
    for (const edge of edges) {
      expect(edge.kind).toBe('imports')
      expect(edge.source).toBe('build')
    }
    const pairs = edges.map((e) => `${e.from.name}->${e.to.name}`).sort()
    expect(pairs).toEqual(['app1->lib1', 'app1->lib2', 'lib1->lib2'])
  })

  it('la respuesta de `turbo query` produce nodos `target` y aristas con source `build`', async () => {
    const tenantId = await createTenant('turbo-fixture')
    const repoId = randomUUID()

    const rawJson = await turboFixture()
    const result = await runWithTenant({ tenantId }, () =>
      ingestParsedBuildGraph({ repoId, tool: 'turborepo', rawJson }),
    )
    expect(result.tool).toBe('turborepo')
    // 2, no 3: el paquete raiz del workspace (`name: "//"`, `path: ""`) que
    // Turborepo reporta como un paquete mas NO es un proyecto — no tiene
    // directorio propio y la clave natural de `graph_nodes` exige ruta no
    // vacia. Si no se filtrara, esa fila invalidaria la respuesta entera.
    expect(result.projectsUpserted).toBe(2)
    // 1, no 3: las dependencias hacia `//` tampoco entran.
    expect(result.edgesInserted).toBe(1)
    expect(result.unresolvedDependencies).toBe(0)

    const nombres = (await readNodes(tenantId, repoId)).map((n) => n.name)
    expect(nombres).not.toContain('//')

    const edges = await readEdges(tenantId, repoId)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      kind: 'imports',
      source: 'build',
      from: { name: '@repo/web', path: 'packages/web' },
      to: { name: '@repo/ui', path: 'packages/ui' },
    })
  })

  it('un workspace de Nx SIN proyectos da un resultado vacio, no un error', async () => {
    // El principio declarado en `detect.ts` es que la ausencia de grafo de build
    // "no es un error, simplemente no aporta aristas". Un `.min(1)` en el
    // esquema convertia un repo recien creado en un ValidationError.
    const tenantId = await createTenant('nx-vacio')
    const repoId = randomUUID()

    const result = await runWithTenant({ tenantId }, () =>
      ingestParsedBuildGraph({
        repoId,
        tool: 'nx',
        rawJson: { graph: { nodes: {}, dependencies: {} } },
      }),
    )
    expect(result.projectsUpserted).toBe(0)
    expect(result.edgesInserted).toBe(0)
    expect(await readNodes(tenantId, repoId)).toEqual([])
  })

  it('un JSON de Nx con forma incorrecta falla ruidoso y no escribe nada', async () => {
    const tenantId = await createTenant('nx-malformado')
    const repoId = randomUUID()

    await expect(
      runWithTenant({ tenantId }, () =>
        ingestParsedBuildGraph({ repoId, tool: 'nx', rawJson: { esto: 'no es un grafo de nx' } }),
      ),
    ).rejects.toThrow(ValidationError)

    expect(await readNodes(tenantId, repoId)).toEqual([])
    expect(await readEdges(tenantId, repoId)).toEqual([])
  })

  it('una respuesta de `turbo query` con errores GraphQL falla ruidoso con el motivo', async () => {
    const tenantId = await createTenant('turbo-errores')
    const repoId = randomUUID()

    await expect(
      runWithTenant({ tenantId }, () =>
        ingestParsedBuildGraph({
          repoId,
          tool: 'turborepo',
          rawJson: { errors: [{ message: 'unknown field "packages"' }] },
        }),
      ),
    ).rejects.toThrow(/unknown field "packages"/)

    expect(await readEdges(tenantId, repoId)).toEqual([])
  })

  it('una reingesta sustituye el grafo de build anterior, no lo acumula', async () => {
    const tenantId = await createTenant('nx-reingesta')
    const repoId = randomUUID()

    const completo = (await nxFixture()) as { graph: { nodes: unknown; dependencies: unknown } }
    await runWithTenant({ tenantId }, () =>
      ingestParsedBuildGraph({ repoId, tool: 'nx', rawJson: completo }),
    )
    expect(await readEdges(tenantId, repoId)).toHaveLength(3)

    // Segunda pasada: app1 ya no depende de nada.
    const shrunk = {
      graph: { nodes: completo.graph.nodes, dependencies: { app1: [], lib1: [], lib2: [] } },
    }
    const result = await runWithTenant({ tenantId }, () =>
      ingestParsedBuildGraph({ repoId, tool: 'nx', rawJson: shrunk }),
    )
    expect(result.edgesInserted).toBe(0)
    expect(await readEdges(tenantId, repoId)).toEqual([])
    // Los nodos `target` siguen ahi: solo se sustituyeron las aristas.
    expect(await readNodes(tenantId, repoId)).toHaveLength(3)
  })
})
