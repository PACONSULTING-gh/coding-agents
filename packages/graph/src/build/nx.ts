import { ValidationError } from '@coord/core'
import { z } from 'zod'

import type { BuildDependency, BuildProjectRef, NormalizedBuildGraph } from './types.js'

/**
 * Normalizacion del grafo de proyectos de Nx.
 *
 * ---------------------------------------------------------------------------
 * LA FORMA ES LA QUE PRODUCE LA HERRAMIENTA, NO LA QUE NOS VENDRIA BIEN
 * ---------------------------------------------------------------------------
 * `nx graph --file=<salida>.json` escribe esto (ejecutado de verdad contra Nx
 * 23.2.0 en un workspace de dos paquetes; el fixture del test es su salida
 * literal, no una reconstruccion):
 *
 *   {
 *     "graph": {
 *       "nodes": {
 *         "@probe/a": { "name": "@probe/a", "type": "lib",
 *                       "data": { "root": "packages/a", ... } },
 *         ...
 *       },
 *       "dependencies": {
 *         "@probe/a": [ { "source": "@probe/a", "target": "@probe/b", "type": "static" } ],
 *         "@probe/b": []
 *       }
 *     }
 *   }
 *
 * Dos cosas que la version anterior de este fichero daba por hechas y son
 * falsas: NO es plano (todo cuelga de `graph`) y `nodes` es un MAPA por nombre,
 * no un array `projects`. Con el esquema anterior, `ingestBuildGraph` lanzaba
 * `ValidationError` contra cualquier repo con Nx de verdad y no aportaba ni una
 * arista `build`. El test pasaba porque el fixture se habia escrito a imagen del
 * validador. Por eso ahora hay ademas un test de integracion que ejecuta la CLI
 * real (`test/build-cli.test.ts`).
 *
 * `data.root` es lo unico que se usa de `data`: es el directorio del proyecto, y
 * es lo que se guarda como `path` del nodo `target` (la clave natural de
 * `graph_nodes` exige una ruta no vacia).
 */

const nxNodeSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1).optional(),
  data: z.looseObject({ root: z.string().min(1) }),
})

const nxDependencySchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.string().min(1).optional(),
})

/**
 * `nodes` puede venir vacio —un workspace recien creado, sin proyectos— y eso NO
 * es un error: el principio declarado en `detect.ts` es que la ausencia de grafo
 * de build no aporta aristas, no que falle. Un `.min(1)` aqui convertiria un
 * resultado vacio legitimo en un fallo ruidoso.
 */
const nxGraphFileSchema = z.looseObject({
  graph: z.looseObject({
    nodes: z.record(z.string(), nxNodeSchema),
    dependencies: z.record(z.string(), z.array(nxDependencySchema)),
  }),
})

/**
 * Valida y normaliza el JSON de `nx graph --file`. Frontera de confianza: si
 * no tiene esta forma, falla ruidoso con el motivo (CLAUDE.md 2.4) y no llega
 * a escribirse nada en la base — `ingestParsedBuildGraph` no abre transaccion
 * hasta que esto termina bien.
 */
export function parseNxGraph(json: unknown): NormalizedBuildGraph {
  const parsed = nxGraphFileSchema.safeParse(json)
  if (!parsed.success) {
    throw new ValidationError(
      `El JSON de \`nx graph\` no tiene la forma esperada: ${parsed.error.message}`,
      { cause: parsed.error },
    )
  }

  const projects: BuildProjectRef[] = Object.entries(parsed.data.graph.nodes).map(
    ([key, node]) => ({
      // La clave del mapa es la identidad que usan las dependencias; `data.name`
      // no siempre viene, asi que la clave manda.
      name: key,
      path: node.data.root,
      projectType: node.type ?? null,
    }),
  )

  const dependencies: BuildDependency[] = Object.values(parsed.data.graph.dependencies)
    .flat()
    .map((dependency) => ({
      from: dependency.source,
      to: dependency.target,
      dependencyType: dependency.type ?? 'unknown',
    }))

  return { tool: 'nx', projects, dependencies }
}
