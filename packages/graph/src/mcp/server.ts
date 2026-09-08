import { runWithTenant } from '@coord/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { GraphMcpServerConfig } from './context.js'
import { activeClaimsInputShape, runActiveClaims } from './tools/active-claims.js'
import { blastRadiusInputShape, runBlastRadius } from './tools/blast-radius.js'
import { runTraversal, traversalInputShape } from './tools/traversal.js'
import { runWhoLastTouched, whoLastTouchedInputShape } from './tools/who-last-touched.js'

/**
 * El servidor MCP del grafo (T05). Cablea las cinco herramientas del epic
 * sobre las consultas ya existentes (T01-T04): este fichero no anade LOGICA
 * de dominio, solo transporte -- es justo lo que impone la fitness function
 * `mcp-sdk-solo-en-graph-mcp` (`.dependency-cruiser.cjs`): el SDK de MCP no
 * sale de `packages/graph/src/mcp/`, y `queries.ts`/`claims.ts` no saben que
 * MCP existe.
 *
 * ---------------------------------------------------------------------------
 * EL TENANT ENVUELVE CADA LLAMADA, NO EL SERVIDOR ENTERO
 * ---------------------------------------------------------------------------
 * `runWithTenant` usa `AsyncLocalStorage`: el contexto vive durante la cadena
 * asincrona de UNA llamada. Envolver la conexion del transporte entera en un
 * solo `runWithTenant` no aislaria nada distinto (el tenant es fijo para todo
 * el proceso, ver `context.ts`), pero envolver cada invocacion es lo que hace
 * que el patron sea EXACTAMENTE el mismo que usa el resto del sistema
 * (`apps/webhook`, `apps/worker`): nunca hay codigo de dominio corriendo sin
 * `requireTenant()` disponible.
 *
 * ---------------------------------------------------------------------------
 * ERRORES: NINGUN catch AQUI
 * ---------------------------------------------------------------------------
 * `McpServer` ya envuelve el handler de cada tool en su propio try/catch (ver
 * `server/mcp.js`): una excepcion se convierte en `{ isError: true, content:
 * [...] }` con el mensaje del error. No hace falta -- y no se debe -- volver a
 * capturar aqui: seria el catch silencioso que CLAUDE.md 7 pide reportar, y
 * ademas perderia el mensaje real (`ValidationError`, `NotFoundError`,
 * `ClaimConflictError`... todos con mensajes pensados para leerse).
 */

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

export function createGraphMcpServer(config: GraphMcpServerConfig): McpServer {
  const server = new McpServer(
    { name: 'coord-graph', version: '0.1.0' },
    {
      instructions:
        'Grafo de dependencias del codigo de este repositorio. Pregunta antes de leer ficheros ' +
        'a ciegas: find_dependents/find_dependencies para "que rompe esto", blast_radius para el ' +
        'impacto de un conjunto de ficheros que vas a cambiar, who_last_touched para saber a ' +
        'quien preguntar, y active_claims para no pisar a otro agente que ya esta en ello.',
    },
  )

  function withTenant<T>(fn: () => Promise<T>): Promise<T> {
    return runWithTenant({ tenantId: config.tenantId }, fn)
  }

  server.registerTool(
    'find_dependents',
    {
      title: 'Dependientes',
      description:
        'Quien depende (transitivamente) de un fichero o simbolo: que se rompe si lo tocas. ' +
        'Devuelve el conjunto ranqueado por cercania, con la senal que predijo cada uno.',
      inputSchema: traversalInputShape,
    },
    async (args) => ok(await withTenant(() => runTraversal('dependents', args))),
  )

  server.registerTool(
    'find_dependencies',
    {
      title: 'Dependencias',
      description:
        'De que depende (transitivamente) un fichero o simbolo. El sentido natural de la arista: ' +
        'lo contrario de find_dependents.',
      inputSchema: traversalInputShape,
    },
    async (args) => ok(await withTenant(() => runTraversal('dependencies', args))),
  )

  server.registerTool(
    'blast_radius',
    {
      title: 'Radio de impacto',
      description:
        'Vas a cambiar estos ficheros: que MAS se ve afectado. Union de los dependientes ' +
        'transitivos de todos ellos, con TODAS las senales (estatica, build, git) que alcanzaron ' +
        'cada resultado.',
      inputSchema: blastRadiusInputShape,
    },
    async (args) => ok(await withTenant(() => runBlastRadius(args))),
  )

  server.registerTool(
    'who_last_touched',
    {
      title: 'Ultimo en tocarlo',
      description:
        'Quien toco por ultima vez cada uno de estos ficheros. Devuelve PERSONAS (cruzadas con ' +
        'los usuarios del tenant cuando el correo coincide), nunca hashes de commit. Necesita ' +
        'GRAPH_CHECKOUT_ROOT configurado en el servidor.',
      inputSchema: whoLastTouchedInputShape,
    },
    async (args) => ok(await withTenant(() => runWhoLastTouched(config, args))),
  )

  server.registerTool(
    'active_claims',
    {
      title: 'Claims activos',
      description:
        'Quien esta trabajando en que ahora mismo (issues y ficheros reclamados y vivos), mas ' +
        'reciente primero. Consultalo ANTES de empezar algo para no colisionar con otro agente.',
      inputSchema: activeClaimsInputShape,
    },
    async (args) => ok(await withTenant(() => runActiveClaims(args))),
  )

  return server
}
