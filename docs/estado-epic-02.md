# Estado del epic 02 — grafo de dependencias y detección de colisiones

**Fecha de la verificación:** 9 de septiembre de 2026
**Quién:** agente de cierre (gate). No escribió features: ejecutó el árbol, aplicó
las migraciones, indexó este repositorio y habló con el servidor MCP.
**Commit del árbol verificado:** `198e960` más el trabajo del epic 02 sin
commitear (72 ficheros nuevos, ver `git status`).

Este informe está escrito para quien **no va a abrir el diff**. Todos los números
de aquí están medidos en esta máquina, no estimados.

---

## 1. Veredicto en una línea

El epic 02 está **funcionalmente completo y en verde**, pero tiene **dos defectos
reales** que un humano tiene que decidir cómo resolver antes de dar por cerrada la
Definition of Done: la ingesta **revienta con cualquier fichero de 32 KiB o más**
(y este repositorio ya tiene uno), y el grafo **no conecta paquetes del monorepo
entre sí**, que es justo la topología de este producto.

---

## 2. Estado por tarea

| Tarea                                     | Estado       | Por qué                                                                                                                            |
| ----------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **T01** Esquema y consultas inversas      | **Completo** | Migración `0007`, CTE con tope de profundidad y guarda de ciclos; p95 medido muy por debajo del presupuesto (§5)                   |
| **T02** Ingesta tree-sitter e incremental | **Parcial**  | Incremental y reanudable comprobados sobre repos reales, pero **falla con ficheros ≥ 32 KiB** (§4.1)                               |
| **T03** Grafo de build y co-cambio        | **Completo** | Nx y Turborepo verificados contra sus CLI **reales**; el overlay de co-cambio funciona, aunque en este repo no produce nada (§6.2) |
| **T04** Claims y leases                   | **Completo** | Carrera, caducidad por TTL, aviso de solape y vista de activos verificados de punta a punta contra Postgres (§7)                   |
| **T05** Herramientas MCP                  | **Completo** | Las 5 herramientas responden por stdio contra el servidor de verdad; respuestas compactas (§8)                                     |

---

## 3. El pipeline, con su salida real

Todo ejecutado en la raíz del repositorio.

| Comando                                | Resultado                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`       | Verde. `Lockfile is up to date, resolution step is skipped` / `Already up to date`    |
| `pnpm -r typecheck`                    | Verde. 7 de 7 proyectos                                                               |
| `pnpm lint`                            | Verde. Sin salida                                                                     |
| `pnpm format:check`                    | **Estaba rojo** (14 ficheros). Corregido con `prettier --write`; ahora verde (§3.1)   |
| `pnpm arch`                            | Verde. `no dependency violations found (151 modules, 517 dependencies cruised)`       |
| `pnpm -r build`                        | Verde. 7 de 7 proyectos                                                               |
| `pnpm -r test`                         | Verde. **283 tests pasados, 2 saltados**, 29 ficheros de test (§3.2)                  |
| `pnpm audit --audit-level=high`        | Verde (código de salida 0). 3 vulnerabilidades **moderate**, todas de `qs` transitivo |
| `gitleaks git --config .gitleaks.toml` | Verde. `12 commits scanned` / `no leaks found`                                        |
| `./scripts/check-action-refs.sh`       | Verde. 5 acciones, todas ancladas                                                     |

### 3.1 Lo único que estaba rojo

`pnpm format:check` fallaba en 14 ficheros del epic 02 (entre ellos
`packages/graph/src/mcp/budget.ts`, `packages/graph/src/ingest/ingest.ts`,
`packages/graph/README.md`, `docs/runbook.md` y 4 ficheros de test). Se corrigió
ejecutando Prettier. **Es un cambio de formato puro**: no se tocó ninguna lógica,
ningún test, ningún umbral. `pnpm lint`, `pnpm -r typecheck` y `pnpm -r test`
siguen en verde después.

Que esto llegara rojo significa que **el hook de pre-commit no se ejecutó** sobre
parte del trabajo del epic (el trabajo está sin commitear, así que nunca pasó por
él). No es un fallo de código, es un aviso sobre el proceso.

### 3.2 Desglose de los tests

| Paquete           | Ficheros | Tests                |
| ----------------- | -------- | -------------------- |
| `packages/core`   | 1        | 6                    |
| `packages/db`     | 4        | 66                   |
| `packages/queue`  | 4        | 27                   |
| `packages/github` | 3        | 23                   |
| `packages/graph`  | 13       | **134 + 2 saltados** |
| `apps/webhook`    | 1        | 16                   |
| `apps/worker`     | 3        | 11                   |

**Los 2 saltados no son un agujero oculto.** Son los tests que instalan Nx y
Turborepo de verdad desde npm (`test/build-cli.test.ts`), detrás de
`GRAPH_BUILD_CLI_TESTS=1` porque necesitan red. El paquete además tiene un test
que **falla si no se han ejecutado**, para que no desaparezcan del informe. Se
ejecutaron a mano:

```
GRAPH_BUILD_CLI_TESTS=1 pnpm --filter @coord/graph exec vitest run test/build-cli.test.ts
  ✓ un workspace con Nx de verdad aporta aristas `build`                      1750ms
  ✓ un workspace con Turborepo de verdad aporta aristas `build`, sin el raíz   549ms
