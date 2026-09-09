import { createHash } from 'node:crypto'

import {
  ConflictError,
  NotFoundError,
  requireTenant,
  uuidSchema,
  ValidationError,
} from '@coord/core'
import { z } from 'zod'

import { appendAuditEntry } from './audit.js'
import { withTenantConnection } from './client.js'

/**
 * Criterios de aceptacion Given/When/Then y su aprobacion humana (T01, epic 05).
 *
 * Es la palanca mas importante del epic y no es tecnica: sin criterios
 * aprobados ANTES de codear, la verificacion posterior es teatro. Lo que hace
 * que la palanca exista de verdad no esta aqui, sino en
 * `packages/graph/src/claims.ts`: un `claim()` sobre un issue sin criterios
 * aprobados se rechaza.
 *
 * El esquema es `packages/db/migrations/0010_acceptance_criteria.sql`. Todo el
 * acceso pasa por `withTenantConnection`, asi que la RLS forzada aplica sin
 * excepciones.
 *
 * ===========================================================================
 * LAS TRES PIEZAS, Y POR QUE CADA UNA ESTA DONDE ESTA
 * ===========================================================================
 *
 * 1. EL HASH DEL CONJUNTO (`computeCriteriaContentHash`). Es lo que hace que la
 *    aprobacion caduque sola. Se calcula aqui, en un solo sitio, y NO se guarda
 *    en `acceptance_criteria`: un hash almacenado seria una segunda fuente de
 *    verdad que un UPDATE directo dejaria desincronizada, que es exactamente el
 *    fallo que este mecanismo viene a evitar.
 *
 * 2. QUIEN APRUEBA sale del contexto (`runWithTenant({ actorId })`), no de un
 *    parametro. Un parametro seria una declaracion del propio llamante: un
 *    agente podria "aprobar en nombre de" un humano y el registro diria que lo
 *    aprobo una persona. Es la misma decision, por el mismo motivo, que en
 *    `claim()` (ver la cabecera de `packages/graph/src/claims.ts`).
 *
 * 3. LA HEURISTICA DE "OBSERVABLE Y ACOTADO" (`assertThenIsObservable`). LEE SU
 *    COMENTARIO ANTES DE FIARTE DE ELLA: comprueba que el `then` menciona algo
 *    que se puede señalar, y no puede hacer mas. Un criterio malo escrito con
 *    las palabras correctas pasa. No sustituye a que un humano lea los
 *    criterios; solo evita la formulacion puramente subjetiva.
 */

// ---------------------------------------------------------------------------
// Normalizacion y hash
// ---------------------------------------------------------------------------

/**
 * Forma canonica de un texto de criterio: NFC, sin espacios en los extremos y
 * con las rachas internas de espacio (incluidos saltos de linea) colapsadas a
 * uno.
 *
 * Es lo que hace que el hash sea ESTABLE ante lo que no cambia el significado
 * —reindentar un criterio, pegarlo desde un editor que usa NFD, partirlo en dos
 * lineas— y solo ante eso. Cambiar una palabra cambia el hash, que es
 * precisamente lo que se quiere.
 *
 * Se aplica ANTES de guardar, no solo al hashear: si se guardara el texto crudo
 * y se hasheara el normalizado, la tabla y el hash contarian cosas distintas.
 */
