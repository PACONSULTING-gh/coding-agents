import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { ValidationError } from '@coord/core'
import { z } from 'zod'

/**
 * Manifiesto firmado de los tests generados (T02, epic 05).
 *
 * ===========================================================================
 * QUE PROTEGE ESTO Y QUE NO. LEELO ENTERO ANTES DE CITARLO COMO UN GATE.
 * ===========================================================================
 * El segundo criterio de aceptacion de T02 dice: "dado el agente implementador,
 * cuando intenta modificar ficheros de test, entonces el intento se bloquea y
 * se registra".
 *
 * Hay que decir en voz alta lo que NO se puede hacer, porque fingir lo
 * contrario seria exactamente la clase de gate que parece puesto y no lo esta:
 *
 *   UN AGENTE QUE CORRE EN LA MAQUINA DEL DESARROLLADOR PUEDE ESCRIBIR EN
 *   CUALQUIER FICHERO AL QUE LLEGUE SU USUARIO. No hay forma, desde dentro del
 *   proceso, de impedirselo. Ni permisos de fichero (los puede cambiar), ni un
 *   hook de git (`--no-verify` lo salta), ni una comprobacion en el propio
 *   agente (la puede editar).
 *
 * Lo que si se puede hacer, y es lo unico que de verdad protege, es DETECTARLO
 * de forma determinista y bloquear la INTEGRACION. Por eso el mecanismo tiene
 * tres piezas, y solo una es una barrera:
 *
 *   1. UNA RUTA CONVENIDA. Los tests generados viven en `<paquete>/test/generated/`
 *      (ver `GENERATED_TESTS_SEGMENT`). Cualquier cambio en ese arbol es
 *      sospechoso por definicion, sin tener que adivinar la intencion.
 *   2. UN MANIFIESTO FIRMADO con el sha256 de cada fichero generado. El CI lo
 *      comprueba: si un fichero cambio sin regenerarse, el hash no cuadra y el
 *      gate lo caza. ESTA ES LA BARRERA. Y solo lo es de verdad cuando hay
 *      clave de firma, porque sin clave un agente puede reescribir el
 *      manifiesto junto con el test y quedarse con los hashes cuadrados; con
 *      clave no puede, porque la clave no esta en el repositorio ni en su
 *      maquina — vive en el CI (ver `signatureChecked` mas abajo, y el aviso
 *      que el CLI imprime cuando falta).
 *   3. UN HOOK DE PRE-COMMIT. **Es un AVISO, no una barrera.** Se salta con
 *      `git commit --no-verify` y lo puede saltar cualquier agente. Esta para
 *      que el desarrollador honesto se entere pronto, no para detener a nadie.
 *
 * Dicho de otro modo: el hook avisa, el CI bloquea, y el registro del intento
 * lo escribe `tamper-audit.ts` en `audit_log`.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTE MODULO NO TOCA EL DISCO NI LA BASE DE DATOS
 * ---------------------------------------------------------------------------
 * Todo aqui es una funcion pura sobre datos que le pasa el llamante. La E/S
 * esta en `generated-tests-fs.ts` y el registro en `tamper-audit.ts`. Asi la
 * comprobacion que corre el CI —que es la que importa— se puede ejercitar
 * entera sin Postgres y sin Docker, que es justo lo que el job de CI tiene
 * disponible.
 */

// ---------------------------------------------------------------------------
// La ruta convenida
// ---------------------------------------------------------------------------

/**
 * Segmento que marca un directorio como propiedad del generador.
 *
 * Los tests generados viven DENTRO del paquete que prueban
 * (`packages/db/test/generated/...`) y no en un arbol aparte en la raiz por un
 * motivo muy concreto: el `vitest.config.ts` de la raiz declara
 * `projects: ['packages/*', 'apps/*']`. Un `tests/generated/` colgando de la
 * raiz NO lo ejecutaria nadie, y un test generado que no se ejecuta es peor que
 * no tenerlo, porque parece cobertura.
 */
export const GENERATED_TESTS_SEGMENT = 'test/generated'

/** Donde vive el manifiesto, relativo a la raiz del repositorio. */
export const GENERATED_TESTS_MANIFEST_PATH = 'verification/generated-tests.manifest.json'

/** Variable de entorno de la que sale la clave HMAC. Jamas del repositorio. */
export const GENERATED_TESTS_SIGNING_KEY_ENV = 'GENERATED_TESTS_MANIFEST_KEY'

export const GENERATED_TESTS_MANIFEST_VERSION = 1

