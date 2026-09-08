# Epic 05 — Verificación por resultados

**PRD origen:** `prd-plataforma-coordinacion.md`
**Fase de la hoja de ruta:** 4
**Depende de:** Epic 01 (gates de CI), Epic 02 (grafo, para blast radius)
**Objetivo:** que un humano pueda aprobar el trabajo de un agente leyendo un
informe de una página, en vez de 300 líneas de diff.

---

## Enfoque técnico

Este es el módulo de mayor valor y mayor riesgo. Se diseña **asumiendo que el
agente hará trampa**, porque está documentado que lo hace: hardcodea valores
esperados, debilita aserciones, borra ficheros de test, y en tareas imposibles
inventa formas de que el test pase sin resolver nada.

Por eso la verificación es en capas, y ninguna capa se fía de la anterior:

1. **Criterios de aceptación aprobados por un humano ANTES de codear.** Esta es
   la palanca más importante del epic, y no es técnica. Sin esto, el resto es
   teatro: se acaba con una fachada de tests verdes sobre funcionalidad rota.
2. **Los tests los escribe un agente distinto** al que escribe el código.
3. **Gate determinista en CI:** build, lint, tipos, tests, escaneos, y umbral de
   mutation testing (que detecta tests que pasan sin comprobar nada real).
4. **Verifier en contexto limpio**, viendo solo el spec y el diff final — nunca
   el razonamiento del que codeó, nunca su narrativa del PR.
5. **Informe de conformidad** por criterio, con cita textual como evidencia.

---

## Tareas

### T01 — Criterios de aceptación como artefacto de primera clase
**Paralelizable:** no (bloquea el resto)
**Depende de:** —
**Toca:** `.claude/epics/`, `packages/core/`

Formato Given/When/Then por tarea, almacenado y versionado, con estado de
aprobación humana. Una tarea sin criterios aprobados no puede empezar.

**Criterios de aceptación:**
- Dada una tarea sin criterios aprobados, cuando un agente intenta reclamarla,
  entonces el claim se rechaza.
- Dado un criterio, cuando lo leo, entonces es observable y acotado: se puede
  señalar la salida, el código de respuesta o el fichero que prueba que se
  cumple.
- Dado un cambio en los criterios después de aprobados, cuando ocurre, entonces
  queda registrado quién y cuándo, y requiere re-aprobación.

---

### T02 — Generación de tests por agente separado
**Paralelizable:** sí (con T03)
**Depende de:** T01
**Toca:** `packages/agents/verification/`

Un agente distinto al que implementa escribe los tests, a partir del spec, no
del código. Preferiblemente otro modelo. Los tests viven en una ruta que el
agente implementador no puede escribir.

**Criterios de aceptación:**
- Dado un criterio de aceptación, cuando se genera su test, entonces el agente
  generador no ha visto la implementación.
- Dado el agente implementador, cuando intenta modificar ficheros de test,
  entonces el intento se bloquea y se registra.
- Dado un conjunto de criterios, cuando termina la generación, entonces cada
  criterio tiene al menos un test asociado y trazable.

---

### T03 — Gate determinista y mutation testing
**Paralelizable:** sí (con T02)
**Depende de:** Epic 01 T06
**Toca:** `.github/workflows/`

Extender el CI: además de lo de Epic 01, añadir umbral de mutation testing en
módulos críticos, y detección explícita de manipulación de tests en el diff.

**Criterios de aceptación:**
- Dado un PR que borra o debilita aserciones, cuando corre el CI, entonces se
  marca y se bloquea.
- Dado un módulo crítico con puntuación de mutación bajo umbral, cuando corre el
  CI, entonces falla con mensaje claro de que los tests no comprueban lo
  suficiente.
- Dado un PR que hardcodea un valor esperado en lugar de calcularlo, cuando pasa
  por el gate, entonces al menos una capa lo detecta.

---

### T04 — Agente Verifier en contexto aislado
**Paralelizable:** no
**Depende de:** T01, T02, T03
**Toca:** `packages/agents/verification/`

Sesión limpia, modelo capaz, extended thinking alto. Recibe **solo**: criterios
de aceptación, diff final, resultados de tests. **No recibe**: cadena de
razonamiento del implementador, descripción del PR, ni sus afirmaciones sobre lo
que hizo — esas se tratan como entrada potencialmente adversaria.

Evalúa criterio a criterio: PASS / FAIL / SIN_EVIDENCIA. Cada veredicto exige
cita textual del criterio y del diff o la salida de tests. Razonamiento antes del
veredicto. Permiso explícito para SIN_EVIDENCIA en vez de asumir que funciona.

**Criterios de aceptación:**
- Dado un diff, cuando lo verifica, entonces el Verifier no tiene acceso al
  contexto del agente que lo escribió.
- Dado un veredicto, cuando lo leo, entonces incluye cita textual del criterio y
  de la evidencia concreta.
- Dado un criterio sin evidencia en el artefacto, cuando se evalúa, entonces
  devuelve SIN_EVIDENCIA en vez de PASS optimista.
- Dado un conjunto de diffs con trampas conocidas (tests borrados, valores
  hardcodeados, criterios imposibles), cuando el Verifier los evalúa, entonces
  los detecta y su tasa de falso aprobado queda medida.

---

### T05 — Informe de conformidad
**Paralelizable:** no
**Depende de:** T04
**Toca:** `packages/agents/verification/`

La salida que sustituye al diff: por criterio, veredicto y evidencia; más un
veredicto global binario. Publicado como comentario del PR.

**Criterios de aceptación:**
- Dado un PR verificado, cuando el humano abre el informe, entonces puede
  decidir sin abrir el diff.
- Dado el veredicto global, cuando existe, entonces es binario (apto / no apto),
  no una puntuación del 1 al 10.
- Dado un informe, cuando lo mido, entonces cabe en una pantalla.

---

### T06 — Flujo de fallo y ambigüedad
**Paralelizable:** no
**Depende de:** T05
**Toca:** `packages/core/`, `apps/worker/`

Qué pasa cuando el gate falla o el veredicto es ambiguo: quién recibe el aviso,
si se reasigna o se devuelve al mismo agente, cuántos reintentos antes de
escalar a humano, y cómo se re-verifica.

**Criterios de aceptación:**
- Dado un fallo de verificación, cuando ocurre, entonces existe un responsable
  asignado y notificado.
- Dado un reintento, cuando ocurre, entonces está acotado a N intentos y después
  escala a humano.
- Dado un veredicto SIN_EVIDENCIA reiterado, cuando ocurre, entonces se trata
  como señal de spec ambiguo y se devuelve a la fase de criterios, no al agente.

---

## Definition of Done del epic

- Ningún merge sin informe de conformidad.
- La tasa de falso aprobado del Verifier está medida contra diffs con trampas.
- El lead del piloto confirma que aprueba sin abrir el diff (métrica del PRD §3).
- El flujo de fallo está definido y probado con un caso real.

---

## Huecos conocidos

**Sin diseñar todavía:**

1. **El flujo concreto de T06.** Sabemos que hace falta, no está definido: quién
   decide, cómo se reasigna, cuántos reintentos. Hay que diseñarlo antes de
   empezar T06 — es la laguna que llevamos arrastrando desde el principio.

2. **El diseño exacto del informe (T05).** Sabemos qué debe contener, no cómo se
   presenta para que genere confianza real y no se convierta en otra notificación
   que la gente aprueba sin leer. Merece una iteración con el usuario real (el
   lead) antes de darlo por bueno.
