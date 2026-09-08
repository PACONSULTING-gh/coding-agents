import { NotFoundError, requireTenant } from '@coord/core'
import { withTenantConnection } from '@coord/db'
import { z } from 'zod'

import { repoIdForRepository } from '../ingest/repo-id.js'
import { NODE_KINDS, type GraphNodeRef, type NodeKind } from '../queries.js'

import { relativeFilePathSchema } from './paths.js'

/**
 * `repoId` es un uuid DERIVADO de `(tenantId, owner/repo)` (ver
 * `ingest/repo-id.ts`): no hace falta guardarlo en ningun sitio ni pedirselo
 * al LLM, que no lo conoce y no tiene por que conocerlo. Cada herramienta pide
 * `repository` como `owner/repo` -- lo que el agente SI tiene, porque es el
 * repo en el que esta trabajando -- y esta funcion lo traduce.
 */
export function resolveRepoId(repository: string): string {
  const { tenantId } = requireTenant()
  return repoIdForRepository(tenantId, repository)
}

/**
 * Referencia a un nodo de partida tal como la da un LLM: una ruta, y
 * opcionalmente un nombre de simbolo dentro de ese fichero. Sin `name` se
 * asume `kind: 'file'` (el caso comun: "que depende de este fichero"); con
 * `name` se asume `kind: 'symbol'` salvo que se declare otra cosa. Un
 * `kind: 'symbol'` sin `name` no identifica nada -- un fichero tiene varios
 * simbolos -- asi que se rechaza aqui mismo, en el propio `inputSchema` de la
 * herramienta (frontera de confianza, T05).
 */
export const nodeRefSchema = z
  .object({
    path: relativeFilePathSchema.describe('Ruta relativa a la raiz del repo.'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe('Nombre del simbolo. Omitelo para referirte al fichero entero.'),
    kind: z
      .enum(NODE_KINDS)
      .optional()
      .describe('Por defecto: "symbol" si hay `name`, si no "file".'),
  })
  .refine((v) => v.kind !== 'symbol' || v.name !== undefined, {
    message: 'Un nodo de tipo "symbol" necesita "name": el "path" solo no lo identifica.',
    path: ['name'],
  })

export type NodeRefInput = z.infer<typeof nodeRefSchema>

function effectiveKind(ref: NodeRefInput): NodeKind {
  return ref.kind ?? (ref.name !== undefined ? 'symbol' : 'file')
}

/**
 * Resuelve una referencia de nodo a su uuid real. La consulta de una fila no
 * merece unirse a `findNodesByPath` (T01): esa esta pensada para RESOLVER EN
 * LOTE una lista de rutas (`blast_radius`), y aqui hace falta ademas filtrar
 * por `name` para desambiguar simbolos, que `findNodesByPath` no ofrece.
 * Sigue la misma via de acceso que el resto del paquete
 * (`withTenantConnection`, tenant_id como filtro explicito y como defensa de
 * la RLS forzada).
 */
export async function resolveNodeId(repoId: string, ref: NodeRefInput): Promise<GraphNodeRef> {
  const kind = effectiveKind(ref)
  return withTenantConnection(async (tx) => {
    const result = await tx.query<{
      node_id: string
      kind: NodeKind
      path: string
      name: string | null
      language: string | null
    }>(
      `SELECT id AS node_id, kind, path, name, language
         FROM graph_nodes
        WHERE tenant_id = $1
          AND repo_id   = $2
          AND kind      = $3
          AND path      = $4
          AND name IS NOT DISTINCT FROM $5::text
        LIMIT 1`,
      [tx.tenantId, repoId, kind, ref.path, ref.name ?? null],
    )
    const row = result.rows[0]
    if (row === undefined) {
      const label = ref.name === undefined ? ref.path : `${ref.path}#${ref.name}`
      throw new NotFoundError(
        `nodo ${kind} "${label}" en el grafo de este repositorio. ` +
          '¿El repositorio esta indexado y la ruta es exacta?',
      )
    }
    return {
      nodeId: row.node_id,
      kind: row.kind,
      path: row.path,
      name: row.name,
      language: row.language,
    }
  })
}
