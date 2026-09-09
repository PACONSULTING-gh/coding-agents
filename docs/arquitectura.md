# Arquitectura (arc42 ligero)

Este documento refleja lo que existe **de verdad** en el repo a fecha de T05
del epic 02 (epic 02 completo). No
describe fases futuras como si ya estuvieran construidas.

> **Documentación por fases:** [`fases/`](fases/) tiene un documento técnico por
> fase con lo que existe de verdad en cada una, sus números medidos y su deuda
> declarada. Este documento describe el conjunto; aquél, cada pieza.

> **Diagrama:** `docs/diagrams/arquitectura.architecture.json`, entregado como HTML
> interactivo con `pnpm diagrams`. Cada componente declara de qué ficheros del repo
> habla, y la entrega **falla** si alguna de esas rutas no existe en la revisión
> fijada — así el diagrama no puede quedarse contando algo que ya no es cierto.
> Ver `docs/diagrams/README.md` y el ADR 0006.

## 1. Contexto

El sistema es una capa de coordinación que se sienta encima de GitHub (Issues,
PRs, webhooks) y de agentes de código. No sustituye a GitHub ni a CCPM: los usa
como fuente de verdad y como motor de ejecución.

Actores externos:

- **GitHub** — origen de eventos (`issues`, `pull_request`, `push`, ...) vía
  webhooks de una GitHub App, y destino de escritura (comentarios, estados).
- **Desarrolladores** — reciben tareas sugeridas, aprueban o rechazan lo que
  proponen los agentes.
- **Agentes de código** (Claude Code, Codex, Copilot CLI) — ejecutan tareas;
  este sistema los coordina, no los reemplaza.

## 2. Estrategia

- Backend TypeScript/Node en monorepo (pnpm workspaces).
- Postgres único como almacén de todo: datos de negocio, cola de trabajos
  (pg-boss), y en fases posteriores el grafo de dependencias y embeddings.
  Ver ADR 0001 y ADR 0002.
- GitHub App como única vía de integración con GitHub (no OAuth App): ver
  CLAUDE.md §3.
- Arquitectura de puertos: `packages/core` define los contratos
  (`QueuePort`, contexto de tenant, errores de dominio); la infraestructura
  concreta vive fuera y los implementa. Sin esto, cambiar pg-boss de sitio
  obligaría a tocar cada llamante.

## 3. Bloques de construcción

Estado real a día de hoy (epic 01 cerrado, epic 02 en curso):

```
packages/core     — IMPLEMENTADO. Contexto de tenant (AsyncLocalStorage),
                     errores de dominio, puerto QueuePort. Sin dependencias
                     de runtime salvo zod. No importa de ningún otro paquete.
packages/db       — IMPLEMENTADO. Esquema multi-tenant con RLS forzada,
                     migraciones, capa de acceso (withTenantConnection) y
                     API del audit_log.
packages/queue    — IMPLEMENTADO. QueuePort sobre pg-boss, con envelope que
                     propaga el tenant al job.
packages/github   — IMPLEMENTADO. Cliente de la GitHub App, verificación de
                     firma y caché de tokens de instalación.
apps/webhook      — IMPLEMENTADO. Listener HTTP fino: verifica, deduplica,
                     encola y responde. No procesa nada.
apps/worker       — IMPLEMENTADO (mínimo). Registra el evento en audit_log,
                     aplica los cambios de instalación y, si hay un checkout
                     local configurado, encola la ingesta del grafo al recibir
                     un push. El resto de la lógica de dominio de cada evento
                     es de fases posteriores.
packages/graph    — IMPLEMENTADO (epic 02 completo). El esquema del grafo
                     (migración 0007), las consultas de recorrido
                     (findDependents, findDependencies, blastRadius) y la
                     ingesta incremental con tree-sitter (parsers de
                     TypeScript/TSX, JavaScript y Python). T03: el grafo
                     nativo de build (Nx/Turborepo, `src/build/`) y el
                     overlay de co-cambio desde `git log` (`src/cochange/`),
                     los dos con `source: 'build'`/`'git'` fluyendo por las
                     MISMAS consultas de T01 sin tocar su firma. T04, los
                     CLAIMS: tabla `claims` (migracion 0008), reservas con
                     arriendo sobre issues y ficheros, y aviso de solape por
                     ruta exacta y por vecindad en el grafo. T05, el grafo
                     como SERVIDOR MCP (`src/mcp/`, transporte stdio):
                     find_dependents/find_dependencies/blast_radius/
                     who_last_touched/active_claims, con presupuesto de
                     contexto (tope de bytes, ranking documentado por
                     herramienta, contador de truncado honesto) y contexto de
                     tenant por variable de entorno (`GRAPH_MCP_TENANT_ID`),
                     nunca por argumento de la llamada.
```

Dependencias entre paquetes (todas apuntan hacia dentro, hacia `core`):

