import { ValidationError } from '@coord/core'
import { z } from 'zod'

import type { BuildDependency, BuildProjectRef, NormalizedBuildGraph } from './types.js'

/**
 * Normalizacion del grafo de paquetes de Turborepo.
 *
 * ---------------------------------------------------------------------------
 * POR QUE `turbo query`, NO `turbo run build --graph` (desviacion documentada)
 * ---------------------------------------------------------------------------
 * El contexto de la tarea decia literalmente `turbo run build --graph`, pero
 * la documentacion oficial de Turborepo (`reference/run`) dice que la salida
 * `--graph=archivo.json` esta MARCADA COMO DEPRECATED y programada para
 * eliminarse en la version 3.0. La via programatica soportada es `turbo query`,
 * una interfaz GraphQL sobre el grafo de paquetes y tareas, desde Turborepo 2.2.
 *
 * ---------------------------------------------------------------------------
 * LA CONSULTA, VERIFICADA CONTRA EL ESQUEMA REAL
 * ---------------------------------------------------------------------------
 * `directDependencies` NO devuelve una lista de paquetes: devuelve un
 * envoltorio `Packages` con un campo `items`. La consulta anterior
 * (`directDependencies { name }`) es INVALIDA, y `turbo query` la rechaza:
 *
 *   {"data":null,"errors":[{"message":"Unknown field \\"name\\" on type \\"Packages\\"."}]}
 *
 * Como `parseTurboGraph` trata `errors` como fallo, la ingesta de Turborepo
 * abortaba SIEMPRE en un repo real. Comprobado ejecutando turbo 2.10.12; la
 * consulta de abajo es la que devuelve `data`, y el fixture del test es su
 * salida literal.
 *
 * ---------------------------------------------------------------------------
 * EL PAQUETE RAIZ (`//`)
 * ---------------------------------------------------------------------------
 * La respuesta real incluye el propio workspace como un paquete con
 * `name: "//"` y `path: ""` (cadena vacia), y ese `//` aparece ademas como
 * dependencia directa de casi todos los paquetes. No es un proyecto: no tiene
 * directorio propio dentro del repo, la clave natural de `graph_nodes` exige
 * una ruta no vacia, y una arista `X --build--> //` no dice nada util. Se
 * FILTRA explicitamente en los dos sitios (proyectos y dependencias) antes de
 * validar; si no, la fila con `path: ""` invalidaria la respuesta entera y no
 * entraria ni una arista.
 */
export const TURBO_GRAPH_QUERY =
  'query { packages { items { name path directDependencies { items { name } } } } }'

/** El workspace raiz, que Turborepo reporta como un paquete mas. No lo es. */
const ROOT_PACKAGE_NAME = '//'

function isRootPackage(value: { name?: unknown; path?: unknown }): boolean {
  return value.name === ROOT_PACKAGE_NAME || value.path === ''
}

const turboPackageSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  directDependencies: z.object({
    items: z.array(z.object({ name: z.string().min(1) })),
  }),
})

const turboDataSchema = z.object({
  packages: z.object({
    items: z.array(turboPackageSchema),
  }),
})

const turboResponseSchema = z.looseObject({
  data: turboDataSchema.nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
})

/** Forma minima que hace falta conocer ANTES de validar, para poder filtrar la raiz. */
const turboRawShapeSchema = z.looseObject({
  data: z
    .looseObject({
      packages: z.looseObject({
        items: z.array(z.looseObject({})),
      }),
    })
    .nullable()
    .optional(),
})

/**
 * Quita el paquete raiz de `items` y de las dependencias directas de cada
 * paquete. Se hace ANTES de `turboResponseSchema` a proposito: su `path` vacio
 * no pasa la validacion, y validar primero convertiria un caso normal en un
 * fallo.
 */
function withoutRootPackage(json: unknown): unknown {
  const shape = turboRawShapeSchema.safeParse(json)
  if (!shape.success || shape.data.data === null || shape.data.data === undefined) return json

  const items = shape.data.data.packages.items
    .filter((item) => !isRootPackage(item as { name?: unknown; path?: unknown }))
    .map((item) => {
      const direct = (item as { directDependencies?: { items?: unknown } }).directDependencies
      if (direct === undefined || !Array.isArray(direct.items)) return item
      return {
        ...item,
        directDependencies: {
          ...direct,
          items: (direct.items as { name?: unknown }[]).filter((dep) => !isRootPackage(dep)),
        },
      }
    })

  return {
    ...(json as Record<string, unknown>),
    data: {
      ...shape.data.data,
      packages: { ...shape.data.data.packages, items },
    },
  }
}

/**
 * Valida y normaliza la respuesta de `turbo query`. Frontera de confianza,
 * igual que `parseNxGraph`: forma incorrecta O errores GraphQL -> falla
 * ruidoso con el motivo, sin escribir nada.
 */
export function parseTurboGraph(json: unknown): NormalizedBuildGraph {
  const parsed = turboResponseSchema.safeParse(withoutRootPackage(json))
  if (!parsed.success) {
    throw new ValidationError(
      `La respuesta de \`turbo query\` no tiene la forma esperada: ${parsed.error.message}`,
      { cause: parsed.error },
    )
  }
  if (parsed.data.errors !== undefined && parsed.data.errors.length > 0) {
    throw new ValidationError(
      `\`turbo query\` devolvio errores: ${parsed.data.errors.map((e) => e.message).join('; ')}`,
    )
  }
  if (parsed.data.data === null || parsed.data.data === undefined) {
    throw new ValidationError('La respuesta de `turbo query` no trae `data` ni `errors`.')
  }

  const items = parsed.data.data.packages.items
  const projects: BuildProjectRef[] = items.map((item) => ({
    name: item.name,
    path: item.path,
    projectType: null,
  }))

  const dependencies: BuildDependency[] = items.flatMap((item) =>
    item.directDependencies.items.map((dependency) => ({
      from: item.name,
      to: dependency.name,
      dependencyType: 'depends-on',
    })),
  )

  return { tool: 'turborepo', projects, dependencies }
}
