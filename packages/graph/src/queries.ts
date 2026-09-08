import { uuidSchema, ValidationError } from '@coord/core'
import { withTenantConnection } from '@coord/db'
import { z } from 'zod'

/**
 * Consultas de recorrido del grafo de dependencias.
 *
 * ---------------------------------------------------------------------------
 * LAS DOS GUARDAS DE LA CTE RECURSIVA. LEE ESTO ANTES DE TOCAR EL SQL.
 * ---------------------------------------------------------------------------
 *
 * 1. TOPE DE PROFUNDIDAD (`t.distance < $4`, con `MAX_TRAVERSAL_DEPTH` como
 *    techo duro). Sin el, una consulta sobre un repo grande expande el grafo
 *    entero y la respuesta deja de caber en el presupuesto de contexto de un
 *    agente, que es justo lo que estas herramientas existen para evitar.
 *
 * 2. GUARDA DE CICLOS. Un repositorio real TIENE ciclos de imports: A importa
 *    B, B importa A. Sin guarda, la CTE no termina NUNCA.
 *
 *    La guarda es la DEDUPLICACION POR NODO Y DISTANCIA (`UNION`, no
 *    `UNION ALL`, y el termino recursivo proyecta SOLO `(node_id, distance)`).
 *    Es la diferencia entre enumerar NODOS ALCANZABLES y enumerar CAMINOS, y
 *    no es una sutileza de estilo: es la diferencia entre un coste lineal en el
 *    vecindario y uno combinatorio en la profundidad.
 *
 *    La version anterior acumulaba el CAMINO recorrido en un array `visited` y
 *    usaba `UNION ALL`. Funcionaba —terminaba, y daba el mismo resultado— pero
 *    el coste explotaba con la profundidad. Medido sobre el escenario de
 *    `test/performance.test.ts` (12.000 nodos, 43.500 aristas), p95 por
 *    profundidad:
 *
 *        profundidad     camino (`visited`)     nodos (esta version)
 *             4                6,9 ms                  3,1 ms
 *             8              130,9 ms                    —
 *            10            ~1.800 ms  (medido           106,7 ms
 *                          por el verificador)
 *
 *    Con la guarda por camino, una consulta a la profundidad MAXIMA que la
 *    propia API acepta incumplia el presupuesto de 200 ms por un factor de 9 y
 *    ocupaba una conexion del pool casi dos segundos. Por eso el techo de
 *    profundidad se mide AHORA a `MAX_TRAVERSAL_DEPTH`, no a 4
 *    (`test/performance.test.ts`).
 *
 *    Como el termino recursivo ya no lleva los datos de la arista, estos se
 *    recuperan en una segunda pasada (`best` / `aggregated`): para cada nodo
 *    alcanzado a distancia minima `d`, las aristas que lo unen con algun nodo
 *    alcanzado a `d - 1`. Es la MISMA arista que habria elegido el recorrido
 *    por caminos.
 *
 * Las dos son criterio de aceptacion de T01 y las dos tienen su test contra
 * Postgres de verdad en `test/queries.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * POR QUE NO SE ABRE UN POOL PROPIO
 * ---------------------------------------------------------------------------
 * Todo pasa por `withTenantConnection` de `@coord/db`: es la unica via de
 * acceso a datos del producto y la que fija `app.tenant_id` LOCAL a la
 * transaccion (ver la cabecera de `packages/db/src/client.ts`). El grafo
 * contiene la estructura del codigo de cada cliente, asi que un atajo aqui
 * significa filtrar el codigo de un cliente a otro.
 *
 * El filtro explicito `tenant_id = $1` que llevan las consultas NO es la
 * defensa —la defensa es la RLS forzada— sino una segunda capa, igual que en
 * `packages/db/src/audit.ts`. Ademas le da al planner un valor constante en la
 * columna lider de los indices.
 */

