# Índice del paquete y decisiones pendientes

---

## Los documentos

| Archivo | Qué es | Cuándo se usa |
|---|---|---|
| `CLAUDE.md` | Constitución: principios, arquitectura cerrada, qué no construir | Se carga en todo agente, siempre |
| `prd-plataforma-coordinacion.md` | PRD raíz | Entrada de CCPM, se parsea a epics |
| `docs-estructura-y-gates.md` | Estructura del monorepo, las tres capas de gates, frontera comprar/construir | Referencia continua |
| `epic-01-cimientos.md` | Fase 0 — infraestructura multi-tenant | Empezar ya |
| `epic-02-grafo-colisiones.md` | Fase 1 — grafo de dependencias y claims | Tras Epic 01 |
| `epic-03-routing.md` | Fase 2 — asignación asistida | Tras Epic 02 T05 |
| `epic-04-heartbeats-colisiones.md` | Fase 3 — estado de agentes y predicción | Tras Epic 02 |
| `epic-05-verificacion.md` | Fase 4 — verificación por resultados | Tras Epic 01 y 02 |
| `epic-06-docs-escalabilidad.md` | Fase 5 — documentación y ganchos | Paralelo a 04 y 05 |
| `liberion-labs-roadmap.md` | Hoja de ruta general (documento previo) | Visión de conjunto |

---

## Orden real de trabajo

```
Epic 01 ──┬── Epic 02 ──┬── Epic 03
          │             ├── Epic 04
          │             └── Epic 05 (también depende de 01 T06)
          └── Epic 06 (en paralelo, no bloquea nada)
```

---

## Decisiones pendientes que bloquean tareas concretas

**Ya no queda ninguna abierta.** Las cuatro que quedaban se decidieron el 12 de
septiembre de 2026 y están en `docs/adr/0010-banco-de-pruebas-con-desarrolladores-simulados.md`.
Aquí va el resumen; el porqué de cada una está en el ADR.

### 1. Proyecto piloto — **DECIDIDA (12 sep 2026)**
**Bloqueaba:** Epic 01 T07 (#8), #34, el cierre del Epic 01

**Decisión:** no hay piloto con un equipo real. Hay un **banco de pruebas con
cinco desarrolladores simulados**, cada uno en su contenedor y con su propia
instancia de Claude Code.

**Corregido el 13 de septiembre de 2026:** la versión anterior decía "con cuenta
de GitHub real" cada uno. Hacen falta **cero** para empezar y **una** cuando se
cablee la asignación: el router identifica a la gente por el email de git, no
por el login. El porqué está en el ADR 0010. La carga de trabajo es un CRM
para una empresa de construcción (Next.js + Postgres + El Gabinete).

Se decidió así porque **ninguno de los doce repos de la organización ha abierto
jamás un issue**, y esta plataforma se apoya en Issues como fuente de verdad:
elegir piloto no era elegir repo, era pedirle a tres personas a tiempo parcial
que cambiaran su forma de trabajar por una herramienta que aún no les ha
demostrado nada.

**Lo que hay que decir cada vez que se citen resultados de aquí:** valida el
MECANISMO —claims, colisiones, router, verificación, escalado— y **no valida la
adopción**. Las dos métricas del PRD §3 que miden comportamiento humano (horas
del lead revisando diffs, y atascos detectados antes que por la persona) son
inobservables con desarrolladores simulados.

### 2. Baseline de métricas — **DECIDIDA (12 sep 2026)**
**Decisión:** **no se mide baseline.** Se comparará cualitativamente al final.

**Y lo que eso desactiva:** el PRD §3 decía que si tras el piloto no se mueve
ninguna métrica, hay que replantear. Sin baseline esa salvaguarda no se puede
aplicar: no habrá con qué comparar, así que "no se ha movido nada" no se podrá
ni afirmar ni negar. La tabla del PRD se corrigió para que no siga prometiendo
una medida que no se va a tomar.

### 3. Formato de la vista de estado — **DECIDIDA (12 sep 2026)**
**Bloqueaba:** Epic 04 T05

**Decisión:** las **tres vías** — un issue fijo que se reescribe, un resumen por
CLI bajo demanda, y **Slack**. No son tres implementaciones: son tres
adaptadores del `NotificationPort` que ya existe.

### 4. Flujo de fallo de verificación — **DECIDIDA (9 sep 2026)**
**Bloqueaba:** Epic 05 T06
**Decisión:** `docs/adr/0008-flujo-de-fallo-y-ambiguedad.md`.

Resumen: no hay *un* flujo de fallo, hay **cuatro modos con tres destinos**. Un
fallo del gate o un FAIL del Verifier vuelven al mismo agente; un SIN_EVIDENCIA
repetido **sobre el mismo criterio** vuelve a la fase de criterios; y un fallo
que impide al Verifier emitir veredicto escala a un humano **sin gastar
intento**. Dos intentos en total. El responsable sale de una cadena (holder del
claim → assignee del issue → nadie, y el "nadie" se dice). El aviso sale por un
puerto, con un adaptador que comenta en el issue.

Que esta tarea estuviera mal planteada —dando por hecho que era un solo flujo—
es la razón de que llevara meses sin diseñarse.

### 5. Presentación del informe de conformidad — **DECIDIDA (12 sep 2026)**
**Bloqueaba:** Epic 05 T05 (parcialmente)

**Decisión:** tres añadidos sobre lo que ya cumple — una sección fija con **lo
que NO se pudo verificar**, un **enlace a la línea del diff** en cada veredicto,
y **con qué se produjo el informe** (modelo, esfuerzo, reintentos o negativas).

Lo último se acota a propósito: **hechos, no una cifra de confianza.** "Modelo
`claude-opus-5`, esfuerzo `xhigh`, 1 reintento tras una negativa" es
verificable; "Confianza: 7/10" es la puntuación del 1 al 10 que el criterio de
aceptación de T05 prohíbe, con otro nombre.