export function normalizeCriterionText(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/**
 * Hash del CONJUNTO de criterios de una tarea. Esta es la definicion, y no hay
 * otra: la migracion 0010 remite aqui a proposito.
 *
 *     sha256( JSON.stringify([[ordinal, given, when, then], ...]) )
 *
 * con los criterios ordenados por `ordinal` ascendente y cada texto ya
 * normalizado. Tres decisiones que importan:
 *
 *   - ORDENADO POR ORDINAL, no por el orden en que los devolvio la consulta.
 *     Un hash que dependiera del orden de un SELECT sin ORDER BY seria
 *     inestable de forma intermitente, que es la peor clase de inestable.
 *   - EL ORDINAL ENTRA EN EL HASH. Reordenar los criterios cambia lo que
 *     significa "el tercer criterio", asi que es un cambio y tiene que
 *     invalidar la aprobacion.
 *   - JSON COMO SERIALIZACION, no una concatenacion con separadores. Con un
 *     separador, un criterio que lo contuviera en su texto podria producir el
 *     mismo hash que otro conjunto distinto (ambiguedad de fronteras); JSON
 *     escapa el contenido y no la tiene.
 */
export function computeCriteriaContentHash(
  criteria: readonly { ordinal: number; given: string; when: string; then: string }[],
): string {
  const canonical = [...criteria]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((criterion) => [
      criterion.ordinal,
      normalizeCriterionText(criterion.given),
      normalizeCriterionText(criterion.when),
      normalizeCriterionText(criterion.then),
    ])
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// La heuristica de "observable y acotado"
// ---------------------------------------------------------------------------

/**
 * Marcas de que el `then` señala algo comprobable. Basta UNA.
 *
 *   - un digito            -> "404", "3 reintentos", "menos de 200 ms"
 *   - algo entre comillas invertidas, una ruta, un identificador con punto o
 *     una llamada -> `claim()`, `packages/db/src/x.ts`, `audit_log.action`
 *   - un verbo de resultado observable (lista de abajo)
 */
const OBSERVABLE_CODE_MARKERS = [
  /`[^`]+`/u, // `algo` entre comillas invertidas
  /\d/u, // cualquier cifra
  /[A-Za-z0-9_]+\([^)]*\)/u, // una llamada: claim(), readAuditLog(db)
  /[A-Za-z0-9_-]+\.[A-Za-z0-9_]{2,}/u, // fichero.ts, tabla.columna
  /[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/u, // una ruta: packages/db
]

/**
 * Verbos que apuntan a un resultado que se puede señalar. En español las formas
 * de tercera persona (que es como se redacta un `then`) y unas cuantas en
 * ingles, porque los criterios de un repo mixto acaban mezclando idioma.
 *
 * La lista se compara sobre el texto en minusculas y SIN acentos, asi que
 * "rechaza" cubre tambien "rechazá" y similares.
 */
const OBSERVABLE_VERBS = [
  'devuelve',
  'devuelven',
  'responde',
  'responden',
  'escribe',
  'escriben',
  'registra',
  'registran',
  'rechaza',
  'rechazan',
  'lanza',
  'lanzan',
  'falla',
  'fallan',
  'bloquea',
  'bloquean',
  'crea',
  'crean',
  'borra',
  'borran',
  'elimina',
  'eliminan',
  'inserta',
  'insertan',
  'guarda',
  'guardan',
  'aparece',
  'aparecen',
  'contiene',
  'contienen',
  'incluye',
  'incluyen',
  'muestra',
  'muestran',
  'emite',
  'emiten',
  'existe',
  'existen',
  'queda',
  'quedan',
  'coincide',
  'coinciden',
  'caduca',
  'caducan',
  'expira',
  'expiran',
  'notifica',
  'notifican',
  'termina',
  'terminan',
  'returns',
  'responds',
  'writes',
  'logs',
  'rejects',
  'throws',
  'fails',
  'blocks',
  'creates',
  'deletes',
  'contains',
  'appears',
  'exits',
]

const OBSERVABLE_VERBS_PATTERN = new RegExp(
  `(^|[^a-z])(${OBSERVABLE_VERBS.join('|')})([^a-z]|$)`,
  'u',
)

/**
 * Terminos puramente subjetivos, por RAIZ: se comparan con un sufijo libre
 * (`robust` casa con "robusto", "robusta", "robustas") para no tener que
 * duplicar la lista por genero y numero.
 *
 * NO se rechaza por contenerlos —"responde en menos de 200 ms y es rapido" es un
 * criterio valido con una coletilla— y por eso la comparacion puede permitirse
 * ser laxa: solo alimenta el mensaje de error cuando ya se ha decidido rechazar
 * por no haber ninguna marca observable.
 */
const SUBJECTIVE_TERMS = [
  'rapid',
  'lent',
  'bonit',
  'intuitiv',
  'usable',
  'robust',
  'limpi',
  'elegante',
  'sencill',
  'adecuad',
  'apropiad',
  'razonable',
  'mejor',
  'peor',
  'optim',
  'eficiente',
  'satisfactori',
  'agradable',
  'comod',
  'facil',
  'correctamente',
  'calidad',
  'clean',
  'nice',
  'better',
  'properly',
  'correctly',
]

const SUBJECTIVE_TERMS_PATTERN = new RegExp(
  `(^|[^a-z])((?:${SUBJECTIVE_TERMS.join('|')})[a-z]*)([^a-z]|$)`,
  'u',
)

/** Minusculas y sin diacriticos, para que las listas no tengan que duplicar acentos. */
function foldForMatching(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
}

/**
 * ===========================================================================
 * ESTO ES UNA HEURISTICA, NO UNA GARANTIA. LEELO ANTES DE CONFIAR EN ELLA.
 * ===========================================================================
 * El segundo criterio de aceptacion de T01 pide que un criterio sea "observable
 * y acotado: se puede señalar la salida, el codigo de respuesta o el fichero que
 * prueba que se cumple". Eso NO es automatizable: decidir si un criterio es
 * bueno es un juicio, y ningun regex lo emite.
 *
 * Lo que si es comprobable, y es lo unico que hace esta funcion, es que el
 * `then` MENCIONE algo señalable: una cifra, un identificador de codigo, o un
 * verbo de resultado. Es un filtro de PISO, no un sello de calidad:
 *
 *   - Rechaza "entonces la solucion es robusta" (nada que señalar).
 *   - Acepta "entonces devuelve algo" (tiene verbo observable y no dice nada).
 *
 * Es decir: pilla la formulacion puramente subjetiva y no pilla nada mas. El
 * juicio sigue siendo del humano que aprueba, y por eso la aprobacion humana
 * existe como paso aparte en vez de derivarse de que la validacion pase.
 */
function assertThenIsObservable(ordinal: number, then: string): void {
  const folded = foldForMatching(then)
  const hasCodeMarker = OBSERVABLE_CODE_MARKERS.some((pattern) => pattern.test(then))
  if (hasCodeMarker || OBSERVABLE_VERBS_PATTERN.test(folded)) {
    return
  }

  const subjective = SUBJECTIVE_TERMS_PATTERN.exec(folded)
  const subjectiveNote =
    subjective === null
      ? ''
      : ` Ademas usa el termino subjetivo "${subjective[2] ?? ''}", que no se puede comprobar.`

  throw new ValidationError(
    `El "then" del criterio ${String(ordinal)} no menciona nada observable: ` +
      `${JSON.stringify(then)}. Tiene que señalar QUE se puede mirar para saber que se cumple ` +
      '— una cifra, un identificador de codigo entre comillas invertidas, una ruta de fichero, ' +
      'o un verbo de resultado (devuelve, rechaza, registra, lanza, aparece...).' +
      `${subjectiveNote} Ojo: esta comprobacion es una heuristica de piso, no valida que el ` +
      'criterio sea bueno; eso lo juzga el humano que lo aprueba.',
  )
}

// ---------------------------------------------------------------------------
// Fronteras de confianza
// ---------------------------------------------------------------------------

/**
 * Misma forma que el CHECK `acceptance_criteria_task_ref_is_well_formed` de la
 * migracion 0010: numero de issue ("21"), slug ("epic-05-t01") o referencia
 * corta ("#21"). Dos capas a proposito, como en `claims`.
 */
export const taskRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/#-]*$/,
    'La referencia de tarea es el numero del issue o un slug: letras, cifras, `.`, `_`, `/`, `#` y `-`.',
  )

const criterionTextSchema = z
  .string()
  .min(1)
  .max(2000)
  .transform(normalizeCriterionText)
  .refine((text) => text.length > 0, 'No puede estar en blanco.')

const criterionInputSchema = z.object({
  given: criterionTextSchema,
  when: criterionTextSchema,
  then: criterionTextSchema,
})
export type AcceptanceCriterionInput = z.input<typeof criterionInputSchema>

/** Tope de criterios por tarea. Una tarea con mas de esto no es una tarea. */
export const MAX_CRITERIA_PER_TASK = 50

const setCriteriaInputSchema = z.object({
  taskRef: taskRefSchema,
  criteria: z.array(criterionInputSchema).min(1).max(MAX_CRITERIA_PER_TASK),
})
export type SetCriteriaInput = z.input<typeof setCriteriaInputSchema>

function parseInput<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError(`Entrada invalida para ${what}: ${parsed.error.message}`, {
      cause: parsed.error,
    })
  }
  return parsed.data
}