/**
 * Forma exacta de la ruta de un test generado, anclada por los dos extremos.
 *
 * Se valida con una lista de caracteres permitida y no rechazando `..`: una
 * lista permitida no tiene agujeros que descubrir despues. Ningun segmento
 * puede ser `..` porque todo segmento empieza por letra o cifra.
 */
export const GENERATED_TEST_PATH_PATTERN =
  /^(packages|apps)\/[a-z0-9][a-z0-9-]*\/test\/generated\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.test\.ts$/

/**
 * Frontera de confianza: la ruta la propone un MODELO, asi que puede venir con
 * `../../`, con una ruta absoluta o apuntando a un test escrito a mano. Se
 * rechaza en el generador, antes de escribir nada.
 */
export function assertGeneratedTestPath(path: string): void {
  if (!GENERATED_TEST_PATH_PATTERN.test(path)) {
    throw new ValidationError(
      `La ruta ${JSON.stringify(path)} no es una ruta de test generado. Tiene que ser ` +
        `\`packages/<paquete>/${GENERATED_TESTS_SEGMENT}/<nombre>.test.ts\` (o \`apps/<app>/...\`), ` +
        'relativa a la raiz del repositorio y sin `..`. Fuera de ese arbol el manifiesto no ' +
        'protege nada y el gate no puede distinguir un test generado de uno escrito a mano.',
    )
  }
}

/**
 * Forma permitida de una referencia de tarea. LISTA PERMITIDA, no lista negra.
 *
 * No es cosmetica: `taskRef` se INTERPOLA LITERALMENTE en el system prompt del
 * generador (`test-generator.ts`) y en el del Verifier (`verifier.ts`). Una
 * cadena libre ahi es un canal por el que se le puede colar al modelo texto que
 * no son criterios de aceptacion — desde la implementacion que el generador no
 * debe ver hasta instrucciones dirigidas al Verifier. Sin espacios, sin saltos
 * de linea y con tope de longitud, no cabe un parrafo.
 *
 * Acepta el numero de issue ("21") y el slug ("epic-05-t01", "epic-05/t01").
 * NO acepta `#`: la clave canonica de un issue es el numero pelado, igual que
 * en `packages/graph/src/claims.ts` (`issueKeySchema`).
 */
export const TASK_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/

/**
 * Paquete destino, con la misma forma que el prefijo de
 * `GENERATED_TEST_PATH_PATTERN`. Tambien se interpola en el system prompt, y
 * ademas decide DONDE se escribe: dos motivos para que sea una lista permitida.
 */
export const TARGET_PACKAGE_PATTERN = /^(packages|apps)\/[a-z0-9][a-z0-9-]*$/

/** Frontera de confianza: lanza si la referencia de tarea no tiene la forma permitida. */
export function assertTaskRef(taskRef: string): void {
  if (!TASK_REF_PATTERN.test(taskRef)) {
    throw new ValidationError(
      `La referencia de tarea ${JSON.stringify(taskRef)} no tiene la forma permitida ` +
        '(numero de issue o slug: letras, cifras, `.`, `_`, `/` y `-`, hasta 64 caracteres, sin ' +
        '`#` y sin espacios). Este valor se interpola tal cual en el prompt del modelo: una ' +
        'cadena libre ahi es un canal de entrada que ningun campo con nombre declara.',
    )
  }
}

/** Frontera de confianza: lanza si el paquete destino no tiene la forma permitida. */
export function assertTargetPackage(targetPackage: string): void {
  if (!TARGET_PACKAGE_PATTERN.test(targetPackage)) {
    throw new ValidationError(
      `El paquete destino ${JSON.stringify(targetPackage)} no tiene la forma permitida ` +
        '(`packages/<nombre>` o `apps/<nombre>`, en minusculas). Igual que `taskRef`, se ' +
        'interpola literalmente en el prompt del generador.',
    )
  }
}

/** `true` si la ruta cae en el arbol propiedad del generador. */
export function isGeneratedTestPath(path: string): boolean {
  return GENERATED_TEST_PATH_PATTERN.test(path)
}

// ---------------------------------------------------------------------------
// Hash y serializacion canonica
// ---------------------------------------------------------------------------

/**
 * sha256 del contenido del fichero, en utf8 y TAL CUAL esta en disco: no se
 * normalizan finales de linea ni espacios. Un espacio de mas en un test es un
 * cambio en el test, y el manifiesto tiene que verlo.
 */
export function hashGeneratedTestContents(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex')
}

