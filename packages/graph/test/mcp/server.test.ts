import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runWithTenant } from '@coord/core'
import { closeDatabase, configureDatabase } from '@coord/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { claim } from '../../src/claims.js'
import { repoIdForRepository } from '../../src/ingest/repo-id.js'
import { startDatabase, type StartedDatabase } from '../support/database.js'
import { createEdges, createFileNodes, createTenant, createUser } from '../support/fixtures.js'
import { createTempRepoAt } from '../support/git-repo.js'

/**
 * T05, criterio literal: "arranca el servidor de verdad y habla con el por
 * stdio con el cliente del SDK -- no pruebes solo las funciones internas".
 * Cada `describe` de aqui abajo levanta `src/mcp/main.ts` como SUBPROCESO real
 * (via `tsx`, sin compilar) y le habla por `StdioClientTransport`, el mismo
 * transporte que usaria Claude Code. Postgres es real (testcontainers, igual
 * que el resto de `packages/graph`); el checkout de `who_last_touched` es un
 * repositorio git real creado con `git init`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TSX_BIN = path.resolve(__dirname, '../../../../node_modules/.bin/tsx')
const MAIN_TS = path.resolve(__dirname, '../../src/mcp/main.ts')

function fullEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) out[key] = value
    else delete out[key]
  }
  return out
}

interface ServerHandle {
  readonly client: Client
  close(): Promise<void>
}

async function startServer(
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
): Promise<ServerHandle> {
  const transport = new StdioClientTransport({
    command: TSX_BIN,
    args: [MAIN_TS],
    env: fullEnv(env),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'coord-graph-mcp-test', version: '0.0.0' })
  await Promise.race([
    client.connect(transport),
    sleep(timeoutMs).then(() => {
      throw new Error('El cliente MCP no conecto a tiempo con el servidor.')
    }),
  ])
  return {
    client,
    close: () => client.close(),
  }
}

/**
 * El tipo que expone el SDK para `callTool` es una union amplia (incluye la
 * variante de tareas, que no lleva `content`). En vez de pelear con esa union
 * en TypeScript, se valida la forma que de verdad importa aqui con zod -- la
 * misma disciplina de "todo lo que entra se valida en la frontera" que el
 * resto del repo aplica a filas de Postgres y a argumentos de herramienta.
 */
const toolCallResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
})

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const raw = await client.callTool({ name, arguments: args })
  const result = toolCallResultSchema.parse(raw)
  const first = result.content[0]
  if (first === undefined || first.type !== 'text' || first.text === undefined) {
    throw new Error(
      `Se esperaba contenido de texto en la respuesta de "${name}": ${JSON.stringify(result.content)}`,
    )
  }
  return { isError: result.isError === true, text: first.text }
}

// ---------------------------------------------------------------------------
// Formas de respuesta esperadas, validadas con zod (nunca `JSON.parse` a
// secas: seria tratar como confiable un texto que en produccion viene, otra
// vez, de un proceso servidor -- aqui controlado, pero el habito es el mismo
// que exige CLAUDE.md 2.4 en toda frontera).
// ---------------------------------------------------------------------------

const nodeKindSchema = z.enum(['file', 'symbol', 'package', 'target'])
const edgeSourceSchema = z.enum(['static', 'build', 'git'])
const edgeKindSchema = z.enum(['imports', 'calls', 'inherits', 'contains', 'cochange'])

const rankedFieldsSchema = {
  shown: z.number(),
  total: z.number().nullable(),
  totalAtLeast: z.number().optional(),
  truncated: z.boolean(),
}

const traversalHitSchema = z.object({
  path: z.string(),
  name: z.string().nullable(),
  kind: nodeKindSchema,
  distance: z.number(),
  signal: edgeSourceSchema,
  via: edgeKindSchema,
  weight: z.number(),
})
const traversalResponseSchema = z.object({
  startNode: z.object({ path: z.string(), name: z.string().nullable(), kind: z.string() }),
  page: z.object({ items: z.array(traversalHitSchema), ...rankedFieldsSchema }),
})

