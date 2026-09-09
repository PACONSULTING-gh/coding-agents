import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, posix, sep } from 'node:path'

import {
  EMPTY_GENERATED_TESTS_MANIFEST,
  GENERATED_TESTS_MANIFEST_PATH,
  GENERATED_TESTS_SEGMENT,
  GENERATED_TESTS_SIGNING_KEY_ENV,
  parseManifest,
  serializeManifest,
  signManifest,
  upsertTaskManifest,
  verifyGeneratedTests,
  type GeneratedTestsManifest,
  type GeneratedTestsVerification,
  type SignedGeneratedTestsManifest,
} from './test-manifest.js'
import type { TestGenerationResult } from './test-generator.js'

/**
 * La capa de E/S del manifiesto: leer lo que hay en disco, escribir lo que
 * genero el generador, y nada mas.
 *
 * Se separa de `test-manifest.ts` a proposito para que la LOGICA de deteccion
 * —la que decide si algo se manipulo— sea una funcion pura sobre datos y se
 * pueda ejercitar sin disco. Aqui solo se recogen ficheros y se escriben.
 *
 * Este modulo NO lo importa `test-generator.ts`. Si lo importara, el generador
 * tendria un camino hacia `node:fs` y el primer criterio de aceptacion de T02
 * dejaria de cumplirse por construccion.
 */

/** Los dos arboles donde puede haber un `test/generated/`. */
const WORKSPACE_ROOTS = ['packages', 'apps'] as const

/** Ruta relativa al repositorio, siempre con `/`, tambien en Windows. */
function toRepoRelative(repoRoot: string, absolute: string): string {
  return absolute
    .slice(repoRoot.length + 1)
    .split(sep)
    .join(posix.sep)
}

async function listDirectory(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    // ENOENT es la respuesta legitima a "todavia no hay tests generados". Se
    // distingue por su codigo y CUALQUIER otro error se propaga: un EACCES
    // tragado aqui haria que el gate no encontrase ficheros y diese verde.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function collectFilesUnder(
  repoRoot: string,
  directory: string,
  into: Map<string, string>,
): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectFilesUnder(repoRoot, absolute, into)
    } else if (entry.isFile()) {
      into.set(toRepoRelative(repoRoot, absolute), await readFile(absolute, 'utf8'))
    }
  }
}

/**
 * Todo lo que hay en disco bajo un `<paquete>/test/generated/`, por ruta
 * relativa al repositorio.
 *
 * Recoge TODOS los ficheros, no solo los `.test.ts`: un fichero cualquiera
 * colado en el arbol del generador tiene que salir como `untracked`, y si el
 * recolector lo filtrase, no saldria.
 */
export async function collectGeneratedTestsOnDisk(
  repoRoot: string,
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>()
  for (const workspaceRoot of WORKSPACE_ROOTS) {
    const base = join(repoRoot, workspaceRoot)
    for (const packageName of await listDirectory(base)) {
      await collectFilesUnder(
        repoRoot,
        join(base, packageName, ...GENERATED_TESTS_SEGMENT.split('/')),
        found,
      )
    }
  }
  return found
}

/** El manifiesto en disco, o `undefined` si todavia no existe ninguno. */
export async function readGeneratedTestsManifest(
  repoRoot: string,
): Promise<SignedGeneratedTestsManifest | undefined> {
  const path = join(repoRoot, ...GENERATED_TESTS_MANIFEST_PATH.split('/'))
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return parseManifest(text)
}

export async function writeGeneratedTestsManifest(
  repoRoot: string,
  signed: SignedGeneratedTestsManifest,
): Promise<void> {
  const path = join(repoRoot, ...GENERATED_TESTS_MANIFEST_PATH.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, serializeManifest(signed), 'utf8')
}

/** La clave de firma, del entorno. Nunca del repositorio (CLAUDE.md 5). */
export function readSigningKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env[GENERATED_TESTS_SIGNING_KEY_ENV]
  return key === undefined || key.trim() === '' ? undefined : key
}

export interface WriteGeneratedTestsInput {
  readonly repoRoot: string
  readonly result: TestGenerationResult
  /** Sin clave el manifiesto se escribe SIN firmar, y el CI lo dira. */
  readonly signingKey?: string | undefined
}

/**
 * Escribe los ficheros generados y actualiza el manifiesto.
 *
 * Es la unica via legitima de tocar el arbol del generador. Cualquier otra
 * escritura ahi acaba saliendo como `modified` o `untracked` en el gate, que es
 * precisamente el punto.
 */
export async function writeGeneratedTests(input: WriteGeneratedTestsInput): Promise<void> {
  for (const file of input.result.files) {
    const absolute = join(input.repoRoot, ...file.path.split('/'))
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, file.contents, 'utf8')
  }

  const existing = await readGeneratedTestsManifest(input.repoRoot)
  const base: GeneratedTestsManifest = existing?.manifest ?? EMPTY_GENERATED_TESTS_MANIFEST
  const updated = upsertTaskManifest(base, input.result.manifest)
  await writeGeneratedTestsManifest(
    input.repoRoot,
    input.signingKey === undefined
      ? { manifest: updated }
      : signManifest(updated, input.signingKey),
  )
}

export interface VerifyOnDiskInput {
  readonly repoRoot: string
  readonly signingKey?: string | undefined
  readonly currentCriteriaHashes?: ReadonlyMap<string, string> | undefined
}

export interface OnDiskVerification extends GeneratedTestsVerification {
  /** `false` cuando todavia no hay manifiesto: no hay nada generado que proteger. */
  readonly manifestPresent: boolean
}

/**
 * La comprobacion completa contra el arbol de trabajo. Es lo que corre el CI
 * (via `verify-generated-tests-cli.ts`) y lo que avisa el hook de pre-commit.
 */
export async function verifyGeneratedTestsOnDisk(
  input: VerifyOnDiskInput,
): Promise<OnDiskVerification> {
  const signed = await readGeneratedTestsManifest(input.repoRoot)
  const filesOnDisk = await collectGeneratedTestsOnDisk(input.repoRoot)

  if (signed === undefined) {
    // Todavia no se ha generado nada. Pero si hay ficheros en el arbol del
    // generador y no hay manifiesto, alguien los puso a mano: eso NO es "nada
    // que comprobar", es un hallazgo.
    const findings = [...filesOnDisk.keys()].map((path) => ({
      kind: 'untracked' as const,
      path,
      taskRef: undefined,
      detail:
        `Hay ficheros bajo ${GENERATED_TESTS_SEGMENT} y no existe ` +
        `${GENERATED_TESTS_MANIFEST_PATH}. El arbol es propiedad del generador: nadie mas ` +
        'escribe ahi.',
    }))
    return {
      manifestPresent: false,
      ok: findings.length === 0,
      signatureChecked: false,
      filesChecked: filesOnDisk.size,
      findings,
    }
  }

  return {
    manifestPresent: true,
    ...verifyGeneratedTests({
      signed,
      filesOnDisk,
      signingKey: input.signingKey,
      currentCriteriaHashes: input.currentCriteriaHashes,
    }),
  }
}
