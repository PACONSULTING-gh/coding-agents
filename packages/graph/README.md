# @coord/graph — grafo de dependencias del código

Responde a una sola pregunta, y es la que justifica el epic 02: **si toco esto,
qué más se ve afectado**.

Estado a día de T05 (epic 02 completo): el esquema, las consultas de
recorrido, la **ingesta incremental** con tree-sitter, el grafo nativo de
build (Nx/Turborepo), el overlay de co-cambio desde `git log`, los claims
sobre issues y ficheros, y el grafo expuesto como **servidor MCP** —
`find_dependents`, `find_dependencies`, `blast_radius`, `who_last_touched` y
`active_claims` — para que un agente **pregunte** en vez de leer ficheros a
ciegas (§7).

---

## 1. Dónde vive el grafo

En el **mismo Postgres** que el resto del dominio, como lista de adyacencia
(`graph_nodes` + `graph_edges`) recorrida con CTEs recursivas. La decisión está
cerrada en CLAUDE.md §3 y §4: en el patrón que usamos —expansión de vecindario
acotada, no pathfinding profundo— Postgres gana, y una base de datos de grafos
solo se reconsidera con una **p95 degradada y medida** delante. No la
re-litigues aquí; si crees que está mal, abre un ADR.

El esquema es la migración `packages/db/migrations/0007_graph_nodes_and_edges.sql`,
en la misma cadena que las del dominio: un solo runner, un solo orden.

| Tabla              | Para qué                                                                    |
| ------------------ | --------------------------------------------------------------------------- |
| `graph_nodes`      | Ficheros, símbolos, paquetes y targets. Clave natural por tenant y repo     |
| `graph_edges`      | `imports`/`calls`/`inherits`/`contains`/`cochange`, con `source` y `weight` |
| `graph_files`      | Hash de contenido por fichero: es lo que hace incremental la ingesta (T02)  |
| `graph_ingestions` | Estado y checkpoint de cada pasada: es lo que permite reanudarla (T02)      |

Las cuatro llevan `tenant_id`, RLS `ENABLE` **y** `FORCE`, política con `USING` y
`WITH CHECK`, y claves ajenas **compuestas** contra `(tenant_id, id)`: mezclar
tenants no es algo que esté desaconsejado, es algo que el motor impide.

### `source` no es decoración

`graph_edges.source` dice **qué señal produjo la arista**: `static` (tree-sitter),
`build` (Nx/Turborepo — Bazel deliberadamente NO soportado, ver §5) o `git`
(co-cambio histórico). Viaja en el resultado
de las consultas porque el criterio de T03 y T05 es que cada afectado indique qué
lo predijo. Por eso forma parte de la clave natural de la arista: la misma pareja
de nodos puede estar unida por un import estático **y** por un co-cambio, y
perder una de las dos sería perder información.

### Los dos índices, y por qué son dos

```
(tenant_id, repo_id, from_node_id, kind)   -- dependencias: de qué depende X
(tenant_id, repo_id, to_node_id,   kind)   -- DEPENDIENTES: quién depende de X
```

La consulta que importa recorre la arista **al revés**. Sin el segundo índice,
cada nivel de la recursión es un seq scan de la tabla de aristas y el criterio de
200 ms en p95 es inalcanzable. `test/performance.test.ts` hace `EXPLAIN` de la
consulta real (como `app_runtime`, con el predicado de la RLS incluido) y falla
si el plan deja de usarlo.

---

## 2. Las consultas

```ts
import { runWithTenant } from '@coord/core'
import { blastRadius, findDependents, findNodesByPath } from '@coord/graph'

await runWithTenant({ tenantId }, async () => {
  const [nodo] = await findNodesByPath({ repoId, paths: ['src/schema.ts'] })
  const afectados = await blastRadius({ repoId, nodeIds: [nodo.nodeId], depth: 3 })
})
```

- `findDependents` — quién depende (transitivamente) del nodo. **Dependencias
  inversas**: la consulta que contesta "si toco esto, qué se rompe".
- `findDependencies` — el sentido natural de la arista.
- `blastRadius` — lo mismo desde varios nodos a la vez (los ficheros de un PR),
  agregando **todas** las señales que alcanzaron cada resultado y ranqueando por
  cercanía y peso.
- `findNodesByPath` — resuelve rutas a nodos, porque quien pregunta parte de un
  diff, no de uuids.

Todas corren dentro de `withTenantConnection` de `@coord/db`. **Este paquete no
abre pool propio**: el grafo contiene la estructura del código de cada cliente,
así que un atajo aquí significa filtrar el código de un cliente a otro.

### Las dos guardas de la CTE recursiva

No son opcionales y las dos son criterio de aceptación:

1. **Tope de profundidad**, parámetro con techo duro (`MAX_TRAVERSAL_DEPTH`).
   Sin él una consulta cualquiera expande el grafo entero y la respuesta deja de
   caber en el presupuesto de contexto de un agente, que es justo lo que estas
   herramientas existen para evitar.
2. **Guarda de ciclos**: deduplicación por nodo y distancia — `UNION` (no
   `UNION ALL`) con el término recursivo proyectando sólo `(node_id, distance)`.
   Un repositorio real **tiene** ciclos de imports; sin esto la consulta no
   devuelve un resultado malo, se queda colgada reteniendo una conexión del pool.

   La guarda anterior acumulaba el **camino** recorrido en un array. Terminaba y
   daba el mismo resultado, pero enumeraba CAMINOS en vez de NODOS, así que el
   coste crecía de forma combinatoria con la profundidad: medido sobre el
   escenario de `test/performance.test.ts` (12.000 nodos, 43.500 aristas), p95 de
   6,9 ms a profundidad 4 pero ~1.800 ms a profundidad 10 —nueve veces el
   presupuesto, en un caso que la propia API permite pedir—. Con la guarda por
   nodo, la misma consulta a profundidad 10 baja a 107 ms. Los datos de la arista
   por la que se llegó se recuperan en una segunda pasada.

Cada nodo sale **una sola vez**, con su distancia **mínima**. El nodo (o los
nodos) de partida nunca salen en su propio resultado: lo que se pregunta es qué
_más_ se ve afectado.

