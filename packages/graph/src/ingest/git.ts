import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { ValidationError } from '@coord/core'

/**
 * Lo poco que hace falta de git, con `node:child_process` de la stdlib y CERO
 * dependencias nuevas (CLAUDE.md 2.4, peldano 3): git ya es un requisito duro
 * del proyecto.
 *
 * Se usa `execFile` con los argumentos en un array, NUNCA `exec` con una cadena:
 * no hay shell de por medio, asi que una ruta con espacios, comillas o `;` no
 * puede convertirse en otro comando. `git -C <ruta>` en vez de cambiar el `cwd`
 * del proceso, que es estado global y no sobrevive a la concurrencia.
 */
const run = promisify(execFile)

/** 64 MiB: un repo con ~500.000 ficheros cabe. Si no cabe, falla en voz alta. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/

/**
 * Ficheros seguidos por git, con rutas relativas a la raiz del repo.
 *
 * `git ls-files` respeta `.gitignore` GRATIS —lo ignorado no esta seguido— y
 * ademas excluye lo que no esta en el indice, que es justo lo que no queremos
 * indexar. `-z` separa por NUL: es el unico separador que no puede aparecer
 * dentro de un nombre de fichero.
 */
export async function listTrackedFiles(repoPath: string): Promise<string[]> {
  const { stdout } = await run('git', ['-C', repoPath, 'ls-files', '-z'], {
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf8',
  })
  return stdout.split('\0').filter((path) => path !== '')
}

/** SHA del commit al que apunta HEAD. */
export async function resolveHeadCommit(repoPath: string): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  })
  const sha = stdout.trim()
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    // La columna `graph_ingestions.commit_sha` tiene el mismo CHECK: mejor
    // fallar aqui, con el valor delante, que con un error del motor.
    throw new ValidationError(`git rev-parse HEAD devolvio algo que no es un sha: ${sha}`)
  }
  return sha
}
