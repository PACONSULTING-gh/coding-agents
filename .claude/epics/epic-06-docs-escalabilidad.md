# Epic 06 — Documentación automática y preparación para escalar

**PRD origen:** `prd-plataforma-coordinacion.md`
**Fase de la hoja de ruta:** 5
**Depende de:** Epic 01 (motor CCPM en uso)
**Puede ir en paralelo con:** Epic 04 y 05
**Objetivo:** que la documentación de cliente salga sola de lo que ya existe, y
que los ganchos de escalabilidad estén puestos antes de necesitarlos.

---

## Enfoque técnico

Una sola fuente de verdad, dos salidas. La cadena que ya tenemos
(PRD → Epic → Task → Issue → Commit) contiene casi todo lo necesario para
generar la SRS, la matriz de trazabilidad y el changelog. Lo único que cambia
entre la versión interna y la de cliente es el registro y el filtro.

**Prevención de fugas por estructura, no por instrucción.** El generador de la
versión de cliente trabaja sobre un conjunto de hechos ya filtrado, no sobre los
artefactos crudos. Así los datos internos nunca entran en su contexto, en vez de
confiar en que el modelo obedezca un "no menciones esto".

Los ganchos de escalabilidad son baratos ahora y caros después. Se ponen ya,
aunque no se usen.

---

## Tareas

### T01 — Extracción de hechos desde artefactos de CCPM
**Paralelizable:** no (bloquea T02)
**Depende de:** —
**Toca:** `packages/agents/docs/`

Script sobre la API de GitHub que exporta, por epic: PRD, epic, tareas, issues,
comentarios y commits, y los reduce a un conjunto de hechos neutrales — qué se
entregó, por qué, impacto, cambios que rompen compatibilidad.

**Criterios de aceptación:**
- Dado un epic cerrado, cuando ejecuto la extracción, entonces obtengo un
  conjunto de hechos estructurado sin prosa generada.
- Dado el conjunto de hechos, cuando lo reviso, entonces cada hecho está marcado
  como interno o compartible.
- Dado un epic con 30 issues, cuando extraigo, entonces tarda menos de un minuto.

---

### T02 — Generación por audiencia
**Paralelizable:** no
**Depende de:** T01
**Toca:** `packages/agents/docs/`

Dos renderizados desde el mismo conjunto de hechos: registro técnico interno
(preciso, con nombres de módulos, pasos de migración) y registro de cliente
(orientado a beneficio, sin jerga interna). El de cliente solo ve los hechos
marcados como compartibles.

**Criterios de aceptación:**
- Dado un conjunto de hechos, cuando genero ambas versiones, entonces el
  contenido factual coincide y solo cambia el registro.
- Dado un hecho marcado como interno, cuando genero la versión de cliente,
  entonces no aparece — ni literal ni parafraseado.
- Dada la versión de cliente, cuando la reviso, entonces no contiene
  identificadores internos, nombres de personas, ni referencias a features no
  lanzadas.
- Dada cualquier salida de cliente, cuando se genera, entonces requiere revisión
  humana antes de enviarse.

---

### T03 — Borradores de SRS, trazabilidad y changelog
**Paralelizable:** sí (con T02)
**Depende de:** T01
**Toca:** `packages/agents/docs/`

Desde los mismos hechos: borrador de SRS (del PRD y epic), matriz de
trazabilidad requisito→issue→commit→test, y changelog. Borradores, no
documentos finales.

**Criterios de aceptación:**
- Dado un epic, cuando genero la matriz de trazabilidad, entonces cada criterio
  de aceptación enlaza con su issue, sus commits y sus tests.
- Dado un criterio sin test asociado, cuando genero la matriz, entonces aparece
  marcado como hueco, no omitido.
- Dado el borrador de SRS, cuando lo comparo con el PRD, entonces no inventa
  requisitos que no estuvieran en los artefactos.

---

### T04 — Kit de plantillas de entrega
**Paralelizable:** sí
**Depende de:** —
**Toca:** `docs/plantillas/`

Preparar UNA vez las plantillas del núcleo que se pide en casi todo proyecto:
README, arc42 ligero, ADR, OpenAPI, runbook, resumen de tests, changelog, DPA.
Los documentos pesados (SRS formal, DPIA, plan de pruebas ISO, pentest) se
generan solo bajo demanda.

**Criterios de aceptación:**
- Dado un proyecto nuevo, cuando instancio el kit, entonces tengo el núcleo
  documental sin escribir nada desde cero.
- Dada una plantilla, cuando la uso, entonces marcar una sección como pendiente
  es preferible a omitirla.

---

### T05 — Ganchos de escalabilidad
**Paralelizable:** sí
**Depende de:** Epic 01
**Toca:** `packages/core/`, `packages/db/`

Lo barato ahora y caro después: abstracción de proveedor de identidad (aunque
solo haya login propio), API de lectura sobre `audit_log`, routing por
equipo/skill preparado para cuando aparezca el tercer equipo, y confirmación de
que la columna `tenant.database_url` se respeta en la capa de acceso.

**Criterios de aceptación:**
- Dada la capa de auth, cuando reviso el código, entonces añadir SAML u OIDC no
  requiere tocar los llamantes.
- Dado el `audit_log`, cuando lo consulto por API, entonces puedo filtrar por
  tenant, actor y rango de fechas, y exportar.
- Dado un tenant con `database_url` distinto, cuando la capa de acceso lo lee,
  entonces enruta correctamente.

---

## Definition of Done del epic

- Un informe de entrega de cliente sale del sistema y pasa revisión humana sin
  correcciones de fondo.
- Cero fugas de información interna en las salidas de cliente, verificado.
- El kit de plantillas existe y se ha usado en un proyecto real.
- Los ganchos de escalabilidad están puestos y no se han usado (eso es señal de
  que no hemos sobre-construido).
