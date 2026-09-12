import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { ValidationError } from '@coord/core'

const run = promisify(execFile)

/**
 * Leer una ENTREGA de un repositorio git local: el diff y la salida de sus
 * tests. Es lo unico que le faltaba al lazo de verificacion de T06 para poder
 * girar de verdad.
 *
 * Hasta ahora `completeVerificationPass` sabia clasificar unos hechos y hacerlos
 * avanzar, pero NADIE podia producir esos hechos: no habia de donde sacar el
 * diff de una entrega ni la salida de sus tests. De git salen los dos.
 *
 * ===========================================================================
 * ESTO NO CONOCE AL VERIFIER, Y ES A PROPOSITO
 * ===========================================================================
 * Devuelve el diff y la evidencia de tests, y nada mas. No monta el
 * `VerificationInput`, porque eso necesita ademas los criterios aprobados, que
 * viven en la base de datos. Quien componga las dos cosas es la raiz de
 * composicion; este modulo solo sabe de git.
 *
 * ===========================================================================
 * `execFile` CON ARGUMENTOS EN ARRAY, NUNCA `exec` CON UNA CADENA
 * ===========================================================================
 * Mismo patron que `ownership/git.ts` y `cochange/git.ts`, y por el mismo
 * motivo: una rama llamada `x; rm -rf /` es un nombre de rama perfectamente
 * valido en git.
 */

/**
 * Tope del diff que se acepta.
 *
 * 256 KiB son del orden de 60-70 mil tokens: cabe en el prompt del Verifier con
 * sitio para los criterios y la salida de tests. Por encima NO SE TRUNCA, se
 * lanza: media entrega verificada con un veredicto de APTO es peor que ninguna,
 * porque el humano lee "apto" y no sabe que la otra mitad no la miro nadie.
 */
export const MAX_DIFF_BYTES = 256 * 1024

/** Tope de captura de la salida de los tests. Generoso: una suite habla mucho. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export interface TestRunEvidence {
  /** El comando tal como se ejecuto, para que el informe pueda citarlo. */
  readonly command: string
  /** Codigo de salida. 0 no basta como prueba, pero es un dato. */
  readonly exitCode: number
  /** stdout + stderr, literal. */
  readonly output: string
}

export interface Delivery {
  /** Donde empieza lo entregado: el ancestro comun, NO la punta de la base. */
  readonly baseSha: string
  readonly headSha: string
  readonly diff: string
  readonly testRun: TestRunEvidence
}

export interface DeliveryRequest {
  /** Ruta al repositorio git local. */
  readonly repoPath: string
  /** Rama o sha contra el que se entrega, normalmente `main`. */
  readonly baseRef: string
  /** Lo entregado. */
  readonly headRef: string
  /** Comando de tests, EN ARRAY. `['pnpm', 'test']`, nunca `'pnpm test'`. */
  readonly testCommand: readonly string[]
  readonly maxDiffBytes?: number
}

/**
 * Una ref que empieza por `-` la lee git como una OPCION, no como una rama.
 * `--output=/etc/passwd` es un nombre de rama sintacticamente valido.
 */
function assertRefIsUsable(ref: string, campo: string): void {
  const limpia = ref.trim()
  if (limpia === '') {
    throw new ValidationError(`readDelivery necesita un \`${campo}\` no vacio.`)
  }
  if (limpia.startsWith('-')) {
    throw new ValidationError(
      `El \`${campo}\` ${JSON.stringify(ref)} empieza por "-", y git lo leeria como una opcion ` +
        'en vez de como una referencia. Se rechaza antes de llegar al proceso.',
    )
  }
}

async function git(repoPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], { maxBuffer: MAX_OUTPUT_BYTES })
  return stdout
}

