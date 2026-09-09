# Fases 2 a 5 — no construidas

**Ninguna línea de estas fases existe.** Este documento describe **intención**, no
implementación. Si algo de aquí acaba construido, se le escribe su propio
documento técnico y esta entrada se reduce a un enlace.

La fuente de verdad son los epics en [`../../.claude/epics/`](../../.claude/epics/);
aquí solo está lo que hace falta para entender por qué van en este orden y qué las
bloquea.

## Orden y bloqueos

```
Fase 0 ──┬── Fase 1 ──┬── Fase 2  (routing)
         │            ├── Fase 3  (heartbeats y predicción)
         │            └── Fase 4  (verificación, también depende de 0-T06)
         └── Fase 5  (docs, en paralelo — pero bloqueada por T07)
```

| Fase | Epic                         | Depende de                    | Bloqueada además por                                                                                                                                          |
| ---- | ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2    | 03 — Routing                 | Fase 1 T05 (herramientas MCP) | —                                                                                                                                                             |
| 3    | 04 — Heartbeats y colisiones | Fase 1 cerrada                | Decidir el **formato de la vista de estado**: comentario en issue, CLI o mensajería. Es decisión de producto                                                  |
| 4    | 05 — Verificación            | Fases 0 y 1                   | El **flujo de fallo de verificación** sigue sin diseñar: quién recibe el aviso, si se reasigna, cuántos reintentos. Es la laguna que arrastra el PRD desde §8 |
| 5    | 06 — Docs y escalabilidad    | CCPM en uso                   | **T07 de la Fase 0**, que a su vez espera a que se elija el proyecto piloto                                                                                   |

## Qué aporta cada una, en una línea

- **Fase 2 — Routing.** Shortlist ranqueada de a quién dar cada tarea, con
  justificación. Ataca el primer problema del PRD. **El humano decide**: el router
  sugiere y nunca asigna (`CLAUDE.md` §2.1).
- **Fase 3 — Heartbeats y predicción.** Daemon local en cada máquina que empuja
  estado al hub —nunca al revés: los portátiles duermen y están tras NAT—, más la
  predicción de ficheros afectados _antes_ de codear. Esa predicción es
  experimental y el PRD §6 exige validarla contra PRs ya mergeados.
- **Fase 4 — Verificación.** Criterios Given/When/Then aprobados antes de codear,
  gate determinista, Verifier en contexto aislado, y un informe de conformidad en
  vez de un diff. Ataca el tercer problema del PRD.
- **Fase 5 — Docs y escalabilidad.** Documentación de cliente generada desde los
  artefactos de CCPM, con prevención de fugas **por estructura**: el generador
  trabaja sobre hechos ya filtrados, no sobre los artefactos crudos.

## Lo que este proyecto sigue sin poder validar

El PRD §6 nombra tres supuestos que solo se comprueban con un piloto real, y
**ninguno se puede medir todavía** porque el proyecto piloto sigue sin decidir
(issue #8):

1. Que el reparto asistido acierte lo bastante como para que el lead lo use en vez
   de ignorarlo.
2. Que un informe de conformidad genere confianza suficiente para aprobar sin
   abrir el diff.
3. Que la predicción de ficheros afectados tenga recall suficiente.

Y las cuatro métricas del PRD §3 **no tienen baseline**. Sin baseline, el piloto
no puede demostrar nada.

> **Un obstáculo concreto y medido:** una de esas métricas es _"colisiones
> descubiertas en merge, por sprint"_. Los tres repos candidatos tienen **cero PRs
> humanos**. Si se empuja directo a `main`, no hay merge donde descubrir nada, y
> esa métrica no existe ni hacia atrás ni hacia delante. Antes del baseline hay que
> decidir si el equipo pasa a trabajar por PR.