/**
 * Identidad del llamante, tomada del contexto. Igual que en `claim()`: si
 * viniera por parametro seria una declaracion del propio llamante y el registro
 * de "quien" no valdria nada.
 */
function callerId(operation: string): string {
  const { actorId } = requireTenant()
  if (actorId === undefined || actorId.trim() === '') {
    throw new ValidationError(
      `\`${operation}\` necesita saber quien llama: pasa \`actorId\` en runWithTenant(). ` +
        'El tercer criterio de T01 exige registrar QUIEN toca los criterios.',
    )
  }
  return actorId.trim()
}

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

const CRITERION_COLUMNS = `
  id,
  tenant_id  AS "tenantId",
  task_ref   AS "taskRef",
  ordinal,
  given_text AS "given",
  when_text  AS "when",
  then_text  AS "then",
  created_at AS "createdAt",
  created_by AS "createdBy"
`

export const acceptanceCriterionRowSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  taskRef: z.string().min(1),
  ordinal: z.number().int().min(1),
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1),
  createdAt: z.date(),
  createdBy: z.string().min(1),
})
export type AcceptanceCriterionRow = z.infer<typeof acceptanceCriterionRowSchema>

const APPROVAL_COLUMNS = `
  id,
  tenant_id    AS "tenantId",
  task_ref     AS "taskRef",
  content_hash AS "contentHash",
  approved_by  AS "approvedBy",
  approved_at  AS "approvedAt",
  revoked_at   AS "revokedAt"
`

export const acceptanceCriteriaApprovalRowSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  taskRef: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  approvedBy: uuidSchema,
  approvedAt: z.date(),
  revokedAt: z.date().nullable(),
})
export type AcceptanceCriteriaApprovalRow = z.infer<typeof acceptanceCriteriaApprovalRowSchema>

/** Los criterios de una tarea, con el hash del conjunto ya calculado. */
export interface AcceptanceCriteriaSet {
  readonly taskRef: string
  readonly criteria: readonly AcceptanceCriterionRow[]
  /** `undefined` cuando la tarea no tiene ningun criterio. */
  readonly contentHash: string | undefined
}

function toSet(taskRef: string, rows: readonly unknown[]): AcceptanceCriteriaSet {
  const criteria = rows.map((row) => acceptanceCriterionRowSchema.parse(row))
  return {
    taskRef,
    criteria,
    contentHash: criteria.length === 0 ? undefined : computeCriteriaContentHash(criteria),
  }
}

// ---------------------------------------------------------------------------
// Estado de aprobacion
// ---------------------------------------------------------------------------

/**
 * Estado de aprobacion de una tarea. NO es un booleano a proposito: quien
 * rechaza un claim tiene que poder decir POR QUE y QUE HACE FALTA, y "no
 * aprobado" y "aprobado pero los criterios cambiaron despues" son dos
 * situaciones con dos remedios distintos.
 */