export async function readDelivery(request: DeliveryRequest): Promise<Delivery> {
  assertRefIsUsable(request.baseRef, 'baseRef')
  assertRefIsUsable(request.headRef, 'headRef')
  const [comando, ...argumentos] = request.testCommand
  if (comando === undefined) {
    throw new ValidationError(
      'readDelivery necesita un `testCommand`. Sin salida de tests el Verifier solo puede mirar ' +
        'el diff, y un criterio que se demuestra corriendo los tests quedaria en SIN_EVIDENCIA ' +
        'por falta del dato, no por falta del trabajo.',
    )
  }

  const maxDiffBytes = request.maxDiffBytes ?? MAX_DIFF_BYTES
  if (!Number.isInteger(maxDiffBytes) || maxDiffBytes < 1) {
    throw new ValidationError(
      `maxDiffBytes tiene que ser un entero >= 1 y se recibio ${String(maxDiffBytes)}.`,
    )
  }

  const headSha = (await git(request.repoPath, ['rev-parse', request.headRef])).trim()

  // EL ANCESTRO COMUN, no la punta de la base.
  //
  // Si se hiciera `diff main..head` con `main` ya avanzado, el diff incluiria el
  // trabajo que OTROS han mergeado mientras tanto, y el Verifier juzgaria codigo
  // que este agente no escribio. Un FAIL sobre codigo ajeno manda al agente a
  // arreglar algo que no es suyo, y le gasta un intento.
  const baseSha = (
    await git(request.repoPath, ['merge-base', request.baseRef, request.headRef])
  ).trim()

  const diff = await git(request.repoPath, ['diff', '--no-color', `${baseSha}..${headSha}`])

  if (diff.trim() === '') {
    throw new ValidationError(
      `No hay ningun cambio entre ${baseSha.slice(0, 8)} y ${headSha.slice(0, 8)}. Una entrega ` +
        'vacia no es una entrega: verificarla daria un informe de conformidad sobre la nada, y ' +
        'ese informe se puede usar para aprobar un merge.',
    )
  }

  const bytes = Buffer.byteLength(diff, 'utf8')
  if (bytes > maxDiffBytes) {
    // NO se trunca. Ver la cabecera de MAX_DIFF_BYTES.
    throw new ValidationError(
      `El diff ocupa ${String(bytes)} bytes y el tope son ${String(maxDiffBytes)}. No se trunca a ` +
        'proposito: media entrega verificada con un veredicto de APTO es peor que ninguna. Parte ' +
        'la tarea, o sube el tope a sabiendas.',
    )
  }

  return {
    baseSha,
    headSha,
    diff,
    testRun: await runTests(request.repoPath, comando, argumentos),
  }
}

/**
 * Corre los tests y devuelve su salida ENTERA, pase lo que pase.
 *
 * Un codigo de salida distinto de cero NO es un error de esta funcion: es el
 * dato. El Verifier necesita ver los tests en rojo para poder decir FAIL, y el
 * gate determinista necesita el codigo para decidir. Lanzar aqui convertiria
 * "los tests fallan" en "no se pudo verificar", que son cosas muy distintas y
 * con destinos distintos en el flujo de T06.
 */
async function runTests(
  repoPath: string,
  comando: string,
  argumentos: readonly string[],
): Promise<TestRunEvidence> {
  const command = [comando, ...argumentos].join(' ')

  try {
    const { stdout, stderr } = await run(comando, argumentos, {
      cwd: repoPath,
      maxBuffer: MAX_OUTPUT_BYTES,
    })
    return { command, exitCode: 0, output: `${stdout}${stderr}` }
  } catch (error) {
    // `execFile` rechaza cuando el codigo no es 0, y adjunta la salida.
    const fallo = error as { code?: unknown; stdout?: unknown; stderr?: unknown }
    const exitCode = typeof fallo.code === 'number' ? fallo.code : 1
    const stdout = typeof fallo.stdout === 'string' ? fallo.stdout : ''
    const stderr = typeof fallo.stderr === 'string' ? fallo.stderr : ''

    if (stdout === '' && stderr === '') {
      // Ni salida ni nada: esto no es "los tests fallaron", es que el comando no
      // llego a correr —no existe, permisos, cwd mal—. Propagarlo, porque
      // devolver `exitCode: 1` con salida vacia se leeria como una suite en
      // rojo y mandaria al agente a arreglar un fallo que no existe.
      throw error
    }
    return { command, exitCode, output: `${stdout}${stderr}` }
  }
}
