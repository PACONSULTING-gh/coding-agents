/**
 * Presupuesto de contexto de las respuestas MCP (T05).
 *
 * El punto de estas herramientas es que un agente PREGUNTE en vez de leer
 * ficheros. Si una respuesta es un volcado enorme, la herramienta le ha
 * comido a el agente el mismo contexto que un `grep` sin filtrar -- exactamente
 * lo que esto existe para evitar. Dos mecanismos, y son independientes:
 *
 *   1. `truncateToBudget` -- tope de BYTES sobre la lista ya ranqueada que
 *      viene de la consulta. Nunca corta un objeto a la mitad: cada elemento
 *      entra entero o no entra.
 *   2. `fetchRankedPage` -- tope de FILAS en el propio motor. La consulta de
 *      T01 ya devuelve `truncated` explicito (pide `limit + 1` filas y recorta
 *      ella misma), asi que aqui NO hace falta ninguna aritmetica de "+1": se
 *      pide `fetchLimit` y se cree lo que dice la capa de consulta.
 *
 * ---------------------------------------------------------------------------
 * EL CONTADOR TIENE QUE SER HONESTO
 * ---------------------------------------------------------------------------
 * "Mostrando 20 de 340" solo se puede decir si de verdad se sabe que hay 340.
 * Si el motor ya corto en 300 (su propio limite), decir "de 300" seria
 * inventar un total que no es el total real -- podria haber 300 o podria haber
 * 3000. Por eso `total` es `null` en ese caso y se ofrece `totalAtLeast` como
 * cota inferior EXPLICITA: el agente sabe que hay al menos esos, y que no se
 * sabe cuantos mas. Mentir con un numero concreto es peor que decir "no lo se,
 * pero es mucho".
 */

/** 8 KiB en JSON: unas pocas decenas de resultados compactos, muy por debajo
 * de lo que cuesta leer un fichero de tamano medio. No es el tope duro de MCP
 * (los transportes admiten mensajes bastante mayores); es el tope que hace que
 * la respuesta siga siendo "una respuesta" y no "un fichero". */
export const MAX_RESPONSE_BYTES = 8 * 1024

export interface Budgeted<T> {
  readonly items: readonly T[]
  /** `true` si quedo fuera al menos un elemento por no caber en el presupuesto. */
  readonly truncated: boolean
}

const encoder = new TextEncoder()

/**
 * Recorta una lista YA RANQUEADA (el orden de entrada es el orden de salida:
 * esta funcion no reordena nada) al primer prefijo que cabe en `maxBytes` de
 * JSON. Si ni el primer elemento cabe, devuelve la lista vacia con
 * `truncated: true` -- eso es distinto de "no habia nada" (que es lista vacia
 * con `truncated: false`), y el llamante debe poder distinguirlo.
 */
export function truncateToBudget<T>(
  items: readonly T[],
  maxBytes: number = MAX_RESPONSE_BYTES,
): Budgeted<T> {
  let usedBytes = 0
  const kept: T[] = []
  for (const item of items) {
    // +1 por el separador (`,`) que llevaria en el array serializado final.
    const itemBytes = encoder.encode(JSON.stringify(item)).length + 1
    if (usedBytes + itemBytes > maxBytes) break
    usedBytes += itemBytes
    kept.push(item)
  }
  return { items: kept, truncated: kept.length < items.length }
}

export interface RankedPage<T> {
  readonly items: readonly T[]
  readonly shown: number
  /** Total EXACTO, solo cuando se pudo saber con certeza (ver cabecera del fichero). */
  readonly total: number | null
  /** Cota inferior cuando `total` es `null`: se vieron al menos estos y habia mas. */
  readonly totalAtLeast?: number | undefined
  /** `true` si el motor, el presupuesto de bytes, o los dos, dejaron algo fuera. */
  readonly truncated: boolean
}

/**
 * Pide `fetchLimit` filas a la capa de consulta —que ya dice si CORTO ella
 * misma, ver `queries.ts`—, las mapea a la forma compacta de salida
 * (`toOutput`, sin repetir `tenant_id` ni columnas internas) y aplica el
 * presupuesto de bytes SIN reordenar: el ranking ya lo hizo la consulta SQL
 * (`ORDER BY distance ASC, weight DESC, path ASC`), y volver a ordenar aqui
 * podria contradecir un orden que ya es el correcto.
 *
 * Cuando el motor corto, `totalAtLeast` es `fetchLimit + 1`: se han devuelto
 * `fetchLimit` filas Y se sabe que habia al menos una mas. Publicar `fetchLimit`
 * seria una cota inferior una unidad por debajo de la que se conoce, y este
 * modulo se presenta como contador honesto.
 */
export async function fetchRankedPage<Row, Out>(options: {
  readonly fetchLimit: number
  readonly fetch: (
    limit: number,
  ) => Promise<{ readonly hits: readonly Row[]; readonly truncated: boolean }>
  readonly toOutput: (row: Row) => Out
  readonly maxBytes?: number
}): Promise<RankedPage<Out>> {
  const { hits, truncated: engineTruncated } = await options.fetch(options.fetchLimit)
  const mapped = hits.map(options.toOutput)
  const budgeted = truncateToBudget(mapped, options.maxBytes)

  return {
    items: budgeted.items,
    shown: budgeted.items.length,
    total: engineTruncated ? null : mapped.length,
    totalAtLeast: engineTruncated ? mapped.length + 1 : undefined,
    truncated: engineTruncated || budgeted.truncated,
  }
}