export const NODE_KINDS = ['file', 'symbol', 'package', 'target'] as const
export type NodeKind = (typeof NODE_KINDS)[number]

export const EDGE_KINDS = ['imports', 'calls', 'inherits', 'contains', 'cochange'] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]

/**
 * Que senal produjo la arista. Viaja SIEMPRE en el resultado: la pregunta "que
 * predijo que esto se ve afectado" (T03 y T05) se responde con esto.
 */
export const EDGE_SOURCES = ['static', 'build', 'git'] as const
export type EdgeSource = (typeof EDGE_SOURCES)[number]

/**
 * Techo duro de profundidad. No es configurable por el llamante: es el limite
 * que impide que una peticion cualquiera convierta la base de datos en un
 * expansor de grafo completo. Si algun dia hace falta mas, se sube aqui, con un
 * numero medido delante.
 */
export const MAX_TRAVERSAL_DEPTH = 10
export const DEFAULT_TRAVERSAL_DEPTH = 3

export const MAX_RESULT_LIMIT = 1000
export const DEFAULT_RESULT_LIMIT = 200

/**
 * Entrada validada en la frontera de confianza. `repoId` y los ids de nodo
 * llegan de fuera (MCP, HTTP, un job): se comprueban antes de tocar la base de
 * datos, y nunca se interpolan en el SQL — viajan como parametros.
 */
const traversalInputSchema = z.object({
  repoId: uuidSchema,
  nodeId: uuidSchema,
  depth: z.number().int().min(1).max(MAX_TRAVERSAL_DEPTH).default(DEFAULT_TRAVERSAL_DEPTH),
  edgeKinds: z
    .array(z.enum(EDGE_KINDS))
    .min(1)
    .default([...EDGE_KINDS]),
  sources: z
    .array(z.enum(EDGE_SOURCES))
    .min(1)
    .default([...EDGE_SOURCES]),
  limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
})

const blastRadiusInputSchema = traversalInputSchema
  .omit({ nodeId: true })
  .extend({ nodeIds: z.array(uuidSchema).min(1).max(500) })

export type TraversalInput = z.input<typeof traversalInputSchema>
export type BlastRadiusInput = z.input<typeof blastRadiusInputSchema>

/** Lo minimo que identifica a un nodo para quien lo lee. */
export interface GraphNodeRef {
  readonly nodeId: string
  readonly kind: NodeKind
  /** Ruta relativa a la raiz del repo. */
  readonly path: string
  /** Nombre del simbolo; `null` en los nodos de tipo `file`. */
  readonly name: string | null
  readonly language: string | null
}

export interface TraversalHit extends GraphNodeRef {
  /** Saltos hasta el nodo de partida. 1 = vecino directo. Siempre el MINIMO. */
  readonly distance: number
  readonly edgeKind: EdgeKind
  /** Senal que produjo la arista por la que se llego. */
  readonly edgeSource: EdgeSource
  readonly weight: number
}

export interface BlastRadiusHit extends GraphNodeRef {
  readonly distance: number
  /** TODAS las senales distintas que alcanzaron este nodo, no solo una. */
  readonly sources: readonly EdgeSource[]
  readonly edgeKinds: readonly EdgeKind[]
  /** Peso de la senal mas fuerte que lo alcanzo. Para `cochange`, la frecuencia. */
  readonly weight: number
}

const nodeRefColumns = {
  kind: z.enum(NODE_KINDS),
  path: z.string().min(1),
  name: z.string().nullable(),
  language: z.string().nullable(),
}

/**
 * Frontera de confianza a la vuelta: lo que sale de un `SELECT` se parsea antes
 * de circular por el dominio, como en `packages/db/src/schema.ts`. Si la
 * migracion y el codigo divergen, se entera aqui y en voz alta.
 */
const traversalRowSchema = z.object({
  node_id: uuidSchema,
  distance: z.number().int().positive(),
  edge_kind: z.enum(EDGE_KINDS),
  edge_source: z.enum(EDGE_SOURCES),
  weight: z.number().positive(),
  ...nodeRefColumns,
})

