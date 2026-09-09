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

Ninguna bloquea el Epic 01. Se pueden tomar sobre la marcha, pero cada una tiene
su fecha límite real. **La 4 ya está decidida** (ADR 0008).

### 1. Proyecto piloto
**Bloquea:** Epic 01 T07
**Qué hay que decidir:** qué proyecto real de Liberion sirve de conejillo de
indias. Debe ser real (no un juguete), con varias personas tocándolo, y tolerar
que la herramienta falle al principio.
**Cuándo:** antes de cerrar el Epic 01.

### 2. Baseline de métricas
**Bloquea:** la validación de todo el producto
**Qué hay que decidir:** cómo se miden hoy las cuatro métricas del PRD §3
(colisiones en merge, horas revisando diffs, tareas duplicadas, agentes
atascados). Si no se mide antes, no habrá con qué comparar después.
**Cuándo:** semana 1 del piloto, no después.

### 3. Formato de la vista de estado
**Bloquea:** Epic 04 T05
**Qué hay que decidir:** comentario en issue, resumen por CLI, o canal de
mensajería. Es decisión de producto, no técnica.
**Cuándo:** antes de empezar Epic 04 T05.

### 4. Flujo de fallo de verificación — ~~PENDIENTE~~ **DECIDIDA (9 sep 2026)**
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

### 5. Presentación del informe de conformidad
**Bloquea:** Epic 05 T05 (parcialmente — se puede empezar con un formato
provisional)
**Qué hay que decidir:** cómo se presenta para que genere confianza real y no
acabe siendo otra notificación que se aprueba sin leer. Necesita iterar con el
lead real, no diseñarse en abstracto.
**Cuándo:** durante el Epic 05, con feedback del usuario real.

---

## Lo que ya está decidido y NO hay que volver a discutir

Está en `CLAUDE.md` §3. Si alguien cree que una decisión está mal, el
procedimiento es abrir un ADR proponiendo el cambio, no reabrir el debate en un
PR.

- GitHub App, no OAuth App
- Postgres con esquema compartido y RLS forzada
- pg-boss sobre el mismo Postgres, tras una interfaz
- PgBouncer en modo transacción desde el día uno
- Grafo en Postgres con CTEs recursivas, no base de datos de grafos
- CCPM + GitHub Issues como motor y fuente de verdad
- Heartbeats push, nunca polling
- TypeScript/Node, monorepo
- SonarQube Server self-hosted (residencia de datos UE)
- ponytail instalado en los agentes desde el principio

---

## Lo que sigue sin investigar (y no hace falta para construir)

- Skills de comunidad por fase del SDLC, más allá de ponytail. Se pueden añadir
  sobre la marcha; no son cimiento.
- Agente de despliegue Terraform/Azure. Ya investigado, pero fuera del alcance
  de la v1 — va en v2 con su propio epic.
- Modelo de precios detallado para la versión producto. La licencia y el enfoque
  están decididos (BSL o fair-code, monetizar hosting + features de IA); los
  números concretos son una conversación posterior.