### El resultado dice si está recortado

`findDependents`, `findDependencies` y `blastRadius` devuelven
`{ hits, truncated }`, no un array pelado. Recortan a `limit` (200 por defecto,
1.000 como techo) y sobre un repositorio real ese tope **se satura**: sin
`truncated`, "no hay más afectados" y "hay más y no te los he contado" serían
indistinguibles, y el consumidor natural de esto es un agente decidiendo si un
cambio es seguro.

---

## 3. La ingesta (T02)

```ts
import { runWithTenant } from '@coord/core'
import { ingestRepository } from '@coord/graph'

await runWithTenant({ tenantId }, () =>
  ingestRepository({ repoId, repoPath: '/var/lib/coord/checkouts/owner/repo' }),
)
```

Devuelve los contadores de la pasada (`filesPlanned`, `filesSkipped`,
`filesParsed`, `edgesInserted`, `unresolvedImports`, `unresolvedReferences`…),
que son los mismos que quedan persistidos en `graph_ingestions.checkpoint`.

### 3.1 Incremental, y por eso reanudable

La lista de ficheros sale de `git ls-files`, que **respeta `.gitignore` gratis**
y sin ninguna dependencia nueva (`node:child_process` es stdlib). De cada
fichero se guarda un sha-256 de su contenido en `graph_files`:

| Situación             | Qué pasa                                                          |
| --------------------- | ----------------------------------------------------------------- |
| El hash coincide      | **No se parsea** y sus aristas **no se tocan**. Ni un `UPDATE`.   |
| El hash cambió        | Se reparsea; sus símbolos y sus aristas salientes se regeneran.   |
| El fichero ya no está | Sus nodos caen, y con ellos **todas** las aristas que lo tocaban. |

Lo importante del tercer caso: las aristas que **apuntaban** al fichero borrado
desaparecen por las claves ajenas `ON DELETE CASCADE` de la migración 0007, sin
necesidad de reparsear a los ficheros que las escribieron. No quedan referencias
colgando.

Los nodos se escriben con **UPSERT sobre la clave natural**, nunca borrando y
recreando. Si se recrearan, cada reindexación cambiaría el `id` de un símbolo y
tumbaría por cascada las aristas que otros ficheros —que no han cambiado y no se
van a reparsear— tienen hacia él: el grafo se iría vaciando solo, en silencio.

### 3.2 Dos fases, y por qué

1. `symbols` — nodos de símbolo, aristas `contains` e `imports`, y el hash.
2. `references` — aristas `calls` e `inherits`.

`calls`/`inherits` apuntan a símbolos que pueden estar en **otro** fichero de la
misma pasada. Resolverlas en la primera fase haría que una arista existiera o no
según el orden en que se procesan los ficheros: en una indexación inicial, donde
todo es nuevo, se perdería cerca de la mitad y de forma no reproducible. El
precio es parsear dos veces cada fichero modificado, y se paga a propósito.

### 3.3 Reanudación

El plan (qué ficheros hay que parsear, cuáles desaparecieron) se congela en
`graph_ingestions.checkpoint` al empezar y **no se recalcula** al reanudar: en
cuanto la primera tanda graba su hash nuevo, un plan recalculado la daría por
"sin cambios" y la ingesta "terminaría" habiendo hecho la mitad del trabajo.

Cada lote escribe **sus datos y su checkpoint en la misma transacción**: o se
confirman los dos o ninguno. Un `SIGKILL` entre lotes deja el checkpoint
diciendo exactamente por dónde iba, y la siguiente llamada continúa desde ahí —
también si la anterior murió con `status = 'failed'`, porque un fallo transitorio
no debería obligar a reindexar el repositorio entero. El motivo del fallo queda
escrito en `graph_ingestions.error`: un `failed` mudo obliga a reproducirlo todo
para saber qué pasó.

`p-limit` acota cuántos ficheros se leen y se parsean a la vez. tree-sitter es
**síncrono**: eso no paraleliza CPU, lo que acota es la lectura de disco
simultánea y cuántos árboles sintácticos hay vivos en memoria.

---

## 4. Los parsers: añadir un lenguaje es añadir un fichero

`src/parse/` tiene un módulo por lenguaje (`typescript.ts` —que cubre TSX con su
propia gramática—, `javascript.ts`, `python.ts`) detrás de una interfaz común
`LanguageParser`. El motor de ingesta no sabe nada de tree-sitter: consume
`LanguageParser` y nada más. Un lenguaje nuevo es un módulo aquí y una línea en
`src/parse/index.ts`.

Se extraen `imports` (incluidos `import type`, `export … from`, `require`,
`import()` con literal, y en Python `import` / `from … import`), `contains`
(fichero → símbolo), `calls` e `inherits`. Todas con `source: 'static'` y
`weight: 1.0`.

**Símbolos: solo declaraciones de nivel superior con nombre.** No se crean nodos
para métodos: un método no tiene nombre único dentro del fichero (dos clases
pueden tener `run()`) y la clave natural del nodo es (ruta, nombre); nodos
ambiguos producen aristas ambiguas. Las llamadas que salen del cuerpo de un
método se atribuyen al símbolo de nivel superior que lo contiene.

### 4.1 Política de resolución — lo que no se resuelve, NO se inventa

Esta es la parte que de verdad decide si el grafo sirve. **Un grafo con aristas
fantasma es peor que uno incompleto**, porque nadie sabe cuáles creerse y todo lo
que se construye encima hereda la mentira. Por eso lo que no se resuelve se
descarta y se **cuenta** (`unresolvedImports`, `unresolvedReferences`).

**Node / TypeScript**, para un especificador relativo (`./`, `../`): se normaliza
contra el directorio del fichero y se prueba, en este orden, contra el conjunto
de ficheros seguidos por git:

1. Reescritura de extensión del ESM de TypeScript: `./x.js` → `x.ts`, `x.tsx`,
   `x.js`, `x.jsx` (y `.mjs`→`.mts`, `.cjs`→`.cts`). Sin esto, **todo** repo de
   TypeScript en ESM —incluido este— quedaría con cero aristas de import.
