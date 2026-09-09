import {
  ValidationError,
  type LlmEffort,
  type LlmMessage,
  type LlmPort,
  type LlmRequest,
  type LlmTextBlock,
  type LlmUsage,
} from '@coord/core'
import { z } from 'zod'

import { TEST_GENERATOR_MODEL } from '../anthropic.js'
import {
  assertGeneratedTestPath,
  assertTargetPackage,
  assertTaskRef,
  buildTaskManifest,
  GENERATED_TESTS_SEGMENT,
  type GeneratedTestTaskManifest,
} from './test-manifest.js'

/**
 * Generador de tests a partir de los criterios de aceptacion (T02, epic 05).
 *
 * ===========================================================================
 * EL PRIMER CRITERIO DE ACEPTACION SE CUMPLE POR CONSTRUCCION, NO POR PROMESA
 * ===========================================================================
 * "Dado un criterio de aceptacion, cuando se genera su test, entonces el agente
 * generador no ha visto la implementacion."
 *
 * Eso no se garantiza con una instruccion en el prompt —un prompt es una
 * peticion, no un limite— sino con la FORMA DE LA FUNCION:
 *
 *   1. `TestGenerationRequest` NO TIENE NINGUN CAMPO PARA EL CODIGO. No hay
 *      `implementation`, ni `sourceFiles`, ni `context`, ni `notes` donde
 *      colarlo. Con `exactOptionalPropertyTypes` y el chequeo de propiedades
 *      sobrantes de TypeScript, intentar pasarlo NO COMPILA (hay un test que lo
 *      afirma con `@ts-expect-error`, y `pnpm -r typecheck` lo ejecuta).
 *   2. ESTE MODULO NO LEE DEL DISCO. No importa `node:fs` — ni directa ni
 *      indirectamente: sus unicas dependencias son `@coord/core`, `zod` y
 *      `./test-manifest.js`, que tampoco tocan el disco. Aunque alguien le
 *      pasara una ruta, no hay forma de que la lea. Esto ya no depende de que
 *      nadie anada el import: la regla `generador-de-tests-no-lee-del-disco` de
 *      `.dependency-cruiser.cjs` lo prohibe y `pnpm arch` corre en CI.
 *   3. LOS DOS CAMPOS DE TEXTO QUE QUEDAN ESTAN ACOTADOS. `taskRef` y
 *      `targetPackage` se interpolan literalmente en el system prompt, asi que
 *      no basta con que "no se llamen implementacion": se validan contra una
 *      lista permitida (`assertTaskRef` / `assertTargetPackage` de
 *      `test-manifest.ts`) antes de construir el prompt. Sin eso, la ausencia
 *      de un campo con nombre obvio no impedia nada: bastaba meter el codigo
 *      en `taskRef`.
 *
 * Con la firma cerrada, la lectura de disco prohibida y los dos campos libres
 * acotados, el criterio se cumple por construccion. Lo que NO se puede
 * garantizar desde aqui es el contenido de los propios criterios: si alguien
 * escribe la implementacion DENTRO de un criterio de aceptacion aprobado, el
 * generador la vera. Ese canal lo cierra la aprobacion humana de T01, no este
 * fichero.
 *
 * ---------------------------------------------------------------------------
 * ENTONCES, ¿COMO ESCRIBE UN TEST QUE COMPILE SI NO VE EL CODIGO?
 * ---------------------------------------------------------------------------
 * Por el UNICO canal que hay: los propios criterios. Y eso no es un accidente
 * feliz, es lo que T01 monto a proposito — `assertThenIsObservable`
 * (`packages/db/src/acceptance-criteria.ts`) exige que el `then` señale algo
 * que se pueda mirar: una cifra, una ruta de fichero, un identificador entre
 * comillas invertidas, una llamada `claim()`. Ese es el contrato que viaja del
 * spec al test.
 *
 * HONESTIDAD SOBRE EL COSTE: un test escrito a ciegas puede no compilar a la
 * primera. Eso es un COSTE ACEPTADO, no un defecto a parchear. La solucion
 * correcta cuando pasa es mejorar el criterio para que diga que se observa; la
 * incorrecta es abrir un canal hacia el codigo, porque el dia que el generador
 * ve la implementacion, sus tests dejan de probar el spec y pasan a probar lo
 * que el codigo ya hace — que es exactamente la fachada de tests verdes sobre
 * funcionalidad rota contra la que existe este epic.
 *
 * ---------------------------------------------------------------------------
 * POR QUE OTRO MODELO
 * ---------------------------------------------------------------------------
 * El implementador de este repositorio es Claude Code sobre Opus. El generador
 * corre sobre `claude-sonnet-5` (`TEST_GENERATOR_MODEL`) con esfuerzo `high`.
 * La constitucion pide que el que verifica no sea el que genera (CLAUDE.md 2.3)
 * y "preferiblemente otro modelo"; aqui ademas conviene que sea otro modelo
 * porque dos instancias del mismo modelo comparten los mismos puntos ciegos.
 */

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/**
 * Un criterio con identidad estable. Es un tipo ESTRUCTURAL a proposito: la
 * fila que devuelve `readCriteria()` de `@coord/db` encaja tal cual, sin que
 * este modulo tenga que importar la capa de datos ni obligar al llamante a
 * traducir nada.
 */