```

Con esa variable puesta, la suite entera del paquete da **135 pasados, 1 saltado**
(el saltado pasa a ser el aviso, que es lo correcto).

---

## 4. Migraciones

Aplicadas sobre el Postgres local (`infra/docker-compose.yml`), que estaba en la
`0006`:

```
migrate:up             -> 0007_graph_nodes_and_edges, 0008_claims_and_leases,
                          0009_graph_pending_import_specifiers
migrate:down --count=3 -> las tres revertidas
                          (comprobado: no queda ninguna de graph_nodes, graph_edges,
                           graph_files, graph_ingestions, claims)
migrate:up             -> las tres reaplicadas
```

**Suben y bajan.** La reversión deja el esquema limpio.

### 4.1 DEFECTO 1 — la ingesta revienta con ficheros de 32 KiB o más

Al indexar el árbol de trabajo completo de este repositorio, la ingesta **abortó
con una excepción no controlada**:

```
Error: Invalid argument
    at Parser.parse (node_modules/.pnpm/tree-sitter@0.21.1/.../index.js:361:13)
    at parseEcmascript (packages/graph/dist/parse/ecmascript.js:256:25)
    at Object.parse (packages/graph/dist/parse/typescript.js:41:16)
```

El fichero culpable es del propio epic: **`packages/graph/src/claims.ts`, 34.665
bytes**.

Medido: el binding de Node de `tree-sitter@0.21.1` acepta una cadena de **hasta
32.767 caracteres** y lanza `Invalid argument` a partir de **32.768**. Afecta a
**todos** los lenguajes (comprobado también con el parser de Python), no solo a
TypeScript.

Por qué importa:

- El tope de la ingesta (`DEFAULT_MAX_FILE_BYTES`) es **1 MiB**, es decir, 32
  veces más permisivo que el límite real del parser. La guarda que existe no
  protege de esto.
- No es un fichero contado y descartado: **es una excepción que aborta la ingesta
  entera**. Lo único que salva el día es que la reanudación funciona (§6.1).
- Hoy no salta al indexar el repositorio **tal como está commiteado**, porque
  `claims.ts` todavía no está en el índice de git. **En cuanto se commitee el
  epic 02, indexar este propio repositorio falla.**

Existe arreglo y está comprobado con las versiones ya fijadas — las dos formas
funcionan con `tree-sitter@0.21.1` + `tree-sitter-typescript@0.23.2`:

```js
parser.parse(source, null, { bufferSize: <bytes suficientes> }) // OK con 50.000 caracteres
parser.parse((offset) => source.slice(offset, offset + 8192))   // OK con 50.000 caracteres
```

**No lo he aplicado a propósito.** Es una decisión de diseño (cuánta memoria se
concede por fichero) y necesita un test de regresión escrito por alguien que no
sea quien escriba el arreglo (CLAUDE.md §2.3 y §5). Maquillarlo bajando
`maxFileBytes` a 32.767 dejaría fuera del grafo, en silencio, cualquier fichero
grande — exactamente el "falso no hay más afectados" que este epic existe para
evitar.

---

## 5. Números medidos

### Consulta de dependencias inversas (criterio de T01: p95 < 200 ms con > 10.000 nodos)

Escenario de referencia de `packages/graph/test/performance.test.ts`:
**12.000 nodos, 43.500 aristas**. 60 ejecuciones por medida, dos pasadas
independientes:

| Profundidad | p50             | **p95**              | max              | Presupuesto |
| ----------- | --------------- | -------------------- | ---------------- | ----------- |
| 4           | 3,9 / 11,5 ms   | **6,1 / 13,1 ms**    | 8,6 / 16,1 ms    | 200 ms      |
| 10 (máxima) | 90,2 / 136,0 ms | **100,9 / 145,6 ms** | 104,0 / 148,9 ms | 200 ms      |

**Criterio cumplido**, y también a la profundidad máxima que acepta la API, no
solo a la de por defecto.

Sobre el grafo real de este repositorio (298 nodos), `findDependents` a
profundidad 5, 60 ejecuciones: **p50 1,26 ms · p95 1,79 ms · max 2,03 ms**.

### Ingesta

| Medida                                                      | Valor                                  |
| ----------------------------------------------------------- | -------------------------------------- |
| Repo sintético de 1.000 ficheros (criterio: < 30 s)         | **1.064 ms** (9.300 aristas)           |
| Reindexado sin cambios del mismo repo                       | **100 ms**                             |
| Este repositorio, ficheros seguidos por git (58 parseables) | **398 ms**                             |
| Árbol de trabajo completo, 119 ficheros parseables          | **600 ms**                             |
| Segunda pasada sin cambios (119 ficheros)                   | **38 ms**, 0 reparseados               |
| Tras cambiar **un** fichero                                 | **54 ms**, 1 planificado, 118 saltados |

### Tamaño de las respuestas MCP (presupuesto declarado: 8 KiB)

| Herramienta         | Bytes de la respuesta | Contenido                  |
| ------------------- | --------------------- | -------------------------- |
| `active_claims`     | 50 (vacía) / **981**  | 3 claims vivos             |
| `who_last_touched`  | **323**               | 2 ficheros                 |
| `find_dependents`   | **385**               | 2 resultados               |
| `blast_radius`      | **923**               | 6 resultados               |
| `find_dependencies` | **8.222**             | 61 resultados, sin truncar |

Matiz honesto: el presupuesto de 8.192 bytes se aplica **solo al array de
resultados**, no al sobre completo del JSON. La respuesta más grande medida se fue
a **8.222 bytes**, un 0,4 % por encima del tope que anuncia el README. No es un
volcado del repositorio ni de lejos, pero el documento afirma "cada respuesta
tiene tope de bytes" y en rigor lo que lo tiene es la lista.

---

## 6. Qué dice el grafo de este repositorio

Indexado con el repoId derivado de `(tenant Liberion Labs, PACONSULTING-gh/coding-agents)`:

| Métrica                         | Ficheros seguidos por git | Árbol de trabajo completo |
| ------------------------------- | ------------------------- | ------------------------- |
| Ficheros parseables             | 58                        | 119                       |
| **Nodos**                       | **298**                   | **621**                   |
| — `file` / `symbol` / `package` | 58 / 211 / 29             | 119 / 464 / 38            |
| **Aristas**                     | **582**                   | **1.387**                 |
| — `contains`                    | 211                       | 464                       |
| — `imports`                     | 196                       | 496                       |
| — `calls`                       | 169                       | 418                       |
| — `inherits`                    | 6                         | 9                         |
| — `cochange` (`source: git`)    | 0                         | 0                         |
| — build (`source: build`)       | 0                         | 0                         |
| Imports sin resolver            | 2                         | 0                         |

Aislamiento comprobado: consultando el **mismo** `repo_id` desde el tenant
"Cliente Rival S.A." se ven **0 nodos**.

### 6.1 La reanudación funciona, y se probó sin quererlo

La ingesta del árbol completo murió con el defecto de §4.1. Al relanzarla,
`resumed: true`: continuó donde iba en vez de empezar de cero. No es un test
simulado — fue una caída real a mitad de ingesta.

### 6.2 Por qué no hay ni una arista de build ni de co-cambio

Ninguna de las dos es un fallo, pero conviene que conste:

- **Build:** este monorepo usa pnpm workspaces a secas. No hay `nx.json` ni
  `turbo.json`, así que `detectBuildTools` devuelve lista vacía y no se ejecuta
  nada. La capa está probada contra las CLI reales (§3.2), pero **este** repo no
  la ejercita.
- **Co-cambio:** el historial tiene **12 commits**. Con el umbral por defecto
  (`minCochanges = 3`: dos ficheros tienen que cambiar juntos tres veces o más),
  no hay ningún par que lo supere. `commitsConsidered: 12, pairsFound: 0`.

Consecuencia práctica: **el grafo de este repositorio es hoy 100 % estático.** Las
dos señales que compensarían la limitación de §6.3 no aportan nada aquí.

### 6.3 DEFECTO 2 — el grafo no cruza fronteras de paquete del monorepo

Consulta pedida, `blast_radius` sobre `packages/core/src/tenant.ts` (del que
depende medio repositorio):

```json
{
  "page": {
    "items": [
      {
        "path": "packages/core/src/index.ts",
        "distance": 1,
        "signals": ["static"],
        "via": ["imports"]
      },
      {
        "path": "packages/core/src/tenant.test.ts",
        "distance": 1,
        "signals": ["static"],
        "via": ["imports"]
      }
    ],
    "shown": 2,
    "total": 2,
    "truncated": false
  },
  "unresolved": { "files": [], "total": 0, "truncated": false }
}
```

**Dos resultados, los dos dentro de `packages/core`.** Y sin embargo
`packages/db/src/client.ts`, `packages/queue/`, `apps/webhook` y `apps/worker`
dependen de `tenant.ts` de verdad.

La causa, comprobada en la base de datos: un import de otro paquete del workspace
(`import { runWithTenant } from '@coord/core'`) se resuelve a un nodo de tipo
`package` llamado `@coord/core`, y **ese nodo no tiene ninguna arista de salida**
(consulta directa: 0 aristas salientes desde cualquier nodo `package`, en los dos
grafos indexados). El grafo queda partido en islas, una por paquete.

Esto es coherente con la política declarada de la ingesta —"un especificador
desnudo apunta a un `package`; lo que no se sabe resolver no se inventa"—, y esa
política es la correcta para `pg` o `node:fs`. Pero un paquete **del propio
workspace** no es una dependencia externa: su código está en el repositorio, y
`pnpm-workspace.yaml` dice exactamente dónde.

Por qué importa más que como detalle técnico: la decisión de repositorio de este
proyecto es **monorepo** (CLAUDE.md §3), y el producto se vende para contestar
"si toco esto, qué más se ve afectado". Hoy, en un monorepo sin Nx ni Turborepo,
la respuesta se queda dentro del paquete. La capa de build (T03) tapa este hueco
**solo si el cliente usa Nx o Turborepo**.

Lo que se ve bien y hay que decir: cuando el import **sí** se resuelve, el grafo
es preciso y la procedencia viaja siempre (`signals`, `via`, `distance`, `weight`
en todas las respuestas), y `blast_radius` distingue "no afectas a nada" de "tus
ficheros no están indexados" con su bloque `unresolved`.

---

## 7. Claims (T04), verificado contra Postgres

Los cuatro criterios de aceptación, ejecutados de verdad:

1. **Dos intentos simultáneos sobre el mismo issue** → uno gana; el otro recibe
   `ClaimConflictError` con mensaje utilizable, no un error del motor:
   `"el fichero packages/core/src/tenant.ts lo tiene Javier (user) desde