const blastRadiusRowSchema = z.object({
  node_id: uuidSchema,
  distance: z.number().int().positive(),
  sources: z.array(z.enum(EDGE_SOURCES)).min(1),
  edge_kinds: z.array(z.enum(EDGE_KINDS)).min(1),
  weight: z.number().positive(),
  ...nodeRefColumns,
})

const nodeRefRowSchema = z.object({ node_id: uuidSchema, ...nodeRefColumns })

/**
 * Sentido del recorrido.
 *
 *   Una arista `from -> to` significa "from DEPENDE DE to".
 *
 *   - `dependents`: quien depende de X. Se entra por `to_node_id` y se avanza a
 *     `from_node_id`. Es la consulta de DEPENDENCIAS INVERSAS, la que contesta
 *     "si toco esto, que se rompe", y por la que existe el segundo indice de la
 *     migracion 0007.
 *   - `dependencies`: de que depende X. El sentido natural de la arista.
 *
 * Los nombres de columna salen de esta tabla constante, NUNCA de datos del
 * llamante: no hay forma de inyectar SQL por aqui.
 */
const DIRECTIONS = {
  dependents: { anchor: 'to_node_id', step: 'from_node_id' },
  dependencies: { anchor: 'from_node_id', step: 'to_node_id' },
} as const
type Direction = keyof typeof DIRECTIONS

/**
 * Termino recursivo compartido: ALCANZABILIDAD POR NODO, no enumeracion de
 * caminos. Parametros:
 *   $1 tenant_id · $2 repo_id · $3 nodos de partida (uuid[]) · $4 profundidad
 *   $5 tipos de arista (text[]) · $6 origenes (text[])
 *
 * `UNION` (no `UNION ALL`) sobre `(node_id, distance)` es la guarda de ciclos:
 * una pareja nodo/distancia se produce UNA vez, asi que un ciclo A -> B -> A no
 * regenera trabajo y la recursion termina por el tope de profundidad. El coste
 * queda acotado por (profundidad x aristas alcanzables) en vez de por el numero
 * de caminos simples, que es exponencial. Ver la cabecera del fichero.
 */
function reachableCte(direction: Direction): string {
  const { anchor, step } = DIRECTIONS[direction]
  return `
WITH RECURSIVE reachable AS (
  -- Termino base: los vecinos directos de los nodos de partida.
  SELECT e.${step} AS node_id, 1 AS distance
    FROM graph_edges e
   WHERE e.tenant_id = $1
     AND e.repo_id   = $2
     AND e.${anchor} = ANY($3::uuid[])
     AND e.kind      = ANY($5::text[])
     AND e.source    = ANY($6::text[])

  UNION

  SELECT e.${step}, t.distance + 1
    FROM reachable t
    JOIN graph_edges e
      ON e.${anchor} = t.node_id
     AND e.tenant_id = $1
     AND e.repo_id   = $2
   WHERE t.distance < $4                    -- guarda 1: tope de profundidad
     AND e.kind   = ANY($5::text[])
     AND e.source = ANY($6::text[])
), nearest AS (
  -- Un mismo nodo se alcanza por varios caminos y a varias distancias: nos
  -- quedamos con la MINIMA, que es la distancia real en el grafo. Los nodos de
  -- partida no son su propio resultado.
  SELECT r.node_id, min(r.distance) AS distance
    FROM reachable r
   WHERE r.node_id <> ALL($3::uuid[])
   GROUP BY r.node_id
)`
}

