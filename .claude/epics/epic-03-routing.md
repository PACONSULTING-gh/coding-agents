# Epic 03 — Asignación asistida entre personas

**PRD origen:** `prd-plataforma-coordinacion.md`
**Fase de la hoja de ruta:** 2
**Depende de:** Epic 02 (al menos T05, las herramientas MCP)
**Objetivo:** que cuando entra una tarea, alguien reciba una sugerencia razonada
de a quién dársela, en vez de decidirlo a ojo.

---

## Enfoque técnico

Score ponderado transparente, no caja negra. Con 3-10 personas no hace falta
matching global: un score explicable gana, porque el humano tiene que poder ver
por qué se sugiere a alguien y anularlo con criterio.

El agente clasifica la tarea, consulta el grafo (qué ficheros toca), el
historial (quién los ha tocado), y la carga actual. Produce un shortlist
ranqueado con justificación y confianza.

**El orden del razonamiento importa:** primero evidencia de skill, después carga
de trabajo. Si se invierte, el modelo coge el atajo de "el que esté más libre" y
la sugerencia deja de aportar.

**Lo que este epic NO hace:** asignar automáticamente. Nunca. El agente sugiere,
el humano confirma. Esto no es una limitación temporal de la v1, es un principio
(ver `CLAUDE.md` §2.1).

---

## Tareas

### T01 — Señales de skill y carga
**Paralelizable:** sí (con T02)
**Depende de:** —
**Toca:** `packages/agents/routing/`

Derivar señales: ownership desde `git blame` y CODEOWNERS sobre los ficheros
afectados; carga actual desde issues abiertos y claims activos; velocidad
histórica desde tiempos de cierre. Guardar como filas en la tabla `skills`, no
calcular al vuelo cada vez.

**Criterios de aceptación:**
- Dado un conjunto de ficheros, cuando pido ownership, entonces devuelve personas
  ordenadas por evidencia real de autoría, no por número bruto de commits.
- Dado un repo con un commit masivo de reformateo, cuando calculo ownership,
  entonces ese commit no distorsiona el resultado.
- Dada una persona, cuando pido su carga, entonces refleja issues en curso y
  claims activos, no issues cerrados.

---

### T02 — Prompt y agente de routing
**Paralelizable:** sí (con T01)
**Depende de:** —
**Toca:** `packages/agents/routing/`

Prompt de sistema estructurado. Procedimiento de razonamiento guiado:
(1) listar ficheros afectados, (2) evidencia de skill por candidato citando
ficheros concretos, (3) solo entonces carga de trabajo, (4) ranking.
Extended thinking activado. Caché sobre el bloque estático del prompt.

Reglas anti-anclaje explícitas y permiso para decir "sin match claro, escalar".

**Criterios de aceptación:**
- Dada una tarea, cuando el agente responde, entonces produce entre 2 y 4
  candidatos ranqueados, cada uno con una razón y su evidencia más fuerte.
- Dada una tarea sin buen match, cuando el agente responde, entonces lo dice
  explícitamente en vez de forzar un candidato.
- Dado un caso donde el más libre NO es el más adecuado, cuando el agente
  decide, entonces la evidencia de skill pesa más que la carga.
- Dado el shortlist, cuando lo leo, entonces puedo saber qué señal condujo cada
  posición sin abrir el código.

---

### T03 — Integración con GitHub Issues
**Paralelizable:** no
**Depende de:** T01, T02
**Toca:** `apps/worker/`, `packages/github/`

Al crearse un issue nuevo, se dispara el routing y se publica el shortlist como
comentario del issue. La confirmación humana se hace asignando el issue de la
forma normal de GitHub — sin interfaz propia.

**Criterios de aceptación:**
- Dado un issue nuevo, cuando se crea, entonces en menos de 2 minutos aparece un
  comentario con el shortlist razonado.
- Dado un issue ya asignado manualmente, cuando se crea, entonces el agente no
  interviene.
- Dado un fallo del agente, cuando ocurre, entonces el issue sigue su curso
  normal y el fallo queda en el log, sin bloquear a nadie.

---

### T04 — Medición de acierto
**Paralelizable:** no
**Depende de:** T03
**Toca:** `packages/agents/routing/`

Registrar, para cada sugerencia: a quién se sugirió, a quién se asignó
finalmente, y si coincide. Esto es la validación del supuesto del PRD §6.

**Criterios de aceptación:**
- Dada una semana de uso, cuando consulto la métrica, entonces sé qué porcentaje
  de veces se aceptó la primera sugerencia.
- Dado que la tasa de anulación supere el 50% sostenido, entonces existe una
  alerta: la sugerencia no está aportando y hay que revisar los pesos.

---

## Definition of Done del epic

- Todo issue nuevo del repo piloto recibe un shortlist razonado.
- Ninguna asignación es automática.
- La tasa de aceptación de la primera sugerencia está medida y registrada.
- Si la tasa es mala, se ha documentado por qué en vez de ignorarlo.
