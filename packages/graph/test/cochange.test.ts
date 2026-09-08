import { randomUUID } from 'node:crypto'

import { runWithTenant } from '@coord/core'
import { closeDatabase, configureDatabase } from '@coord/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ingestCochange } from '../src/cochange/index.js'

import { startDatabase, type StartedDatabase } from './support/database.js'
import { createFileNodes, createTenant } from './support/fixtures.js'
import { readEdges } from './support/graph-state.js'
import { createTempRepo, type TempRepo } from './support/git-repo.js'

/**
 * Criterios de aceptacion de T03, parte 2 (overlay de co-cambio), contra git
 * y Postgres DE VERDAD (CLAUDE.md 5: nada de dobles de `git log`):
 *
 *   1. Dos ficheros que cambian juntos repetidamente (por encima del umbral)
 *      producen una arista `cochange`/`git` con su peso.
 *   2. Dos ficheros que solo coinciden una vez NO producen arista.
 *   3. Un commit gigante (por encima del tope configurado) no genera la
 *      explosion de aristas que generaria sin el tope.
 *   4. Un par que co-cambia pero no tiene nodo `file` en el grafo (T02 nunca
 *      lo indexo) se descarta y se cuenta, no se inventa un nodo.
 */

let db: StartedDatabase
const repos: TempRepo[] = []

beforeAll(async () => {
  db = await startDatabase()
  configureDatabase({ connectionString: db.runtimeUrl, max: 8, allowExitOnIdle: true })
}, 300_000)

afterAll(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()))
  await closeDatabase()
  await db?.container.stop()
})

async function newRepo(prefix: string): Promise<TempRepo> {
  const repo = await createTempRepo(prefix)
  repos.push(repo)
  return repo
}

/** Ventana amplia a proposito: los commits del test se crean "ahora mismo". */
const SINCE_MONTHS = 24

describe('1-2. umbral: co-cambio repetido produce arista, uno aislado no', () => {
  it('5 co-cambios de a+b cruzan el umbral; 1 co-cambio de x+y no, y el PESO persistido es el lift', async () => {
    const tenantId = await createTenant('cochange-umbral')
    const repoId = randomUUID()
    const repo = await newRepo('umbral')

    const COCAMBIOS = 5
    // Nombre NO ASCII a proposito: por defecto `git log --name-only` lo ESCAPA
    // ("src/a\\303\\261o.ts") segun `core.quotepath`, y esa ruta no casaria nunca
    // con la de `graph_nodes` — el par se descartaria en silencio. La ingesta
    // pasa `-c core.quotepath=false`; esto lo comprueba.
    const ACENTUADO = 'src/año.ts'
    await createFileNodes(tenantId, repoId, ['a.ts', 'b.ts', 'x.ts', 'y.ts', ACENTUADO])

    for (let i = 0; i < COCAMBIOS; i += 1) {
      await repo.write('a.ts', `export const a = ${String(i)}\n`)
      await repo.write('b.ts', `export const b = ${String(i)}\n`)
      await repo.write(ACENTUADO, `export const anio = ${String(i)}\n`)
      await repo.commit(`cambia a, b y ${ACENTUADO} juntos (${String(i)})`)
    }
    await repo.write('x.ts', 'export const x = 1\n')
    await repo.write('y.ts', 'export const y = 1\n')
    await repo.commit('cambia x e y juntos, una sola vez')

    const result = await runWithTenant({ tenantId }, () =>
      ingestCochange({ repoId, repoPath: repo.path, sinceMonths: SINCE_MONTHS }),
    )
    const COMMITS = COCAMBIOS + 1
    expect(result.commitsConsidered).toBe(COMMITS)
    expect(result.commitsSkippedGiant).toBe(0)
    // (a,b), (a,año) y (b,año): los tres cambian juntos. (x,y) no cruza minCochanges=3.
    expect(result.pairsFound).toBe(3)
    expect(result.unresolvedPairs).toBe(0)

    const edges = await readEdges(tenantId, repoId)
    const cochangeEdges = edges.filter((e) => e.kind === 'cochange')
    // Los DOS sentidos por par (ver `cochange/store.ts`): 3 pares -> 6 aristas.
    expect(cochangeEdges).toHaveLength(6)
    for (const edge of cochangeEdges) {
      expect(edge.source).toBe('git')
      expect([edge.from.path, edge.to.path].sort()).not.toContain('x.ts')
    }

    // La ruta con acento llega SIN escapar: si `core.quotepath` estuviera
    // activo, este par no existiria y `unresolvedPairs` habria subido.
    expect(cochangeEdges.some((e) => e.from.path === ACENTUADO)).toBe(true)

    // EL PESO PERSISTIDO. `weight` es el LIFT, no la frecuencia (ver ADR 0005 y
    // `cochange/mine.ts`): (coocurrencias * commits considerados) / (apariciones
    // de A * apariciones de B). Se CALCULA aqui con los numeros del escenario,
    // no se copia un decimal a ojo. La frecuencia bruta va en `metadata`.
    const apariciones = COCAMBIOS
    const liftEsperado = (COCAMBIOS * COMMITS) / (apariciones * apariciones)
    const ab = cochangeEdges.find((e) => e.from.path === 'a.ts' && e.to.path === 'b.ts')
    expect(ab).toBeDefined()
    expect(ab?.weight).toBeCloseTo(liftEsperado, 5)
    expect(ab?.metadata).toMatchObject({ cochangeCount: COCAMBIOS })
    // Y el control: el lift NO es la frecuencia bruta, que es 5.
    expect(ab?.weight).not.toBeCloseTo(COCAMBIOS, 5)
  })
})