/**
 * JSON con las claves de todo objeto ordenadas. Hace falta porque la firma se
 * calcula sobre el TEXTO: si el orden de las claves dependiera de como se
 * construyo el objeto, un manifiesto reserializado dejaria de validar sin que
 * nadie lo hubiera tocado, y el gate se convertiria en ruido que la gente
 * aprende a ignorar.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return Object.fromEntries(entries.map(([key, inner]) => [key, sortKeysDeep(inner)]))
}

// ---------------------------------------------------------------------------
// Esquemas (el manifiesto viene de disco: frontera de confianza)
// ---------------------------------------------------------------------------

const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Un sha256 son 64 digitos hexadecimales en minuscula.')

const isoInstantSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    'El instante va en ISO-8601 UTC, tal como lo escribe `Date.prototype.toISOString`.',
  )

export const generatedTestEntrySchema = z.object({
  /** Ruta relativa a la raiz del repositorio. */
  path: z.string().refine(isGeneratedTestPath, {
    message: 'Fuera del arbol propiedad del generador.',
  }),
  sha256: sha256Schema,
  /**
   * Los criterios que cubre este fichero. `min(1)` no es decoracion: es el
   * TERCER criterio de aceptacion de T02 ("cada criterio tiene al menos un test
   * asociado y trazable") sostenido por el esquema. Un fichero generado que no
   * dijera a que criterio responde rompe la trazabilidad en el sentido
   * test -> criterio.
   */
  criterionIds: z.array(z.string().min(1)).min(1),
})
export type GeneratedTestEntry = z.infer<typeof generatedTestEntrySchema>

export const generatedTestTaskManifestSchema = z.object({
  /** Misma lista permitida que valida el generador antes de llamar al modelo. */
  taskRef: z.string().regex(TASK_REF_PATTERN, 'Referencia de tarea fuera de la forma permitida.'),
  /**
   * Hash del conjunto de criterios que se uso para generar
   * (`computeCriteriaContentHash` de `packages/db/src/acceptance-criteria.ts`).
   * Sirve para cazar el caso "los criterios cambiaron y los tests generados se
   * quedaron como estaban", que es una forma silenciosa de que el gate deje de
   * comprobar lo que dice comprobar.
   */
  criteriaContentHash: sha256Schema,
  generatorModel: z.string().min(1),
  generatedAt: isoInstantSchema,
  files: z.array(generatedTestEntrySchema).min(1),
})
export type GeneratedTestTaskManifest = z.infer<typeof generatedTestTaskManifestSchema>

export const generatedTestsManifestSchema = z.object({
  version: z.literal(GENERATED_TESTS_MANIFEST_VERSION),
  tasks: z.array(generatedTestTaskManifestSchema),
})
export type GeneratedTestsManifest = z.infer<typeof generatedTestsManifestSchema>

export const manifestSignatureSchema = z.object({
  algorithm: z.literal('hmac-sha256'),
  value: sha256Schema,
})
export type ManifestSignature = z.infer<typeof manifestSignatureSchema>

export const signedGeneratedTestsManifestSchema = z.object({
  manifest: generatedTestsManifestSchema,
  signature: manifestSignatureSchema.optional(),
})
export type SignedGeneratedTestsManifest = z.infer<typeof signedGeneratedTestsManifestSchema>

export const EMPTY_GENERATED_TESTS_MANIFEST: GeneratedTestsManifest = {
  version: GENERATED_TESTS_MANIFEST_VERSION,
  tasks: [],
}

// ---------------------------------------------------------------------------
// Construir, firmar, serializar
// ---------------------------------------------------------------------------

export interface BuildTaskManifestInput {
  readonly taskRef: string
  readonly criteriaContentHash: string
  readonly generatorModel: string
  readonly generatedAt?: Date
  readonly files: readonly {
    readonly path: string
    readonly contents: string
    readonly criterionIds: readonly string[]
  }[]
}

/** Calcula el trozo de manifiesto de UNA tarea a partir del contenido generado. */
export function buildTaskManifest(input: BuildTaskManifestInput): GeneratedTestTaskManifest {
  const task = {
    taskRef: input.taskRef,
    criteriaContentHash: input.criteriaContentHash,
    generatorModel: input.generatorModel,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    files: input.files.map((file) => ({
      path: file.path,
      sha256: hashGeneratedTestContents(file.contents),
      criterionIds: [...file.criterionIds],
    })),
  }
  const parsed = generatedTestTaskManifestSchema.safeParse(task)
  if (!parsed.success) {
    throw new ValidationError(
      `El manifiesto de ${input.taskRef} no es valido: ${parsed.error.message}`,
      {
        cause: parsed.error,
      },
    )
  }
  return parsed.data
}

