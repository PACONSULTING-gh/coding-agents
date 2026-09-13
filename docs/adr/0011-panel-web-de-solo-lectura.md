# ADR 0011 — Un panel web, que el PRD decía que no

**Estado:** Aceptada · **Fecha:** 13 de septiembre de 2026

**Contradice:** `.claude/epics/epic-04-heartbeats-colisiones.md`, T05.

## Contexto

El epic 04 T05 dice, literalmente, que la vista de estado del equipo puede ser un comentario recurrente, un resumen por CLI o un canal — **«no una UI propia, que está fuera de alcance del PRD»**.

Se ha construido una UI propia. Este ADR existe para que eso no se lea como un descuido dentro de seis meses.

## Decisión

Un panel web de **solo lectura** (`apps/dashboard`, Next.js + los tokens de El Gabinete) con tres vistas: equipo, reservas vivas y verificaciones.

Se construye porque se pidió explícitamente. No hay un argumento técnico que lo justifique frente al CLI y a Slack, que ya cumplen los tres criterios de aceptación de T05; lo que aporta es que una persona vea el estado sin instalar nada ni tener acceso a la terminal.

## Lo que se acepta

- **Una superficie más que mantener.** La vista de estado ya tenía tres canales, y ahora tiene cuatro. Se mitiga con lo único que lo hace sostenible: los cuatro pintan lo que devuelve `buildTeamStatus`, en `packages/core`. Cuatro formatos con cuatro lógicas acabarían en cuatro versiones de la verdad y una discusión sobre cuál mirar.
- **Contradice el PRD.** Si algún día el alcance se revisa con un cliente delante, este renglón es de los que hay que volver a mirar.

## Lo que NO se acepta, y por eso el panel es como es

**Solo lectura, sin un botón que cambie nada.** Los agentes proponen y los humanos deciden (`CLAUDE.md` §2.1), pero decidir _desde aquí_ exigiría autenticación, permisos y `audit_log`, y hoy no existe ninguna de las tres. Un panel de solo lectura sin login es una vista. Uno con acciones sería un agujero, y el día que alguien añada el primer botón tiene que saber que está abriendo esa puerta.

**El tenant sale del entorno, no de la URL.** Sin autenticación, aceptarlo por parámetro significa que cambiar un uuid en la barra de direcciones enseña los datos de otro cliente. Cuando haya login, saldrá de la sesión.

**El color nunca es la única señal.** Cada estado lleva su palabra: «dormido» y «sin señal» no se distinguen por el tono. Quien lo mire en una captura en blanco y negro —que es como acaban viajando estas cosas por un chat— tiene que poder leerlo igual.

## Disparadores para reconsiderarlo

1. **Que alguien quiera actuar desde el panel.** Ahí deja de ser una vista, y hace falta autenticación, RBAC y auditoría antes que el botón.
2. **Que el panel y los otros tres canales empiecen a contar cosas distintas.** Sería la señal de que la lógica se ha duplicado, que es exactamente lo que este diseño evita.
3. **Que el alcance del PRD se revise.** Entonces esto deja de ser una excepción y pasa a ser alcance, o se quita.