const blastHitSchema = z.object({
  path: z.string(),
  name: z.string().nullable(),
  kind: nodeKindSchema,
  distance: z.number(),
  signals: z.array(edgeSourceSchema),
  via: z.array(edgeKindSchema),
  weight: z.number(),
})
const blastRadiusResponseSchema = z.object({
  page: z.object({ items: z.array(blastHitSchema), ...rankedFieldsSchema }),
  unresolved: z.object({
    files: z.array(z.string()),
    total: z.number(),
    truncated: z.boolean(),
  }),
})

const touchedFileSchema = z.object({
  path: z.string(),
  found: z.boolean(),
  person: z.string().optional(),
  source: z.enum(['user', 'git']).optional(),
  lastTouchedAt: z.string().optional(),
  commit: z.string().optional(),
})
const whoLastTouchedResponseSchema = z.object({
  items: z.array(touchedFileSchema),
  truncated: z.boolean(),
})

const activeClaimsResponseSchema = z.object({
  items: z.array(
    z.object({
      claimId: z.string(),
      repoId: z.string(),
      subject: z.object({ kind: z.enum(['issue', 'file']), key: z.string() }),
      holder: z.object({ kind: z.enum(['user', 'agent']), id: z.string(), label: z.string() }),
      claimedAt: z.string(),
      expiresAt: z.string(),
    }),
  ),
  ...rankedFieldsSchema,
})

let db: StartedDatabase

beforeAll(async () => {
  db = await startDatabase()
  // El proceso de TEST necesita su propio pool para sembrar datos (fixtures,
  // `claim()`...): el servidor MCP, al ser un PROCESO APARTE, se conecta a la
  // misma base con SU PROPIA configuracion (la que le pasamos por env).
  configureDatabase({ connectionString: db.runtimeUrl, max: 10, allowExitOnIdle: true })
}, 300_000)

afterAll(async () => {
  await closeDatabase()
  await db?.container.stop()
})