export interface TraceableCriterion {
  /** Identidad estable del criterio. Es lo que hace trazable el test. */
  readonly id: string
  readonly ordinal: number
  readonly given: string
  readonly when: string
  readonly then: string
}

/**
 * Lo UNICO que recibe el generador.
 *
 * Antes de añadir un campo aqui: si lo que vas a meter puede contener codigo de
 * la implementacion (aunque sea "solo la firma", "solo los imports", "solo el
 * nombre del modulo"), estas rompiendo el primer criterio de aceptacion. Los
 * campos de aqui son todos metadatos de DONDE va el test, nunca de QUE hace el
 * codigo.
 */
export interface TestGenerationRequest {
  /** Numero de issue o slug de la tarea. Va al manifiesto. */
  readonly taskRef: string
  readonly criteria: readonly TraceableCriterion[]
  /**
   * Hash del conjunto de criterios (`computeCriteriaContentHash` de `@coord/db`).
   * Se guarda en el manifiesto para poder detectar despues que los criterios
   * cambiaron y los tests no se regeneraron.
   */
  readonly criteriaContentHash: string
  /**
   * Paquete destino, `packages/db` o `apps/worker`. Determina DONDE se escribe,
   * no QUE se escribe: el generador sigue sin ver una linea de ese paquete.
   */
  readonly targetPackage: string
}

export interface TestGenerationOptions {
  /** Por defecto `TEST_GENERATOR_MODEL` (`claude-sonnet-5`). */
  readonly model?: string
  /** Por defecto `high`, como pide el epic para este rol. */
  readonly effort?: LlmEffort
  readonly maxOutputTokens?: number
  /** Inyectable para que el manifiesto sea reproducible en los tests. */
  readonly now?: Date
}

export const TEST_GENERATOR_EFFORT: LlmEffort = 'high'
export const DEFAULT_TEST_GENERATION_MAX_OUTPUT_TOKENS = 32_000

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export interface GeneratedTestFile {
  /** Ruta relativa a la raiz del repositorio, dentro del arbol del generador. */
  readonly path: string
  readonly contents: string
  /** Criterios que cubre. Es la trazabilidad test -> criterio. */
  readonly criterionIds: readonly string[]
}

export interface TestGenerationResult {
  readonly taskRef: string
  /** Modelo que respondio de verdad, tal como lo declaro el proveedor. */
  readonly model: string
  readonly files: readonly GeneratedTestFile[]
  /** Trozo de manifiesto de esta tarea, listo para `upsertTaskManifest`. */
  readonly manifest: GeneratedTestTaskManifest
  readonly usage: LlmUsage
}

