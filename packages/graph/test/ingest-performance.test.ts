import { randomUUID } from 'node:crypto'

import { runWithTenant } from '@coord/core'
import { closeDatabase, configureDatabase } from '@coord/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ingestRepository } from '../src/ingest/index.js'

import { startDatabase, type StartedDatabase } from './support/database.js'
import { createTenant } from './support/fixtures.js'
import { createTempRepo, type TempRepo } from './support/git-repo.js'
import { readGraphFiles } from './support/graph-state.js'

/**
 * Segundo criterio de aceptacion de T02, literal:
 *
 *   "Dado un commit, cuando termina la ingesta, entonces el grafo refleja el
 *    estado del repo en menos de 30 segundos para repos de tamano medio."
 *
 * ---------------------------------------------------------------------------
 * QUE ES "TAMANO MEDIO" AQUI, Y POR QUE ASI
 * ---------------------------------------------------------------------------
 * 1.000 ficheros TypeScript en 10 capas, cada uno con imports reales a la capa
 * anterior, una clase que hereda de otro fichero y llamadas cruzadas. No es un
 * repositorio de ficheros vacios: si lo fuera, la medida no diria nada, porque
 * lo que cuesta es parsear y resolver, no listar.
 *
 * El umbral NO se relaja. Si esto se pone en rojo, lo que hay que arreglar es
 * la ingesta, no el numero.
 */

const LAYERS = 10
const PER_LAYER = 100
const TOTAL_FILES = LAYERS * PER_LAYER
const BUDGET_MS = 30_000

let db: StartedDatabase
let repo: TempRepo

beforeAll(async () => {
  db = await startDatabase()
  configureDatabase({ connectionString: db.runtimeUrl, max: 8, allowExitOnIdle: true })

  repo = await createTempRepo('perf')
  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (let index = 0; index < PER_LAYER; index += 1) {
      await repo.write(`src/l${String(layer)}/m${String(index)}.ts`, moduleSource(layer, index))
    }
  }
  await repo.commit('repo de tamano medio')
}, 600_000)

afterAll(async () => {
  await repo?.cleanup()
  await closeDatabase()
  await db?.container.stop()
})

/** Un modulo con la forma de uno real: imports, clase, herencia y llamadas. */
function moduleSource(layer: number, index: number): string {
  const name = `M${String(layer)}_${String(index)}`
  if (layer === 0) {
    return [
      `export class ${name} {`,
      '  value(): number {',
      `    return ${String(index)}`,
      '  }',
      '}',
      '',
      `export function make${name}(): ${name} {`,
      `  return new ${name}()`,
      '}',
      '',
    ].join('\n')
  }

  const dependencies = [0, 1, 2].map((offset) => (index + offset * 7) % PER_LAYER)
  const imports = dependencies.map(
    (dependency) =>
      `import { M${String(layer - 1)}_${String(dependency)}, makeM${String(layer - 1)}_${String(dependency)} } from '../l${String(layer - 1)}/m${String(dependency)}.js'`,
  )
  const first = dependencies[0] ?? 0
  return [
    ...imports,
    '',
    `export class ${name} extends M${String(layer - 1)}_${String(first)} {`,
    '  total(): number {',
    `    return ${dependencies
      .map((dependency) => `makeM${String(layer - 1)}_${String(dependency)}().value()`)
      .join(' + ')}`,
    '  }',
    '}',
    '',
    `export function make${name}(): ${name} {`,
    `  return new ${name}()`,
    '}',
    '',
  ].join('\n')
}

describe('la ingesta completa de un repo de tamano medio cabe en el presupuesto', () => {
  let tenantId: string
  let repoId: string

  beforeAll(async () => {
    tenantId = await createTenant('rendimiento')
    repoId = randomUUID()
  })

  it(`indexa ${String(TOTAL_FILES)} ficheros en menos de ${String(BUDGET_MS)} ms`, async () => {
    const startedAt = Date.now()
    const result = await runWithTenant({ tenantId }, () =>
      ingestRepository({ repoId, repoPath: repo.path }),
    )
    const elapsed = Date.now() - startedAt

    expect(result.filesPlanned).toBe(TOTAL_FILES)
    expect(result.edgesInserted).toBeGreaterThan(TOTAL_FILES)
    const indexed = await readGraphFiles(tenantId, repoId)
    expect(indexed.size).toBe(TOTAL_FILES)

    console.log(
      `ingesta completa: ${String(elapsed)} ms para ${String(TOTAL_FILES)} ficheros ` +
        `(${String(result.edgesInserted)} aristas, ${String(result.durationMs)} ms medidos dentro)`,
    )
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })

  it('la reindexacion sin cambios no vuelve a parsear nada y es mucho mas barata', async () => {
    const startedAt = Date.now()
    const result = await runWithTenant({ tenantId }, () =>
      ingestRepository({ repoId, repoPath: repo.path }),
    )
    const elapsed = Date.now() - startedAt

    expect(result.filesPlanned).toBe(0)
    expect(result.filesSkipped).toBe(TOTAL_FILES)
    expect(result.filesParsed).toBe(0)

    console.log(`reindexacion sin cambios: ${String(elapsed)} ms`)
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })
})