2. La ruta tal cual.
3. La ruta con cada extensión conocida.
4. `ruta/index.<ext>`.

La primera que exista gana; si no existe ninguna, **no hay arista**.

Un especificador **nudo** (`pg`, `@coord/db`, `node:fs`) es un nodo `package`,
nunca un fichero: el paquete existe de verdad como dependencia, pero fingir que
apunta a un fichero del repo sería inventárselo. Un fichero del repo que se llame
igual que un paquete (`src/zod.ts` frente a `import 'zod'`) **no** produce arista
hacia ese fichero, y hay un test que lo comprueba. Los subcaminos se colapsan al
paquete (`lodash/merge` → `lodash`). Los imports internos (`#algo`) quedan sin
resolver: resolverlos exigiría interpretar el `package.json` de cada paquete.

> Los paquetes del **workspace** (`@coord/db`) se quedan como nodo `package`
> aunque T03 ya exista: la ingesta de build (§5) crea nodos `target` a partir
> del nombre del proyecto en Nx/Turbo, no a partir del nombre del paquete npm
> que declara su `package.json`, así que unir los dos nodos exigiría leer y
> resolver ese `package.json` por proyecto — deliberadamente fuera de alcance
> de T03 (no es criterio de aceptación; ver la cabecera de `src/build/ingest.ts`).

**Python**: los puntos iniciales cuentan niveles de paquete desde el directorio
del fichero; un módulo absoluto se busca desde la **raíz** del repositorio. En
los dos casos se prueban `ruta.py` y `ruta/__init__.py`. No se adivinan otras
raíces de fuentes (`src/`, `PYTHONPATH`): adivinarlas produciría aristas hacia
ficheros que quizá no son ese módulo. Lo que no cae dentro del repo es un nodo
`package` con el primer segmento del nombre (`os.path` → `os`). `from . import x`
se resuelve al **módulo** `x` del paquete, que es de lo que de verdad se depende.

**`calls` e `inherits`** se resuelven a un símbolo del mismo fichero, o a uno
importado **por nombre** (o a través de un namespace, `ns.foo`) desde un fichero
que sí resolvió. Un import por defecto (`import D from './d.js'`) no dice qué
nombre tiene `D` en su módulo de origen: **no se resuelve**. Un acceso de dos
niveles (`a.b.c()`) tampoco.

### 4.2 Enganche al worker

`apps/worker` procesa el evento `push` encolando un job `graph.ingest` por el
`QueuePort` que ya existe; el procesador de esa cola es quien indexa. El handler
del webhook **no** indexa: corre dentro de la transacción del tenant que escribe
la auditoría, y una ingesta tarda segundos.

El código a indexar sale de un checkout local (`GRAPH_CHECKOUT_ROOT`, con la
forma `<raíz>/<owner>/<repo>`). Clonar y actualizar checkouts no es de esta
tarea: **sin esa variable el enganche no se registra** y se dice en el log. Es
una decisión explícita y visible, no un fallo silencioso.

### 4.3 Indexar a mano: `graph:index`

El webhook no es la única vía. Para probar el grafo —o el servidor MCP— sin
registrar la GitHub App ni montar un túnel:

```bash
pnpm --filter @coord/graph graph:index -- \
  --repo PACONSULTING-gh/coding-agents --path "$PWD"
```

```
Indexado PACONSULTING-gh/coding-agents desde /home/jviserass/…/CodingAgents
  repo_id      cab7ee9f-32db-5bbc-8e3a-d071e4481aa1
  commit       b049b960c6ba769c5068a92344e33da200247ff3
  ficheros     136 parseados · 55 sin cambios · 0 borrados
  grafo        359 nodos · 937 aristas
  build        sin Nx ni Turborepo en este repo
  co-change    0 aristas
  sin resolver 2 imports (se descartan: el grafo no inventa aristas)
  tiempo       420 ms
```

**El tenant no tiene valor por defecto**, ni lo tendrá: la RLS lo exige, y un
comando que eligiera uno sería justo el atajo que rompe el aislamiento sin que
nadie se entere. Sale de `--tenant`, de `GRAPH_TENANT_ID`, o de
`GRAPH_MCP_TENANT_ID` — este último a propósito, para que **lo que escribe el
comando sea lo que consulta el agente**, sin ids que copiar a mano.

El `repo_id` se deriva del tenant y del `owner/repo`, igual que en el worker y en
el servidor MCP (§1). Por eso `--repo` es la identidad lógica y `--path` solo dice
dónde está el checkout: puedes indexar un directorio cualquiera y seguirá
escribiendo en el grafo del repositorio que le digas.

La secuencia (estáticas → build → co-change) vive en `indexRepository`, y la usan
**el worker y el comando**. Si algún día se añade una cuarta señal, entra por un
solo sitio: duplicarla significaría que la vía menos usada se queda atrás sin que
nadie lo note.

`--json` para scripts. Un directorio que no es un repositorio git falla **antes**
de tocar la base, diciendo por qué.

---

## 5. Grafo nativo de build y overlay de co-cambio (T03)

Dos fuentes de señal mas allá del análisis estático de T02, en `src/build/` y
`src/cochange/` respectivamente. Ninguna toca `queries.ts`: T01 ya devolvía
`edgeSource`/`sources` por arista, así que las aristas `build` y `git` que
produce T03 fluyen por `findDependents`/`blastRadius` sin cambiar su firma
(`test/provenance.test.ts` lo prueba con un grafo que mezcla las tres señales).

### 5.1 Grafo nativo de build (`src/build/`)

Detecta la herramienta mirando **solo los ficheros de configuración** de la
raíz del repo (`nx.json`, `turbo.json`) — no ejecuta nada para detectar, y la
ausencia total no es un error: la ingesta de build simplemente no aporta
aristas. Cada proyecto se escribe como nodo `target` (`path` = su directorio
raíz, `name` = su nombre en la herramienta); las dependencias entre proyectos,
como arista `imports`/`source: 'build'`/`weight: 1.0` (migración 0007: el peso
de build es binario, la frecuencia solo tiene sentido en `cochange`).

