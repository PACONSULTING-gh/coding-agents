# Fase 1 — Grafo de dependencias y detección de colisiones

**Epic 02** · issues [#11](https://github.com/PACONSULTING-gh/coding-agents/issues/11) y #12–#16 · **T01–T05 construidas**

Que el sistema sepa, dado un cambio, **qué más se ve afectado y quién más está
tocando eso ahora**. Es la primera fase que ataca un problema del PRD en vez de
poner fontanería — aunque todavía no lo resuelve: pone el mecanismo.

Diagrama: [`ingesta`](../diagrams/ingesta.dataflow.json).

---

## 1. El grafo vive en Postgres

`graph_nodes` y `graph_edges`, con CTEs recursivas. **Nada de base de datos de
grafos**: la decisión está cerrada en `CLAUDE.md` §3, y el patrón que usamos es
expansión de vecindario acotada, no pathfinding profundo.

Nodos: `file`, `symbol`, `package`, `target`. Aristas: `imports`, `calls`,
`inherits`, `contains`, `cochange` — cada una con **`source`** (`static`, `build`,
`git`) y `weight`. Ese `source` es el que responde a _"¿qué señal predijo esto?"_,
que es criterio de aceptación.

**Índices en ambas direcciones.** El de `to_node_id` no es simetría decorativa: la
consulta inversa recorre la arista al revés, y sin él el presupuesto de latencia
es inalcanzable. Un test hace `EXPLAIN` como `app_runtime` y afirma que el plan lo
usa, para que esa afirmación deje de ser una promesa.

### Las dos guardas de la CTE

Ambas son criterio de aceptación, y ambas hicieron falta:

1. **Tope de profundidad** (`MAX_TRAVERSAL_DEPTH = 10`).
2. **Guarda de ciclos.** Un repo real _tiene_ ciclos de imports. El test del ciclo
   lleva timeout: si se cuelga, falla en vez de quedarse colgado.

La primera versión **enumeraba caminos, no nodos**, lo que a profundidad 10 daba
~1.800 ms. Reescrita con deduplicación por nodo y distancia:

| Profundidad | Antes      | Ahora            |
| ----------- | ---------- | ---------------- |
| 4           | p95 6,9 ms | p95 **6,1 ms**   |
| 10          | ~1.800 ms  | p95 **145,6 ms** |

Medido sobre 12.000 nodos y 43.500 aristas, 60 ejecuciones. El test afirma además
que cada consulta devuelve resultados de verdad: una consulta que no encuentra
nada también tarda 2 ms y pasaría el umbral sin demostrar nada.

> **El criterio de 200 ms se cumple en hardware de desarrollo y NO en el runner de
> CI**, que da 285 ms a profundidad máxima. No se bajó el umbral: fuera de CI se
> exige 200 ms sin excepción, y en CI un techo de 600 ms que sigue cazando la
> regresión original (~1.800 ms) con 3× de margen. **Pendiente:** si los 200 ms
> tienen que valer donde se despliegue, hay que medirlo ahí.

---

## 2. Ingesta incremental

El diagrama [`ingesta`](../diagrams/ingesta.dataflow.json) recorre el pipeline. Lo
esencial:

`git ls-files` lista lo indexable — respeta `.gitignore` gratis y sin
dependencias. Cada fichero guarda su **hash de contenido** en `graph_files`: si no
cambió, no se reparsea y sus aristas no se tocan.

El **checkpoint va en la MISMA transacción** que los datos del lote. Si se
guardaran por separado, un fallo entre medias dejaría el checkpoint diciendo que
un trabajo se hizo cuando no.

**Lo que no resuelve, no se inventa.** Un import externo que no casa se descarta y
se cuenta. Una arista fantasma es peor que una que falta, porque nadie sabe cuáles
creerse. Hay test que lo afirma **en negativo**.

**Medido sobre este repo:** 119 ficheros parseables → 621 nodos y 1.387 aristas en
600 ms. Segunda pasada: 0 reparseados, 38 ms. Un fichero cambiado: 1 planificado,
118 saltados, 54 ms.

### Dos fallos que encontró arrancarlo, no los tests

**La ingesta reventaba con cualquier fichero de más de 32 KiB.** El binding nativo
de tree-sitter 0.21 reserva 32 KiB y lanza `Invalid argument` —sin fichero ni
posición— a partir de 32.768 caracteres. Medido al carácter exacto. El culpable
era `packages/graph/src/claims.ts`, **del propio epic**, con 34.665 bytes: indexar
este repo habría abortado entero. Los tests usaban ficheros de ejemplo pequeños.

_No se bajó `maxFileBytes` a 32 KiB para esquivarlo:_ eso no arregla nada, solo
hace que el fichero se salte en silencio y el grafo mienta por omisión.

**El grafo no cruzaba las fronteras de paquete.** `import ... from '@coord/core'`
resolvía a un nodo `package` sin aristas de salida, así que el recorrido moría en
cada paquete — que en un monorepo es donde están casi todas las dependencias.

| `blast_radius` de `packages/core/src/tenant.ts` | Afectados                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Antes                                           | **2**, ambos dentro de `packages/core`                                  |
| Ahora                                           | **28**: `db` (11), `queue` (8), `webhook` (4), `worker` (3), `core` (2) |

La resolución de workspace vive en el motor y no en el parser: un workspace de
pnpm es un concepto del repositorio, no del lenguaje. Python no tiene
`pnpm-workspace.yaml`.

---

## 3. Señales de build y co-change

**Estado real en este repo: no aportan nada.** El grafo indexado tiene **2.551
aristas `source=static` y cero de las otras dos**:

- `source=build` da 0 porque aquí no hay Nx ni Turborepo.
- `source=git` da 0 porque con 12 commits ningún par de ficheros llega al umbral.

El ingestor existe y está probado **contra las CLI reales**, y ahí saltó algo: los
dos parsers estaban escritos contra formatos que esas herramientas ya no producen.
Nx 23.2.0 devuelve `{graph:{nodes,dependencies}}`, no `{projects,dependencies}`; y
la consulta de Turborepo 2.10.12 fallaba con `Unknown field "name" on type
"Packages"`. Los fixtures eran inventados, así que ningún test lo detectaba. Ahora
son la salida literal de cada herramienta.

Decisiones documentadas: hay **tope de ficheros por commit** —un merge o un
"format all" que toca 400 ficheros generaría decenas de miles de aristas espurias
y ahogaría la señal— y el peso es **lift, no frecuencia bruta**, porque la
frecuencia favorece a los ficheros que cambian mucho por su cuenta (ADR 0005).

> **Pendiente de decisión humana:** `blastRadius` ordena mezclando escalas. Las
> aristas `static` y `build` valen 1.0 fijo, y el lift de co-change no está
> acotado. Normalizarlo cambia la semántica documentada de las herramientas MCP.

---

## 4. Claims — el spec pedía algo imposible

El epic decía _"advisory locks de Postgres, **transaccionales y con TTL**"_. Es
contradictorio:

- `pg_advisory_xact_lock` se libera en el `COMMIT`: no puede sostener un claim que
  dura minutos.
- `pg_advisory_lock` de sesión sí persiste, pero **no funciona bajo PgBouncer en
  modo transacción** — mismo motivo que obligó a `set_config(..., true)` en la
  capa de datos.

Se implementó el diseño correcto —tabla `claims` con `expires_at` como fuente de
verdad, y `pg_advisory_xact_lock` **solo** para serializar la operación de
reclamar— y se registró en **ADR 0004** en vez de arreglarlo en silencio
(`CLAUDE.md` §7). El criterio de `pg_locks` se cumple por construcción: no se
retiene ningún lock entre transacciones.

**Los claims caducan solos.** La corrección no depende de que corra la purga; la
purga solo borra filas viejas. Y un claim rechazado devuelve **quién lo tiene y
hasta cuándo**, no un booleano — es lo único que le sirve a quien se lo encuentra.

La carrera se prueba con concurrencia real: conexiones distintas, `Promise.all`, y
repetida. Una carrera que solo se gana una vez no demuestra nada.

**Fue la única tarea del epic que pasó la verificación limpia: 9/9.**

---

## 5. Herramientas MCP

`find_dependents`, `find_dependencies`, `blast_radius`, `who_last_touched`,
`active_claims`, por stdio. El objetivo es que un agente **pregunte** en vez de
leer ficheros; si las respuestas fueran volcados, habríamos hecho lo contrario.

Toda respuesta pasa por un presupuesto de bytes y va ranqueada, con contador
honesto de lo truncado. Tamaños medidos: 50 · 323 · 385 · 923 · 8.222 bytes.

`who_last_touched` devuelve **personas**, cruzando el autor de git con los
usuarios del tenant, y redacta el correo: es un dato personal y esto va a un LLM.

Un servidor MCP no tiene sesión de donde sacar el tenant, así que viene de
`GRAPH_MCP_TENANT_ID` y **el servidor se niega a arrancar si falta**. Nunca
responder "todo" por no tener contexto.

### Indexar a mano, y la prueba de que el MCP responde

`pnpm --filter @coord/graph graph:index -- --repo <owner/nombre> --path <dir>`
llena el grafo sin webhook, sin GitHub App y sin túnel. La secuencia vive en
`indexRepository` y la comparten el comando y el worker: si algún día se añade una
cuarta señal, entra por un solo sitio.

Comprobado de punta a punta contra este repo: indexado en **420 ms** (136 ficheros
parseados, 55 sin cambios, 359 nodos, 937 aristas), y un cliente MCP real
conectado por stdio lista las cinco herramientas y devuelve `blast_radius` con
afectados cruzando paquetes, cada uno con su distancia y su señal.

El tenant **no tiene valor por defecto**, ni lo tendrá: la RLS lo exige, y un
comando que eligiera uno sería el atajo que rompe el aislamiento sin que nadie se
entere.

### Lo que falta para cerrar la fase

De los cuatro criterios de la Definition of Done del epic quedan **dos**, y ambos
dependen del proyecto piloto (#8): _"dado un PR en el repo piloto, el sistema dice
qué se ve afectado y quién lo tocó"_, y el enganche a un repositorio real del
equipo.