export type CriteriaApprovalState =
  /** No hay ni un criterio escrito. */
  | { readonly status: 'no_criteria'; readonly taskRef: string }
  /** Hay criterios, nadie los ha aprobado (o la aprobacion se revoco). */
  | {
      readonly status: 'not_approved'
      readonly taskRef: string
      readonly contentHash: string
      readonly criteriaCount: number
    }
  /**
   * Hubo aprobacion, pero los criterios cambiaron despues: el hash aprobado ya
   * no es el de los criterios actuales. Nadie revoco nada — caduco sola.
   */
  | {
      readonly status: 'stale'
      readonly taskRef: string
      readonly contentHash: string
      readonly criteriaCount: number
      readonly approvedContentHash: string
      readonly approvedBy: string
      readonly approvedAt: Date
    }
  | {
      readonly status: 'approved'
      readonly taskRef: string
      readonly contentHash: string
      readonly criteriaCount: number
      readonly approvedBy: string
      readonly approvedAt: Date
    }

/** Frase para un humano. La usa el rechazo del claim y sirve para cualquier UI. */
export function describeCriteriaApprovalState(state: CriteriaApprovalState): string {
  switch (state.status) {
    case 'no_criteria':
      return (
        `la tarea ${state.taskRef} no tiene criterios de aceptacion. ` +
        'Escribelos (Given/When/Then) y que un humano los apruebe antes de empezar'
      )
    case 'not_approved':
      return (
        `los ${String(state.criteriaCount)} criterios de la tarea ${state.taskRef} existen pero ` +
        'nadie los ha aprobado. Hace falta que un humano los apruebe antes de empezar'
      )
    case 'stale':
      return (
        `los criterios de la tarea ${state.taskRef} cambiaron despues de aprobarse ` +
        `(se aprobo ${state.approvedContentHash.slice(0, 12)} el ` +
        `${state.approvedAt.toISOString()} y ahora son ${state.contentHash.slice(0, 12)}). ` +
        'La aprobacion caduco sola: hace falta re-aprobarlos'
      )
    case 'approved':
      return `los criterios de la tarea ${state.taskRef} estan aprobados`
  }
}

/**
 * Un claim (o cualquier otra operacion) bloqueado porque la tarea no tiene
 * criterios aprobados.
 *
 * Extiende `ConflictError`, asi que su `code` sigue siendo `CONFLICT`. Lleva el
 * `state` entero: el criterio de aceptacion pide que el rechazo diga por que y
 * que hace falta, y un booleano no puede decirlo.
 */
export class AcceptanceCriteriaNotApprovedError extends ConflictError {
  public readonly state: CriteriaApprovalState

  constructor(state: CriteriaApprovalState, options?: { cause?: unknown }) {
    super(`No se puede empezar: ${describeCriteriaApprovalState(state)}.`, options)
    this.state = state
  }
}

// ---------------------------------------------------------------------------
// Operaciones
// ---------------------------------------------------------------------------

/**
 * Sustituye el conjunto ENTERO de criterios de una tarea. Los ordinales se
 * asignan 1..N por el orden del array.
 *
 * Se reemplaza el conjunto y no se parchean criterios sueltos porque la unidad
 * que se aprueba es el conjunto: un "edita el criterio 3" que dejase el resto
 * intacto seguiria invalidando la aprobacion (el hash cambia), asi que no
 * compra nada y si añade una segunda forma de escribir en la tabla.
 *
 * Queda registrado en `audit_log` quien y cuando, con el hash anterior y el
 * nuevo (tercer criterio de aceptacion de T01).
 */
