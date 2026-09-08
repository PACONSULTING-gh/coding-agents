import { randomUUID } from 'node:crypto'

import { runWithTenant, ValidationError } from '@coord/core'
import { closeDatabase, configureDatabase, withTenantConnection } from '@coord/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  blastRadius,
  findDependencies,
  findDependents,
  findNodesByPath,
  MAX_TRAVERSAL_DEPTH,
} from '../src/queries.js'

import { startDatabase, type StartedDatabase } from './support/database.js'
import { createEdges, createFileNodes, createTenant } from './support/fixtures.js'

/**
 * Criterios de aceptacion de T01 (epic 02), contra Postgres de verdad:
 *
 *   1. Conjunto transitivo hasta la profundidad indicada.
 *   2. Sin bucles infinitos en grafos ciclicos.
 *   3. Dos tenants con grafos distintos no se ven entre si.
 *
 * El cuarto criterio (p95 < 200 ms con mas de 10.000 nodos) esta en
 * `performance.test.ts`, que necesita su propio conjunto de datos.
 */

let db: StartedDatabase

beforeAll(async () => {
  db = await startDatabase()
  configureDatabase({ connectionString: db.runtimeUrl, max: 8, allowExitOnIdle: true })
}, 300_000)

afterAll(async () => {
  await closeDatabase()
  await db?.container.stop()
})