// ---------------------------------------------------------------------------
// El contrato de salida que se le pide al modelo
// ---------------------------------------------------------------------------

/**
 * JSON Schema de la respuesta. Se pide salida estructurada porque el prefill
 * del turno `assistant` esta eliminado en los modelos actuales y devuelve 400:
 * ya no hay forma de forzar el formato "empezando la respuesta por el".
 */
const GENERATED_TESTS_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'criterionIds', 'contents'],
        properties: {
          path: {
            type: 'string',
            description:
              'Ruta relativa a la raiz del repositorio, dentro de <paquete>/test/generated/, terminada en .test.ts',
          },
          criterionIds: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
            description: 'Ids de los criterios que cubre este fichero.',
          },
          contents: { type: 'string', description: 'El fichero de test completo.' },
        },
      },
    },
  },
}

/**
 * Validacion de lo que vuelve. Pedir salida estructurada NO exime de validar:
 * sigue siendo texto generado por un modelo, es decir, una frontera de
 * confianza (CLAUDE.md 2.4, "validacion en fronteras de confianza" no se
 * recorta en ningun peldaño).
 */
const generatedFilesSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        criterionIds: z.array(z.string().min(1)).min(1),
        contents: z.string().min(1),
      }),
    )
    .min(1),
})

// ---------------------------------------------------------------------------
// El prompt
// ---------------------------------------------------------------------------

/**
 * Instrucciones del rol. Es la parte ESTABLE del prompt y por eso lleva el
 * corte de cache: el cache de prompt es de prefijo, asi que lo que no cambia va
 * primero (CLAUDE.md no lo pide, pero el coste del epic 05 si).
 */
function systemPrompt(request: TestGenerationRequest): readonly LlmTextBlock[] {
  return [
    {
      cacheBreakpoint: true,
      text: [
        'Eres el agente GENERADOR DE TESTS de una plataforma de coordinacion.',
        '',
        'No has visto la implementacion y no vas a verla: escribes los tests a partir de los',
        'criterios de aceptacion y de nada mas. Si un criterio no dice que se puede observar',
        'para saber que se cumple, NO te lo inventes: escribe el test que falla y deja en un',
        'comentario que el criterio es ambiguo. Un test que finge comprobar algo es peor que',
        'no tener test (asi lo dice la constitucion del repositorio).',
        '',
        'Reglas duras:',
        `  * Un fichero por criterio como minimo. Cada fichero declara en "criterionIds" los`,
        '    criterios que cubre, y TODOS los criterios de la peticion tienen que quedar',
        '    cubiertos por al menos un fichero.',
        `  * Las rutas van bajo "<paquete>/${GENERATED_TESTS_SEGMENT}/" y terminan en ".test.ts".`,
        '  * Tests de vitest, en TypeScript, con imports por ruta relativa o por el nombre del',
        '    paquete (@coord/...).',
        '  * Nada de mocks de lo que no controlamos: contra Postgres o HTTP reales.',
        '  * Ni una credencial en el codigo, ni siquiera de test.',
        '  * Identificadores en ingles, comentarios en espanol.',
        '  * Cada test lleva en un comentario el id y el texto del criterio que comprueba, para',
        '    que se pueda ir del test al criterio sin salir del fichero.',
      ].join('\n'),
    },
    {
      text: [
        `Tarea: ${request.taskRef}.`,
        `Paquete destino: ${request.targetPackage}.`,
        `Ruta obligatoria de los ficheros: ${request.targetPackage}/${GENERATED_TESTS_SEGMENT}/...`,
      ].join('\n'),
    },
  ]
}

/**
 * El mensaje de usuario: los criterios, y solo los criterios. Si algun dia
 * alguien mete algo mas aqui, el test `no-ve-la-implementacion` se pone rojo.
 */