describe('el servidor MCP del grafo, con datos reales de un tenant', () => {
  const repository = 'acme/widgets'
  let tenantId: string
  let repoId: string
  let checkoutRoot: string
  let server: ServerHandle

  beforeAll(async () => {
    tenantId = await createTenant('mcp-acme')
    repoId = repoIdForRepository(tenantId, repository)

    const nodeIds = await createFileNodes(tenantId, repoId, [
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/unrelated.ts',
    ])
    // b importa a (b DEPENDE de a); c co-cambia con b (senal `git`, no `static`).
    await createEdges(tenantId, repoId, [
      {
        from: nodeIds.get('src/b.ts')!,
        to: nodeIds.get('src/a.ts')!,
        kind: 'imports',
        source: 'static',
        weight: 1,
      },
      {
        from: nodeIds.get('src/c.ts')!,
        to: nodeIds.get('src/b.ts')!,
        kind: 'cochange',
        source: 'git',
        weight: 5,
      },
    ])

    // Dos nodos a la MISMA distancia (1) de un tercer hub, con pesos
    // distintos: el orden de salida tiene que preferir el peso mayor.
    const hubIds = await createFileNodes(tenantId, repoId, [
      'src/hub.ts',
      'src/hub-dependent-fuerte.ts',
      'src/hub-dependent-debil.ts',
    ])
    await createEdges(tenantId, repoId, [
      {
        from: hubIds.get('src/hub-dependent-fuerte.ts')!,
        to: hubIds.get('src/hub.ts')!,
        kind: 'imports',
        source: 'static',
        weight: 100,
      },
      {
        from: hubIds.get('src/hub-dependent-debil.ts')!,
        to: hubIds.get('src/hub.ts')!,
        kind: 'imports',
        source: 'static',
        weight: 1,
      },
    ])

    // Un abanico grande a proposito: fuerza el recorte por presupuesto de
    // bytes con un TOTAL conocido (no truncado por el motor), para poder
    // afirmar el contador honesto en el caso "se sabe el total, igual se
    // recorta por bytes".
    const fanoutPaths = Array.from(
      { length: 80 },
      (_, i) => `src/muy/anidado/paquete/modulo-${String(i).padStart(3, '0')}/archivo.ts`,
    )
    const fanoutIds = await createFileNodes(tenantId, repoId, ['src/fanout-hub.ts', ...fanoutPaths])
    const fanoutHubId = fanoutIds.get('src/fanout-hub.ts')!
    await createEdges(
      tenantId,
      repoId,
      fanoutPaths.map((p) => ({
        from: fanoutIds.get(p)!,
        to: fanoutHubId,
        kind: 'imports' as const,
        source: 'static' as const,
        weight: 1,
      })),
    )

    // Abanico de MAS de FETCH_LIMIT (300) dependientes: es el unico escenario
    // que ejercita contra Postgres real la rama "el MOTOR tambien corto"
    // (`total: null` + `totalAtLeast`). Sin el, esa rama solo se probaba con un
    // `fetch` fabricado en memoria, y nada garantizaba que el `LIMIT` de la CTE
    // y la deteccion de truncado casaran de verdad en SQL.
    const grandePaths = Array.from(
      { length: 350 },
      (_, i) => `src/grande/m${String(i).padStart(3, '0')}.ts`,
    )
    const grandeIds = await createFileNodes(tenantId, repoId, ['src/grande-hub.ts', ...grandePaths])
    const grandeHubId = grandeIds.get('src/grande-hub.ts')!
    await createEdges(
      tenantId,
      repoId,
      grandePaths.map((p) => ({
        from: grandeIds.get(p)!,
        to: grandeHubId,
        kind: 'imports' as const,
        source: 'static' as const,
        weight: 1,
      })),
    )

    // Dos afectados a la MISMA distancia del mismo origen y con pesos distintos,
    // elegidos para que el orden correcto (por peso) CONTRADIGA el alfabetico:
    // "aaa" pesa poco y "zzz" pesa mucho, asi que si `blastRadius` dejara de
    // ranquear, el orden alfabetico daria el resultado contrario.
    const blastIds = await createFileNodes(tenantId, repoId, [
      'src/blast-origen.ts',
      'src/blast-aaa-debil.ts',
      'src/blast-zzz-fuerte.ts',
    ])
    await createEdges(tenantId, repoId, [
      {
        from: blastIds.get('src/blast-aaa-debil.ts')!,
        to: blastIds.get('src/blast-origen.ts')!,
        kind: 'imports',
        source: 'static',
        weight: 1,
      },
      {
        from: blastIds.get('src/blast-zzz-fuerte.ts')!,
        to: blastIds.get('src/blast-origen.ts')!,
        kind: 'cochange',
        source: 'git',
        weight: 42,
      },
    ])

    // Usuario del tenant: el correo de un commit va a coincidir con este.
    await createUser(tenantId, { email: 'ada@example.invalid', displayName: 'Ada Lovelace' })

    // Checkout git real con la forma <raiz>/<owner>/<repo>.
    checkoutRoot = await mkdtemp(path.join(tmpdir(), 'coord-graph-mcp-checkout-'))
    const repo = await createTempRepoAt(path.join(checkoutRoot, repository))
    await repo.write('src/a.ts', 'export const a = 1\n')
    await repo.commit('a', { name: 'Ada Lovelace', email: 'ada@example.invalid' })
    await repo.write('src/b.ts', 'export const b = 2\n')
    await repo.commit('b', { name: 'Bot Committer', email: 'bot@ci.example.invalid' })
    // 'src/unrelated.ts' NUNCA se commitea: es el caso `found: false`.

    // Un claim activo sobre src/a.ts, para active_claims.
    await runWithTenant({ tenantId, actorId: 'agent-1' }, () =>
      claim({
        repoId,
        subject: { kind: 'file', key: 'src/a.ts' },
        holder: { kind: 'agent', id: 'agent-1', label: 'Agente de Ada' },
        ttlSeconds: 3600,
      }),
    )

    server = await startServer({
      GRAPH_MCP_TENANT_ID: tenantId,
      PGBOUNCER_URL: db.runtimeUrl,
      DATABASE_URL: undefined,
      GRAPH_CHECKOUT_ROOT: checkoutRoot,
    })
  }, 120_000)

  afterAll(async () => {
    await server?.close()
  })

  it('el servidor anuncia las cinco herramientas del epic', async () => {
    const { tools } = await server.client.listTools()
    const names = tools.map((tool) => tool.name).sort()
    expect(names).toEqual([
      'active_claims',
      'blast_radius',
      'find_dependencies',
      'find_dependents',
      'who_last_touched',
    ])
  })

  it('find_dependents: quien depende de src/a.ts, con la senal de cada uno', async () => {
    const { isError, text } = await callTool(server.client, 'find_dependents', {
      repository,
      node: { path: 'src/a.ts' },
      depth: 2,
    })
    expect(isError).toBe(false)
    const parsed = traversalResponseSchema.parse(JSON.parse(text))
    expect(parsed.page.items.map((hit) => [hit.path, hit.distance, hit.signal])).toEqual([
      ['src/b.ts', 1, 'static'],
      ['src/c.ts', 2, 'git'],
    ])
    expect(parsed.page.truncated).toBe(false)
    expect(parsed.page.total).toBe(2)
  })

  it('find_dependencies: de que depende src/b.ts', async () => {
    const { text } = await callTool(server.client, 'find_dependencies', {
      repository,
      node: { path: 'src/b.ts' },
    })
    const parsed = traversalResponseSchema.parse(JSON.parse(text))
    expect(parsed.page.items).toHaveLength(1)
    expect(parsed.page.items[0]?.path).toBe('src/a.ts')
  })

  it('find_dependents sobre un fichero que no esta en el grafo: error de herramienta, no lista vacia', async () => {
    const { isError, text } = await callTool(server.client, 'find_dependents', {
      repository,
      node: { path: 'src/no-existe.ts' },
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/no encontrado/i)
  })

  it('blast_radius: el impacto de tocar src/a.ts es el mismo conjunto que find_dependents', async () => {
    const { text } = await callTool(server.client, 'blast_radius', {
      repository,
      files: ['src/a.ts', 'src/no-indexado-todavia.ts'],
    })
    const parsed = blastRadiusResponseSchema.parse(JSON.parse(text))
    expect(parsed.page.items.map((hit) => hit.path)).toEqual(['src/b.ts', 'src/c.ts'])
    expect(parsed.page.items[1]?.signals).toEqual(['git'])
    expect(parsed.unresolved.files).toEqual(['src/no-indexado-todavia.ts'])
    expect(parsed.unresolved.total).toBe(1)
    expect(parsed.unresolved.truncated).toBe(false)
  })

  it('blast_radius ranquea por peso a igual distancia, contra el orden alfabetico', async () => {
    const { text } = await callTool(server.client, 'blast_radius', {
      repository,
      files: ['src/blast-origen.ts'],
      depth: 1,
    })
    const parsed = blastRadiusResponseSchema.parse(JSON.parse(text))
    // `blastRadius` tiene su PROPIO SQL de agregacion, distinto del de
    // `find_dependents`: si solo se probara el orden alli, este quedaria sin
    // proteger. El orden correcto es el contrario al alfabetico.
    expect(parsed.page.items.map((hit) => hit.path)).toEqual([
      'src/blast-zzz-fuerte.ts',
      'src/blast-aaa-debil.ts',
    ])
  })

  it('blast_radius con MUCHOS ficheros sin resolver: la respuesta ENTERA cabe en el presupuesto', async () => {
    // El caso que rompia el criterio: 200 rutas largas contra un repo sin
    // indexar. Antes `unresolvedFiles` salia entero, fuera del presupuesto.
    const files = Array.from(
      { length: 200 },
      (_, i) =>
        `src/paquete/muy/anidado/que/no/esta/indexado/modulo-${String(i).padStart(3, '0')}/archivo-largo.ts`,
    )
    const { text } = await callTool(server.client, 'blast_radius', { repository, files })
    const bytes = new TextEncoder().encode(text).length
    const parsed = blastRadiusResponseSchema.parse(JSON.parse(text))

    expect(bytes).toBeLessThan(16 * 1024)
    // El contador es honesto: se dice cuantas habia de verdad y que se recorto.
    expect(parsed.unresolved.total).toBe(200)
    expect(parsed.unresolved.truncated).toBe(true)
    expect(parsed.unresolved.files.length).toBeLessThan(200)
    expect(parsed.unresolved.files.length).toBeGreaterThan(0)
  })

  it('cuando el MOTOR corta (mas de 300 dependientes), el total es null y la cota se dice', async () => {
    const { text } = await callTool(server.client, 'find_dependents', {
      repository,
      node: { path: 'src/grande-hub.ts' },
      depth: 1,
    })
    const parsed = traversalResponseSchema.parse(JSON.parse(text))
    expect(parsed.page.truncated).toBe(true)
    // Se sabe que hay MAS de los que devolvio el motor, pero no cuantos: el
    // total exacto seria una invencion.
    expect(parsed.page.total).toBeNull()
    expect(parsed.page.totalAtLeast).toBe(301)
    // Y aun asi la respuesta cabe en el presupuesto.
    expect(new TextEncoder().encode(text).length).toBeLessThan(16 * 1024)
  })

  it('ranking: a igual distancia, gana el peso mayor', async () => {
    const { text } = await callTool(server.client, 'find_dependents', {
      repository,
      node: { path: 'src/hub.ts' },
      depth: 1,
    })
    const parsed = traversalResponseSchema.parse(JSON.parse(text))
    expect(parsed.page.items.map((hit) => hit.path)).toEqual([
      'src/hub-dependent-fuerte.ts',
      'src/hub-dependent-debil.ts',
    ])
  })

  it('presupuesto de bytes: un abanico grande se recorta con un contador honesto', async () => {
    const { text } = await callTool(server.client, 'find_dependents', {
      repository,
      node: { path: 'src/fanout-hub.ts' },
      depth: 1,
    })
    const bytes = new TextEncoder().encode(text).length
    const parsed = traversalResponseSchema.parse(JSON.parse(text))
    // La respuesta ENTERA (no solo `items`) cabe holgadamente: es el
    // criterio de aceptacion literal de T05 ("cabe holgadamente en el
    // presupuesto de contexto").
    expect(bytes).toBeLessThan(16 * 1024)
    expect(parsed.page.truncated).toBe(true)
    expect(parsed.page.shown).toBeLessThan(80)
    // El motor SI vio los 80 (no corto: 80 < FETCH_LIMIT); el total es exacto,
    // no una cota inferior inventada.
    expect(parsed.page.total).toBe(80)
    expect(parsed.page.shown).toBe(parsed.page.items.length)
  })

  it('who_last_touched: personas, no hashes; nunca el correo', async () => {
    const { text } = await callTool(server.client, 'who_last_touched', {
      repository,
      files: ['src/a.ts', 'src/b.ts', 'src/unrelated.ts'],
    })
    const parsed = whoLastTouchedResponseSchema.parse(JSON.parse(text))
    const byPath = new Map(parsed.items.map((row) => [row.path, row]))

    expect(byPath.get('src/a.ts')).toMatchObject({
      found: true,
      person: 'Ada Lovelace',
      source: 'user',
    })
    expect(byPath.get('src/b.ts')).toMatchObject({
      found: true,
      person: 'Bot Committer',
      source: 'git',
    })
    expect(byPath.get('src/unrelated.ts')).toMatchObject({ found: false })

    // El correo NUNCA sale, ni el que hizo match ni el que no.
    expect(text).not.toContain('ada@example.invalid')
    expect(text).not.toContain('bot@ci.example.invalid')
    // Nada de hashes largos de commit como identidad de "quien": el sha
    // completo no aparece, como mucho el corto que va como trazabilidad.
    const shaPattern = /\b[0-9a-f]{40}\b/
    expect(text).not.toMatch(shaPattern)
  })

  it('active_claims: el claim activo sobre src/a.ts, con quien lo tiene', async () => {
    const { text } = await callTool(server.client, 'active_claims', { repository })
    const parsed = activeClaimsResponseSchema.parse(JSON.parse(text))
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]?.subject).toEqual({ kind: 'file', key: 'src/a.ts' })
    expect(parsed.items[0]?.holder.label).toBe('Agente de Ada')
  })

  it('entrada invalida: error de herramienta con motivo, nunca una lista vacia', async () => {
    const { isError, text } = await callTool(server.client, 'find_dependents', {
      repository: 'esto-no-es-owner-slash-repo',
      node: { path: 'src/a.ts' },
    })
    expect(isError).toBe(true)
    expect(text.length).toBeGreaterThan(0)
  })
})