/**
 * Mete (o reemplaza) el trozo de una tarea en el manifiesto completo.
 *
 * Reemplaza el bloque ENTERO de la tarea y no fusiona fichero a fichero: si una
 * regeneracion produce menos ficheros que la anterior, los que sobran tienen
 * que desaparecer del manifiesto, porque si no quedarian como `missing` para
 * siempre. Las tareas van ordenadas por `taskRef` para que el fichero no cambie
 * solo por el orden en que se regeneraron.
 */
export function upsertTaskManifest(
  manifest: GeneratedTestsManifest,
  task: GeneratedTestTaskManifest,
): GeneratedTestsManifest {
  const tasks = [...manifest.tasks.filter((existing) => existing.taskRef !== task.taskRef), task]
  tasks.sort((a, b) => (a.taskRef < b.taskRef ? -1 : a.taskRef > b.taskRef ? 1 : 0))
  return { version: GENERATED_TESTS_MANIFEST_VERSION, tasks }
}

function requireKey(signingKey: string, operation: string): string {
  if (signingKey.trim() === '') {
    throw new ValidationError(
      `\`${operation}\` necesita una clave no vacia. La clave sale de ${GENERATED_TESTS_SIGNING_KEY_ENV} ` +
        'y vive en el CI: en el repositorio no hay ninguna (CLAUDE.md 5).',
    )
  }
  return signingKey
}

/** HMAC-SHA256 del manifiesto canonico. La firma NO cubre a la propia firma. */
export function computeManifestSignature(
  manifest: GeneratedTestsManifest,
  signingKey: string,
): ManifestSignature {
  const key = requireKey(signingKey, 'computeManifestSignature')
  return {
    algorithm: 'hmac-sha256',
    value: createHmac('sha256', key).update(canonicalJson(manifest), 'utf8').digest('hex'),
  }
}

export function signManifest(
  manifest: GeneratedTestsManifest,
  signingKey: string,
): SignedGeneratedTestsManifest {
  return { manifest, signature: computeManifestSignature(manifest, signingKey) }
}

/** Comparacion en tiempo constante: una firma no se compara con `===`. */
export function manifestSignatureMatches(
  manifest: GeneratedTestsManifest,
  signature: ManifestSignature,
  signingKey: string,
): boolean {
  const expected = Buffer.from(computeManifestSignature(manifest, signingKey).value, 'hex')
  const actual = Buffer.from(signature.value, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Texto que se escribe a disco: canonico y con salto final, para que el diff sea limpio. */
export function serializeManifest(signed: SignedGeneratedTestsManifest): string {
  return `${JSON.stringify(sortKeysDeep(signed), null, 2)}\n`
}

/** Frontera de confianza: el manifiesto viene de disco y puede estar manipulado. */
export function parseManifest(text: string): SignedGeneratedTestsManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ValidationError(
      `${GENERATED_TESTS_MANIFEST_PATH} no es JSON valido. Un manifiesto ilegible NO se ignora: ` +
        'sin el, la comprobacion de manipulacion no existe.',
      { cause: error },
    )
  }
  const parsed = signedGeneratedTestsManifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError(
      `${GENERATED_TESTS_MANIFEST_PATH} no tiene la forma esperada: ${parsed.error.message}`,
      { cause: parsed.error },
    )
  }
  return parsed.data
}

// ---------------------------------------------------------------------------
// La comprobacion
// ---------------------------------------------------------------------------

export const GENERATED_TEST_FINDING_KINDS = [
  /** El fichero esta en el manifiesto y su contenido en disco no cuadra con el hash. */
  'modified',
  /** El fichero esta en el manifiesto y no esta en disco: alguien borro un test. */
  'missing',
  /** Hay un fichero en el arbol del generador que el manifiesto no declara. */
  'untracked',
  /** Hay clave y el manifiesto no viene firmado. */
  'signature_missing',
  /** La firma no cuadra: el manifiesto se edito despues de firmarse. */
  'signature_invalid',
  /** Los criterios de la tarea cambiaron despues de generar sus tests. */
  'criteria_drifted',
] as const
export type GeneratedTestFindingKind = (typeof GENERATED_TEST_FINDING_KINDS)[number]

export interface GeneratedTestFinding {
  readonly kind: GeneratedTestFindingKind
  readonly path: string | undefined
  readonly taskRef: string | undefined
  readonly detail: string
}

