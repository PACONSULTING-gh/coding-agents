import { ValidationError } from '@coord/core'
import { z } from 'zod'

/**
 * Estado persistido de una ingesta. Vive en `graph_ingestions.checkpoint`, que
 * es lo que hace que una ingesta interrumpida continue donde iba.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EL PLAN SE CONGELA EN LA BASE
 * ---------------------------------------------------------------------------
 * El plan (que ficheros hay que parsear, cuales han desaparecido) se calcula
 * UNA vez, al empezar, y se guarda. No se recalcula al reanudar, y esto no es
 * un capricho: en cuanto la primera tanda de ficheros graba su `content_hash`
 * nuevo, recalcular el plan los daria por "sin cambios" y la fase siguiente se
 * quedaria sin la lista de lo que cambio en ESTA pasada. El resultado seria una
 * ingesta que "termina" habiendo hecho la mitad del trabajo, en silencio.
 *
 * `nextIndex` es el indice del siguiente elemento de `files` que toca procesar
 * en la fase actual. Es un cursor, no una lista de hechos: cuesta lo mismo con
 * 10 ficheros que con 100.000.
 *
 * ---------------------------------------------------------------------------
 * LAS DOS FASES, Y POR QUE SON DOS
 * ---------------------------------------------------------------------------
 *   1. `symbols`    — nodos de simbolo, aristas `contains` e `imports`, y el
 *                     hash del fichero.
 *   2. `references` — aristas `calls` e `inherits`.
 *
 * `calls`/`inherits` apuntan a simbolos que pueden estar en OTRO fichero de la
 * misma pasada. Si se resolvieran en la primera fase, que una arista existiera
 * o no dependeria del orden en que se procesan los ficheros: en una indexacion
 * inicial, donde todo es nuevo, se perderia mas o menos la mitad, y de forma no
 * reproducible. Separar las fases hace que la fase 2 encuentre SIEMPRE todos
 * los simbolos ya escritos, independientemente del orden.
 *
 * El precio es parsear cada fichero modificado dos veces. Se paga a proposito:
 * en una ingesta incremental esos ficheros son un punado, y en la inicial sigue
 * siendo mas barato que guardar en la base los arboles intermedios.
 */
export const INGESTION_PHASES = ['symbols', 'references', 'completed'] as const
export type IngestionPhase = (typeof INGESTION_PHASES)[number]

const statsSchema = z.object({
  /** Ficheros seguidos por git que algun parser sabe leer. */
  totalFiles: z.number().int().min(0),
  /** De esos, los que hay que parsear en esta pasada. */
  filesPlanned: z.number().int().min(0),
  /** Los que NO se tocan porque su hash no cambio. */
  filesSkipped: z.number().int().min(0),
  /**
   * Parseos REALES ejecutados, acumulados entre reanudaciones. Es la prueba
   * observable de que el incremental funciona: si un fichero no cambio, este
   * contador no sube por el.
   */
  filesParsed: z.number().int().min(0),
  /** Ficheros que ya no estan en el repo y cuyos nodos se han borrado. */
  filesRemoved: z.number().int().min(0),
  /** Ficheros que superan el tope de tamano y no se parsean. */
  filesTooLarge: z.number().int().min(0),
  nodesUpserted: z.number().int().min(0),
  edgesInserted: z.number().int().min(0),
  /** Imports que no apuntan a ningun fichero ni paquete conocido: NO producen arista. */
  unresolvedImports: z.number().int().min(0),
  /** Llamadas y herencias cuyo destino no se pudo resolver: NO producen arista. */
  unresolvedReferences: z.number().int().min(0),
})

export type IngestionStats = z.infer<typeof statsSchema>

export const EMPTY_STATS: IngestionStats = {
  totalFiles: 0,
  filesPlanned: 0,
  filesSkipped: 0,
  filesParsed: 0,
  filesRemoved: 0,
  filesTooLarge: 0,
  nodesUpserted: 0,
  edgesInserted: 0,
  unresolvedImports: 0,
  unresolvedReferences: 0,
}

const checkpointSchema = z.object({
  version: z.literal(1),
  phase: z.enum(INGESTION_PHASES),
  files: z.array(z.string().min(1)),
  removed: z.array(z.string().min(1)),
  nextIndex: z.number().int().min(0),
  stats: statsSchema,
})

export type IngestionCheckpoint = z.infer<typeof checkpointSchema>

/**
 * El checkpoint sale de una columna `jsonb` que escribio otro proceso (o una
 * version anterior del codigo): frontera de confianza. Se valida antes de
 * usarlo, y si no cuadra se dice en voz alta en vez de reanudar sobre un estado
 * que no se entiende.
 */
export function parseCheckpoint(value: unknown): IngestionCheckpoint {
  const parsed = checkpointSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError(
      `El checkpoint de la ingesta no tiene la forma esperada: ${parsed.error.message}`,
      { cause: parsed.error },
    )
  }
  return parsed.data
}

/** `true` si el valor es un checkpoint reanudable (y no el `{}` por defecto). */
export function isCheckpoint(value: unknown): boolean {
  return checkpointSchema.safeParse(value).success
}