describe('aislamiento entre tenants, y las herramientas sin lo que necesitan', () => {
  const repository = 'acme/widgets'
  let tenantA: string
  let tenantB: string
  let serverA: ServerHandle
  let serverB: ServerHandle

  beforeAll(async () => {
    tenantA = await createTenant('mcp-iso-a')
    tenantB = await createTenant('mcp-iso-b')

    const repoIdA = repoIdForRepository(tenantA, repository)
    const nodesA = await createFileNodes(tenantA, repoIdA, ['src/a.ts', 'src/b.ts'])
    await createEdges(tenantA, repoIdA, [
      {
        from: nodesA.get('src/b.ts')!,
        to: nodesA.get('src/a.ts')!,
        kind: 'imports',
        source: 'static',
      },
    ])
    await runWithTenant({ tenantId: tenantA, actorId: 'agent-a' }, () =>
      claim({
        repoId: repoIdA,
        subject: { kind: 'issue', key: '1' },
        holder: { kind: 'agent', id: 'agent-a', label: 'Agente A' },
        ttlSeconds: 3600,
      }),
    )

    // MISMO nombre de repo y MISMA ruta en tenant B, pero SIN el vecino: si
    // el aislamiento fallara, find_dependents veria "src/b.ts" de todas
    // formas.
    const repoIdB = repoIdForRepository(tenantB, repository)
    await createFileNodes(tenantB, repoIdB, ['src/a.ts'])

    serverA = await startServer({
      GRAPH_MCP_TENANT_ID: tenantA,
      PGBOUNCER_URL: db.runtimeUrl,
      DATABASE_URL: undefined,
      // Adrede SIN GRAPH_CHECKOUT_ROOT: cubre el caso "who_last_touched sin
      // checkout configurado" con un servidor que por lo demas es normal.
      GRAPH_CHECKOUT_ROOT: undefined,
    })
    serverB = await startServer({
      GRAPH_MCP_TENANT_ID: tenantB,
      PGBOUNCER_URL: db.runtimeUrl,
      DATABASE_URL: undefined,
      GRAPH_CHECKOUT_ROOT: undefined,
    })
  }, 120_000)

  afterAll(async () => {
    await serverA?.close()
    await serverB?.close()
  })

  it('el tenant B no ve al dependiente del tenant A, aunque el repo y la ruta se llamen igual', async () => {
    const { text } = await callTool(serverB.client, 'find_dependents', {
      repository,
      node: { path: 'src/a.ts' },
    })
    const parsed = traversalResponseSchema.parse(JSON.parse(text))
    expect(parsed.page.items).toEqual([])
    expect(parsed.page.truncated).toBe(false)
  })

  it('el tenant B no ve los claims del tenant A', async () => {
    const { text } = await callTool(serverB.client, 'active_claims', {})
    const parsed = activeClaimsResponseSchema.parse(JSON.parse(text))
    expect(parsed.items).toEqual([])
  })

  it('el tenant A si ve su propio claim', async () => {
    const { text } = await callTool(serverA.client, 'active_claims', {})
    const parsed = activeClaimsResponseSchema.parse(JSON.parse(text))
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]?.subject).toEqual({ kind: 'issue', key: '1' })
  })

  it('who_last_touched sin GRAPH_CHECKOUT_ROOT: error de herramienta que lo dice, no un crash silencioso', async () => {
    const { isError, text } = await callTool(serverA.client, 'who_last_touched', {
      repository,
      files: ['src/a.ts'],
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/GRAPH_CHECKOUT_ROOT/)
  })
})

