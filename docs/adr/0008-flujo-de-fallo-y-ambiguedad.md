# ADR 0008 — El flujo de fallo no es uno: son cuatro modos con tres destinos

**Estado:** Aceptada · **Fecha:** 10 de septiembre de 2026 · **Issue:** #20 (epic 05, T06)

**Contexto de origen:** epic 05, T06. Cierra la decisión pendiente n.º 4 de
`.claude/epics/00-indice-y-pendientes.md`, la única que quedaba sin diseñar
desde el principio del proyecto.

## Contexto

T06 está escrito como **un** flujo:

> Qué pasa cuando el gate falla o el veredicto es ambiguo: quién recibe el
> aviso, si se reasigna o se devuelve al mismo agente, cuántos reintentos antes
> de escalar a humano, y cómo se re-verifica.

Esa es la razón de que lleve meses sin diseñarse. No hay un flujo: hay **cuatro
modos de fallo que significan cosas distintas**, y tratarlos igual obliga a
elegir un comportamiento que está mal para tres de ellos.

El cuarto modo dejó de ser hipotético el 9 de septiembre de 2026: `claude-opus-5`
**rechaza** la petición del Verifier con la categoría `reasoning_extraction`
(issue #27). Un flujo que trate eso como "el trabajo está mal" culpa al agente de
algo que no hizo, consume su único reintento y acaba escalando a un humano con un
diagnóstico falso.

## Decisión

### 1. Cuatro modos, tres destinos

| Modo                   | Qué significa                                                                                          | Destino                                                                          | ¿Gasta intento? |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------- |
| `gate_failed`          | El gate determinista falló (build, lint, tipos, tests, mutación, integridad). Ni siquiera hay informe. | Mismo agente                                                                     | Sí              |
| `verifier_fail`        | `no_apto` con al menos un FAIL: hay evidencia **citada** de que no cumple.                             | Mismo agente                                                                     | Sí              |
| `verifier_no_evidence` | `no_apto` sin ningún FAIL y con al menos un SIN_EVIDENCIA.                                             | Mismo agente la 1.ª vez; **fase de criterios** si se repite en el mismo criterio | Sí              |
| `verifier_unavailable` | El Verifier no pudo emitir veredicto: negativa del modelo, timeout, sin credenciales.                  | **Humano, directamente**                                                         | **No**          |

La última columna es la mitad menos obvia y la más importante. Un fallo de
infraestructura no es trabajo mal hecho, así que **no gasta el presupuesto de
intentos del agente**. Si lo gastara, una racha de rechazos del modelo escalaría
todas las tareas del día como si todos los agentes hubieran fallado a la vez.

### 2. Dos intentos en total, no tres

Un agente entrega, falla, se le devuelve **una vez** con el informe de
conformidad delante, y si vuelve a fallar escala a un humano.

El argumento no es de coste, aunque también: si el segundo intento no ve el
problema **teniendo el informe con la cita textual de qué criterio incumple y
por qué**, el tercero tampoco va a verlo. Lo que cambia entre el intento 2 y el
3 no es la información disponible, es solo la esperanza.

### 3. `SIN_EVIDENCIA` repetido es un problema del spec, no del agente

El criterio de aceptación dice "SIN_EVIDENCIA **reiterado**", y esa palabra es la
que fija el diseño: el **primer** SIN_EVIDENCIA vuelve al agente, porque puede
ser simplemente que no dejó evidencia observable de algo que sí hizo. El
**segundo sobre el mismo criterio** ya no: significa que el criterio no se puede
observar, y eso no lo arregla el agente por mucho que se le insista.

Ahí el flujo llama a `revokeCriteriaApproval()` —que ya existe (T01)— y la tarea
vuelve a `not_approved`. **No se reasigna a nadie**: se devuelve a la fase de
criterios, que es donde está el defecto.

Por eso el contador de SIN_EVIDENCIA es **por criterio** y no por tarea: dos
criterios distintos saliendo SIN_EVIDENCIA una vez cada uno no son un spec
ambiguo, son dos huecos de evidencia.

### 4. El responsable sale de una cadena, y si no hay se dice

El criterio pide "existe un responsable asignado y notificado". El responsable se
resuelve por la primera de estas fuentes que dé algo:

1. El **holder del claim activo** sobre la tarea (`claims.ts` ya lo tiene:
   `kind`, `id`, `label`).
2. El **assignee del issue** de GitHub.
3. **Nadie.**

El tercer caso no se disimula eligiendo a alguien plausible. Se notifica en el
issue **sin mención** y con una línea que dice que no hay responsable
identificado, porque una tarea que falla y no tiene dueño es en sí misma un
hallazgo que alguien tiene que ver. Inventar un destinatario convierte ese
hallazgo en un mensaje que alguien ignora por no ir con él.

**El router del epic 03 NO entra en esta cadena**, y la primera versión de este
ADR decía que sí. Estaba mal: el router **sugiere**, no asigna, y tratar a su
candidato como responsable de un escalado sería asignarle trabajo por la puerta
de atrás — justo lo que el epic 03 prohíbe en su primera línea y lo que dice
`CLAUDE.md` §2.1.

Lo que sí cabe, y es otra cosa, es que el aviso **mencione** que el router había
sugerido a alguien, como información para quien lo lea. Informar no es asignar.
Mientras nadie reclame la tarea ni se asigne el issue, el responsable es "nadie",
y eso se dice en voz alta.

### 5. El aviso sale por un puerto, no por GitHub

`NotificationPort` en `packages/core`, mismo patrón que `QueuePort` y `LlmPort`.
El único adaptador de hoy publica un **comentario en el issue con mención al
responsable** — coherente con `CLAUDE.md` §3: los issues son la fuente de verdad
y los comentarios el audit trail.

El puerto no es ceremonia: la decisión n.º 3 del índice de pendientes (formato de
la vista de estado, epic 04 T05) sigue **abierta**, y cuando se resuelva habrá que
enganchar otro canal. Con el puerto es un adaptador nuevo; sin él, es tocar el
flujo entero.

### 6. La re-verificación es limpia, y el informe anterior NO viaja al Verifier

Un reintento se verifica desde cero: contexto limpio, criterios y **el diff
nuevo**. El informe del intento anterior **no** se le pasa al Verifier —sería
exactamente el "razonamiento del que codeó" que el epic prohíbe (T04), solo que
con otro nombre—.

Al **agente**, en cambio, sí se le da el informe entero. Es la asimetría que hace
que el reintento sirva de algo sin contaminar la verificación.

### 7. El estado vive en una tabla; el histórico, en `audit_log`

Tabla `verification_flow`, una fila por tarea y tenant, con `tenant_id` y RLS
forzada como todo lo demás: intentos consumidos, estado, último resultado, SHA
verificado, responsable y el recuento de SIN_EVIDENCIA por criterio.

"¿Cuántos intentos lleva esto?" es una consulta que se hará en cada entrega, y
derivarla contando entradas de un log append-only convierte una lectura de una
fila en un recuento. El `audit_log` sigue siendo el registro de **lo que pasó**;
la tabla es el estado de **dónde está**.

## Consecuencias

**Lo que se gana:**

- Un fallo de infraestructura deja de parecer trabajo mal hecho, que hoy es un
  problema real y medido (issue #27).
- La ambigüedad del spec deja de castigarse insistiéndole al agente.
- El presupuesto de intentos es explícito y acotado: nadie descubre a las tres
  horas que un agente lleva seis pasadas.

**Lo que se acepta:**

- **Dos intentos pueden quedarse cortos** en tareas grandes, donde el primer
  fallo es de comprensión y el segundo ya iba bien encaminado. Se acepta a
  sabiendas: es más barato que un humano mire una tarea de más a que un agente
  queme cuatro pasadas de `xhigh` sobre un diff grande. Si se demuestra que pasa
  a menudo, subir el tope es cambiar una constante.
- **El responsable puede ser "nadie"**, y seguirá pudiendo serlo: el router no lo
  resuelve, porque sugerir no es asignar.
- **Una tabla más** que mantener y migrar.

**Lo que hay que vigilar:** que `verifier_unavailable` no se convierta en el
cajón donde acaba todo lo que no se entiende. Si crece, el problema no es el
flujo: es que el Verifier no funciona y hay que arreglarlo, no reintentarlo.

## Alternativas descartadas

- **Un flujo único con reintentos y escalado.** Es lo que dice T06 hoy. Se
  descarta porque obliga a elegir un comportamiento que está mal para tres de
  los cuatro modos: o se castiga al agente por un rechazo del modelo, o se le
  insiste con un criterio imposible, o se escala a un humano un fallo de lint que
  el agente puede arreglar solo.

- **Reasignar a otro agente tras el primer fallo.** Suena a redundancia y es
  desperdicio: el segundo agente empieza sin el contexto del primero y tiende a
  repetir el mismo error, porque la causa suele estar en el spec o en el código,
  no en quién lo escribió. Además, `CLAUDE.md` §2.1 prohíbe que un agente apruebe
  el trabajo de otro; reasignar sin humano se acerca demasiado a esa frontera.

- **Tres intentos.** Ver la decisión 2. Se puede subir cambiando una constante el
  día que haya datos del piloto que lo justifiquen; no antes.

- **Derivar el contador del `audit_log` sin tabla nueva.** Menos superficie y una
  sola fuente de verdad, pero convierte cada consulta de estado en un recuento
  sobre una tabla que crece sin límite, y el estado deja de verse de un vistazo.

- **Notificar por correo o mensajería ya.** Es la decisión n.º 3 del índice y
  sigue abierta (epic 04 T05). Decidirla de rebote aquí, sin el usuario real
  delante, es justo lo que el índice dice que no se haga.
