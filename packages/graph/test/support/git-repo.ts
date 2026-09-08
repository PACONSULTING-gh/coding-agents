import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Repositorios git DE VERDAD para los tests, en un directorio temporal.
 *
 * Nada de dobles de `git log` ni de un `listTrackedFiles` falso (CLAUDE.md 5:
 * nada de mocks de lo que no controlas). Lo que la ingesta tiene que aguantar
 * es git, con su indice, su `.gitignore` y sus rutas reales; un doble solo
 * demostraria que el doble hace lo que le hemos dicho.
 *
 * La configuracion de usuario se pasa por `-c` en cada commit: asi el test no
 * depende de la configuracion global de quien lo ejecute ni la modifica.
 */
const DEFAULT_AUTHOR = { name: 'Tests', email: 'tests@example.invalid' }

function identityFlags(author: { name: string; email: string }): string[] {
  return [
    '-c',
    `user.email=${author.email}`,
    '-c',
    `user.name=${author.name}`,
    '-c',
    'commit.gpgsign=false',
  ]
}

export interface TempRepo {
  /** Ruta absoluta al repositorio. */
  readonly path: string
  write(relative: string, content: string): Promise<void>
  remove(relative: string): Promise<void>
  /** Confirma todo lo que haya y devuelve el sha del commit. Autor por defecto: `DEFAULT_AUTHOR`. */
  commit(message: string, author?: { name: string; email: string }): Promise<string>
  cleanup(): Promise<void>
}

function repoAt(root: string): TempRepo {
  return {
    path: root,

    async write(relative: string, content: string): Promise<void> {
      const absolute = path.join(root, relative)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, content, 'utf8')
    },

    async remove(relative: string): Promise<void> {
      await rm(path.join(root, relative))
    },

    async commit(message: string, author = DEFAULT_AUTHOR): Promise<string> {
      await run('git', ['-C', root, 'add', '-A'])
      await run('git', ['-C', root, ...identityFlags(author), 'commit', '-q', '-m', message])
      const { stdout } = await run('git', ['-C', root, 'rev-parse', 'HEAD'])
      return stdout.trim()
    },

    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function createTempRepo(prefix: string): Promise<TempRepo> {
  const root = await mkdtemp(path.join(tmpdir(), `coord-graph-${prefix}-`))
  await run('git', ['-C', root, 'init', '-q', '-b', 'main'])
  return repoAt(root)
}

/**
 * Igual que `createTempRepo`, pero en una ruta EXACTA en vez de un directorio
 * generado. Existe para los tests de `who_last_touched` (T05): necesitan que
 * el repo viva en `<GRAPH_CHECKOUT_ROOT>/<owner>/<repo>`, la misma forma que
 * usa `resolveCheckoutPath` en produccion, y no una ruta aleatoria.
 */
export async function createTempRepoAt(root: string): Promise<TempRepo> {
  await mkdir(root, { recursive: true })
  await run('git', ['-C', root, 'init', '-q', '-b', 'main'])
  return repoAt(root)
}
