#!/usr/bin/env node
import { closeDatabase, configureDatabase, resolveRuntimeConnectionString } from '@coord/db'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { loadServerConfig } from './context.js'
import { createGraphMcpServer } from './server.js'

/**
 * Punto de entrada del servidor MCP del grafo (T05). Transporte STDIO: es lo
 * que espera Claude Code (y cualquier cliente MCP local) para un servidor que
 * arranca como subproceso. Ver `packages/graph/README.md` para el bloque de
 * configuracion completo.
 *
 * NADA se escribe en stdout salvo el propio protocolo JSON-RPC del SDK: es el
 * canal del transporte. Cualquier log de arranque va a stderr
 * (`console.error`/`console.warn`, que en Node ya son stderr), incluido el
 * aviso de `resolveRuntimeConnectionString` cuando falta `PGBOUNCER_URL`.
 */
async function main(): Promise<void> {
  const config = loadServerConfig()

  configureDatabase({
    connectionString: resolveRuntimeConnectionString(),
    applicationName: 'coord-graph-mcp',
  })

  const server = createGraphMcpServer(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server
        .close()
        .then(() => closeDatabase())
        .then(
          () => process.exit(0),
          (error: unknown) => {
            console.error('Fallo el apagado ordenado del servidor MCP del grafo:', error)
            process.exit(1)
          },
        )
    })
  }
}

main().catch((error: unknown) => {
  console.error('El servidor MCP del grafo no pudo arrancar:', error)
  process.exitCode = 1
})
