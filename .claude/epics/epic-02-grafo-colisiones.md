# Epic 02 — Grafo de dependencias y detección de colisiones

**PRD origen:** `prd-plataforma-coordinacion.md`
**Fase de la hoja de ruta:** 1
**Depende de:** Epic 01 cerrado
**Objetivo:** que el sistema sepa, dado un cambio o una tarea, qué más se ve
afectado y quién más está tocando eso mismo ahora.

---

## Enfoque técnico

El grafo vive en el mismo Postgres: tabla de nodos, tabla de aristas, consultas
de dependencias inversas con CTEs recursivas. No se añade una base de datos de
grafos: en el patrón que usamos (expansión de vecindario acotada, no
pathfinding profundo) Postgres es más rápido.

Construcción por capas: tree-sitter para aristas de import/llamada/herencia en
cualquier lenguaje, más el grafo nativo de Nx/Bazel/Turborepo si el repo del
cliente ya lo tiene. Overlay de co-change desde el historial de git, que es la
señal más barata para dependencias lógicas que el análisis estático no ve.

**Lo importante:** actualización incremental desde el día uno. Un rebuild
completo del grafo no sobrevive a un repo grande, y retrofitearlo después es
caro.

**Lo que este epic NO hace:** predecir archivos afectados desde el texto de una
tarea (eso es Epic 04, y es experimental). Aquí solo se calcula el afectado a
partir de un cambio que ya existe.

---

## Tareas

### T01 — Esquema del grafo y consultas de dependencias inversas
**Paralelizable:** no (bloquea el resto)
**Depende de:** —
**Toca:** `packages/graph/`

Tablas `nodes` y `edges`. Nodos: fichero, símbolo, paquete, target. Aristas:
`imports`, `calls`, `inherits`, `contains`, `cochange`, con tipo de origen
(estático, build, git). Índices en ambas direcciones. CTE recursiva con tope de
profundidad y guarda de ciclos.

**Criterios de aceptación:**
- Dado un nodo, cuando pido sus dependientes, entonces obtengo el conjunto
  transitivo hasta la profundidad indicada, sin bucles infinitos en grafos
  cíclicos.
- Dado un repo con más de 10.000 nodos, cuando ejecuto una consulta de
  dependencias inversas, entonces responde en menos de 200 ms en p95.
- Dadas dos tenants con grafos distintos, cuando consulto desde una, entonces no
  aparece ningún nodo de la otra.

---

### T02 — Ingesta con tree-sitter e indexación incremental
**Paralelizable:** no (depende de T01)
**Depende de:** T01
**Toca:** `packages/graph/`

Parseo con tree-sitter, extracción de aristas. Cada fichero guarda su hash de
contenido junto a los nodos y aristas que generó: al llegar un commit, solo se
reparsea lo que cambió de hash.

**Criterios de aceptación:**
- Dado un repo ya indexado, cuando cambia un solo fichero, entonces solo ese
  fichero se reparsea y el resto del grafo no se toca.
- Dado un commit, cuando termina la ingesta, entonces el grafo refleja el estado
  del repo en menos de 30 segundos para repos de tamaño medio.
- Dado un fichero borrado, cuando se procesa el commit, entonces sus nodos y
  aristas desaparecen del grafo.
- Dada una ingesta interrumpida a mitad, cuando se reanuda, entonces continúa
  sin empezar de cero.

---

### T03 — Ingesta de grafos nativos de build y overlay de co-change
**Paralelizable:** sí (con T04)
**Depende de:** T02
**Toca:** `packages/graph/`

Si el repo tiene Nx/Bazel/Turborepo, ingerir su grafo de proyectos y normalizarlo
al esquema común. Aparte, minar el historial de git para aristas `cochange`
(ficheros que cambian juntos repetidamente), con umbral configurable.

**Criterios de aceptación:**
- Dado un repo con Nx, cuando se ingiere, entonces sus aristas entre proyectos
  aparecen en el grafo marcadas con origen `build`.
- Dado el historial de git, cuando se minan co-cambios, entonces cada arista
  lleva su peso (frecuencia de co-cambio).
- Dada una consulta de afectados, cuando incluye co-change, entonces cada
  resultado indica qué señal lo predijo (estática o histórica).

---

### T04 — Claims y leases sobre issues y ficheros
**Paralelizable:** sí (con T03)
**Depende de:** T01
**Toca:** `packages/graph/`, `packages/core/`

Advisory locks de Postgres, transaccionales y con TTL. Un claim reserva un issue
y opcionalmente un conjunto de ficheros. Los claims caducan solos si el agente
muere. Vista de claims activos.

**Criterios de aceptación:**
- Dados dos intentos simultáneos de reclamar el mismo issue, cuando compiten,
  entonces solo uno lo consigue y el otro recibe un rechazo claro.
- Dado un claim cuyo dueño desaparece, cuando pasa el TTL, entonces el claim se
  libera automáticamente.
- Dado un claim sobre ficheros, cuando otro intenta reclamar un fichero
  solapado, entonces recibe aviso con quién lo tiene y desde cuándo.
- Dado el sistema con muchos claims activos, cuando reviso `pg_locks`, entonces
  no hay agotamiento de memoria compartida.

---

### T05 — Herramientas MCP del grafo
**Paralelizable:** no
**Depende de:** T03, T04
**Toca:** `packages/graph/mcp/`

Exponer el grafo como servidor MCP: `find_dependents`, `find_dependencies`,
`blast_radius`, `who_last_touched`, `active_claims`. Salidas compactas y
ranqueadas, no volcados enormes — el objetivo es que un agente pregunte en vez
de leer ficheros.

**Criterios de aceptación:**
- Dado un agente con el servidor MCP conectado, cuando llama a `blast_radius`
  con un conjunto de ficheros, entonces recibe el conjunto afectado ranqueado
  con la señal que lo predijo.
- Dada una respuesta de cualquier herramienta, cuando la mido, entonces cabe
  holgadamente en el presupuesto de contexto (no vuelca el repo entero).
- Dado `who_last_touched`, cuando lo llamo con unos ficheros, entonces devuelve
  personas, no solo hashes de commit.

---

## Definition of Done del epic

- Dado un PR abierto en el repo piloto, el sistema puede decir qué más se ve
  afectado y quién lo tocó por última vez.
- Dos personas no pueden reclamar el mismo issue a la vez.
- La ingesta es incremental y sobrevive a interrupciones.
- Las herramientas MCP están conectadas a al menos un agente real del equipo.