export interface GeneratedTestsVerification {
  readonly ok: boolean
  /**
   * `false` cuando no habia clave. Un `ok: true` con `signatureChecked: false`
   * significa "los hashes cuadran", NO "nadie ha tocado esto": quien reescribio
   * el test pudo reescribir tambien el manifiesto. Quien consuma este resultado
   * TIENE que mirar este campo.
   */
  readonly signatureChecked: boolean
  readonly filesChecked: number
  readonly findings: readonly GeneratedTestFinding[]
}

export interface VerifyGeneratedTestsInput {
  readonly signed: SignedGeneratedTestsManifest
  /** Contenido de cada fichero que hay EN DISCO bajo un `test/generated/`, por ruta. */
  readonly filesOnDisk: ReadonlyMap<string, string>
  /** Clave HMAC. Sin ella la firma no se comprueba (y se dice). */
  readonly signingKey?: string | undefined
  /**
   * Hash actual del conjunto de criterios por tarea, si el llamante lo tiene a
   * mano (lo da `readCriteria()` de `@coord/db`). Sin esto no se puede detectar
   * la deriva de criterios, y se dice tambien.
   */
  readonly currentCriteriaHashes?: ReadonlyMap<string, string> | undefined
}

export function verifyGeneratedTests(input: VerifyGeneratedTestsInput): GeneratedTestsVerification {
  const findings: GeneratedTestFinding[] = []
  const { manifest, signature } = input.signed
  const key = input.signingKey

  let signatureChecked = false
  if (key !== undefined && key.trim() !== '') {
    if (signature === undefined) {
      findings.push({
        kind: 'signature_missing',
        path: GENERATED_TESTS_MANIFEST_PATH,
        taskRef: undefined,
        detail:
          'Hay clave de firma configurada y el manifiesto no viene firmado. Sin firma, quien ' +
          'reescriba un test puede reescribir tambien sus hashes.',
      })
    } else if (!manifestSignatureMatches(manifest, signature, key)) {
      findings.push({
        kind: 'signature_invalid',
        path: GENERATED_TESTS_MANIFEST_PATH,
        taskRef: undefined,
        detail: 'La firma no cuadra con el contenido del manifiesto: se edito despues de firmarse.',
      })
    }
    signatureChecked = true
  }

  const declared = new Set<string>()
  for (const task of manifest.tasks) {
    const currentHash = input.currentCriteriaHashes?.get(task.taskRef)
    if (currentHash !== undefined && currentHash !== task.criteriaContentHash) {
      findings.push({
        kind: 'criteria_drifted',
        path: undefined,
        taskRef: task.taskRef,
        detail:
          `Los tests de ${task.taskRef} se generaron sobre los criterios ` +
          `${task.criteriaContentHash.slice(0, 12)} y ahora los criterios son ` +
          `${currentHash.slice(0, 12)}. Hay que regenerarlos: si no, los tests verdes no dicen ` +
          'nada sobre los criterios vigentes.',
      })
    }

    for (const file of task.files) {
      declared.add(file.path)
      const contents = input.filesOnDisk.get(file.path)
      if (contents === undefined) {
        findings.push({
          kind: 'missing',
          path: file.path,
          taskRef: task.taskRef,
          detail:
            'El manifiesto lo declara y no esta en disco. Borrar un test generado es una de las ' +
            'trampas documentadas del epic 05.',
        })
        continue
      }
      const actual = hashGeneratedTestContents(contents)
      if (actual !== file.sha256) {
        findings.push({
          kind: 'modified',
          path: file.path,
          taskRef: task.taskRef,
          detail:
            `El contenido no cuadra con el manifiesto (esperado ${file.sha256.slice(0, 12)}, ` +
            `encontrado ${actual.slice(0, 12)}). Los tests generados no se editan a mano: se ` +
            'regeneran desde los criterios.',
        })
      }
    }
  }

  for (const path of input.filesOnDisk.keys()) {
    if (!declared.has(path)) {
      findings.push({
        kind: 'untracked',
        path,
        taskRef: undefined,
        detail:
          'Esta en el arbol propiedad del generador y el manifiesto no lo declara. O se genero ' +
          'sin actualizar el manifiesto, o lo escribio alguien que no era el generador.',
      })
    }
  }

  return {
    ok: findings.length === 0,
    signatureChecked,
    filesChecked: input.filesOnDisk.size,
    findings,
  }
}

/** Resumen de una linea por hallazgo, para el CLI, el hook y el registro de auditoria. */
export function describeFinding(finding: GeneratedTestFinding): string {
  const where = finding.path ?? finding.taskRef ?? '(manifiesto)'
  return `[${finding.kind}] ${where}: ${finding.detail}`
}