```
apps/webhook  ──┐
apps/worker   ──┼──> packages/{db,queue,github} ──> packages/core
                └──────────────────────────────────> packages/core

packages/graph ────> packages/db ──> packages/core
apps/worker   ────> packages/graph
```

`packages/core` no depende de ningún otro paquete del repo. Se comprueba con
dependency-cruiser en CI (regla `core-no-sale`), no solo por convención.

### Recorrido de un webhook de GitHub (T05)

```
GitHub ──HTTPS POST──> apps/webhook
                         1. verifica HMAC-SHA256 sobre el cuerpo CRUDO
                            (firma inválida -> 401 + log + audit_log)
                         2. instalación -> tenant  (github_installations,
                            lectura sin contexto de tenant, ver más abajo)
                         3. INSERT ... ON CONFLICT DO NOTHING en
                            webhook_deliveries  (dedup por GUID de entrega)
                         4. runWithTenant(...) -> QueuePort.enqueue
                         5. 200  (objetivo < 500 ms)
                                    │
                                    ▼
                             cola pg-boss (una cola por tipo de evento)
                                    │
                                    ▼
                              apps/worker
                                 restaura el tenant desde el envelope,
                                 escribe en audit_log y, si es un evento
                                 de instalación, actualiza github_installations
```

Todo lo que cuesta tiempo pasa detrás de la cola, donde hay reintentos con
backoff y cola de fallidos. En la petición HTTP solo cabe lo que no se puede
diferir, porque ahí el reloj lo lleva GitHub (corta a los 10 s).

**La única lectura del sistema que ocurre sin contexto de tenant** es el paso 2:
es imposible saber de quién es un webhook antes de mirar el mapeo de la
instalación. La migración `0006` la acota con una segunda política de RLS que
solo permite `SELECT`, solo fuera de contexto de tenant, y solo de la
instalación que el llamante declara por adelantado en
`app.github_installation_lookup`. El radio de exposición es una fila, no la
tabla.

### El grafo de dependencias vive en el mismo Postgres

La migración `0007` añade `graph_nodes`, `graph_edges`, `graph_files` y
`graph_ingestions` a la MISMA cadena de migraciones y con el MISMO patrón
multi-tenant que el resto: `tenant_id` como columna líder, claves ajenas
compuestas contra `(tenant_id, id)`, y RLS habilitada **y forzada**. No hay
base de datos de grafos (CLAUDE.md §3 y §4): la lista de adyacencia con CTEs
recursivas gana en el patrón que usamos —expansión de vecindario acotada, no
pathfinding profundo—, y Neo4j solo se reconsidera con una p95 degradada y
medida delante.

Las dos guardas de la CTE recursiva no son opcionales y las dos tienen test:
tope de profundidad (con techo duro) y guarda de ciclos. La guarda de ciclos es
la **deduplicación por nodo y distancia** (`UNION`, no `UNION ALL`, con el
término recursivo proyectando sólo `(node_id, distance)`), porque un repositorio
real tiene ciclos de imports y sin ella la consulta no termina. La diferencia con
acumular el camino recorrido no es de estilo: enumerar caminos hace que el coste
crezca de forma combinatoria con la profundidad —medido, p95 de ~1.800 ms a
profundidad 10 frente a un presupuesto de 200 ms—, y enumerar nodos alcanzables
lo hace lineal en el vecindario. La medición de referencia —12.000 nodos, 43.500
aristas, y el p95 medido a profundidad 4 **y a la profundidad máxima que la API
acepta**— está en `packages/graph/test/performance.test.ts`.

Las consultas recortan a `limit` y **dicen que lo han hecho**: devuelven
`{ hits, truncated }`, no un array pelado. Un "no hay más afectados" falso es
exactamente el fallo que este epic existe para evitar.

`packages/graph` importa de `core` y de `db`, nunca al revés; todo su acceso a
datos pasa por `withTenantConnection` y no abre pool propio.

### La ingesta del grafo es incremental desde el primer día

`packages/graph/src/parse/` tiene un módulo por lenguaje detrás de la interfaz
`LanguageParser`; el motor de ingesta no conoce tree-sitter. `src/ingest/` lista
los ficheros con `git ls-files` (que respeta `.gitignore` sin dependencias
nuevas), guarda un sha-256 por fichero en `graph_files` y **solo reparsea lo que
cambió de hash**. Un rebuild completo no sobrevive a un repo grande y
retrofitear el incremental después sale caro, así que el epic lo exige desde el
principio.

La ingesta corre en dos fases (símbolos primero, referencias después) para que
las aristas `calls`/`inherits` no dependan del orden en que se procesan los
ficheros, y cada lote escribe sus datos **y su checkpoint** en la misma
transacción: una ingesta muerta a mitad continúa donde iba, no empieza de cero.
Lo que no se puede resolver —un import a un fichero que no existe, una llamada a
un símbolo desconocido— se descarta y se cuenta; nunca se inventa una arista.

