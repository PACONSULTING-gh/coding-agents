# Documentación técnica por fases

Un documento por fase de la hoja de ruta. Cada uno describe **lo que existe de
verdad** en esa fase: qué módulos hay, cómo funcionan por dentro, qué se midió y
qué quedó fuera.

**Regla de este directorio:** aquí no se documenta nada que no esté construido.
Las fases sin construir tienen un solo documento de intención, marcado como tal.
Si lees una cifra en estas páginas, está medida; si no lo está, lo dice.

## Estado real

| Fase | Epic                              | Documento                                                      | Estado                                                               |
| ---- | --------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| 0    | Epic 01 — Cimientos               | [`fase-0-cimientos.md`](fase-0-cimientos.md)                   | **Construida.** T01–T06 en `main`; T07 bloqueado por decisión humana |
| 1    | Epic 02 — Grafo y colisiones      | [`fase-1-grafo-y-colisiones.md`](fase-1-grafo-y-colisiones.md) | **Construida.** T01–T05 en `main`                                    |
| 2    | Epic 03 — Routing                 | [`fases-siguientes.md`](fases-siguientes.md)                   | No construida                                                        |
| 3    | Epic 04 — Heartbeats y colisiones | [`fases-siguientes.md`](fases-siguientes.md)                   | No construida                                                        |
| 4    | Epic 05 — Verificación            | [`fases-siguientes.md`](fases-siguientes.md)                   | No construida                                                        |
| 5    | Epic 06 — Docs y escalabilidad    | [`fases-siguientes.md`](fases-siguientes.md)                   | No construida                                                        |

## Lo que hay hoy, en números

Medido sobre `main`, no estimado:

|                  |                                                                             |
| ---------------- | --------------------------------------------------------------------------- |
| Paquetes         | 5 (`core`, `db`, `queue`, `github`, `graph`) y 2 apps (`webhook`, `worker`) |
| Código fuente    | ~10.800 líneas TypeScript, sin contar tests                                 |
| Migraciones      | 9, todas con RLS forzada donde corresponde                                  |
| Tablas           | 19                                                                          |
| Ficheros de test | 30, contra Postgres y git reales                                            |
| Tests            | 291, más 2 saltados que requieren red                                       |
| ADRs             | 7                                                                           |

## Los tres problemas del PRD, y dónde va cada uno

`CLAUDE.md` §1 define el producto por tres problemas. Conviene tener claro cuál
ataca cada fase, porque las Fases 0 y 1 **no resuelven ninguno todavía**: montan
lo que hace falta para resolverlos.

| Problema                                        | Lo ataca                                      | Estado                                 |
| ----------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| Repartir tareas entre personas                  | Fase 2 (router)                               | No construido                          |
| Evitar que agentes de distintos devs colisionen | Fase 1 (grafo + claims) y Fase 3 (predicción) | Mecanismo construido, sin usar todavía |
| Supervisar sin leer el diff                     | Fase 4 (Verifier)                             | No construido                          |

Dicho sin adornos: hoy el sistema **no evita ni una tarea duplicada**. Tiene el
grafo y los claims que lo harán posible, y nada más.

## Diagramas

Los tres viven en [`../diagrams/`](../diagrams/) y se regeneran con
`pnpm diagrams`:

| Diagrama                   | Fase  | Qué cuenta                                                     |
| -------------------------- | ----- | -------------------------------------------------------------- |
| `arquitectura`             | 0 y 1 | Los módulos y por dónde pasa el aislamiento por tenant         |
| `webhook` (secuencia)      | 0     | El ciclo de vida completo de un webhook, con los tres rechazos |
| `ingesta` (flujo de datos) | 1     | Por qué la indexación es incremental y no un rebuild           |

**Ojo con la evidencia:** solo los diagramas de tipo `architecture` verifican sus
rutas contra el repo. Los de secuencia y flujo de datos **no tienen esa red de
seguridad**, así que sus afirmaciones se revisan a mano como cualquier prosa.
