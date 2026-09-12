# ADR 0010 — El piloto es un banco de pruebas con desarrolladores simulados, no un equipo real

**Estado:** Aceptada · **Fecha:** 12 de septiembre de 2026

**Resuelve:** las decisiones 1, 2, 3 y 5 de `.claude/epics/00-indice-y-pendientes.md`, que bloqueaban el Epic 01 T07 (#8), la medición de acierto del router (#34) y el cierre del Epic 01.

## Contexto

El PRD pide un piloto **real**: un proyecto con varias personas tocándolo, que tolere que la herramienta falle al principio. Esa era la decisión 1 y llevaba abierta desde el primer día.

Mirando la organización el 11 de septiembre de 2026, doce repositorios:

| Repo                | Personas | Commits desde julio | PRs                 | Issues |
| ------------------- | -------- | ------------------- | ------------------- | ------ |
| `reforma-app`       | 3-4      | 100+                | 25, todos mergeados | **0**  |
| `paginaweb`         | 3        | 82                  | 0                   | **0**  |
| `splats2`           | 1        | 70                  | 0                   | 0      |
| `obramat-scrapping` | 1 + bot  | 41                  | 0                   | 0      |

**Ninguno ha abierto jamás un issue.** Y esta plataforma se apoya en GitHub Issues como fuente de verdad. Elegir piloto no era elegir repo: era pedirle a un equipo de tres personas a tiempo parcial que cambiara su forma de trabajar para probar una herramienta que todavía no les ha demostrado nada.

## Decisión

**El piloto es un banco de pruebas con cinco desarrolladores simulados**, cada uno en su contenedor, con su cuenta de GitHub real y su propia instancia de Claude Code. La carga de trabajo es un CRM para una empresa de construcción, sobre Next.js + Postgres + El Gabinete.

Las cuentas de GitHub son **reales y no bots**, y esa parte no es negociable: el router sugiere un login, un humano asigna el issue a ese login, y el escalado menciona a alguien. Con actores internos esos tres caminos no se ejercitan, y son criterios de aceptación de T03 y de T06. Una GitHub App tampoco vale: no se puede poner como assignee de un issue.

## Lo que esto valida, y lo que NO

Esta es la parte que hay que leer antes de citar cualquier cifra que salga de aquí.

**Valida, y no es poco:**

- Los claims y los leases entre máquinas distintas, que es el mecanismo de colisión.
- La detección de colisiones por el grafo, con cinco fuentes de trabajo concurrente.
- Las sugerencias del router con candidatos que tienen historial de autoría de verdad.
- La verificación y el flujo de fallo de punta a punta, sobre diffs que nadie escribió para ser verificados.
- Los heartbeats entre procesos separados.

**NO valida, y ninguna cantidad de contenedores lo arreglará:** las dos métricas del PRD §3 que miden **comportamiento humano**.

- _Tiempo del lead revisando diffs._ Un desarrollador simulado no se cansa de leer, no aprueba por inercia un viernes, y no deja de mirar un informe porque le parezca fiable. La métrica mide un hábito, y aquí no hay hábito.
- _Agentes atascados detectados por el sistema antes que por la persona._ El "antes que por la persona" exige una persona que se dé cuenta tarde. Un proceso simulado no se da cuenta nunca, así que el porcentaje saldría del 100 % por construcción, y sería un número inventado.

**Esto es un banco de pruebas del mecanismo, no un piloto de la adopción.** El día que alguien presente resultados de aquí, tiene que decir esa frase.

## Decisión 2 — sin baseline de métricas

Las cuatro métricas del PRD §3 decían "medir en semana 1". **No se va a medir ninguna baseline.** Se comparará cualitativamente al final.

La consecuencia hay que decirla, porque desactiva una salvaguarda que el PRD se había puesto a sí mismo: §3 dice _"si tras el piloto no se mueve ninguna de estas, el producto no resuelve el problema y hay que replantear"_. **Sin baseline, esa frase no se puede aplicar.** No habrá con qué comparar, así que "no se ha movido nada" nunca se podrá afirmar ni negar.

Se acepta a cambio de no gastar la primera semana en instrumentación de un equipo que todavía no usa la herramienta. La tabla del PRD se corrige para que no siga prometiendo una medida que no se va a tomar.

## Decisión 3 — la vista de estado sale por tres vías, y el canal es Slack

Un issue fijo que se reescribe, un resumen por CLI bajo demanda, y **Slack**. No son tres implementaciones: son tres adaptadores del `NotificationPort` que ya existe.

Slack y no Telegram ni Discord porque es donde el criterio _"su responsable recibe aviso sin tener que consultar nada"_ se cumple sin que nadie tenga que instalar nada nuevo, y porque los hilos por tarea encajan con un aviso por issue.

## Decisión 5 — el informe de conformidad

Tres cosas, además de lo que ya cumple (cabe en una pantalla, veredicto binario, evidencia citada por criterio):

1. **Una sección fija con lo que NO se pudo verificar.** Los criterios en `SIN_EVIDENCIA` y por qué. Un informe que solo cuenta lo que salió bien es exactamente el que se aprueba sin leer.
2. **Cada veredicto enlaza a la línea del diff.** Comprobar una cita tiene que costar dos segundos, no abrir el PR entero.
3. **El informe dice con qué se produjo:** modelo, esfuerzo, y si hubo reintentos o negativas del modelo.

El punto 3 roza un criterio de aceptación de T05 que prohíbe expresamente "una puntuación del 1 al 10", y por eso se acota aquí: **se reportan hechos, no una cifra de confianza**. "Modelo `claude-opus-5`, esfuerzo `xhigh`, 1 reintento tras una negativa" es un hecho verificable. "Confianza: 7/10" es la puntuación prohibida con otro nombre, y no se añade.

## Consecuencias que se aceptan

- **Cinco agentes sobre una sola suscripción.** El ADR 0009 ya aceptó que la plataforma compitiera por los límites del desarrollador; esto lo multiplica por cinco. Un día de banco de pruebas a pleno rendimiento puede dejar sin herramienta a quien la necesita para trabajar. Por eso el número de agentes que escriben a la vez es **configurable**, y se puede bajar a turnos sin rediseñar nada: los claims duran más que la escritura, así que sigue habiendo colisiones aunque solo teclee uno.
- **Cinco cuentas de GitHub que crear y mantener**, con sus correos. Es trabajo manual de una persona y no se puede automatizar desde aquí.
- **Los contenedores no duermen ni están tras NAT**, que es justo el escenario para el que se diseñó el heartbeat por push (`CLAUDE.md` §3). Ese caso queda sin ejercitar.
- **El CRM es carga de trabajo, no producto.** Si acaba siendo un producto de verdad, deja de ser un banco de pruebas donde romper cosas sale gratis, y eso cambia esta decisión.

## Disparadores para reconsiderarlo

1. **Que un equipo real empiece a usar issues.** Ahí el piloto de adopción se puede hacer de verdad, y las dos métricas humanas dejan de ser inobservables.
2. **Que los límites de la suscripción estorben de forma medible** al trabajo de las personas.
3. **Que el CRM pase a ser producto** con un cliente detrás.
4. **Que haga falta afirmar algo sobre adopción** —en una venta, en una decisión de seguir o parar— porque este banco no lo sostiene.