En el recorrido de un webhook, un `push` no indexa dentro de la transacción del
evento: encola un job `graph.ingest` por el `QueuePort` que ya existe, y el
procesador de esa cola es quien indexa desde un checkout local
(`GRAPH_CHECKOUT_ROOT`). Sin esa variable el enganche no se registra y se dice en
el log. Ese job encadena **las tres capas** sobre el mismo `repo_id`: la ingesta
estática (T02), el grafo nativo de build y el overlay de co-cambio (T03). Si
alguna falla, el job falla: no se traga el error.

Reparsear sólo lo que cambió de hash **no basta**: la resolución de un import
depende también del conjunto de rutas del repositorio. Por eso `graph_files`
guarda los especificadores de cada fichero (migración `0009`) y la planificación
replanifica los ficheros cuya resolución cambia al añadirse o borrarse rutas —si
no, revertir un borrado dejaba aristas que no volvían nunca, en silencio. Y
cuando el llamante pasa un `commitSha`, la ingesta comprueba que el checkout
está de verdad en ese commit antes de sellar nada con esa etiqueta.

### Los claims son un arriendo en tabla, no un lock sostenido

La migración `0008` añade `claims`: quién (persona o agente) tiene reservado qué
(un issue, unos ficheros) en qué repositorio, desde cuándo y hasta cuándo. Es lo
que evita que agentes de **desarrolladores distintos** colisionen, que es el
segundo de los tres problemas del producto.

El epic pedía "advisory locks transaccionales y con TTL" y eso no existe: un lock
transaccional muere en el `COMMIT`, y uno de sesión **no sobrevive a PgBouncer en
modo transacción** —la conexión lógica no está atada a un backend físico, así que
el lock se quedaría pegado en un backend que después sirve a otro tenant—, que es
exactamente el motivo por el que la capa de acceso usa `set_config(..., true)`.
La discrepancia y el diseño que se implementó en su lugar están en el
**ADR 0004**.

Lo que hay: la fila es la fuente de verdad (`released_at IS NULL AND
expires_at > now()`), `pg_advisory_xact_lock` se usa **solo** para serializar la
reclamación dentro de una transacción —así no queda ningún lock retenido entre
transacciones, que es un criterio de aceptación literal— y un índice único
parcial respalda la exclusividad desde el motor. Como el predicado de un índice
parcial tiene que ser inmutable y `now()` no lo es, la caducidad se materializa
en `released_at` durante la propia transacción que reclama: por eso **ningún
proceso de limpieza forma parte de la corrección**, y la purga periódica sobre el
`QueuePort` solo recorta el histórico.

### El grafo se pregunta por MCP, no se lee a ciegas

`packages/graph/src/mcp/` expone el grafo (T01-T04) como servidor MCP sobre
`@modelcontextprotocol/sdk`, transporte stdio: `find_dependents`,
`find_dependencies`, `blast_radius`, `who_last_touched` y `active_claims`. Es
la pieza que resuelve el tercer problema del producto —supervisar el trabajo
de un agente sin leer el diff— desde el lado del propio agente: puede
preguntar "qué se rompe si toco esto" o "quién está ya trabajando en esto" en
vez de tener que leer el repositorio entero para averiguarlo.

Un servidor MCP no tiene sesión HTTP de la que sacar el tenant: se declara por
variable de entorno al arrancar el proceso (`GRAPH_MCP_TENANT_ID`), nunca por
argumento de una herramienta, y el servidor se niega a arrancar sin ella —
nunca responde "todo" por no tener contexto (CLAUDE.md §2.6). El SDK de MCP no
sale de `packages/graph/{src,test}/mcp/` (fitness function
`mcp-sdk-solo-en-graph-mcp`): la lógica de consulta no depende de cómo se
expone.

Cada respuesta lleva tope de bytes y viene ranqueada (el criterio de ranking
lo documenta cada herramienta: distancia y peso del grafo para las de
recorrido, recencia del claim para `active_claims`), con un contador de
truncado que nunca inventa un total que no conoce. Ver
`packages/graph/README.md` §7 para el detalle y el bloque de configuración de
Claude Code.

### Por qué NO existen todavía `packages/agents` ni `apps/daemon`

Son de fases posteriores de la hoja de ruta (Fases 2-4 según
`docs/quality-gates.md` §4). Crearlos vacíos ahora sería sobre-ingeniería
según el peldaño 1 de la escalera de pereza de CLAUDE.md §2.4 ("¿hace falta
que exista?"): no tienen consumidor todavía, y un paquete vacío no es
scaffolding útil, es ruido que hay que mantener sincronizado sin que aporte
nada. Se crean en el epic que primero los necesite.

## 4. Despliegue

Todavía no hay despliegue a ningún entorno remoto. Lo único que existe es
`infra/docker-compose.yml` con un contenedor de Postgres para desarrollo
local. PgBouncer, CI/CD y cualquier infraestructura de nube llegan en tareas
posteriores (T03 y T06 en adelante) y este documento se actualizará cuando
existan de verdad.
