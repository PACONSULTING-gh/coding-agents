import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { listCochangeCommits } from '../src/cochange/git.js'

import { createTempRepo, type TempRepo } from './support/git-repo.js'

/**
 * La ventana de historial del minado de co-cambios, contra git DE VERDAD.
 *
 * Vive aparte de `cochange.test.ts` porque aquello levanta Postgres y esto no
 * lo necesita: lo unico que se prueba aqui es que argumento se le pasa a `git
 * log` y que devuelve. Aparte tambien de `cochange-mine.test.ts`, que es el
 * algoritmo con arrays a mano y no ejecuta git.
 */

let repo: TempRepo

const HACE_DOS_ANOS = '2024-01-15T10:00:00+00:00'

beforeAll(async () => {
  repo = await createTempRepo('cochange-git')

  await repo.write('src/a.ts', 'export const a = 1\n')
  await repo.write('src/b.ts', 'export const b = 1\n')
  await repo.commit('a y b juntos')

  await repo.write('src/a.ts', 'export const a = 2\n')
  await repo.write('src/b.ts', 'export const b = 2\n')
  await repo.commit('a y b otra vez')

  // EL COMMIT VIEJO VA EN LA PUNTA, que es lo que hace util este fixture: si
  // fuera el mas antiguo, `--since` y `--since-as-filter` darian lo mismo y el
  // test no distinguiria entre el codigo bueno y el malo.
  await repo.write('CHANGELOG.md', '# 0.1.0\n')
  await repo.commitAt('nota de version con la fecha desviada', HACE_DOS_ANOS)
}, 120_000)

afterAll(async () => {
  await repo?.cleanup()
})

describe('la ventana de historial', () => {
  it('un commit viejo en la punta NO vacia la ventana entera', async () => {
    // REGRESION del issue #35, y de un fallo real de git MEDIDO, no supuesto:
    // `--since` PARA de recorrer al encontrar un commit mas viejo que el corte,
    // en vez de filtrar. Aqui el commit de hace dos años es el ULTIMO del
    // historial, asi que con `--since` esta llamada devolveria CERO — no
    // "menos", cero— y el overlay de co-cambio se quedaria sin producir nada,
    // sin un solo error que lo explicara.
    const commits = await listCochangeCommits(repo.path, { sinceMonths: 12 })

    expect(commits).toHaveLength(2)
    expect(commits.flatMap((c) => c.files).sort()).toEqual([
      'src/a.ts',
      'src/a.ts',
      'src/b.ts',
      'src/b.ts',
    ])
    // Y el viejo se queda fuera: la ventana recorta de verdad, no es que se
    // haya desactivado el filtro para que el test pase.
    expect(commits.flatMap((c) => c.files)).not.toContain('CHANGELOG.md')
  }, 60_000)

  it('una ventana suficientemente ancha incluye tambien el commit desviado', async () => {
    // Contrapeso: sin esto, un `listCochangeCommits` que devolviera siempre los
    // dos ultimos commits pasaria el test de arriba.
    const commits = await listCochangeCommits(repo.path, { sinceMonths: 12 * 50 })

    expect(commits).toHaveLength(3)
    expect(commits.flatMap((c) => c.files)).toContain('CHANGELOG.md')
  }, 60_000)
})