2026-09-08T22:29:46.657Z y hasta 2026-09-08T22:34:46.657Z; el issue #976645
lo tiene Javier (user) ..."`.
2. **Caducidad por TTL** → claim con `ttlSeconds: 1`; pasado el TTL, otra persona
   lo reclama sin intervención de nadie. No hay proceso de limpieza en el camino
   crítico.
3. **Solape de ficheros** → `checkOverlap` devuelve el conflicto `exact` con
   titular, `claimId` y ventana temporal, y `graphProbeTruncated: false`.
4. **Vista de claims activos** → 3 claims, `truncated: false`.

El epic pedía "advisory locks transaccionales y con TTL" y eso **no es lo que hay**:
la fuente de verdad es una fila en `claims`, y el advisory lock solo serializa la
reclamación dentro de una transacción. La desviación está registrada en
`docs/adr/0004-claims-como-lease-en-tabla.md` con su razonamiento (un lock de
sesión no sobrevive a PgBouncer en modo transacción, que es decisión cerrada).
**Es una desviación bien argumentada y documentada, no un descuido.**

---

## 8. El servidor MCP (T05)

Arrancado de verdad contra el `dist/` compilado
(`node packages/graph/dist/mcp/main.js`, transporte stdio) y consultado con el
cliente del SDK:

