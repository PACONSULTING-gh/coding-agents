# ADR 0005 — El peso de una arista `cochange` es el _lift_, no la frecuencia bruta

**Estado:** Aceptada

**Contexto de origen:** epic 02, T03 (issue #14). Este ADR **registra una
desviación del enunciado del epic**, que pedía otra cosa.

## Contexto

El criterio de aceptación de T03 dice literalmente:

> Dado el historial de git, cuando se minan co-cambios, entonces cada arista
> lleva su **peso (frecuencia de co-cambio)**.

La implementación (`packages/graph/src/cochange/mine.ts`) guarda en
`graph_edges.weight` el **lift** del par, no la frecuencia:

```
lift(A, B) = (co-ocurrencias(A, B) × commits considerados)
             ────────────────────────────────────────────
                 apariciones(A) × apariciones(B)
```

La razón estaba escrita **solo dentro del propio fichero de código**, y el
`COMMENT` de la columna en la migración `0007` decía justo lo contrario
("para `cochange` es la frecuencia de co-cambio"). Es decir: la documentación
que lee primero quien consulta la tabla contradecía al comportamiento real, y la
desviación respecto del epic no constaba en ningún sitio donde se leyera sin
abrir el código.

## Decisión

**`graph_edges.weight` lleva el lift.** La frecuencia bruta **no se pierde**:
viaja en `graph_edges.metadata.cochangeCount` de cada arista.

Se corrige además el `COMMENT` de la columna en la migración `0009`, para que el
esquema no afirme algo que el código no hace.

## Por qué

La frecuencia bruta está **sesgada hacia los ficheros que cambian mucho de por
sí**. Un `package.json`, un `index.ts` barril o un fichero de rutas aparecen en
casi todos los commits: co-cambian mucho con todo, y con la frecuencia bruta
como peso saldrían los primeros en el ranking de afectados de cualquier
consulta, empujando fuera a los ficheros que de verdad están acoplados al que se
está tocando. Ese ranking es lo único que hace útil la señal —la lista de
co-cambios sin ordenar no cabe en el presupuesto de contexto de un agente—, así
que un peso sesgado no es un detalle de presentación: rompe la funcionalidad.

El lift normaliza precisamente por eso: divide la co-ocurrencia observada entre
la que cabría esperar solo por la frecuencia individual de cada fichero. Un lift
alto significa "estos dos cambian juntos **más de lo que explica el azar**"; uno
cercano a 0, que su co-cambio se explica enteramente por lo mucho que cambian
por separado.

La tarea T03, más específica que el epic, pedía explícitamente considerar una
normalización tipo lift/confianza en vez de la frecuencia bruta. Se resuelve la
tensión a favor de la instrucción más específica, y se deja constancia aquí.

## Consecuencias

- El peso de `cochange` **no es comparable en escala** con el de las aristas
  `static` y `build`, que valen 1.0 fijo. El lift no está acotado y supera 1 con
  facilidad. Hoy `blastRadius` ordena por `weight DESC` mezclando las dos
  escalas, de modo que un par de ficheros que coincidieron tres veces en el
  historial puede quedar por delante de un import estático directo. **Está
  identificado y pendiente de decisión humana** (normalizar el lift a un rango
  comparable, o rankear primero por distancia y tipo de señal y usar el peso solo
  como desempate dentro de la misma señal). No se toca aquí porque cambia el
  criterio de ranking documentado de T05 y merece decidirse a propósito, no de
  paso.
- Quien quiera la frecuencia bruta la tiene en `metadata.cochangeCount`, y hay
  un test de integración que comprueba **el valor persistido** de las dos cosas
  (`packages/graph/test/cochange.test.ts`), no solo el cálculo en memoria.