/**
 * Segunda pasada: recupera los datos de la ARISTA por la que se llego a cada
 * nodo, que el termino recursivo ya no arrastra.
 *
 * Para un nodo alcanzado a distancia minima `d`, la arista buena es la que lo
 * une con algun nodo alcanzado a `d - 1` (o con un nodo de partida, si `d = 1`).
 * Por la propiedad del recorrido en anchura, ese predecesor existe siempre, asi
 * que ningun nodo de `nearest` se cae por el camino. A igualdad de distancia se
 * elige la arista de mayor peso, con `kind`/`source` como desempate ESTABLE:
 * sin el, dos ejecuciones podrian devolver senales distintas para el mismo nodo.
 *
 * ES UN JOIN NORMAL, Y ESO SIGNIFICA UNA PASADA SOBRE LAS ARISTAS DEL REPO.
 * El planner resuelve esto con un hash join y, para construir el hash, recorre
 * una vez las aristas del repositorio (`Seq Scan on graph_edges` con el filtro
 * de tenant/repo). Se probo la alternativa —`CROSS JOIN LATERAL` correlado por
 * `nr.node_id`, que si usa el indice— y es MUCHO PEOR: `nearest` es una CTE, el
 * `EXISTS` de dentro no se puede hashear cuando esta correlado, y a profundidad
 * maxima (miles de nodos alcanzados) la consulta pasa de 107 ms a mas de 2,7 s.
 * Medido, no supuesto.
 *
 * Asi que la regla es: la RECURSION —que es la parte cuyo coste crece con la
 * profundidad— tiene que ir por el indice inverso siempre, y esta segunda pasada
 * es UNA sola sobre las aristas del repo. `test/performance.test.ts` lo fija con
 * un EXPLAIN: cero seq scans dentro de la union recursiva, y como mucho uno en
 * todo el plan.
 */
function traversalSql(direction: Direction): string {
  const { anchor, step } = DIRECTIONS[direction]
  return `${reachableCte(direction)}
, best AS (
  SELECT DISTINCT ON (nr.node_id)
         nr.node_id,
         nr.distance,
         e.kind   AS edge_kind,
         e.source AS edge_source,
         e.weight::double precision AS weight
    FROM nearest nr
    JOIN graph_edges e
      ON e.${step}    = nr.node_id
     AND e.tenant_id  = $1
     AND e.repo_id    = $2
     AND e.kind       = ANY($5::text[])
     AND e.source     = ANY($6::text[])
   WHERE (nr.distance = 1 AND e.${anchor} = ANY($3::uuid[]))
      OR EXISTS (SELECT 1 FROM nearest p
                  WHERE p.node_id = e.${anchor} AND p.distance = nr.distance - 1)
   ORDER BY nr.node_id, e.weight DESC, e.kind ASC, e.source ASC
)
SELECT b.node_id, b.distance, b.edge_kind, b.edge_source, b.weight,
       n.kind, n.path, n.name, n.language
  FROM best b
  JOIN graph_nodes n ON n.id = b.node_id AND n.tenant_id = $1
 ORDER BY b.distance ASC, b.weight DESC, n.path ASC
 LIMIT $7 + 1`
}

/**
 * Exportada, y solo por esto: `test/performance.test.ts` le hace `EXPLAIN` y
 * comprueba que el plan real usa el indice inverso
 * `graph_edges_tenant_id_repo_id_to_node_id_kind_idx` y no un seq scan. La
 * migracion 0007 afirma que sin ese indice el criterio de 200 ms es
 * inalcanzable; asi esa afirmacion se comprueba en vez de creerse.
 */
export const DEPENDENTS_SQL = traversalSql('dependents')
const DEPENDENCIES_SQL = traversalSql('dependencies')

/**
 * Igual que el anterior pero agregando por nodo: en vez de quedarse con una
 * arista, junta TODAS las senales distintas que lo alcanzaron. Es lo que
 * permite responder "que predijo esto: el analisis estatico, el grafo de build
 * o el historial de git" sin una segunda consulta.
 */