export async function setCriteria(input: SetCriteriaInput): Promise<AcceptanceCriteriaSet> {
  const parsed = parseInput(setCriteriaInputSchema, input, 'setCriteria')
  const author = callerId('setCriteria')

  parsed.criteria.forEach((criterion, index) => {
    assertThenIsObservable(index + 1, criterion.then)
  })

  return withTenantConnection(async (tx) => {
    const before = toSet(
      parsed.taskRef,
      (
        await tx.query(
          `SELECT ${CRITERION_COLUMNS} FROM acceptance_criteria
            WHERE tenant_id = $1 AND task_ref = $2 ORDER BY ordinal`,
          [tx.tenantId, parsed.taskRef],
        )
      ).rows,
    )

    await tx.query(`DELETE FROM acceptance_criteria WHERE tenant_id = $1 AND task_ref = $2`, [
      tx.tenantId,
      parsed.taskRef,
    ])

    const inserted = await tx.query(
      `INSERT INTO acceptance_criteria
         (tenant_id, task_ref, ordinal, given_text, when_text, then_text, created_by)
       SELECT $1, $2, c.ord, c.given_text, c.when_text, c.then_text, $3
         FROM unnest($4::text[], $5::text[], $6::text[]) WITH ORDINALITY
              AS c(given_text, when_text, then_text, ord)
       RETURNING ${CRITERION_COLUMNS}`,
      [
        tx.tenantId,
        parsed.taskRef,
        author,
        parsed.criteria.map((criterion) => criterion.given),
        parsed.criteria.map((criterion) => criterion.when),
        parsed.criteria.map((criterion) => criterion.then),
      ],
    )

    const after = toSet(parsed.taskRef, inserted.rows)
    if (after.criteria.length !== parsed.criteria.length) {
      // Con RLS forzada, un INSERT que devuelve menos filas de las pedidas
      // significa que la politica rechazo alguna. Nunca en silencio.
      throw new Error(
        `El INSERT en acceptance_criteria devolvio ${String(after.criteria.length)} filas de ` +
          `${String(parsed.criteria.length)}: revisa que el contexto de tenant coincida con ` +
          'app.tenant_id en la conexion.',
      )
    }

    await appendAuditEntry(tx, {
      action: 'acceptance_criteria.set',
      resourceType: 'acceptance_criteria',
      resourceId: parsed.taskRef,
      metadata: {
        taskRef: parsed.taskRef,
        criteriaCount: after.criteria.length,
        contentHash: after.contentHash ?? null,
        previousContentHash: before.contentHash ?? null,
        // Cambiar los criterios despues de aprobados es el caso que el tercer
        // criterio de T01 quiere poder auditar. Se marca explicitamente para
        // que sea filtrable, no solo deducible comparando hashes.
        replacedExistingCriteria: before.criteria.length > 0,
      },
    })

    return after
  })
}

/** Los criterios de una tarea, ordenados, con el hash del conjunto. */
export async function readCriteria(taskRef: string): Promise<AcceptanceCriteriaSet> {
  const parsedRef = parseInput(taskRefSchema, taskRef, 'readCriteria')
  return withTenantConnection(async (tx) => {
    const result = await tx.query(
      `SELECT ${CRITERION_COLUMNS} FROM acceptance_criteria
        WHERE tenant_id = $1 AND task_ref = $2 ORDER BY ordinal`,
      [tx.tenantId, parsedRef],
    )
    return toSet(parsedRef, result.rows)
  })
}

const approveCriteriaInputSchema = z.object({
  taskRef: taskRefSchema,
  /**
   * Hash que el aprobador cree estar aprobando. Opcional pero MUY recomendable
   * desde una UI: si entre que se leyeron los criterios y se pulso "aprobar"
   * alguien los cambio, aprobar sin este campo firma un texto que el aprobador
   * no ha visto.
   */
  expectedContentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
})
export type ApproveCriteriaInput = z.input<typeof approveCriteriaInputSchema>

/**
 * Aprueba el conjunto ACTUAL de criterios de una tarea.
 *
 * Quien aprueba sale del contexto y tiene que ser un `users.id` del tenant: la
 * clave ajena compuesta de la migracion 0010 lo impone. Un agente con un
 * `actorId` inventado no puede aprobar nada, que es la mitad estructural de
 * "ningun agente aprueba su propio trabajo" (CLAUDE.md 2.1).
 *
 * Es idempotente: aprobar dos veces el mismo contenido devuelve la aprobacion
 * que ya habia en vez de duplicarla (lo impone tambien el indice unico parcial).
 */
