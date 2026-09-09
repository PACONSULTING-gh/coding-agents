import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Un `claude` de mentira para los tests de `ClaudeCliLlm`.
 *
 * Mismo principio que `fake-anthropic-api.ts`: no se dobla la clase que
 * estamos probando, se dobla el OTRO LADO DEL CABLE. Aqui el cable es un
 * proceso, asi que el doble es un ejecutable de verdad que Node arranca de
 * verdad: se ejercita el spawn, el paso del prompt por stdin, los codigos de
 * salida y el parseo de la salida.
 *
 * El guion escribe en `invocation.json` los argumentos y el stdin que recibio,
 * para que el test pueda comprobar COMO se le llamo —que es donde vive el
 * aislamiento— y no solo que devolvio.
 */

export interface FakeClaudeCli {
  /** Ruta del ejecutable, para pasarsela a `ClaudeCliLlm`. */
  readonly executable: string
  /** Directorio de trabajo vacio que el adaptador exige. */
  readonly cwd: string
  /** Como se le llamo la ultima vez. */
  invocation(): Promise<{ args: string[]; stdin: string }>
}

export interface FakeClaudeCliOptions {
  /** Lo que el falso CLI escribe en stdout. Objeto (se serializa) o texto crudo. */
  readonly stdout: unknown
  /** Codigo de salida. 0 si no se dice. */
  readonly exitCode?: number
  readonly stderr?: string
}

const SCRIPT = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'))

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (stdin += chunk))
process.stdin.on('end', () => {
  writeFileSync(
    join(here, 'invocation.json'),
    JSON.stringify({ args: process.argv.slice(2), stdin }),
  )
  if (config.stdout !== '') process.stdout.write(config.stdout)
  if (config.stderr !== '') process.stderr.write(config.stderr)
  process.exit(config.exitCode)
})
`

export async function startFakeClaudeCli(options: FakeClaudeCliOptions): Promise<FakeClaudeCli> {
  const root = await mkdtemp(join(tmpdir(), 'fake-claude-'))
  const executable = join(root, 'claude.mjs')
  const cwd = join(root, 'sesion')
  await mkdir(cwd)

  await writeFile(executable, SCRIPT, 'utf8')
  await chmod(executable, 0o755)
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      stdout: typeof options.stdout === 'string' ? options.stdout : JSON.stringify(options.stdout),
      stderr: options.stderr ?? '',
      exitCode: options.exitCode ?? 0,
    }),
    'utf8',
  )

  return {
    executable,
    cwd,
    invocation: async () => {
      const raw = await readFile(join(root, 'invocation.json'), 'utf8')
      return JSON.parse(raw) as { args: string[]; stdin: string }
    },
  }
}

/** Una respuesta con la forma que devuelve `claude --print --output-format json`. */
export function successPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    api_error_status: null,
    num_turns: 1,
    result: 'OK',
    usage: {
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 33,
      cache_creation_input_tokens: 44,
    },
    modelUsage: {
      'claude-haiku-4-5-20251001': { outputTokens: 3 },
      'claude-opus-5[1m]': { outputTokens: 22 },
    },
    ...overrides,
  }
}