describe('el servidor no arranca sin contexto de tenant', () => {
  it('sin GRAPH_MCP_TENANT_ID, el proceso falla y la conexion nunca se completa', async () => {
    const transport = new StdioClientTransport({
      command: TSX_BIN,
      args: [MAIN_TS],
      env: fullEnv({ GRAPH_MCP_TENANT_ID: undefined, PGBOUNCER_URL: db.runtimeUrl }),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'coord-graph-mcp-test-sin-tenant', version: '0.0.0' })

    // Se lee el stderr del proceso: `toBeDefined()` sobre la carrera pasaria
    // igual si el servidor se QUEDARA COLGADO (el TIMEOUT tambien es un error
    // "definido"), que es justo el fallo que hay que distinguir. Aqui se exige
    // el motivo concreto.
    let stderr = ''
    const collect = new Promise<void>((resolve) => {
      const attach = (): void => {
        if (transport.stderr === null) {
          setTimeout(attach, 10)
          return
        }
        transport.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        transport.stderr.on('close', () => {
          resolve()
        })
      }
      attach()
    })

    const error = await Promise.race([
      client.connect(transport).then(
        () => new Error('EL SERVIDOR ARRANCO SIN GRAPH_MCP_TENANT_ID'),
        (cause: unknown) => cause,
      ),
      sleep(15_000).then(
        () => new Error('TIMEOUT: el servidor se quedo colgado en vez de negarse'),
      ),
    ])
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toMatch(/TIMEOUT|ARRANCO SIN/)

    await Promise.race([collect, sleep(5_000)])
    expect(stderr).toMatch(/GRAPH_MCP_TENANT_ID/)
  }, 30_000)
})

