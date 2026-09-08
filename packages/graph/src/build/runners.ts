import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * Invocacion real de las CLIs de Nx y Turborepo, con `execFile` (array de
 * argumentos, sin shell de por medio — mismo motivo que `ingest/git.ts`).
 *
 * Estas dos funciones NO tienen test: harian falta Nx o Turborepo instalados
 * de verdad en un repositorio fixture, y eso es exactamente lo que el epic
 * pide EVITAR ("un `nx graph` de mentira... fixture, no un mock del comando").
 * Lo que si tiene test es todo lo que hacen `nx.ts` y `turborepo.ts` con el
 * JSON que estas funciones producen: la validacion y la normalizacion. Esta
 * frontera —comando sin test, parseo con test exhaustivo— es deliberada, y se
 * deja escrita aqui para que quien la lea no la confunda con un descuido.
 *
 * `--no-install` en las dos: si la herramienta no esta instalada en el repo
 * que se esta ingiriendo, falla al momento con un mensaje claro, en vez de
 * intentar una instalacion por red desde un proceso de ingesta.
 */
const run = promisify(execFile)

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** Ejecuta `nx graph --file=...` en `repoPath` y devuelve el JSON ya parseado. */
export async function runNxGraph(repoPath: string): Promise<unknown> {
  const dir = await mkdtemp(path.join(tmpdir(), 'coord-graph-nx-'))
  const outFile = path.join(dir, 'graph.json')
  try {
    await run('npx', ['--no-install', 'nx', 'graph', `--file=${outFile}`], {
      cwd: repoPath,
      maxBuffer: MAX_OUTPUT_BYTES,
    })
    const content = await readFile(outFile, 'utf8')
    return JSON.parse(content) as unknown
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Ejecuta `turbo query <query>` en `repoPath` y devuelve el JSON ya parseado. */
export async function runTurboQuery(repoPath: string, query: string): Promise<unknown> {
  const { stdout } = await run('npx', ['--no-install', 'turbo', 'query', query], {
    cwd: repoPath,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf8',
  })
  return JSON.parse(stdout) as unknown
}