describe('3. un commit gigante no genera la explosion de aristas', () => {
  it('un commit que toca mas ficheros que el tope se descarta entero, aunque se repita', async () => {
    const tenantId = await createTenant('cochange-gigante')
    const repoId = randomUUID()
    const repo = await newRepo('gigante')

    // 60 ficheros: por encima del tope por defecto (50). Representativo de un
    // "format all"/merge de 400 ficheros sin pagar el coste de escribir 400
    // ficheros de verdad en el test.
    const giantFiles = Array.from({ length: 60 }, (_, i) => `pkg/f${String(i)}.ts`)
    await createFileNodes(tenantId, repoId, giantFiles)

    // Se repite 3 veces: si el tope NO filtrara, cada pareja de los 60
    // ficheros co-cambiaria 3 veces (por encima de minCochanges=3) y saldrian
    // C(60,2) = 1770 pares.
    for (let pass = 0; pass < 3; pass += 1) {
      for (const file of giantFiles) {
        await repo.write(file, `export const v = ${String(pass)}\n`)
      }
      await repo.commit(`pasada gigante ${String(pass)}`)
    }

    const result = await runWithTenant({ tenantId }, () =>
      ingestCochange({ repoId, repoPath: repo.path, sinceMonths: SINCE_MONTHS }),
    )
    expect(result.commitsSkippedGiant).toBe(3)
    expect(result.commitsConsidered).toBe(0)
    expect(result.pairsFound).toBe(0)
    expect(result.edgesInserted).toBe(0)

    const edges = await readEdges(tenantId, repoId)
    expect(edges.filter((e) => e.kind === 'cochange')).toEqual([])
  })
})

describe('4. un par sin nodo `file` en el grafo se descarta y se cuenta, no se inventa', () => {
  it('ficheros que git vio pero T02 nunca indexo no producen arista', async () => {
    const tenantId = await createTenant('cochange-sin-nodo')
    const repoId = randomUUID()
    const repo = await newRepo('sin-nodo')

    // NO se crea ningun nodo `file` para README.md ni CHANGELOG.md: T02 no
    // los indexa (ningun LanguageParser los atiende).
    for (let i = 0; i < 4; i += 1) {
      await repo.write('README.md', `cambio ${String(i)}\n`)
      await repo.write('CHANGELOG.md', `cambio ${String(i)}\n`)
      await repo.commit(`actualiza docs (${String(i)})`)
    }

    const result = await runWithTenant({ tenantId }, () =>
      ingestCochange({ repoId, repoPath: repo.path, sinceMonths: SINCE_MONTHS }),
    )
    expect(result.pairsFound).toBe(1) // el minado en si SI ve el par...
    expect(result.unresolvedPairs).toBe(1) // ...pero no resuelve a nodos.
    expect(result.edgesInserted).toBe(0)

    expect(await readEdges(tenantId, repoId)).toEqual([])
  })
})