/**
 * `who_last_touched` es la UNICA herramienta que no pasa por la base de datos
 * para localizar el recurso: mira el sistema de ficheros. Con una raiz de
 * checkouts compartida entre tenants —que es un despliegue perfectamente
 * normal— eso significaba que cualquier `owner/repo` presente bajo esa raiz
 * devolvia nombres de autor y fechas de su `git log`, estuviera o no asociado
 * al tenant que preguntaba. La RLS no cubre esa puerta porque no se consultaba
 * nada.
 */
describe('who_last_touched con una raiz de checkouts COMPARTIDA entre tenants', () => {
  const repository = 'acme/compartido'
  let conRepo: string
  let sinRepo: string
  let checkoutRoot: string
  let servidorConRepo: ServerHandle
  let servidorSinRepo: ServerHandle

  beforeAll(async () => {
    conRepo = await createTenant('mcp-checkout-propietario')
    sinRepo = await createTenant('mcp-checkout-ajeno')

    // Solo el primer tenant tiene el repositorio indexado.
    await createFileNodes(conRepo, repoIdForRepository(conRepo, repository), ['src/a.ts'])

    checkoutRoot = await mkdtemp(path.join(tmpdir(), 'coord-graph-mcp-compartido-'))
    const repo = await createTempRepoAt(path.join(checkoutRoot, repository))
    await repo.write('src/a.ts', 'export const a = 1\n')
    await repo.commit('a', { name: 'Ada Lovelace', email: 'ada@example.invalid' })

    const env = {
      PGBOUNCER_URL: db.runtimeUrl,
      DATABASE_URL: undefined,
      GRAPH_CHECKOUT_ROOT: checkoutRoot,
    }
    servidorConRepo = await startServer({ ...env, GRAPH_MCP_TENANT_ID: conRepo })
    servidorSinRepo = await startServer({ ...env, GRAPH_MCP_TENANT_ID: sinRepo })
  }, 120_000)

  afterAll(async () => {
    await servidorConRepo?.close()
    await servidorSinRepo?.close()
  })

  it('el tenant que SI tiene el repositorio indexado recibe su historial', async () => {
    const { isError, text } = await callTool(servidorConRepo.client, 'who_last_touched', {
      repository,
      files: ['src/a.ts'],
    })
    expect(isError).toBe(false)
    const parsed = whoLastTouchedResponseSchema.parse(JSON.parse(text))
    expect(parsed.items[0]?.person).toBe('Ada Lovelace')
  })

  it('el tenant que NO lo tiene recibe un error, no el historial de otro cliente', async () => {
    const { isError, text } = await callTool(servidorSinRepo.client, 'who_last_touched', {
      repository,
      files: ['src/a.ts'],
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/no esta indexado para este tenant/i)
    // Y no se filtra NADA del historial ajeno en el mensaje de error.
    expect(text).not.toMatch(/Ada Lovelace/)
  })
})
