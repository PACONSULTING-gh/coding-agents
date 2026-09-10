import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { listAuthorshipCommits } from '../src/ownership/git.js'
import { computeOwnership } from '../src/ownership/score.js'

import { createTempRepo, type TempRepo } from './support/git-repo.js'

/**
 * `listAuthorshipCommits` contra un repositorio de git DE VERDAD (epic 03/T01).
 *
 * Los tests del parseo (`ownership-score.test.ts`) prueban que sé leer una
 * cadena que me invento yo. Esto prueba lo otro: que `git log --numstat` con
 * esas banderas produce de verdad esa cadena. Un doble no puede decir nada de
 * eso (CLAUDE.md 5).
 */

const AUTORA = { name: 'Autora', email: 'autora@ejemplo.test' }
const ERRATAS = { name: 'Erratas', email: 'erratas@ejemplo.test' }
const FORMATEADOR = { name: 'Formateador', email: 'formateador@ejemplo.test' }

const run = promisify(execFile)

let repo: TempRepo
let shaDelReformateo: string

/**
 * Un commit con fecha ANTIGUA. El helper compartido commitea siempre con la
 * fecha de ahora, y sin un commit viejo no hay forma de comprobar que la
 * ventana recorta: `--since=0 months ago` incluye lo de hace un segundo, asi
 * que con todo el historial recien creado cualquier ventana devuelve todo.
 */
async function commitAntiguo(mensaje: string, cuandoIso: string): Promise<void> {
  await run('git', ['-C', repo.path, 'add', '-A'])
  await run(
    'git',
    [
      '-C',
      repo.path,
      '-c',
      'user.name=Antigua',
      '-c',
      'user.email=antigua@ejemplo.test',
      'commit',
      '-q',
      '-m',
      mensaje,
    ],
    { env: { ...process.env, GIT_AUTHOR_DATE: cuandoIso, GIT_COMMITTER_DATE: cuandoIso } },
  )
}

beforeAll(async () => {
  repo = await createTempRepo('ownership')

  // Autoría real: un fichero escrito de arriba abajo, 120 líneas.
  const lineas = Array.from({ length: 120 }, (_, i) => `// linea ${String(i)}`)
  await repo.write('src/router.ts', `${lineas.join('\n')}\n`)
  await repo.commit('Issue #31: el router', AUTORA)

  // Tres pasadas de erratas: MUCHOS commits, DOS líneas cada uno (+1/-1).
  //
  // Se cambia una sola línea a propósito, y no se reescribe el fichero: el
  // helper `write` machaca el contenido entero, y un fichero reescrito sale
  // en `--numstat` como 120 borradas y 120 añadidas. Eso no es un arreglo de
  // errata, es una reescritura — y convertiría al de las erratas en el mayor
  // "autor" del fichero por accidente del fixture.
  for (const n of [1, 2, 3]) {
    lineas[n] = `// linea ${String(n)} (errata ${String(n)} corregida)`
    await repo.write('src/router.ts', `${lineas.join('\n')}\n`)
    await repo.commit(`Issue #31: errata ${String(n)}`, ERRATAS)
  }

  // Un `format all` que toca 60 ficheros, uno de ellos el nuestro.
  await repo.write('src/router.ts', `${lineas.map((l) => `${l}  `).join('\n')}\n`)
  for (let i = 0; i < 59; i += 1) {
    await repo.write(`src/otro-${String(i)}.ts`, '// reformateado\n')
  }
  shaDelReformateo = await repo.commit('chore: format all', FORMATEADOR)

  // Y algo de hace dos años, para poder comprobar que la ventana recorta.
  await repo.write('src/antiguo.ts', '// de hace mucho\n')
  await commitAntiguo('Issue #31: codigo antiguo', '2024-01-15T10:00:00Z')
}, 120_000)

afterAll(async () => {
  await repo?.cleanup()
})