function criteriaMessage(request: TestGenerationRequest): LlmMessage {
  const payload = request.criteria.map((criterion) => ({
    id: criterion.id,
    ordinal: criterion.ordinal,
    given: criterion.given,
    when: criterion.when,
    then: criterion.then,
  }))
  return {
    role: 'user',
    content: [
      'Criterios de aceptacion aprobados. Escribe sus tests.',
      '',
      JSON.stringify(payload, null, 2),
    ].join('\n'),
  }
}

// ---------------------------------------------------------------------------
// La operacion
// ---------------------------------------------------------------------------

function assertRequestIsUsable(request: TestGenerationRequest): void {
  // Frontera de confianza ANTES de construir el prompt: los dos unicos campos
  // de texto libre de la peticion acaban interpolados en el system prompt.
  assertTaskRef(request.taskRef)
  assertTargetPackage(request.targetPackage)
  if (request.criteria.length === 0) {
    throw new ValidationError(
      `La tarea ${request.taskRef} no trae ni un criterio. Generar tests sin criterios es ` +
        'justo lo que el epic 05 llama teatro: no se hace.',
    )
  }
  const ids = new Set(request.criteria.map((criterion) => criterion.id))
  if (ids.size !== request.criteria.length) {
    throw new ValidationError(
      `Hay criterios con el mismo id en ${request.taskRef}: sin ids unicos la trazabilidad ` +
        'test -> criterio no significa nada.',
    )
  }
}

/**
 * Comprueba el TERCER criterio de aceptacion sobre la salida real: "cada
 * criterio tiene al menos un test asociado y trazable".
 *
 * Se comprueba aqui y se lanza, en vez de dejarlo para una revision posterior,
 * porque un conjunto de tests con un criterio sin cubrir es exactamente el
 * fallo silencioso que este epic persigue: todo verde y un criterio que nadie
 * comprueba.
 */
function assertEveryCriterionIsCovered(
  request: TestGenerationRequest,
  files: readonly GeneratedTestFile[],
): void {
  const known = new Set(request.criteria.map((criterion) => criterion.id))
  const covered = new Set<string>()
  for (const file of files) {
    // Primera pasada: que el id EXISTA. Va antes que nada porque un id
    // inventado es el fallo mas grave de los dos y su mensaje es el util.
    for (const id of file.criterionIds) {
      if (!known.has(id)) {
        throw new ValidationError(
          `El fichero generado ${file.path} dice cubrir el criterio "${id}", que no existe en ` +
            `la tarea ${request.taskRef}. Una trazabilidad que apunta a un criterio inventado ` +
            'es peor que ninguna.',
        )
      }
      covered.add(id)
    }
    // Segunda pasada: que el id APAREZCA en el fichero. Sin esto la
    // trazabilidad es AUTODECLARADA — el modelo puede decir que un fichero
    // cubre `c-uno` sin que el fichero lo mencione ni lo ejercite, y el gate lo
    // daria por cubierto. La comprobacion es barata y determinista, y el system
    // prompt ya exige ese comentario, asi que no pide nada nuevo.
    //
    // LO QUE ESTO NO ES: una prueba de que el test COMPRUEBE el criterio. Eso
    // no lo puede decidir un `includes`, y no se presenta como si pudiera. Lo
    // que cierra es el caso en que el fichero no habla del criterio en absoluto.
    for (const id of file.criterionIds) {
      if (!file.contents.includes(id)) {
        throw new ValidationError(
          `El fichero generado ${file.path} declara cubrir el criterio "${id}" pero ese id no ` +
            'aparece en ninguna parte de su contenido. La trazabilidad test -> criterio no puede ' +
            'ser una declaracion del propio generador: el id tiene que estar EN el fichero para ' +
            'que se pueda ir del test al criterio sin salir de el (tercer criterio de T02).',
        )
      }
    }
  }

  const uncovered = request.criteria.filter((criterion) => !covered.has(criterion.id))
  if (uncovered.length > 0) {
    throw new ValidationError(
      `La generacion dejo ${String(uncovered.length)} criterio(s) de ${request.taskRef} sin ` +
        `ningun test: ${uncovered.map((criterion) => `#${String(criterion.ordinal)} (${criterion.id})`).join(', ')}. ` +
        'El tercer criterio de aceptacion de T02 exige que cada criterio tenga al menos un test ' +
        'asociado y trazable.',
    )
  }
}

