import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Lo que el daemon mira en la maquina para enriquecer el latido (epic 04 /
 * T02, issue #61).
 *
 * ===========================================================================
 * "ULTIMO CAMBIO EN FICHEROS" ES EL TRABAJO SIN COMMITEAR
 * ===========================================================================
 * Se podria medir de varias formas y casi todas mienten:
 *
 *   - El mtime mas reciente de TODO el arbol incluye ficheros que toco un
 *     `pnpm install` o el propio editor al guardar sin cambiar nada.
 *   - La fecha del ultimo commit dice cuando se guardo, no cuando se trabajo:
 *     un agente que lleva una hora escribiendo sin commitear saldria como
 *     parado desde hace una hora.
 *
 * Lo que de verdad responde a "¿esta produciendo algo?" es el fichero mas
 * recientemente tocado DE ENTRE LOS QUE DIFIEREN DE HEAD. Si no hay ninguno, no
 * hay trabajo en curso, y eso se dice devolviendo `undefined` en vez de una
 * fecha cualquiera.
 *
 * Y aqui NO se interpreta nada: esto recoge, y clasificar es de
 * `classifyAgentActivity`. Un recolector que ademas opinara haria imposible
 * cambiar la politica sin tocar el daemon de cinco maquinas.
 */

export interface DaemonTelemetry {
  /** En que tarea dice el daemon que esta. Viene de su configuracion. */
  readonly taskRef?: string
  /** Rama actual. `undefined` si el repo esta en HEAD suelto o no es un repo. */
  readonly branch?: string
  /** Instante del fichero sin commitear tocado mas recientemente. */
  readonly lastFileChangeAt?: Date
  /** Cuantos ficheros difieren de HEAD. Cero es un dato, no un hueco. */
  readonly dirtyFileCount: number
}

async function git(repoPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], { maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

/**
 * Los ficheros que difieren de HEAD, incluidos los que git no sigue todavia.
 *
 * `-z` y no lineas: un nombre de fichero puede llevar saltos de linea, y
 * partir por `\n` convertiria un fichero raro en dos rutas que no existen.
 */
export function parsePorcelain(stdout: string): readonly string[] {
  return (
    stdout
      .split('\0')
      .filter((entrada) => entrada.length > 3)
      // El formato es `XY <ruta>`: dos codigos de estado y un espacio.
      .map((entrada) => entrada.slice(3))
      .filter((ruta) => ruta !== '')
  )
}

/**
 * El mas reciente de los `mtime`. `undefined` si no hay ninguno.
 *
 * Un fichero que desaparece entre el `git status` y el `stat` —el agente lo
 * borro justo ahora— se IGNORA en vez de tumbar el latido. Que el daemon deje
 * de latir porque alguien borro un fichero seria absurdo: el latido es
 * precisamente lo que dice que la maquina sigue viva.
 */
async function mostRecentMtime(
  repoPath: string,
  rutas: readonly string[],
): Promise<Date | undefined> {
  let masReciente: number | undefined

  for (const ruta of rutas) {
    try {
      const info = await stat(join(repoPath, ruta))
      const ms = info.mtimeMs
      if (masReciente === undefined || ms > masReciente) masReciente = ms
    } catch {
      // Ver arriba: desaparecio entre medias. No es un fallo del daemon.
      continue
    }
  }

  return masReciente === undefined ? undefined : new Date(masReciente)
}

export interface CollectTelemetryInput {
  readonly repoPath: string
  readonly taskRef?: string
}

export async function collectTelemetry(input: CollectTelemetryInput): Promise<DaemonTelemetry> {
  const [ramaCruda, estadoCrudo] = await Promise.all([
    git(input.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    git(input.repoPath, ['status', '--porcelain=v1', '-z']).catch(() => ''),
  ])

  // `HEAD` literal significa que no hay rama (detached). No es una rama llamada
  // "HEAD", y decir que lo es mandaria a alguien a buscarla.
  const rama = ramaCruda.trim()
  const branch = rama === '' || rama === 'HEAD' ? undefined : rama

  const sucios = parsePorcelain(estadoCrudo)
  const lastFileChangeAt = await mostRecentMtime(input.repoPath, sucios)

  return {
    ...(input.taskRef === undefined ? {} : { taskRef: input.taskRef }),
    ...(branch === undefined ? {} : { branch }),
    ...(lastFileChangeAt === undefined ? {} : { lastFileChangeAt }),
    dirtyFileCount: sucios.length,
  }
}