describe('lo que git devuelve de verdad', () => {
  it('trae sha, email, nombre, fecha y líneas por fichero', async () => {
    const commits = await listAuthorshipCommits(repo.path, { sinceMonths: 12 })

    expect(commits.length).toBeGreaterThanOrEqual(5)
    const ultimo = commits[0]
    expect(ultimo?.authorEmail).toBe('formateador@ejemplo.test')
    expect(ultimo?.authorName).toBe('Formateador')
    expect(ultimo?.at).toBeInstanceOf(Date)
    // El `format all` toca 60 ficheros, y eso es lo que le hace descartable.
    expect(ultimo?.files).toHaveLength(60)
    expect(ultimo?.files.every((f) => f.lines > 0)).toBe(true)
  }, 60_000)

  it('la ventana recorta, y un commit viejo en la punta NO la vacía entera', async () => {
    // REGRESIÓN de un fallo real de git, medido: `--since` PARA de recorrer al
    // encontrar un commit más viejo que el corte, en vez de filtrar. Aquí el
    // commit de hace dos años es justo el ÚLTIMO del historial, así que con
    // `--since` esta llamada devolvería CERO y la señal de ownership
    // desaparecería sin un solo error. Con `--since-as-filter` devuelve lo que
    // toca.
    const emails = async (sinceMonths: number): Promise<string[]> =>
      (await listAuthorshipCommits(repo.path, { sinceMonths })).map((c) => c.authorEmail)

    const doceMeses = await emails(12)
    // Lo reciente sigue estando, pese al commit viejo en la punta.
    expect(doceMeses).toContain('autora@ejemplo.test')
    // Y lo de hace dos años queda fuera...
    expect(doceMeses).not.toContain('antigua@ejemplo.test')
    // ...pero entra con una ventana de 36 meses.
    expect(await emails(36)).toContain('antigua@ejemplo.test')
  }, 60_000)
})

describe('el criterio de T01, de punta a punta y contra git real', () => {
  it('quien escribió el fichero gana, y el format all no cuenta', async () => {
    const commits = await listAuthorshipCommits(repo.path, { sinceMonths: 12 })
    const resultado = computeOwnership(commits, ['src/router.ts'])

    const owners = resultado.files[0]?.owners ?? []
    expect(owners[0]?.authorEmail).toBe('autora@ejemplo.test')
    // El de las erratas tiene MÁS commits y aun así va detrás.
    const erratas = owners.find((o) => o.authorEmail === 'erratas@ejemplo.test')
    expect(erratas?.commits).toBeGreaterThan(owners[0]?.commits ?? 0)
    // Y el formateador no aparece en absoluto: su commit se descartó entero.
    expect(owners.some((o) => o.authorEmail === 'formateador@ejemplo.test')).toBe(false)
    expect(resultado.discardedByBreadth).toBe(1)
  }, 60_000)

  it('con el sha del format all en la lista de ignorados, se descarta por ESE motivo', async () => {
    // Es lo que alimentaría `.git-blame-ignore-revs`. El resultado es el mismo,
    // pero el motivo que se reporta no, y eso importa para poder explicarlo.
    const commits = await listAuthorshipCommits(repo.path, { sinceMonths: 12 })
    const resultado = computeOwnership(commits, ['src/router.ts'], {
      maxFilesPerCommit: 1000,
      ignoreShas: [shaDelReformateo],
    })

    expect(resultado.discardedByIgnoreList).toBe(1)
    expect(resultado.discardedByBreadth).toBe(0)
    expect(
      resultado.files[0]?.owners.some((o) => o.authorEmail === 'formateador@ejemplo.test'),
    ).toBe(false)
  }, 60_000)

  it('sin ninguna defensa, el format all SÍ contaminaría', async () => {
    // El contrapeso que hace medible a los otros dos tests: sin el tope ni la
    // lista de ignorados, el formateador entra en el ranking. Sin esto, los
    // tests de arriba pasarían igual aunque las defensas no hicieran nada.
    const commits = await listAuthorshipCommits(repo.path, { sinceMonths: 12 })
    const resultado = computeOwnership(commits, ['src/router.ts'], { maxFilesPerCommit: 1000 })

    expect(
      resultado.files[0]?.owners.some((o) => o.authorEmail === 'formateador@ejemplo.test'),
    ).toBe(true)
  }, 60_000)
})