function assertNoDuplicatePaths(files: readonly GeneratedTestFile[]): void {
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new ValidationError(
        `La generacion devolvio dos veces la ruta ${file.path}. El segundo escribiria encima del ` +
          'primero y uno de los dos criterios se quedaria sin test sin que nadie lo notase.',
      )
    }
    seen.add(file.path)
  }
}

/**
 * Genera los tests de una tarea.
 *
 * Los errores del proveedor (429, 400, negativa del modelo) NO se atrapan: se
 * propagan con su tipo. Un `catch` que devolviera "cero ficheros" haria que una
 * tarea sin tests pareciera una tarea generada (CLAUDE.md 5 y 7).
 */
export async function generateTests(
  llm: LlmPort,
  request: TestGenerationRequest,
  options: TestGenerationOptions = {},
): Promise<TestGenerationResult> {
  assertRequestIsUsable(request)

  const llmRequest: LlmRequest = {
    model: options.model ?? TEST_GENERATOR_MODEL,
    system: systemPrompt(request),
    messages: [criteriaMessage(request)],
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_TEST_GENERATION_MAX_OUTPUT_TOKENS,
    effort: options.effort ?? TEST_GENERATOR_EFFORT,
    reasoning: 'on',
    outputSchema: {
      name: 'generated_tests',
      description: 'Ficheros de test derivados de los criterios de aceptacion.',
      schema: GENERATED_TESTS_OUTPUT_SCHEMA,
    },
  }

  const result = await llm.complete(llmRequest)

  const parsed = generatedFilesSchema.safeParse(result.structured)
  if (!parsed.success) {
    throw new ValidationError(
      `La respuesta del generador no tiene la forma pedida para ${request.taskRef}: ` +
        parsed.error.message,
      { cause: parsed.error },
    )
  }

  const files: GeneratedTestFile[] = parsed.data.files.map((file) => {
    // La ruta la propone el modelo: frontera de confianza. Se rechaza cualquier
    // cosa fuera del arbol del generador ANTES de que nadie la escriba.
    assertGeneratedTestPath(file.path)
    if (!file.path.startsWith(`${request.targetPackage}/${GENERATED_TESTS_SEGMENT}/`)) {
      throw new ValidationError(
        `El generador propuso ${file.path}, fuera del paquete destino ` +
          `${request.targetPackage}/${GENERATED_TESTS_SEGMENT}/.`,
      )
    }
    return { path: file.path, contents: file.contents, criterionIds: file.criterionIds }
  })

  assertNoDuplicatePaths(files)
  assertEveryCriterionIsCovered(request, files)

  return {
    taskRef: request.taskRef,
    model: result.model,
    files,
    manifest: buildTaskManifest({
      taskRef: request.taskRef,
      criteriaContentHash: request.criteriaContentHash,
      generatorModel: result.model,
      ...(options.now === undefined ? {} : { generatedAt: options.now }),
      files,
    }),
    usage: result.usage,
  }
}

/**
 * Trazabilidad en el sentido criterio -> tests. El sentido contrario
 * (test -> criterio) lo da `GeneratedTestFile.criterionIds` y el propio
 * manifiesto, asi que se puede recorrer en los dos sin consultar nada mas.
 */
export function testsForCriterion(
  result: TestGenerationResult,
  criterionId: string,
): readonly GeneratedTestFile[] {
  return result.files.filter((file) => file.criterionIds.includes(criterionId))
}