describe('1. conjunto transitivo y tope de profundidad', () => {
  /** A depende de B, B de C, C de D. Los dependientes de D son C, B y A, en ese orden. */
  let tenantId: string
  let repoId: string
  let nodes: Map<string, string>

  beforeAll(async () => {
    tenantId = await createTenant('cadena')
    repoId = randomUUID()
    nodes = await createFileNodes(tenantId, repoId, ['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    const id = (path: string): string => {
      const value = nodes.get(path)
      if (value === undefined) throw new Error(`Falta el nodo ${path}`)
      return value
    }
    await createEdges(tenantId, repoId, [
      { from: id('a.ts'), to: id('b.ts') },
      { from: id('b.ts'), to: id('c.ts') },
      { from: id('c.ts'), to: id('d.ts') },
    ])
  })

  const idOf = (path: string): string => {
    const value = nodes.get(path)
    if (value === undefined) throw new Error(`Falta el nodo ${path}`)
    return value
  }

  it('a profundidad 2 desde d.ts salen c.ts y b.ts, y NO a.ts', async () => {
    const { hits, truncated } = await runWithTenant({ tenantId }, () =>
      findDependents({ repoId, nodeId: idOf('d.ts'), depth: 2 }),
    )
    expect(truncated).toBe(false)

    expect(hits.map((hit) => `${hit.path}@${String(hit.distance)}`)).toEqual(['c.ts@1', 'b.ts@2'])
    expect(hits.map((hit) => hit.path)).not.toContain('a.ts')
  })

  it('a profundidad 3 aparece tambien a.ts, y cada nodo una sola vez', async () => {
    const { hits } = await runWithTenant({ tenantId }, () =>
      findDependents({ repoId, nodeId: idOf('d.ts'), depth: 3 }),
    )

    expect(hits.map((hit) => `${hit.path}@${String(hit.distance)}`)).toEqual([
      'c.ts@1',
      'b.ts@2',
      'a.ts@3',
    ])
    // El nodo de partida nunca sale en su propio resultado.
    expect(hits.map((hit) => hit.path)).not.toContain('d.ts')
  })

  it('la arista devuelve la senal que la produjo', async () => {
    const { hits } = await runWithTenant({ tenantId }, () =>
      findDependents({ repoId, nodeId: idOf('d.ts'), depth: 1 }),
    )
    const [primero] = hits

    expect(primero?.edgeSource).toBe('static')
    expect(primero?.edgeKind).toBe('imports')
    expect(primero?.kind).toBe('file')
    expect(primero?.name).toBeNull()
    expect(primero?.language).toBe('typescript')
  })

  it('findDependencies recorre la arista en su sentido natural', async () => {
    const { hits } = await runWithTenant({ tenantId }, () =>
      findDependencies({ repoId, nodeId: idOf('a.ts'), depth: 2 }),
    )

    expect(hits.map((hit) => `${hit.path}@${String(hit.distance)}`)).toEqual(['b.ts@1', 'c.ts@2'])
    expect(hits.map((hit) => hit.path)).not.toContain('d.ts')
  })

  it('el filtro por tipo de arista y por origen acota el recorrido', async () => {
    const { hits } = await runWithTenant({ tenantId }, () =>
      findDependents({ repoId, nodeId: idOf('d.ts'), depth: 3, sources: ['git'] }),
    )
    expect(hits).toEqual([])
  })

  it('una profundidad por encima del techo duro se rechaza en la frontera', async () => {
    await expect(
      runWithTenant({ tenantId }, () =>
        findDependents({ repoId, nodeId: idOf('d.ts'), depth: MAX_TRAVERSAL_DEPTH + 1 }),
      ),
    ).rejects.toBeInstanceOf(ValidationError)

    await expect(
      runWithTenant({ tenantId }, () => findDependents({ repoId, nodeId: 'no-soy-un-uuid' })),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('findNodesByPath resuelve rutas a nodos, que es como entra un diff', async () => {
    const refs = await runWithTenant({ tenantId }, () =>
      findNodesByPath({ repoId, paths: ['a.ts', 'd.ts', 'no-existe.ts'] }),
    )
    expect(refs.map((ref) => ref.path)).toEqual(['a.ts', 'd.ts'])
  })
})

describe('2. grafo ciclico: la consulta TERMINA y no duplica', () => {
  let tenantId: string
  let repoId: string
  let nodes: Map<string, string>

  beforeAll(async () => {
    tenantId = await createTenant('ciclos')
    repoId = randomUUID()
    nodes = await createFileNodes(tenantId, repoId, ['x.ts', 'y.ts', 'p.ts', 'q.ts', 'r.ts'])
    const id = (path: string): string => {
      const value = nodes.get(path)
      if (value === undefined) throw new Error(`Falta el nodo ${path}`)
      return value
    }
    await createEdges(tenantId, repoId, [
      // Ciclo de dos: x importa y, y importa x.
      { from: id('x.ts'), to: id('y.ts') },
      { from: id('y.ts'), to: id('x.ts') },
      // Ciclo de tres: p -> q -> r -> p.
      { from: id('p.ts'), to: id('q.ts') },
      { from: id('q.ts'), to: id('r.ts') },
      { from: id('r.ts'), to: id('p.ts') },
    ])
  })

  const idOf = (path: string): string => {
    const value = nodes.get(path)
    if (value === undefined) throw new Error(`Falta el nodo ${path}`)
    return value
  }

  /**
   * TIMEOUT CORTO A PROPOSITO. Sin la guarda de ciclos la CTE recursiva no
   * devuelve nunca; con el timeout global de 180 s el fallo tardaria tres
   * minutos en manifestarse y pareceria "lentitud". Aqui, si no termina en 20
   * segundos, el test FALLA: colgarse es exactamente el bug que se persigue.
   */
  it('ciclo de dos: termina, y el vecino aparece una sola vez', async () => {
    const { hits } = await runWithTenant({ tenantId }, () =>
      findDependents({ repoId, nodeId: idOf('x.ts'), depth: MAX_TRAVERSAL_DEPTH }),
    )

    expect(hits).toHaveLength(1)
    expect(hits[0]?.path).toBe('y.ts')
    expect(hits[0]?.distance).toBe(1)
  }, 20_000)

  it('ciclo de tres: los dos nodos restantes, cada uno una vez y a su distancia minima', async () => {
    const { hits } = await runWithTenant({ tenantId }, () =>
      findDependents({ repoId, nodeId: idOf('p.ts'), depth: MAX_TRAVERSAL_DEPTH }),
    )

    expect(hits.map((hit) => `${hit.path}@${String(hit.distance)}`)).toEqual(['r.ts@1', 'q.ts@2'])
  }, 20_000)

  it('blastRadius sobre un grafo ciclico tambien termina', async () => {
    const { hits } = await runWithTenant({ tenantId }, () =>
      blastRadius({
        repoId,
        nodeIds: [idOf('x.ts'), idOf('p.ts')],
        depth: MAX_TRAVERSAL_DEPTH,
      }),
    )

    // Ni x.ts ni p.ts, que son la entrada: lo que se pregunta es que MAS se ve
    // afectado.
    expect(hits.map((hit) => hit.path).sort()).toEqual(['q.ts', 'r.ts', 'y.ts'])
    expect(new Set(hits.map((hit) => hit.nodeId)).size).toBe(hits.length)
  }, 20_000)
})

describe('3. aislamiento entre tenants', () => {
  /**
   * Los dos tenants usan A PROPOSITO las MISMAS rutas y el MISMO grafo. Si el
   * aislamiento dependiera de que las claves naturales no chocan, este test
   * pasaria por casualidad. Lo unico que separa a los dos grafos es la RLS.
   */
  const PATHS = ['src/core.ts', 'src/api.ts', 'src/ui.ts'] as const

  let tenantA: string
  let tenantB: string
  let repoA: string
  let repoB: string
  let nodesA: Map<string, string>
  let nodesB: Map<string, string>

  beforeAll(async () => {
    tenantA = await createTenant('aislado-a')
    tenantB = await createTenant('aislado-b')
    repoA = randomUUID()
    repoB = randomUUID()

    nodesA = await createFileNodes(tenantA, repoA, PATHS)
    nodesB = await createFileNodes(tenantB, repoB, PATHS)

    const link = async (
      tenant: string,
      repo: string,
      nodes: Map<string, string>,
    ): Promise<void> => {
      const id = (path: string): string => {
        const value = nodes.get(path)
        if (value === undefined) throw new Error(`Falta el nodo ${path}`)
        return value
      }
      await createEdges(tenant, repo, [
        { from: id('src/api.ts'), to: id('src/core.ts') },
        { from: id('src/ui.ts'), to: id('src/api.ts') },
      ])
    }
    await link(tenantA, repoA, nodesA)
    await link(tenantB, repoB, nodesB)
  })

  it('los dos tenants tienen nodos con la misma ruta y son nodos distintos', () => {
    for (const path of PATHS) {
      expect(nodesA.get(path)).toBeDefined()
      expect(nodesA.get(path)).not.toBe(nodesB.get(path))
    }
  })

  it('desde A no aparece ni un nodo de B, aunque el grafo sea identico', async () => {
    const coreA = nodesA.get('src/core.ts')
    if (coreA === undefined) throw new Error('Falta el nodo de partida')

    const { hits } = await runWithTenant({ tenantId: tenantA }, () =>
      findDependents({ repoId: repoA, nodeId: coreA, depth: MAX_TRAVERSAL_DEPTH }),
    )

    expect(hits.map((hit) => hit.path)).toEqual(['src/api.ts', 'src/ui.ts'])
    const idsDeB = new Set(nodesB.values())
    for (const hit of hits) {
      expect(idsDeB.has(hit.nodeId), `${hit.path} es un nodo del tenant B`).toBe(false)
    }
  })

  it('preguntar desde A por un nodo de B no devuelve nada (no filtra ni su existencia)', async () => {
    const coreB = nodesB.get('src/core.ts')
    if (coreB === undefined) throw new Error('Falta el nodo de partida')

    const { hits } = await runWithTenant({ tenantId: tenantA }, () =>
      findDependents({ repoId: repoB, nodeId: coreB, depth: MAX_TRAVERSAL_DEPTH }),
    )
    expect(hits).toEqual([])
  })

  it('una consulta SIN filtro de tenant tampoco cruza: la defensa es la RLS', async () => {
    // SQL deliberadamente mal escrito: ni `WHERE tenant_id`, ni `repo_id`, ni
    // LIMIT. Si la RLS no estuviera forzada, esto devolveria los seis nodos.
    const leer = async (): Promise<string[]> =>
      withTenantConnection(async (tx) => {
        const result = await tx.query<{ id: string }>('SELECT id FROM graph_nodes')
        return result.rows.map((row) => row.id)
      })

    const vistosPorA = await runWithTenant({ tenantId: tenantA }, leer)
    const vistosPorB = await runWithTenant({ tenantId: tenantB }, leer)

    expect(vistosPorA.sort()).toEqual([...nodesA.values()].sort())
    expect(vistosPorB.sort()).toEqual([...nodesB.values()].sort())
    expect(vistosPorA.some((id) => vistosPorB.includes(id))).toBe(false)

    // Lo mismo para las aristas: dos por tenant, no cuatro.
    const aristasDeA = await runWithTenant({ tenantId: tenantA }, () =>
      withTenantConnection(async (tx) => {
        const result = await tx.query<{ total: string }>(
          'SELECT count(*) AS total FROM graph_edges',
        )
        return result.rows[0]?.total
      }),
    )
    expect(aristasDeA).toBe('2')
  })

  it('el motor rechaza una arista que cruce tenants (clave ajena compuesta)', async () => {
    const apiA = nodesA.get('src/api.ts')
    const coreB = nodesB.get('src/core.ts')
    if (apiA === undefined || coreB === undefined) throw new Error('Faltan nodos')

    // No es una convencion ni una comprobacion de la aplicacion: no existe la
    // fila (tenantA, coreB) en graph_nodes, asi que la FK compuesta lo impide.
    await expect(
      runWithTenant({ tenantId: tenantA }, () =>
        withTenantConnection(async (tx) => {
          await tx.query(
            `INSERT INTO graph_edges (tenant_id, repo_id, from_node_id, to_node_id, kind, source)
             VALUES ($1, $2, $3, $4, 'imports', 'static')`,
            [tenantA, repoA, apiA, coreB],
          )
        }),
      ),
    ).rejects.toThrow(/graph_edges_to_node_fkey|foreign key/i)
  })
})

describe('4. blastRadius indica QUE SENAL predijo cada resultado', () => {
  let tenantId: string
  let repoId: string
  let nodes: Map<string, string>

  beforeAll(async () => {
    tenantId = await createTenant('senales')
    repoId = randomUUID()
    nodes = await createFileNodes(tenantId, repoId, [
      'src/schema.ts',
      'src/repo.ts',
      'docs/schema.md',
    ])
    const id = (path: string): string => {
      const value = nodes.get(path)
      if (value === undefined) throw new Error(`Falta el nodo ${path}`)
      return value
    }
    await createEdges(tenantId, repoId, [
      // Senal estatica: repo.ts importa schema.ts.
      { from: id('src/repo.ts'), to: id('src/schema.ts'), kind: 'imports', source: 'static' },
      // Senal historica: repo.ts y schema.ts ademas cambian juntos a menudo.
      {
        from: id('src/repo.ts'),
        to: id('src/schema.ts'),
        kind: 'cochange',
        source: 'git',
        weight: 7,
      },
      // Solo senal historica: la documentacion no importa nada, pero cambia con el esquema.
      {
        from: id('docs/schema.md'),
        to: id('src/schema.ts'),
        kind: 'cochange',
        source: 'git',
        weight: 3,
      },
    ])
  })

  it('agrega todas las senales que alcanzaron cada nodo y ranquea por peso', async () => {
    const schemaId = nodes.get('src/schema.ts')
    if (schemaId === undefined) throw new Error('Falta el nodo de partida')

    const { hits } = await runWithTenant({ tenantId }, () =>
      blastRadius({ repoId, nodeIds: [schemaId], depth: 2 }),
    )

    expect(hits.map((hit) => hit.path)).toEqual(['src/repo.ts', 'docs/schema.md'])

    const [repo, doc] = hits
    expect(repo?.sources).toEqual(['git', 'static'])
    expect(repo?.edgeKinds).toEqual(['cochange', 'imports'])
    expect(repo?.weight).toBe(7)

    expect(doc?.sources).toEqual(['git'])
    expect(doc?.weight).toBe(3)
  })

  it('filtrando por origen `static` desaparece lo que solo predijo el historial', async () => {
    const schemaId = nodes.get('src/schema.ts')
    if (schemaId === undefined) throw new Error('Falta el nodo de partida')

    const { hits } = await runWithTenant({ tenantId }, () =>
      blastRadius({ repoId, nodeIds: [schemaId], depth: 2, sources: ['static'] }),
    )
    expect(hits.map((hit) => hit.path)).toEqual(['src/repo.ts'])
    expect(hits[0]?.sources).toEqual(['static'])
  })
})