```ts
import { runWithTenant } from '@coord/core'
import { ingestBuildGraph } from '@coord/graph'

await runWithTenant({ tenantId }, () => ingestBuildGraph({ repoId, repoPath }))
```

**Nx**: `nx graph --file=<salida>.json`. La forma está verificada **ejecutando
la herramienta** (Nx 23.2.0), no leyendo documentación: todo cuelga de `graph`,
y `nodes` es un **mapa por nombre**, no un array `projects`.

```json
{
  "graph": {
    "nodes": { "app1": { "name": "app1", "type": "lib", "data": { "root": "packages/app1" } } },
    "dependencies": { "app1": [{ "source": "app1", "target": "lib1", "type": "static" }] }
  }
}
```

El validador anterior esperaba `projects`/`dependencies` en la raíz —una forma
que Nx no produce—, así que contra un repo con Nx de verdad `ingestBuildGraph`
lanzaba `ValidationError` y no aportaba ni una arista. El fixture del test se
había escrito a imagen del validador, no de la herramienta, y por eso el test
pasaba con la funcionalidad rota. Ahora el fixture es la salida **literal** de
`nx graph --file` (`test/fixtures/nx-graph-23.2.0.json`).

**Turborepo, y por qué NO es `turbo run build --graph` (desviación del
contexto de la tarea, documentada)**: la documentación oficial de Turborepo
marca la salida `--graph=archivo.json` como **deprecated, eliminada en 3.0**
("Formats like png, jpg, pdf, and json are deprecated and scheduled for
removal in version 3.0"), y señala la vía programática soportada: `turbo
query`, una interfaz GraphQL disponible desde 2.2. `src/build/turborepo.ts` usa
`turbo query 'query { packages { items { name path directDependencies { items { name } } } } }'`
en su lugar — construir esto sobre una salida que la propia herramienta dice
que va a desaparecer sería escribir código muerto a propósito.

Dos cosas de la respuesta REAL (comprobadas ejecutando turbo 2.10.12) que la
versión anterior no contemplaba y que la rompían del todo:

- `directDependencies` **no** es una lista de paquetes, es un envoltorio
  `Packages` con `items`. La consulta anterior era inválida contra el esquema
  GraphQL y `turbo query` respondía
  `{"data":null,"errors":[{"message":"Unknown field \"name\" on type \"Packages\"."}]}`,
  con lo que la ingesta abortaba **siempre**.
- La respuesta incluye el propio workspace como un paquete más, con
  `name: "//"` y `path: ""`. Se **filtra** explícitamente, en `projects` y en
  las dependencias directas: no es un proyecto, no tiene directorio propio, y
  la clave natural de `graph_nodes` exige una ruta no vacía —sin filtrarlo, esa
  fila invalidaría la respuesta entera—.

**Bazel: decisión explícita de NO soportarlo, no un olvido.** `bazel query
--output=proto` no vuelca un JSON normalizado como Nx o `turbo query`: exige
compilar el `.proto` de Bazel y resolver qué versión hay instalada (el formato
varía entre versiones), para un cliente que hoy no usa Bazel. `src/build/detect.ts`
ni siquiera reconoce `WORKSPACE`/`BUILD.bazel`: detectarlo sin ingerirlo sería
peor que no detectarlo, parecería soportado sin estarlo. El disparador para
reconsiderarlo es medible (CLAUDE.md §4): un cliente real con Bazel.

Cada pasada **sustituye** el grafo de build anterior de esa herramienta
(`source = 'build' AND metadata->>'buildTool' = ...`): a diferencia de la
ingesta estática, Nx/Turbo entregan el grafo completo cada vez, así que no hay
un "solo lo que cambió" que resolver — sustituir es lo que evita acumular
aristas de proyectos que dejaron de depender entre sí.

Frontera de confianza: `parseNxGraph`/`parseTurboGraph` validan con zod ANTES
de que `ingestParsedBuildGraph` abra transacción — un JSON con forma
incorrecta, o una respuesta de `turbo query` con `errors`, falla ruidoso con el
motivo y no escribe nada.

El camino de entrada COMPLETO —detectar la herramienta, ejecutar su CLI de
verdad, parsear su salida real y escribir— **sí tiene test**:
`test/build-cli.test.ts` crea un workspace mínimo, instala Nx o Turborepo y
ejecuta `ingestBuildGraph` de extremo a extremo. Es el único test que habría
detectado los dos fallos de arriba, y por eso existe. No corre por defecto
porque instalar con npm necesita **red**, y un test que depende de la red en
cada `pnpm test` convierte un corte de npm en un CI rojo que nadie sabe
interpretar; se activa a propósito:

```bash
GRAPH_BUILD_CLI_TESTS=1 pnpm --filter @coord/graph test build-cli
```

El salto no es silencioso: sin la variable, el fichero declara un test que dice
en voz alta que la comprobación no se ha hecho y cómo hacerla.

### 5.2 Overlay de co-cambio (`src/cochange/`)

Mina `git log` (con `node:child_process`, cero dependencias nuevas) para
aristas `cochange`/`source: 'git'` entre ficheros que cambian juntos
repetidamente. Solo conecta ficheros que **ya tienen** nodo `file` en el grafo
(los que T02 indexó): un `README.md` que co-cambia con un `.ts` no inventa un
nodo, se descarta y se cuenta (`unresolvedPairs`).

```ts
import { runWithTenant } from '@coord/core'
import { ingestCochange } from '@coord/graph'

await runWithTenant({ tenantId }, () => ingestCochange({ repoId, repoPath }))
```

Cuatro decisiones, documentadas con su motivo en la cabecera de
`src/cochange/mine.ts` (resumen aquí, detalle allí):

| Decisión                    | Valor por defecto             | Por qué                                                                                                                                                                                                                                                     |
| --------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Umbral mínimo de co-cambios | 3 (`minCochanges`)            | Con 1, cualquier coincidencia de un commit ajeno a los dos ficheros ya genera arista. Repetición separa acoplamiento real de azar.                                                                                                                          |
| Tope de ficheros por commit | 50 (`maxFilesPerCommit`)      | Un commit de 400 ficheros (merge, "format all") generaría ~80.000 pares de un solo commit y ahogaría la señal. El commit se descarta **entero** — ni pares ni denominador — no se trunca su lista.                                                          |
| Ventana de historial        | 6 meses (`sinceMonths`)       | Tiempo, no conteo de commits: la cadencia de commits varía tanto entre repos que "los últimos N commits" no es una ventana comparable entre ellos.                                                                                                          |
| Peso                        | **Lift**, no frecuencia bruta | `lift(A,B) = coCambios·N / (cambios(A)·cambios(B))`. La frecuencia bruta favorece a ficheros que cambian mucho por su cuenta (un `CHANGELOG.md`); el lift corrige por eso. La frecuencia bruta sigue disponible en `metadata.cochangeCount` de cada arista. |

**Renombrados**: `git log` corre con `--no-renames` explícito, para que el
resultado no dependa de `diff.renames` en el `.gitconfig` de quien ejecute la
ingesta. Un fichero renombrado es dos identidades de ruta distintas; su
historial de co-cambio anterior al renombrado se pierde con el nombre antiguo.
Seguirlo de verdad exigiría `--follow`, que solo sigue un fichero cada vez —
no escala a una pasada de minado sobre el repo entero.

**Simetría**: el co-cambio no tiene una dirección de dependencia más real que
otra (A y B cambiaron juntos), así que cada par se escribe en **los dos
sentidos** (`graph_edges` es dirigida) — es lo que hace que el fichero
aparezca como afectado busque quien busque desde cualquiera de los dos.

Cada pasada **sustituye** todas las aristas `cochange`/`git` del repo (se
remina el historial completo cada vez, no es incremental como T02).

---

## 6. Claims y leases sobre issues y ficheros (T04)

Lo que evita que dos agentes de **dos personas distintas** se pisen. La API está
en `src/claims.ts`; el vocabulario de dominio (`Claim`, `ClaimSubject`,
`ClaimHolder`, `ClaimConflict`) vive en `@coord/core`, que no toca la base.

```ts
const lease = await runWithTenant({ tenantId, actorId: ana.id }, () =>
  claim({
    repoId,
    subject: { kind: 'issue', key: '15' },
    holder: { kind: 'user', id: ana.id, label: 'Ana Pérez' },
    ttlSeconds: 3600,
    files: ['packages/graph/src/claims.ts'],
  }),
)
```

`claim` · `release` · `renew` · `activeClaims` · `checkOverlap`, todo por
`withTenantConnection`.

`activeClaims` devuelve `{ claims, truncated }`, no un array pelado: es una vista
que un supervisor mira para saber quién tiene qué, y una lista recortada en
silencio le haría creer que está completa.

`checkOverlap` calcula el solape **exacto** con su propia consulta acotada por
los ficheros preguntados (como mucho `MAX_CLAIM_FILES`), no filtrando en memoria
todos los claims del repositorio. Ese camino perdía solapes en silencio en cuanto
un repo pasaba del límite —alcanzable con cinco claims de 200 ficheros—, y un
falso "no hay solape" en la superficie que existe para avisar de colisiones es el
peor fallo posible. Lo que sí está acotado (y lo dice, en `graphProbeTruncated`)
es el sondeo por vecindad en el grafo.

### 6.1 El epic pedía algo imposible, y esto no es lo que pedía

T04 dice _"advisory locks de Postgres, **transaccionales y con TTL**"_. Las tres
propiedades no pueden darse a la vez: un lock transaccional muere en el `COMMIT`
y uno de sesión **no funciona bajo PgBouncer en modo transacción**, que es
decisión cerrada (CLAUDE.md §3). Además un lock no sabe decir **de quién es**, y
eso es un criterio de aceptación de la propia tarea.

La discrepancia está registrada en
[`docs/adr/0004-claims-como-lease-en-tabla.md`](../../docs/adr/0004-claims-como-lease-en-tabla.md).
**No la re-litigues aquí.**

Lo que se implementa:

| Pieza                                            | Papel                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| Tabla `claims` (migración `0008`)                | **Fuente de verdad.** Vivo = `released_at IS NULL AND expires_at > now()`  |
| `pg_advisory_xact_lock(tenant, repo)`            | Serializa **solo** la operación de reclamar, dentro de UNA transacción     |
| Índice único parcial `WHERE released_at IS NULL` | Red del motor: dos claims sin liberar sobre el mismo sujeto son imposibles |

### 6.2 Por qué el índice único no puede llevar `now()`

El predicado de un índice parcial tiene que ser **inmutable**, y `now()` no lo
es: Postgres rechaza `WHERE ... AND expires_at > now()` con `42P17`. Si lo
aceptara, la pertenencia de una fila al índice cambiaría sola con el paso del
tiempo.

Se resuelve **materializando la caducidad**: la propia operación de reclamar, ya
dentro del advisory lock, marca `released_at = now(), released_reason = 'expired'`
en los claims del sujeto que ya vencieron, y solo después inserta. Ese **segado
es un paso en línea de la transacción**, no un proceso de fondo — por eso el
índice puede ser `WHERE released_at IS NULL` a secas, que es inmutable, y por eso
**ningún proceso de limpieza forma parte de la corrección**.

Las dos guardas están comprobadas por mutación: desactivando el advisory lock la
ronda 1 de la carrera sigue pasando y las rondas 2-5 fallan (los perdedores
reciben la violación cruda del índice, sin decir quién lo tiene); desactivando el
segado, el test de caducidad falla. Ninguna de las dos sobra.

### 6.3 Quién puede renovar y liberar

Solo el titular, y la identidad sale del `actorId` del contexto — no de un
parámetro, que sería una declaración del propio llamante. Por eso `claim()`
**exige** `holder.id === actorId`: sin eso, "otro no puede renovar el claim
ajeno" no se puede sostener.

Un claim **caducado no se renueva**: en ese momento cualquiera pudo haberlo
reclamado, así que resucitarlo sería dárselo al que llega tarde. Se vuelve a
reclamar. Y **no hay override para humanos**: un claim atascado se suelta solo al
vencer su TTL. Dar a un supervisor la potestad de liberar el claim de otro es
RBAC, y merece decisión humana explícita (CLAUDE.md §2.1), no una opción `force`
colada aquí.

### 6.4 `checkOverlap`: el aviso útil no es solo la ruta exacta

Dos señales, y la segunda es la que hace útil a la primera:

- **`exact`** — alguien tiene reclamado literalmente ese fichero. Es el criterio
  de aceptación literal, y **nunca se trunca**.
- **`graph`** — nadie tiene ese fichero, pero el grafo de T01-T03 lo conecta con
  lo que tiene otro, **en los dos sentidos** (`findDependents` y
  `findDependencies`): o tu cambio le llega a él, o el suyo te llega a ti.

La parte de grafo cuesta dos consultas por claim ajeno, así que se acota a
`MAX_GRAPH_PROBES` sondeos; si se pasa, el resultado lo dice con
`graphProbeTruncated`, nunca en silencio. Se puede apagar entera con
`includeGraphNeighbourhood: false` para quedarse en el criterio literal.

### 6.5 La purga NO forma parte de la corrección

`purgeExpiredClaims` solo recorta el histórico para que la tabla no crezca sin
fin. Se engancha al `QueuePort` que ya existe:

- `registerClaimsPurgeProcessor(queue)` — una vez por proceso worker.
- `scheduleClaimsPurge(queue, { cron, retentionDays })` — **por tenant**, porque
  `QueuePort.schedule` congela el tenant al programar.

Si deja de correr, el sistema sigue siendo correcto y solo se acumulan filas.
**Todavía no está enganchada en `apps/worker`**: hacerlo requiere enumerar
tenants al arrancar, y eso es aprovisionamiento, que no existe aún.

---

## 7. Herramientas MCP (T05)

El punto de esta pieza: que un agente **pregunte** en vez de leer ficheros. Si
una respuesta fuera un volcado enorme, la herramienta le habría comido al
agente el mismo contexto que un `grep` sin filtrar — justo lo que existe para
evitar. Servidor MCP sobre `@modelcontextprotocol/sdk` (transporte **stdio**),
todo el código en `src/mcp/` (fitness function `mcp-sdk-solo-en-graph-mcp`,
§8): el SDK no sale de ahí, y `queries.ts`/`claims.ts` no saben que MCP
existe.

| Herramienta         | Contesta                                                                          |
| ------------------- | --------------------------------------------------------------------------------- |
| `find_dependents`   | Quién depende (transitivamente) de un fichero o símbolo: qué se rompe si lo tocas |
| `find_dependencies` | De qué depende (transitivamente) un fichero o símbolo                             |
| `blast_radius`      | Vas a cambiar estos ficheros: qué MÁS se ve afectado (unión, todas las señales)   |
| `who_last_touched`  | Quién tocó por última vez cada uno de estos ficheros — **personas**, no hashes    |
| `active_claims`     | Quién está trabajando en qué ahora mismo (T04), más reciente primero              |

### 7.1 De dónde sale el contexto de tenant

Un servidor MCP habla por stdio con **un** agente a la vez y no tiene sesión
HTTP de la que leer "quién pregunta" (a diferencia de `apps/webhook`, que lo
saca del mapeo de instalación de GitHub). La decisión, en `src/mcp/context.ts`:
**variable de entorno al arrancar el proceso** (`GRAPH_MCP_TENANT_ID`), no
argumento de cada llamada a herramienta — así el aislamiento entre tenants lo
garantiza quien despliega el servidor, no un dato que un LLM puede escribir en
una llamada. **Sin la variable (o si no es un uuid), el servidor no arranca**:
nunca se responde "todo" por no tener contexto (CLAUDE.md §2.6).

`GRAPH_CHECKOUT_ROOT` es aparte y solo la necesita `who_last_touched` (§7.4):
sin ella el servidor arranca igual — las otras cuatro herramientas no la
tocan — y la herramienta falla, con el motivo, **al llamarla**.

El repositorio, en cambio, **sí** es argumento de cada herramienta
(`repository`, como `"owner/repo"`): un tenant puede tener varios repos, y es
justo el dato que el agente sí conoce porque es el repo en el que está
trabajando. Cada herramienta lo traduce a `repoId` con la misma derivación
determinista que usa la ingesta (`repoIdForRepository`, T02) — no hay que
guardarlo en ningún sitio ni pedírselo al LLM de otra forma.

### 7.2 Presupuesto de contexto: ranking y contador honesto

Cada respuesta tiene tope de **bytes** (`MAX_RESPONSE_BYTES`, 8 KiB de JSON en
`src/mcp/budget.ts`) y nunca corta un objeto a la mitad: cada elemento entra
entero o no entra. El criterio de ranking **no es el mismo** para las cinco
herramientas, y cada una documenta por qué en su propio módulo
(`src/mcp/tools/`):

- `find_dependents` / `find_dependencies` / `blast_radius` — el orden ya lo
  fija la consulta SQL de T01/T03 (`ORDER BY distance ASC, weight DESC, path
ASC`) y el servidor **no reordena**: distancia en el grafo primero (lo más
  cercano es lo más probable que se vea afectado de verdad), peso de la señal
  como desempate (un import estático o un co-cambio frecuente pesa más que una
  arista débil), y ruta como desempate estable para que "mostrando N de M" sea
  reproducible.
- `active_claims` — no hay grafo que recorrer, así que se ordena por
  `claimed_at DESC`: lo más reciente primero, porque a quien pregunta "en qué
  está metido todo el mundo ahora mismo" le importa más quien empezó hace 5
  minutos que quien está a punto de caducar.
- `who_last_touched` — no aplica: es una resolución `path -> persona` por cada
  fichero **pedido**, no un descubrimiento. El orden de salida es el de
  entrada.

El contador de truncado es **honesto** de dos formas independientes
(`fetchRankedPage` en `budget.ts`):

1. La capa de consulta (T01) ya devuelve `truncated`, así que aquí no hace falta
   aritmética de "+1": si el motor cortó, `total` es `null` y `totalAtLeast` da
   la cota inferior que de verdad se conoce (`fetchLimit + 1`, porque se
   devolvieron `fetchLimit` y se sabe que había al menos una más) — nunca se
   inventa un total concreto.
2. El presupuesto de bytes puede recortar aparte, con `total` exacto si el
   motor no cortó.

`blast_radius` añade una tercera cosa que nunca se calla: `unresolved` — los
ficheros pedidos que no tienen nodo en el grafo (repo sin indexar, fichero nuevo
sin commitear), con `files` (los que caben), `total` (cuántos había de verdad) y
`truncated`. Un resultado vacío por "ninguno de tus ficheros está indexado" no es
lo mismo que "no afectas a nada", y confundirlos sería exactamente el "no
respondas 'todo' ni 'nada' por no tener contexto" que esta tarea prohíbe.

**Esa lista pasa también por el presupuesto de bytes.** La escribe el llamante
(hasta 500 rutas de 1.024 caracteres): devolverla entera hacía que una llamada
perfectamente legal —un PR de 200 ficheros contra un repo aún sin ingerir—
produjera una respuesta de cientos de miles de bytes frente a un presupuesto de
8 KiB, que es justo el volcado que esta herramienta existe para evitar.

### 7.3 Procedencia, siempre

`find_dependents`/`find_dependencies` devuelven `signal` (`static`/`build`/`git`)
y `via` (el tipo de arista) por cada resultado; `blast_radius` agrega **todas**
las señales distintas que alcanzaron cada nodo (`signals`/`via`, plural) — la
misma agregación que ya hacía `blastRadius` de T01/T03, sin tocar su firma.

### 7.4 `who_last_touched`: personas, nunca el correo

Sale de `git log` sobre un checkout real bajo `GRAPH_CHECKOUT_ROOT` (la misma
forma `<raíz>/<owner>/<repo>` que usa la ingesta, T02) y cruza el correo del
autor contra `users` del tenant activo.

Antes de tocar el disco **exige que el repositorio esté indexado para el tenant
activo**. Es la única herramienta que no localiza el recurso por la base de
datos, así que la RLS forzada no la cubre: sin esa comprobación, una raíz de
checkouts compartida por varios tenants convertía cualquier `owner/repo` bajo
ella en historial legible desde cualquier tenant. Si hay usuario con ese correo, se
devuelve su `display_name` (`source: "user"`); si no, el **nombre de autor de
git tal cual** (`source: "git"`) — nunca un hash, nunca "desconocido". El
correo **no sale en la respuesta en ningún caso**: es un dato personal y esto
va a un LLM, y el nombre ya contesta la pregunta. Un fichero sin ningún commit
en el checkout se devuelve como `found: false`, no se omite.

### 7.5 Conectarlo a Claude Code

El servidor arranca con `packages/graph/src/mcp/main.ts` (transporte stdio).
En producción, contra el `dist/` ya construido
(`pnpm --filter @coord/graph build`):

```json
{
  "mcpServers": {
    "coord-graph": {
      "command": "node",
      "args": ["/ruta/absoluta/al/repo/packages/graph/dist/mcp/main.js"],
      "env": {
        "PGBOUNCER_URL": "postgres://app_runtime:changeme-runtime@localhost:6432/coord",
        "GRAPH_MCP_TENANT_ID": "<uuid-del-tenant>",
        "GRAPH_CHECKOUT_ROOT": "/var/lib/coord/checkouts"
      }
    }
  }
}
```

- `PGBOUNCER_URL` (o `DATABASE_URL` si no hay pooler a mano): la misma
  convención de `@coord/db` — ver `.env.example`.
- `GRAPH_MCP_TENANT_ID`: **obligatoria**, el uuid del tenant (§7.1).
- `GRAPH_CHECKOUT_ROOT`: solo si vas a usar `who_last_touched` (§7.4).

No hace falta compilar para probarlo a mano: `tsx packages/graph/src/mcp/main.ts`
con esas mismas variables en el entorno arranca el mismo servidor leyendo
TypeScript directamente (asi es como lo arranca `test/mcp/server.test.ts`, §9).

---

## 8. Fitness functions que afectan a este paquete

En `.dependency-cruiser.cjs`, comprobadas introduciendo a propósito la violación
que dicen prohibir:

| Regla                       | Qué impide                                                                  |
| --------------------------- | --------------------------------------------------------------------------- |
| `core-no-sale`              | `packages/core` no puede importar `packages/graph`                          |
| `tree-sitter-solo-en-graph` | `tree-sitter` y sus gramáticas no salen de `packages/graph`                 |
| `mcp-sdk-solo-en-graph-mcp` | `@modelcontextprotocol/sdk` solo dentro de `packages/graph/{src,test}/mcp/` |

`test/mcp/` tiene el mismo permiso que `src/mcp/` (y solo ese subdirectorio,
no el resto de `test/`) porque el criterio de aceptación de T05 exige arrancar
el servidor de verdad y hablarle por stdio con el **cliente** del SDK, no solo
probar las funciones internas (§9).

---

## 9. Tests

```bash
pnpm --filter @coord/graph test     # necesita Docker
```

Postgres **de verdad** con testcontainers y la misma separación de roles que el
despliegue (`app_migrator` dueño de las tablas, `app_runtime` consultando). Si
los tests se conectaran como superusuario se saltarían la RLS por atributo de rol
y el test de aislamiento pasaría sin comprobar nada.

- `test/queries.test.ts` — transitividad y profundidad; grafos cíclicos (con
  timeout corto: colgarse **es** el bug); aislamiento entre dos tenants con **las
  mismas rutas a propósito**, incluido el caso de una consulta sin filtro
  explícito; y el rechazo de una arista que cruce tenants.
- `test/performance.test.ts` — 12.000 nodos en 12 capas, ventilación variable,
  anillos que meten ciclos reales y co-cambios de largo alcance; 60 ejecuciones
  de la consulta de dependencias inversas y aserción de **p95 < 200 ms**, a
  profundidad 4 **y a `MAX_TRAVERSAL_DEPTH`** (medido: 13,7 ms y 101,4 ms). Se
  mide a la profundidad máxima porque es la que la API acepta: un presupuesto
  comprobado solo en el caso fácil no es un presupuesto. Incluye además el
  EXPLAIN que prohíbe seq scans dentro de la unión recursiva, y la aserción de
  que un resultado recortado se reporta con `truncated`.
- `test/ingest.test.ts` — repositorios git **de verdad** creados con `git init`
  en un directorio temporal (nada de dobles de `git`): incremental comprobado
  contra los `updated_at` de `graph_files` (que el trabajo **no se hizo**, no que
  no se llamó a una función); borrado con las aristas entrantes incluidas;
  interrupción **dentro** de un lote, reanudación, y comparación del grafo
  reanudado contra una indexación limpia del mismo repositorio; y corrección del
  grafo con aserciones de aristas que **sí** existen y de aristas fantasma que
  **no** deben existir.
- `test/claims.test.ts` — la concurrencia se rompe en los bordes, así que los
  bordes son lo que se prueba: **10 intentos simultáneos** (`Promise.all`,
  conexiones distintas) sobre el mismo issue, repetido 5 rondas, con la
  aserción de que gana exactamente uno y los otros nueve reciben un rechazo que
  **nombra al ganador**; caducidad tanto backdateando la fila como con un TTL
  real de 1 s, y comprobando que la fila vieja **sigue en la tabla** (nadie la
  purgó); solape exacto y por vecindad de grafo; `pg_locks` sin ningún advisory
  lock retenido, **con un control** que demuestra que el contador sabe ver uno
  en vuelo; y renovación por el dueño frente a renovación por un tercero.
- `test/ingest-performance.test.ts` — 1.000 ficheros TypeScript en 10 capas con
  imports, herencia y llamadas cruzadas reales: la ingesta completa tiene que
  caber en **30 s**. Medida real en el portátil de desarrollo: ~8 s la completa,
  ~35 ms la reindexación sin cambios.
- `test/build.test.ts` — detección de herramienta (fs puro, sin Postgres); la
  salida **literal** de `nx graph --file` (Nx 23.2.0) y de `turbo query`
  (Turborepo 2.10.12), guardadas en `test/fixtures/` tal cual las escribieron las
  herramientas, produciendo nodos `target` y aristas `source: 'build'`; JSON malformado y una respuesta de `turbo query`
  con `errors` fallando ruidoso **sin escribir nada**; un workspace sin
  proyectos que da resultado vacío en vez de error; y una reingesta que
  sustituye el grafo de build anterior en vez de acumularlo.
- `test/cochange-mine.test.ts` — el algoritmo de minado con arrays a mano, sin
  Postgres ni git: parseo del formato de `git log`, umbral, deduplicación de
  ficheros repetidos dentro de un commit, el tope de ficheros por commit
  descartando el commit **entero** (ni pares ni denominador), y el peso por
  lift pesando menos a un fichero que cambia mucho por su cuenta que a un par
  igual de frecuente pero exclusivo.
- `test/cochange.test.ts` — repositorios git **de verdad**: 5 co-cambios de
  dos ficheros cruzan el umbral y producen arista **en los dos sentidos** con
  su peso, 1 co-cambio de otros dos no la produce; un commit que toca más
  ficheros que el tope (60, representativo del caso real de 400) se descarta
  entero aunque se repita 3 veces, sin generar la explosión de aristas; y un
  par que co-cambia pero no tiene nodo `file` en el grafo se cuenta como
  `unresolvedPairs` y no se inventa.
- `test/provenance.test.ts` — una consulta que mezcla aristas `static`,
  `build` y `git` hacia el mismo nodo: `findDependents` se queda con la señal
  de mayor peso (una fila por nodo), `blastRadius` agrega **todas** las
  señales que lo alcanzaron. Prueba end-to-end de que T03 no necesitó tocar
  `queries.ts` para cumplir su tercer criterio de aceptación.
- `test/mcp/budget.test.ts` — puro, sin Postgres: `truncateToBudget` nunca
  corta un objeto a la mitad (y distingue "no cupo nada" de "no había nada");
  `fetchRankedPage` **no reordena** (caso con un orden que si se alterase se
  detectaría), y el contador honesto en sus dos formas — el motor cortó
  (`total: null` + `totalAtLeast`) y el presupuesto de bytes cortó con un
  total exacto conocido, con un abanico de 5.000 filas a propósito.
- `test/mcp/context.test.ts` — puro: `loadServerConfig` falla ruidoso sin
  `GRAPH_MCP_TENANT_ID` o con un valor que no es un uuid; `GRAPH_CHECKOUT_ROOT`
  es opcional y una cadena en blanco cuenta como no definida.
- `test/mcp/server.test.ts` — criterio literal de T05: arranca
  `src/mcp/main.ts` como **subproceso real** (via `tsx`, la misma forma que lo
  arrancaría Claude Code) y le habla por `StdioClientTransport` con el
  **cliente** del SDK, nunca llamando a las funciones internas directamente.
  Postgres real y un checkout git real (`git init`, sin dobles). Cubre las
  cinco herramientas con datos reales y su procedencia (`static`/`git`);
  `find_dependents` sobre un nodo inexistente como error de herramienta, no
  lista vacía; ranking por peso a igual distancia; un abanico de 80
  dependientes que fuerza el recorte por presupuesto de bytes con el contador
  verificado; `who_last_touched` con un correo que hace match (`source:
"user"`), uno que no (`source: "git"`), un fichero nunca commiteado
  (`found: false`), y la aserción de que **ningún correo ni sha completo**
  aparece en la respuesta; `active_claims` con el titular; entrada inválida
  como error de herramienta; **aislamiento entre dos tenants** con el mismo
  nombre de repo y la misma ruta de fichero a propósito (uno no ve al
  dependiente ni al claim del otro); `who_last_touched` sin
  `GRAPH_CHECKOUT_ROOT` como error que lo dice; y el servidor sin
  `GRAPH_MCP_TENANT_ID` no llega a completar el handshake MCP.

`test/support/database.ts` usa el `psql` del contenedor en vez de un cliente `pg`
para lo poco que la capa de acceso no puede hacer (`ALTER ROLE`, `ANALYZE`): la
fitness function `pg-solo-en-db` reserva el driver a `packages/db`, y este
paquete no adquiere acceso directo a Postgres ni siquiera en sus tests. Es el
mismo patrón que `packages/queue/test/postgres.ts`.
