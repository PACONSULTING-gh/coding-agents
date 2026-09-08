import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Fitness function del criterio de aceptacion literal de T04:
 *
 *   "Dado el codigo de la aplicacion, cuando busco importaciones directas de
 *    pg-boss fuera de packages/queue/, entonces no hay ninguna."
 *
 * dependency-cruiser ya tiene la misma regla (`pg-boss-solo-en-queue`), pero
 * esta version vive con el paquete que la causa: si alguien mueve, renombra o
 * relaja la configuracion de dependency-cruiser, este test sigue fallando.
 * El criterio de aceptacion no depende de una herramienta concreta.
 */

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']
/**
 * Directorios que NO son codigo del repositorio: dependencias, salida de build
 * y areneros de herramientas. `.stryker-tmp` merece mencion aparte: Stryker
 * copia el arbol entero ahi para instrumentarlo, asi que sin excluirlo este
 * test denuncia una COPIA de packages/queue/src/pg-boss-queue.ts en una ruta
 * que no empieza por packages/queue. Es un falso positivo de artefacto, no una
 * relajacion de la regla: el fichero original se sigue comprobando.
 */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'reports',
  '.git',
  '.stryker-tmp',
])

/** El nombre del paquete, partido, para que este mismo fichero no se autodelate. */
const FORBIDDEN_MODULE = ['pg', 'boss'].join('-')

/** El unico directorio autorizado a conocer la implementacion de la cola. */
const ALLOWED_DIRECTORY = join('packages', 'queue')

const IMPORT_PATTERNS = [
  new RegExp(String.raw`from\s+['"]${FORBIDDEN_MODULE}(?:/[^'"]*)?['"]`),
  new RegExp(String.raw`import\s*\(\s*['"]${FORBIDDEN_MODULE}(?:/[^'"]*)?['"]`),
  new RegExp(String.raw`require\s*\(\s*['"]${FORBIDDEN_MODULE}(?:/[^'"]*)?['"]`),
  new RegExp(String.raw`import\s+['"]${FORBIDDEN_MODULE}(?:/[^'"]*)?['"]`),
]

/** Sube desde este fichero hasta la raiz del monorepo (la del workspace de pnpm). */
async function findRepositoryRoot(): Promise<string> {
  let current = import.meta.dirname
  for (;;) {
    const entries = await readdir(current)
    if (entries.includes('pnpm-workspace.yaml')) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new Error('No se encontro la raiz del monorepo (pnpm-workspace.yaml)')
    }
    current = parent
  }
}

async function collectSourceFiles(root: string, directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue
      }
      found.push(...(await collectSourceFiles(root, fullPath)))
      continue
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      continue
    }
    const relativePath = relative(root, fullPath)
    if (relativePath === ALLOWED_DIRECTORY || relativePath.startsWith(ALLOWED_DIRECTORY + sep)) {
      continue
    }
    found.push(relativePath)
  }
  return found
}

describe('fitness function: pg-boss no se filtra fuera de packages/queue', () => {
  it('encuentra ficheros que revisar (la busqueda no esta rota)', async () => {
    const root = await findRepositoryRoot()
    const files = await collectSourceFiles(root, root)
    // Si esto fuese 0, el test pasaria siempre sin comprobar nada.
    expect(files.length).toBeGreaterThan(5)
  })

  it('no hay ni un import del motor de cola fuera de packages/queue', async () => {
    const root = await findRepositoryRoot()
    const files = await collectSourceFiles(root, root)

    const offenders: string[] = []
    for (const file of files) {
      const content = await readFile(join(root, file), 'utf8')
      const lines = content.split('\n')
      for (const [index, line] of lines.entries()) {
        if (IMPORT_PATTERNS.some((pattern) => pattern.test(line))) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
