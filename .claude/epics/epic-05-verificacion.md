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
**Toca:** `packages/core/`, `packages/db/`, `packages/github/`, `apps/worker/`
**Diseño:** `docs/adr/0008-flujo-de-fallo-y-ambiguedad.md`

**Esta tarea estaba mal planteada** y por eso llevaba meses sin diseñarse: daba
por hecho que hay *un* flujo de fallo. No lo hay. Hay **cuatro modos que
significan cosas distintas**, y tratarlos igual obliga a elegir un
comportamiento que está mal para tres de ellos.

| Modo | Destino | ¿Gasta intento? |
|---|---|---|
| `gate_failed` — el gate determinista falló, no hay ni informe | Mismo agente | Sí |
| `verifier_fail` — `no_apto` con al menos un FAIL citado | Mismo agente | Sí |
| `verifier_no_evidence` — `no_apto` sin FAIL y con SIN_EVIDENCIA | Mismo agente la 1.ª vez; **fase de criterios** si se repite en el mismo criterio | Sí |
| `verifier_unavailable` — el Verifier no pudo emitir veredicto | **Humano, directamente** | **No** |

Lo decidido (el porqué de cada punto está en el ADR):

1. **Dos intentos en total**, no tres. Si el segundo no ve el problema con el
   informe delante, el tercero tampoco.
2. **Un fallo de infraestructura no gasta intento.** No es hipotético: hoy
   `claude-opus-5` rechaza la petición del Verifier (issue #27).
3. **El contador de SIN_EVIDENCIA es por criterio**, no por tarea. Dos criterios
   distintos fallando una vez cada uno no son un spec ambiguo.
4. **El responsable sale de una cadena** —holder del claim → assignee del issue →
   nadie— y el "nadie" **se dice en voz alta** en vez de elegir a alguien
   plausible.
5. **El aviso sale por un `NotificationPort`**, con un adaptador que comenta en
   el issue mencionando al responsable. El canal definitivo depende de la
   decisión 3 del índice (epic 04 T05), que sigue abierta.
6. **La re-verificación es limpia:** al Verifier se le da el diff nuevo y NUNCA
   el informe anterior —sería el "razonamiento del que codeó" con otro nombre—.
   Al agente sí se le da entero.
7. **El estado vive en la tabla `verification_flow`**; el `audit_log` guarda el
   histórico.

**Criterios de aceptación:**
- Dado un fallo de verificación, cuando ocurre, entonces existe un responsable
  asignado y notificado.
- Dado que no se puede identificar ningún responsable, cuando se notifica,
  entonces el aviso lo dice explícitamente en vez de elegir a alguien.
- Dado un reintento, cuando ocurre, entonces está acotado a N intentos y después
  escala a humano.
- Dado un fallo que impide al Verifier emitir veredicto, cuando ocurre, entonces
  escala a un humano y **no** consume ningún intento del agente.
- Dado un veredicto SIN_EVIDENCIA reiterado sobre el MISMO criterio, cuando
  ocurre, entonces se revoca la aprobación de los criterios y la tarea vuelve a
  la fase de criterios, no al agente.
- Dado un reintento, cuando se re-verifica, entonces el Verifier no recibe el
  informe del intento anterior.

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
