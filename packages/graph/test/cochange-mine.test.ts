import { describe, expect, it } from 'vitest'

import { parseNameOnlyLog } from '../src/cochange/git.js'
import { mineCochangePairs } from '../src/cochange/mine.js'

/**
 * El algoritmo de minado en si, con arrays a mano: no hace falta Postgres ni
 * un repositorio git real para probar las tres decisiones documentadas en la
 * cabecera de `src/cochange/mine.ts`. El extremo a extremo contra git y
 * Postgres de verdad esta en `cochange.test.ts`.
 */

describe('parseNameOnlyLog: el formato que produce listCochangeCommits', () => {
  it('separa varios commits y sus ficheros', () => {
    const stdout = '\x01aaaaaaa\x02\nsrc/a.ts\nsrc/b.ts\n\n\x01bbbbbbb\x02\nsrc/c.ts\n\n'
    expect(parseNameOnlyLog(stdout)).toEqual([
      { sha: 'aaaaaaa', files: ['src/a.ts', 'src/b.ts'] },
      { sha: 'bbbbbbb', files: ['src/c.ts'] },
    ])
  })

  it('un commit sin ficheros (merge sin diff) sale con lista vacia', () => {
    const stdout = '\x01aaaaaaa\x02\n\n'
    expect(parseNameOnlyLog(stdout)).toEqual([{ sha: 'aaaaaaa', files: [] }])
  })

  it('historial vacio produce un array vacio', () => {
    expect(parseNameOnlyLog('')).toEqual([])
  })
})

describe('mineCochangePairs: umbral, tope de fichero por commit, y peso normalizado', () => {
  it('un par que co-cambia por debajo del umbral no produce arista', () => {
    const commits = [
      { sha: '1', files: ['a.ts', 'b.ts'] },
      { sha: '2', files: ['a.ts', 'b.ts'] },
    ]
    const result = mineCochangePairs(commits, { minCochanges: 3 })
    expect(result.pairs).toEqual([])
  })

  it('un par que co-cambia al menos el umbral de veces produce una arista con su frecuencia', () => {
    const commits = [
      { sha: '1', files: ['a.ts', 'b.ts'] },
      { sha: '2', files: ['a.ts', 'b.ts'] },
      { sha: '3', files: ['a.ts', 'b.ts'] },
    ]
    const result = mineCochangePairs(commits, { minCochanges: 3 })
    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toMatchObject({ a: 'a.ts', b: 'b.ts', cochangeCount: 3 })
    expect(result.pairs[0]?.weight).toBeGreaterThan(0)
  })

  it('el orden de los ficheros dentro del commit no importa: la clave del par es canonica', () => {
    const commits = [
      { sha: '1', files: ['b.ts', 'a.ts'] },
      { sha: '2', files: ['a.ts', 'b.ts'] },
      { sha: '3', files: ['b.ts', 'a.ts'] },
    ]
    const result = mineCochangePairs(commits, { minCochanges: 3 })
    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toMatchObject({ a: 'a.ts', b: 'b.ts' })
  })

  it('un fichero duplicado en la lista de un commit no infla el conteo', () => {
    const commits = [
      { sha: '1', files: ['a.ts', 'a.ts', 'b.ts'] },
      { sha: '2', files: ['a.ts', 'b.ts'] },
      { sha: '3', files: ['a.ts', 'b.ts'] },
    ]
    const result = mineCochangePairs(commits, { minCochanges: 3 })
    expect(result.pairs[0]?.cochangeCount).toBe(3)
  })

  it('un commit por encima del tope de ficheros se descarta ENTERO: ni pares ni denominador', () => {
    const giant = Array.from({ length: 10 }, (_, i) => `f${String(i)}.ts`)
    const commits = [
      { sha: 'g1', files: giant },
      { sha: 'g2', files: giant },
      { sha: 'g3', files: giant },
      // Un commit normal, que SI debe contar.
      { sha: 'n1', files: ['x.ts', 'y.ts'] },
    ]
    const result = mineCochangePairs(commits, { minCochanges: 1, maxFilesPerCommit: 5 })
    expect(result.commitsSkippedGiant).toBe(3)
    expect(result.commitsConsidered).toBe(1)
    // Ninguna pareja de `giant` aparece, a pesar de co-cambiar 3 veces cada una.
    expect(result.pairs.some((p) => p.a.startsWith('f') || p.b.startsWith('f'))).toBe(false)
    expect(result.pairs).toEqual([{ a: 'x.ts', b: 'y.ts', cochangeCount: 1, weight: 1 }])
  })

  it('un fichero que cambia mucho por su cuenta (hot.ts) pesa menos, a igual frecuencia bruta, que un par exclusivo', () => {
    // hot.ts es un CHANGELOG.md tipico: cambia en 20 commits, 4 de ellos junto
    // a a.ts (que no cambia en ningun otro sitio). b.ts y c.ts SOLO cambian
    // juntos, tambien 4 veces: misma frecuencia bruta que (a, hot), pero sin
    // el ruido de un fichero que cambia por su cuenta.
    const commits: { sha: string; files: string[] }[] = []
    for (let i = 0; i < 4; i += 1)
      commits.push({ sha: `ha${String(i)}`, files: ['hot.ts', 'a.ts'] })
    for (let i = 0; i < 16; i += 1) commits.push({ sha: `h${String(i)}`, files: ['hot.ts'] })
    for (let i = 0; i < 4; i += 1) commits.push({ sha: `bc${String(i)}`, files: ['b.ts', 'c.ts'] })

    const result = mineCochangePairs(commits, { minCochanges: 1 })
    const hotA = result.pairs.find((p) => p.a === 'a.ts' && p.b === 'hot.ts')
    const bC = result.pairs.find((p) => p.a === 'b.ts' && p.b === 'c.ts')
    // Misma frecuencia bruta (4 co-cambios cada par)...
    expect(hotA?.cochangeCount).toBe(4)
    expect(bC?.cochangeCount).toBe(4)
    // ...pero el peso normalizado NO es igual: hot.ts diluye su propio par
    // porque cambia otras 16 veces sin a.ts, mientras que b.ts y c.ts solo
    // cambian juntos.
    expect(hotA?.weight).toBeLessThan(bC?.weight ?? 0)
  })

  it('sin pares que superen el umbral, el resultado es vacio pero informa cuantos commits conto', () => {
    const commits = [{ sha: '1', files: ['a.ts', 'b.ts'] }]
    const result = mineCochangePairs(commits, { minCochanges: 3 })
    expect(result.pairs).toEqual([])
    expect(result.commitsConsidered).toBe(1)
    expect(result.commitsSkippedGiant).toBe(0)
  })
})