export async function approveCriteria(
  input: ApproveCriteriaInput,
): Promise<AcceptanceCriteriaApprovalRow> {
  const parsed = parseInput(approveCriteriaInputSchema, input, 'approveCriteria')
  const approver = parseInput(uuidSchema, callerId('approveCriteria'), 'approveCriteria.actorId')

  return withTenantConnection(async (tx) => {
    const current = toSet(
      parsed.taskRef,
      (
        await tx.query(
          `SELECT ${CRITERION_COLUMNS} FROM acceptance_criteria
            WHERE tenant_id = $1 AND task_ref = $2 ORDER BY ordinal`,
          [tx.tenantId, parsed.taskRef],
        )
      ).rows,
    )

    if (current.contentHash === undefined) {
      throw new NotFoundError(
        `criterios de aceptacion de la tarea ${parsed.taskRef} (no hay ninguno que aprobar)`,
      )
    }

    if (
      parsed.expectedContentHash !== undefined &&
      parsed.expectedContentHash !== current.contentHash
    ) {
      throw new ConflictError(
        `Los criterios de la tarea ${parsed.taskRef} cambiaron entre que los leiste y ahora: ` +
          `esperabas ${parsed.expectedContentHash.slice(0, 12)} y son ` +
          `${current.contentHash.slice(0, 12)}. Vuelve a leerlos antes de aprobar.`,
      )
    }

    const inserted = await tx.query(
      `INSERT INTO acceptance_criteria_approvals (tenant_id, task_ref, content_hash, approved_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, task_ref, content_hash) WHERE revoked_at IS NULL DO NOTHING
       RETURNING ${APPROVAL_COLUMNS}`,
      [tx.tenantId, parsed.taskRef, current.contentHash, approver],
    )

    const [row] = inserted.rows
    if (row === undefined) {
      // Ya existia una aprobacion viva de este mismo contenido: se devuelve esa
      // y NO se registra un evento nuevo, porque no ha pasado nada nuevo.
      const existing = await tx.query(
        `SELECT ${APPROVAL_COLUMNS} FROM acceptance_criteria_approvals
          WHERE tenant_id = $1 AND task_ref = $2 AND content_hash = $3 AND revoked_at IS NULL`,
        [tx.tenantId, parsed.taskRef, current.contentHash],
      )
      const [existingRow] = existing.rows
      if (existingRow === undefined) {
        throw new Error(
          'El INSERT en acceptance_criteria_approvals no inserto ni encontro la fila en ' +
            'conflicto: revisa que el contexto de tenant coincida con app.tenant_id.',
        )
      }
      return acceptanceCriteriaApprovalRowSchema.parse(existingRow)
    }

    const approval = acceptanceCriteriaApprovalRowSchema.parse(row)
    await appendAuditEntry(tx, {
      action: 'acceptance_criteria.approved',
      resourceType: 'acceptance_criteria',
      resourceId: parsed.taskRef,
      actorId: approver,
      actorType: 'user',
      metadata: {
        taskRef: parsed.taskRef,
        contentHash: approval.contentHash,
        criteriaCount: current.criteria.length,
        approvalId: approval.id,
      },
    })
    return approval
  })
}

/**
 * Revocacion EXPLICITA de una aprobacion viva ("aprobe por error").
 *
 * Es otra cosa que la caducidad por cambio de contenido, que no pasa por aqui y
 * no escribe nada. Existe porque sin ella `revoked_at` seria una columna que
 * ningun camino puede escribir.
 */