- `listTools` devuelve las cinco: `active_claims`, `blast_radius`,
  `find_dependencies`, `find_dependents`, `who_last_touched`.
- Las cinco responden sin error contra el grafo real (§5 para los tamaños).
- `who_last_touched` devuelve **personas**: `{"person":"JVISERASS","source":"git",
"lastTouchedAt":"2026-09-08T19:33:34+02:00","commit":"3e19cadde6be"}`. En esta
  prueba `source` es `git` y no `user` porque el correo del autor de los commits
  no coincide con ningún `users.email` del tenant sembrado; el comportamiento es
  el documentado, y el correo **no sale** en la respuesta.
- Sin `GRAPH_MCP_TENANT_ID` el servidor **se niega a arrancar**, con el motivo
  escrito. Comprobado. Nunca responde "todo" por falta de contexto.

---

## 9. Higiene del árbol

`git status` limpio de basura: 17 ficheros modificados y 72 sin seguir, **todos**
código o documentación del epic 02. Ni `node_modules`, ni `dist`, ni `.env`, ni
ficheros temporales de agentes, ni sobras de pruebas. `dist/` y `*.tsbuildinfo`
están en `.gitignore`.

`gitleaks dir` (que sí mira el `.env` local) encuentra 2 secretos, los dos **en
`.env`**, que está ignorado por git y nunca se ha commiteado. El gate que corre en
CI es `gitleaks git`, sobre el historial, y está limpio.

