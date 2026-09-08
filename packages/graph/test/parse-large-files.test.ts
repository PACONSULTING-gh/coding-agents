import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parserForPath } from '../src/parse/index.js'

/**
 * REGRESION de un fallo que encontro el gate del epic 02 indexando ESTE repo, y
 * que ningun test de la tarea vio: la ingesta abortaba entera con
 * `Error: Invalid argument` al llegar a un fichero de mas de 32 KiB.
 *
 * Causa: el binding nativo de tree-sitter 0.21 reserva 32 KiB de buffer por
 * defecto. Medido: 32.767 caracteres pasan, 32.768 falla. El culpable era
 * `packages/graph/src/claims.ts` (34.665 bytes), escrito por el propio epic.
 *
 * Los tests de parseo usaban ficheros de ejemplo pequenos, asi que el limite no
 * aparecia nunca. Este test lo fija con margen.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Justo por encima del limite del binding, y bastante por encima. */
const SIZES = [32_768, 64_000, 200_000]

describe('parseo de ficheros grandes', () => {
  it.each(SIZES)('parsea TypeScript de %i caracteres sin reventar', (size) => {
    const parser = parserForPath('big.ts')
    expect(parser).toBeDefined()

    // Relleno con codigo real, no espacios: el limite es de bytes de entrada, y
    // ademas asi comprobamos que el arbol resultante sirve para algo.
    const filler = 'export function f%i(): number {\n  return %i\n}\n'
    let source = "import { a } from './dep.js'\n"
    let i = 0
    while (source.length < size) {
      source += filler.replaceAll('%i', String(i++))
    }

    const parsed = parser!.parse(source, 'src/big.ts')
    // El import sigue detectandose al final del fichero grande: si el buffer se
    // hubiera quedado corto en silencio, el arbol estaria truncado.
    expect(parsed.imports.map((imp) => imp.specifier)).toContain('./dep.js')
    expect(parsed.symbols.length).toBeGreaterThan(10)
  })

  it('parsea Python de mas de 32 KiB', () => {
    const parser = parserForPath('big.py')
    expect(parser).toBeDefined()
    let source = 'import os\n'
    let i = 0
    while (source.length < 40_000) {
      source += `def f${String(i++)}():\n    return os.getcwd()\n`
    }
    const parsed = parser!.parse(source, 'src/big.py')
    expect(parsed.imports.map((imp) => imp.specifier)).toContain('os')
  })

  it('parsea el fichero real mas grande de packages/graph/src', async () => {
    // El caso exacto que rompio el gate. Si manana alguien escribe uno mayor,
    // este test lo cubre solo.
    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.name.endsWith('.ts')) files.push(full)
      }
    }
    await walk(SRC_DIR)

    const sources = await Promise.all(
      files.map(async (f) => ({ f, source: await readFile(f, 'utf8') })),
    )
    const biggest = sources.reduce((a, b) => (b.source.length > a.source.length ? b : a))

    const parser = parserForPath(biggest.f)
    expect(parser).toBeDefined()
    expect(() => parser!.parse(biggest.source, biggest.f)).not.toThrow()
  })

  it('ningun parser llama a parser.parse directo: todos pasan por parseSource', async () => {
    // Fitness function del arreglo. El bug vuelve en cuanto alguien anade un
    // cuarto lenguaje copiando el patron antiguo, y un test de comportamiento no
    // lo detectaria hasta que ese lenguaje tuviera un fichero de 32 KiB.
    const parseDir = join(SRC_DIR, 'parse')
    const offenders: string[] = []
    for (const entry of await readdir(parseDir)) {
      if (!entry.endsWith('.ts') || entry === 'tree-sitter-buffer.ts') continue
      const source = await readFile(join(parseDir, entry), 'utf8')
      // `.parse(` precedido de algo que no sea `parseSource(` ni un esquema zod.
      for (const line of source.split('\n')) {
        if (/\b(?:parser|Parser|\w*[Pp]arser\(\))\s*\.parse\s*\(/.test(line)) {
          offenders.push(`${entry}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
