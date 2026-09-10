import { randomUUID } from 'node:crypto'

import { runWithTenant } from '@coord/core'
import { closeDatabase, configureDatabase } from '@coord/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { blastRadius, findDependents } from '../src/queries.js'

import { startDatabase, type StartedDatabase } from './support/database.js'
import { createEdges, createFileNodes, createTenant } from './support/fixtures.js'

/**
 * Criterio de aceptacion de T03, parte 3 (procedencia de la senal): "dada una
 * consulta de afectados que mezcla estatico y co-change, cada resultado
 * indica que senal lo predijo".
 *
 * Las consultas (`findDependents`, `blastRadius`) ya devuelven `edgeSource` /
 * `sources` desde T01 (`queries.ts` no se ha tocado en T03: nada que extender,
 * ver la cabecera de `src/build/` y `src/cochange/`). Lo que prueba este
 * fichero es que las aristas que produce T03 —`build` y `git`/`cochange`—
 * fluyen correctamente por esas consultas ya existentes, mezcladas con una
 * arista `static`, tal y como pide el criterio de aceptacion.
 */

let db: StartedDatabase

beforeAll(async () => {
  db = await startDatabase()
  configureDatabase({ connectionString: db.runtimeUrl, max: 8, allowExitOnIdle: true })
}, 300_000)

afterAll(async () => {
  await closeDatabase()
  await db?.stop()
})

describe('una consulta de afectados que mezcla estatico, build y co-change', () => {
  it('findDependents se queda con la senal MAS FUERTE cuando un nodo se alcanza por varias', async () => {
    const tenantId = await createTenant('procedencia-dependents')
    const repoId = randomUUID()
    const nodes = await createFileNodes(tenantId, repoId, [
      'target.ts',
      'onlyStatic.ts',
      'onlyGit.ts',
      'both.ts',
    ])
    const id = (path: string): string => {
      const value = nodes.get(path)
      if (value === undefined) throw new Error(`Falta el nodo ${path}`)
      return value
    }

    await createEdges(tenantId, repoId, [
      {
        from: id('onlyStatic.ts'),
        to: id('target.ts'),
        kind: 'imports',
        source: 'static',
        weight: 1,
      },
      { from: id('onlyGit.ts'), to: id('target.ts'), kind: 'cochange', source: 'git', weight: 3 },
      // "both.ts" alcanza target.ts por DOS senales distintas.
      { from: id('both.ts'), to: id('target.ts'), kind: 'imports', source: 'static', weight: 1 },
      { from: id('both.ts'), to: id('target.ts'), kind: 'cochange', source: 'git', weight: 5 },
    ])

    const hits = await runWithTenant({ tenantId }, () =>
      findDependents({ repoId, nodeId: id('target.ts') }),
    ).then((result) => result.hits)
    const byPath = new Map(hits.map((h) => [h.path, h]))

    expect(byPath.get('onlyStatic.ts')?.edgeSource).toBe('static')
    expect(byPath.get('onlyGit.ts')?.edgeSource).toBe('git')
    // `both.ts` sale UNA vez (DISTINCT ON node_id): con la senal de MAYOR
    // peso, que es exactamente lo que documenta `queries.ts` ("se queda con
    // el minimo [de distancia]"; a igual distancia, gana el peso mayor).
    expect(byPath.get('both.ts')?.edgeSource).toBe('git')
    expect(byPath.get('both.ts')?.weight).toBe(5)
  })

  it('blastRadius, en cambio, agrega TODAS las senales que alcanzaron cada nodo', async () => {
    const tenantId = await createTenant('procedencia-blast')
    const repoId = randomUUID()
    const nodes = await createFileNodes(tenantId, repoId, [
      'start.ts',
      'affected.ts',
      'buildOnly.ts',
    ])
    const id = (path: string): string => {
      const value = nodes.get(path)
      if (value === undefined) throw new Error(`Falta el nodo ${path}`)
      return value
    }

    // `blastRadius(start)` recorre DEPENDIENTES: aristas cuyo `to_node_id` es
    // uno de los nodos de partida. "affected.ts DEPENDE de start.ts" es
    // `from: affected, to: start` (la arista dice "from depende de to").
    await createEdges(tenantId, repoId, [
      // affected.ts se alcanza desde start.ts por analisis estatico, por el
      // grafo de build (T03 parte 1) Y por co-cambio (T03 parte 2).
      { from: id('affected.ts'), to: id('start.ts'), kind: 'imports', source: 'static', weight: 1 },
      { from: id('affected.ts'), to: id('start.ts'), kind: 'imports', source: 'build', weight: 1 },
      { from: id('affected.ts'), to: id('start.ts'), kind: 'cochange', source: 'git', weight: 4.2 },
      // buildOnly.ts solo por el grafo de build.
      { from: id('buildOnly.ts'), to: id('start.ts'), kind: 'imports', source: 'build', weight: 1 },
    ])

    const hits = await runWithTenant({ tenantId }, () =>
      blastRadius({ repoId, nodeIds: [id('start.ts')] }),
    ).then((result) => result.hits)
    const byPath = new Map(hits.map((h) => [h.path, h]))

    const affected = byPath.get('affected.ts')
    expect(affected).toBeDefined()
    expect(new Set(affected?.sources)).toEqual(new Set(['static', 'build', 'git']))
    expect(new Set(affected?.edgeKinds)).toEqual(new Set(['imports', 'cochange']))
    // El peso que se conserva es el de la senal MAS FUERTE (max), 4.2 del
    // co-cambio. `real` en Postgres es float32: se compara con tolerancia.
    expect(affected?.weight).toBeCloseTo(4.2, 5)

    const buildOnly = byPath.get('buildOnly.ts')
    expect(buildOnly).toBeDefined()
    expect(buildOnly?.sources).toEqual(['build'])
  })
})