**No se ha hecho ningún commit ni se ha tocado el remoto.**

Estado que queda en el Postgres de desarrollo local, para que a nadie le extrañe:
las migraciones `0007`-`0009` aplicadas, dos grafos indexados
(`PACONSULTING-gh/coding-agents` y `local/snapshot`) bajo el tenant Liberion Labs,
y unos claims de prueba que caducan solos a los 5 minutos.

---

## 10. Deuda técnica asumida a propósito

Toda con su motivo escrito por quien la asumió. No está escondida.

| Deuda                                                                        | Motivo                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/graph` **fuera del mutation testing**                              | Medido y rechazado por deshonesto: 291 mutantes, 229 timeouts, 0 muertos, y una puntuación de 78,69 que superaba el `break=60` **sin que ningún test matara nada**. Está razonado en `stryker.config.json`. Desbloquearlo exige refactorizar los 13 ficheros de test para que no levanten contenedor por mutante |
| `purgeExpiredClaims` **no enganchada** en `apps/worker`                      | Programarla exige enumerar tenants al arrancar, y eso es aprovisionamiento, que aún no existe. **No afecta a la corrección**: la caducidad se materializa en la propia transacción que reclama                                                                                                                   |
| `graph_edges.weight` de `cochange` lleva el **lift**, no la frecuencia bruta | El criterio de T03 pedía frecuencia. El lift corrige el sesgo de los ficheros que cambian mucho por su cuenta; la frecuencia bruta se conserva en `metadata.cochangeCount`. ADR 0005                                                                                                                             |
| Claims como arriendo en tabla, no advisory locks                             | Lo que pedía T04 es imposible bajo PgBouncer en modo transacción. ADR 0004                                                                                                                                                                                                                                       |
| No existe tabla `repositories`: el `repo_id` se **deriva**                   | Crearla sin consumidor sería inventar modelo de datos. La derivación es determinista y aislada por tenant                                                                                                                                                                                                        |

---

## 11. Lo que requiere decisión o acción humana

Por orden de urgencia.

1. **Arreglar el límite de 32 KiB de tree-sitter (§4.1).** Bloqueante: en cuanto
   se commitee el epic, indexar este mismo repositorio falla. Hay que decidir
   entre `bufferSize` explícito o la forma de callback, y escribirlo con un test
   de regresión que use un fichero de más de 32 KiB. **El test lo tiene que
   escribir alguien distinto de quien haga el arreglo.**
2. **Decidir qué se hace con los paquetes del workspace (§6.3).** Opciones:
   resolver los especificadores de paquetes del propio workspace a su fichero de
   entrada (leyendo `pnpm-workspace.yaml` y los `package.json`), o aceptar que el
   grafo estático se queda dentro del paquete y depender de la capa de build. Es
   una decisión de producto, no de implementación: cambia lo que el sistema es
   capaz de contestar.
3. **No hay forma de indexar un repositorio a mano.** Hoy la ingesta solo se
   dispara desde un job `graph.ingest`, que solo se encola al recibir un `push`
   de GitHub. Para el arranque en frío de un repositorio (y para conectar el MCP a
   un agente, §12) hace falta un comando. Es pequeño, pero no existe.
4. **Revisar el matiz del presupuesto de 8 KiB (§5)**: o se aplica el tope al
   sobre completo, o el README deja de decir "cada respuesta".
5. **Las 3 vulnerabilidades moderate de `qs`** son transitivas y el gate de CI
   (`--audit-level=high`) las deja pasar. Decisión consciente pendiente de
   confirmar, no un descubrimiento.
6. **Aprobación humana del epic** (CLAUDE.md §2.1 y §6). Ningún agente puede
   aprobar esto, este informe incluido.

---

## 12. Definition of Done del epic

| Criterio del epic                                                                     | Estado                                                                                                                                 |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Dado un PR abierto, el sistema dice qué se ve afectado y quién lo tocó por última vez | **Parcial.** `blast_radius` y `who_last_touched` funcionan y responden bien, pero el alcance se corta en la frontera de paquete (§6.3) |
| Dos personas no pueden reclamar el mismo issue a la vez                               | **Cumplido** y verificado con una carrera real (§7)                                                                                    |
| La ingesta es incremental y sobrevive a interrupciones                                | **Cumplido** y verificado con una caída real (§6.1). Con la salvedad de §4.1                                                           |
| Las herramientas MCP están conectadas a al menos un agente real del equipo            | **NO cumplido** (ver abajo)                                                                                                            |

### Qué falta exactamente para conectar el MCP a un agente real

El servidor funciona; lo que falta es todo lo de alrededor. Para que un miembro
del equipo lo use desde su Claude Code:

1. **Que exista un tenant de verdad y su uuid.** Hoy los dos tenants del Postgres
   local son semillas de test. No hay flujo de aprovisionamiento.
2. **Que el repositorio esté indexado para ese tenant** — sin eso las cinco
   herramientas contestan vacío, y `who_last_touched` además se niega. Y hoy la
   única manera de indexar es recibir un webhook de `push` de GitHub con
   `GRAPH_CHECKOUT_ROOT` configurado y un checkout local ya clonado. **Esto es el
   punto 3 de §11 y es el bloqueante real.**
3. **Un checkout local mantenido al día** bajo `GRAPH_CHECKOUT_ROOT`, con la forma
   `<raíz>/<owner>/<repo>`. Clonar y actualizar checkouts no lo hace nadie
   todavía: es una decisión explícita del epic, no un olvido.
4. **El bloque de configuración en el `mcp.json` de cada persona**, con
   `PGBOUNCER_URL`, `GRAPH_MCP_TENANT_ID` y `GRAPH_CHECKOUT_ROOT`. La plantilla
   está en `packages/graph/README.md` §7.5 y es correcta: la verifiqué arrancando
   el servidor exactamente así.
5. **Decidir el §6.3 antes de enseñárselo a nadie.** Un agente que pregunta "qué
   se rompe si toco `tenant.ts`" y recibe dos ficheros del mismo paquete no
   aprende a preguntar: aprende a no fiarse de la herramienta.

Los puntos 1-3 no son de este epic —son aprovisionamiento y despliegue—, pero
mientras no existan, **este criterio de la Definition of Done no se puede marcar**,
y decir lo contrario sería fingir que funciona.