function blastRadiusSql(): string {
  const { anchor, step } = DIRECTIONS.dependents
  return `${reachableCte('dependents')}
, aggregated AS (
  SELECT nr.node_id,
         nr.distance,
         array_agg(DISTINCT e.source ORDER BY e.source) AS sources,
         array_agg(DISTINCT e.kind   ORDER BY e.kind)   AS edge_kinds,
         max(e.weight)::double precision                AS weight
    FROM nearest nr
    JOIN graph_edges e
      ON e.${step}   = nr.node_id
     AND e.tenant_id = $1
     AND e.repo_id   = $2
     AND e.kind      = ANY($5::text[])
     AND e.source    = ANY($6::text[])
   WHERE e.${anchor} = ANY($3::uuid[])
      OR EXISTS (SELECT 1 FROM nearest p
                  WHERE p.node_id = e.${anchor} AND p.distance < $4)
   GROUP BY nr.node_id, nr.distance
)
SELECT a.node_id, a.distance, a.sources, a.edge_kinds, a.weight,
       n.kind, n.path, n.name, n.language
  FROM aggregated a
  JOIN graph_nodes n ON n.id = a.node_id AND n.tenant_id = $1
 ORDER BY a.distance ASC, a.weight DESC, n.path ASC
 LIMIT $7 + 1`
}

const BLAST_RADIUS_SQL = blastRadiusSql()

function parseInput<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    // La causa viaja entera: nunca se traga el detalle de por que fallo.
    throw new ValidationError(`Entrada invalida para ${what}: ${parsed.error.message}`, {
      cause: parsed.error,
    })
  }
  return parsed.data
}

/**
 * ---------------------------------------------------------------------------
 * POR QUE EL RESULTADO NO ES UN ARRAY PELADO
 * ---------------------------------------------------------------------------
 * Estas consultas recortan a `limit` (200 por defecto, 1.000 como techo). Sobre
 * un repositorio real ese tope SE SATURA, y devolver solo el array haria que
 * "no hay mas afectados" y "hay mas y no te los he contado" fueran
 * indistinguibles. El consumidor natural de esto es un agente decidiendo si un
 * cambio es seguro: un falso "no hay nada mas" es exactamente el fallo que este
 * epic existe para evitar.
 *
 * Por eso se piden `limit + 1` filas y se devuelve `truncated` explicito. La
 * capa MCP (`src/mcp/budget.ts`) ya aplicaba este mismo criterio de contador
 * honesto; ahora lo aplica tambien la capa de consulta, para CUALQUIER otro
 * consumidor (los claims de T04, por ejemplo).
 */
export interface TraversalResult {
  readonly hits: readonly TraversalHit[]
  /** `true` si habia mas resultados de los que cabian en `limit`. */
  readonly truncated: boolean
}

export interface BlastRadiusResult {
  readonly hits: readonly BlastRadiusHit[]
  readonly truncated: boolean
}

function toTraversalHit(row: unknown): TraversalHit {
  const parsed = traversalRowSchema.parse(row)
  return {
    nodeId: parsed.node_id,
    kind: parsed.kind,
    path: parsed.path,
    name: parsed.name,
    language: parsed.language,
    distance: parsed.distance,
    edgeKind: parsed.edge_kind,
    edgeSource: parsed.edge_source,
    weight: parsed.weight,
  }
}

async function traverse(
  sql: string,
  input: z.output<typeof blastRadiusInputSchema>,
): Promise<TraversalResult> {
  return withTenantConnection(async (tx) => {
    const result = await tx.query(sql, [
      tx.tenantId,
      input.repoId,
      input.nodeIds,
      input.depth,
      input.edgeKinds,
      input.sources,
      input.limit,
    ])
    const truncated = result.rows.length > input.limit
    const rows = truncated ? result.rows.slice(0, input.limit) : result.rows
    return { hits: rows.map(toTraversalHit), truncated }
  })
}