export async function revokeCriteriaApproval(
  taskRef: string,
): Promise<AcceptanceCriteriaApprovalRow> {
  const parsedRef = parseInput(taskRefSchema, taskRef, 'revokeCriteriaApproval')
  const actor = parseInput(
    uuidSchema,
    callerId('revokeCriteriaApproval'),
    'revokeCriteriaApproval.actorId',
  )

  return withTenantConnection(async (tx) => {
    const updated = await tx.query(
      `UPDATE acceptance_criteria_approvals
          SET revoked_at = now()
        WHERE tenant_id = $1 AND task_ref = $2 AND revoked_at IS NULL
        RETURNING ${APPROVAL_COLUMNS}`,
      [tx.tenantId, parsedRef],
    )
    const [row] = updated.rows
    if (row === undefined) {
      throw new NotFoundError(`aprobacion viva de los criterios de la tarea ${parsedRef}`)
    }
    const approval = acceptanceCriteriaApprovalRowSchema.parse(row)
    await appendAuditEntry(tx, {
      action: 'acceptance_criteria.approval_revoked',
      resourceType: 'acceptance_criteria',
      resourceId: parsedRef,
      actorId: actor,
      actorType: 'user',
      metadata: { taskRef: parsedRef, contentHash: approval.contentHash, approvalId: approval.id },
    })
    return approval
  })
}

/**
 * ¿Puede empezar esta tarea?
 *
 * Compara el hash de los criterios que hay AHORA con el de la aprobacion viva.
 * Ahi esta todo el mecanismo: no hay ninguna columna "aprobado" que alguien
 * tenga que acordarse de bajar, asi que un cambio en los criterios invalida la
 * aprobacion por construccion.
 */
export async function criteriaApprovalState(taskRef: string): Promise<CriteriaApprovalState> {
  const parsedRef = parseInput(taskRefSchema, taskRef, 'criteriaApprovalState')

  return withTenantConnection<CriteriaApprovalState>(async (tx) => {
    const current = toSet(
      parsedRef,
      (
        await tx.query(
          `SELECT ${CRITERION_COLUMNS} FROM acceptance_criteria
            WHERE tenant_id = $1 AND task_ref = $2 ORDER BY ordinal`,
          [tx.tenantId, parsedRef],
        )
      ).rows,
    )

    if (current.contentHash === undefined) {
      return { status: 'no_criteria', taskRef: parsedRef }
    }

    const approvals = await tx.query(
      `SELECT ${APPROVAL_COLUMNS} FROM acceptance_criteria_approvals
        WHERE tenant_id = $1 AND task_ref = $2 AND revoked_at IS NULL
        ORDER BY approved_at DESC, id DESC
        LIMIT 50`,
      [tx.tenantId, parsedRef],
    )
    const live = approvals.rows.map((row) => acceptanceCriteriaApprovalRowSchema.parse(row))

    const matching = live.find((approval) => approval.contentHash === current.contentHash)
    if (matching !== undefined) {
      return {
        status: 'approved',
        taskRef: parsedRef,
        contentHash: current.contentHash,
        criteriaCount: current.criteria.length,
        approvedBy: matching.approvedBy,
        approvedAt: matching.approvedAt,
      }
    }

    const [mostRecent] = live
    if (mostRecent !== undefined) {
      return {
        status: 'stale',
        taskRef: parsedRef,
        contentHash: current.contentHash,
        criteriaCount: current.criteria.length,
        approvedContentHash: mostRecent.contentHash,
        approvedBy: mostRecent.approvedBy,
        approvedAt: mostRecent.approvedAt,
      }
    }

    return {
      status: 'not_approved',
      taskRef: parsedRef,
      contentHash: current.contentHash,
      criteriaCount: current.criteria.length,
    }
  })
}

/**
 * Lanza si la tarea no puede empezar. Es el enganche que usa `claim()` en
 * `packages/graph/src/claims.ts`; vive aqui para que cualquier otra operacion
 * que algun dia necesite la misma puerta no la reimplemente.
 */
export async function assertCriteriaApproved(taskRef: string): Promise<CriteriaApprovalState> {
  const state = await criteriaApprovalState(taskRef)
  if (state.status !== 'approved') {
    throw new AcceptanceCriteriaNotApprovedError(state)
  }
  return state
}