/**
 * DEPENDENCIAS INVERSAS: quien depende (transitivamente) del nodo dado.
 *
 * Es la consulta que contesta "si toco esto, que mas se ve afectado". Devuelve
 * el conjunto transitivo hasta `depth`, cada nodo UNA vez y con su distancia
 * MINIMA, mas el `edgeSource` de la arista por la que se llego — y `truncated`,
 * que dice si ese conjunto esta completo.
 */
export async function findDependents(input: TraversalInput): Promise<TraversalResult> {
  const { nodeId, ...rest } = parseInput(traversalInputSchema, input, 'findDependents')
  return traverse(DEPENDENTS_SQL, { ...rest, nodeIds: [nodeId] })
}

/** El sentido natural de la arista: de que depende (transitivamente) el nodo dado. */
export async function findDependencies(input: TraversalInput): Promise<TraversalResult> {
  const { nodeId, ...rest } = parseInput(traversalInputSchema, input, 'findDependencies')
  return traverse(DEPENDENCIES_SQL, { ...rest, nodeIds: [nodeId] })
}

/**
 * Radio de impacto de un conjunto de nodos que cambian a la vez (los ficheros
 * de un PR, por ejemplo): la union de sus dependientes transitivos, ranqueada
 * por cercania y peso, con las senales que predijeron cada resultado.
 *
 * Los propios nodos de entrada NO salen en el resultado: lo que se pregunta es
 * que MAS se ve afectado.
 */
export async function blastRadius(input: BlastRadiusInput): Promise<BlastRadiusResult> {
  const parsed = parseInput(blastRadiusInputSchema, input, 'blastRadius')
  return withTenantConnection(async (tx) => {
    const result = await tx.query(BLAST_RADIUS_SQL, [
      tx.tenantId,
      parsed.repoId,
      parsed.nodeIds,
      parsed.depth,
      parsed.edgeKinds,
      parsed.sources,
      parsed.limit,
    ])
    const truncated = result.rows.length > parsed.limit
    const rows = truncated ? result.rows.slice(0, parsed.limit) : result.rows
    return {
      hits: rows.map((row) => {
        const parsedRow = blastRadiusRowSchema.parse(row)
        return {
          nodeId: parsedRow.node_id,
          kind: parsedRow.kind,
          path: parsedRow.path,
          name: parsedRow.name,
          language: parsedRow.language,
          distance: parsedRow.distance,
          sources: parsedRow.sources,
          edgeKinds: parsedRow.edge_kinds,
          weight: parsedRow.weight,
        }
      }),
      truncated,
    }
  })
}

const findNodesByPathInputSchema = z.object({
  repoId: uuidSchema,
  paths: z.array(z.string().min(1)).min(1).max(1000),
  kind: z.enum(NODE_KINDS).default('file'),
})
export type FindNodesByPathInput = z.input<typeof findNodesByPathInputSchema>

/**
 * Resuelve rutas de fichero a nodos del grafo. Existe porque quien pregunta
 * parte casi siempre de un diff o de una lista de ficheros, no de uuids; el
 * resultado se le pasa a `blastRadius`.
 */
export async function findNodesByPath(input: FindNodesByPathInput): Promise<GraphNodeRef[]> {
  const parsed = parseInput(findNodesByPathInputSchema, input, 'findNodesByPath')
  return withTenantConnection(async (tx) => {
    const result = await tx.query(
      `SELECT n.id AS node_id, n.kind, n.path, n.name, n.language
         FROM graph_nodes n
        WHERE n.tenant_id = $1
          AND n.repo_id   = $2
          AND n.kind      = $3
          AND n.path      = ANY($4::text[])
        ORDER BY n.path`,
      [tx.tenantId, parsed.repoId, parsed.kind, parsed.paths],
    )
    return result.rows.map((row) => {
      const parsedRow = nodeRefRowSchema.parse(row)
      return {
        nodeId: parsedRow.node_id,
        kind: parsedRow.kind,
        path: parsedRow.path,
        name: parsedRow.name,
        language: parsedRow.language,
      }
    })
  })
}
