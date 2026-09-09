import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { runWithTenant, type JobEnvelope } from '@coord/core'
import {
  closeDatabase,
  configureDatabase,
  findInstallationRouting,
  readAuditLog,
  upsertInstallation,
  withTenantConnection,
} from '@coord/db'
import { createSignatureVerifier, queueNameForEvent, type GithubWebhookJob } from '@coord/github'
import { PgBossQueue } from '@coord/queue'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildServer, WEBHOOK_PATH } from '../src/server.js'
// El montaje de Postgres con separacion de roles ya existe en packages/db
// (peldano 2 de la escalera: reutilizar antes que escribir). Se importa por
// ruta relativa porque es infraestructura de test, no API publica del paquete.
import { startDatabase, type StartedDatabase } from '../../../packages/db/test/support/database.js'

/**
 * Tests de integracion del listener contra un PostgreSQL DE VERDAD
 * (testcontainers) y la cola de verdad (pg-boss sobre ese mismo Postgres).
 * Nada mockeado: lo que se comprueba —deduplicacion bajo carrera, RLS, latencia
 * real— es comportamiento del motor y de la cola (CLAUDE.md 5).
 *
 * Ningun secreto esta en el repositorio: el secreto de webhook se genera
 * aleatorio en cada ejecucion.
 */

const WEBHOOK_SECRET = randomBytes(32).toString('hex')
const INSTALLATION_ID = 55_123_456
const UNKNOWN_INSTALLATION_ID = 99_999_999

let database: StartedDatabase
let queue: PgBossQueue
let server: ReturnType<typeof buildServer>
let baseUrl: string
let tenantId: string

/** Jobs que ha recogido el consumidor de prueba, por GUID de entrega. */
const consumed: GithubWebhookJob[] = []

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex')}`
}

function issuePayload(installationId: number): string {
  return JSON.stringify({
    action: 'opened',
    issue: { number: 12, title: 'Prueba' },
    repository: { full_name: 'PACONSULTING-gh/coord' },
    sender: { login: 'una-persona' },
    installation: { id: installationId },
  })
}

interface PostOptions {
  body: string
  deliveryId?: string | undefined
  event?: string | undefined
  signature?: string | undefined
}

async function post(options: PostOptions): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.deliveryId !== undefined) headers['x-github-delivery'] = options.deliveryId
  if (options.event !== undefined) headers['x-github-event'] = options.event
  if (options.signature !== undefined) headers['x-hub-signature-256'] = options.signature

  const response = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
    method: 'POST',
    headers,
    body: options.body,
  })
  return { status: response.status, body: await response.json() }
}

/** Peticion valida completa: firma calculada sobre el cuerpo exacto que se envia. */
async function postValid(
  deliveryId: string,
  body = issuePayload(INSTALLATION_ID),
): Promise<{ status: number; body: unknown }> {
  return post({ body, deliveryId, event: 'issues', signature: sign(body) })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(
  description: string,
  condition: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await delay(100)
  }
  throw new Error(`Se agoto la espera de: ${description}`)
}

beforeAll(async () => {
  database = await startDatabase()

  configureDatabase({
    connectionString: database.runtimeUrl,
    applicationName: 'coord-webhook-test',
    allowExitOnIdle: true,
  })

  // Tenant + mapeo de la instalacion. Crear un tenant no necesita ninguna via
  // administrativa: basta con abrir el contexto con el id que se va a insertar
  // (la politica de `tenants` compara contra `id`).
  tenantId = randomUUID()
  await runWithTenant({ tenantId }, async () => {
    await withTenantConnection((tx) =>
      tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        'Liberion Labs',
        `liberion-${tenantId.slice(0, 8)}`,
      ]),
    )
    await withTenantConnection((tx) =>
      upsertInstallation(tx, {
        installationId: INSTALLATION_ID,
        accountLogin: 'PACONSULTING-gh',
        accountType: 'Organization',
        repositorySelection: 'all',
      }),
    )
  })

  // pg-boss crea su propio esquema, asi que en el test se conecta con el rol
  // privilegiado del contenedor. En produccion el esquema `queue` se aprovisiona
  // una vez y el runtime solo lo usa.
  queue = new PgBossQueue({ connectionString: database.superUrl })
  await queue.start()
  await queue.process(
    queueNameForEvent('issues'),
    (job: JobEnvelope<GithubWebhookJob>) => {
      consumed.push(job.payload)
      return Promise.resolve()
    },
    { pollIntervalSeconds: 1 },
  )

  server = buildServer({
    queue,
    verifySignature: createSignatureVerifier(WEBHOOK_SECRET),
    // `silent`: el listener loguea mucho a proposito y aqui solo estorbaria.
    logger: pino({ level: 'silent' }),
    checkQueue: () => queue.checkHealth(),
  })
  await server.listen({ port: 0, host: '127.0.0.1' })
  const address = server.server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${String(address.port)}`
}, 180_000)

afterAll(async () => {
  await server?.close()
  await queue?.stop()
  await closeDatabase()
  await database?.stop()
})

describe('1. verificacion de firma', () => {
  it('una entrega valida responde 200 y queda encolada', async () => {
    const deliveryId = randomUUID()
    const response = await postValid(deliveryId)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'queued' })

    await waitFor('que el job llegue al worker', () =>
      consumed.some((job) => job.deliveryId === deliveryId),
    )
    const job = consumed.find((entry) => entry.deliveryId === deliveryId)
    expect(job?.event).toBe('issues')
    expect(job?.action).toBe('opened')
    expect(job?.installationId).toBe(INSTALLATION_ID)
  })

  it('una firma invalida responde 401 y NO encola', async () => {
    const deliveryId = randomUUID()
    const body = issuePayload(INSTALLATION_ID)

    const response = await post({
      body,
      deliveryId,
      event: 'issues',
      signature: `sha256=${'0'.repeat(64)}`,
    })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'firma_invalida' })
    await delay(3_000)
    expect(consumed.filter((job) => job.deliveryId === deliveryId)).toHaveLength(0)
  })

  it('un cuerpo alterado en un solo byte responde 401', async () => {
    const body = issuePayload(INSTALLATION_ID)
    const signature = sign(body)
    const tampered = body.replace('"number":12', '"number":13')
    expect(tampered).not.toBe(body)

    const response = await post({
      body: tampered,
      deliveryId: randomUUID(),
      event: 'issues',
      signature,
    })
    expect(response.status).toBe(401)
  })

  it('sin cabecera de firma responde 401', async () => {
    const body = issuePayload(INSTALLATION_ID)
    const response = await post({ body, deliveryId: randomUUID(), event: 'issues' })
    expect(response.status).toBe(401)
  })

  it('una firma sha1 responde 401 aunque el HMAC sha1 sea correcto', async () => {
    const body = issuePayload(INSTALLATION_ID)
    const sha1 = `sha1=${createHmac('sha1', WEBHOOK_SECRET).update(body, 'utf8').digest('hex')}`

    const response = await post({
      body,
      deliveryId: randomUUID(),
      event: 'issues',
      signature: sha1,
    })
    expect(response.status).toBe(401)
  })

  it('la firma se calcula sobre los BYTES CRUDOS, no sobre el JSON reserializado', async () => {
    // El resto de tests de este bloque envian JSON compacto, que es exactamente
    // lo que produciria un JSON.parse + JSON.stringify: con esos cuerpos, una
    // regresion que reserializase el cuerpo antes de verificar pasaria
    // inadvertida. Este cuerpo va indentado y firmado sobre esos bytes exactos,
    // asi que solo cuadra si el HMAC se calculo sobre el Buffer original.
    const indentado = JSON.stringify(
      {
        action: 'opened',
        issue: { number: 13, title: 'Cuerpo con formato' },
        repository: { full_name: 'PACONSULTING-gh/coord' },
        sender: { login: 'una-persona' },
        installation: { id: INSTALLATION_ID },
      },
      null,
      2,
    )
    // Control de que el cuerpo es realmente distinto de su forma compacta.
    expect(indentado).not.toBe(JSON.stringify(JSON.parse(indentado)))

    const deliveryId = randomUUID()
    const respuesta = await post({
      body: indentado,
      deliveryId,
      event: 'issues',
      signature: sign(indentado),
    })
    expect(respuesta.status).toBe(200)

    await waitFor('el job indentado llega al consumidor', () =>
      consumed.some((job) => job.deliveryId === deliveryId),
    )
  })

  it('el intento rechazado queda registrado en audit_log del tenant', async () => {
    const deliveryId = randomUUID()
    const body = issuePayload(INSTALLATION_ID)

    await post({ body, deliveryId, event: 'issues', signature: `sha256=${'1'.repeat(64)}` })

    const page = await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) =>
        readAuditLog(tx, { actions: ['github.webhook.signature_rejected'] }),
      ),
    )
    const entry = page.entries.find((row) => row.resourceId === deliveryId)
    expect(entry, 'no se registro el intento con firma invalida').toBeDefined()
    expect(entry?.actorType).toBe('system')
    expect(entry?.metadata['reason']).toBe('signature_mismatch')
    expect(entry?.metadata['installationId']).toBe(INSTALLATION_ID)
  })
})

describe('2. deduplicacion por GUID de entrega', () => {
  it('la misma entrega dos veces se encola una sola vez', async () => {
    const deliveryId = randomUUID()

    const first = await postValid(deliveryId)
    const second = await postValid(deliveryId)

    expect(first.body).toEqual({ status: 'queued' })
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ status: 'duplicate' })

    await waitFor('que llegue el job', () => consumed.some((job) => job.deliveryId === deliveryId))
    // Margen para que, si hubiera un segundo job, diera tiempo a llegar.
    await delay(3_000)
    expect(consumed.filter((job) => job.deliveryId === deliveryId)).toHaveLength(1)
  })

  it('dos entregas simultaneas con el mismo GUID (carrera) tambien se encolan una vez', async () => {
    const deliveryId = randomUUID()

    const [a, b] = await Promise.all([postValid(deliveryId), postValid(deliveryId)])

    expect([a.status, b.status]).toEqual([200, 200])
    // Exactamente una gana la carrera: la restriccion unica de la base decide,
    // no el orden en que lleguen.
    const outcomes = [a.body, b.body].map((body) => (body as { status: string }).status).sort()
    expect(outcomes).toEqual(['duplicate', 'queued'])

    await waitFor('que llegue el job', () => consumed.some((job) => job.deliveryId === deliveryId))
    await delay(3_000)
    expect(consumed.filter((job) => job.deliveryId === deliveryId)).toHaveLength(1)
  })
})

describe('3. mapeo instalacion -> tenant', () => {
  it('la instalacion mapeada se recupera sin contexto de tenant', async () => {
    const routing = await findInstallationRouting(INSTALLATION_ID)

    expect(routing).toEqual({
      tenantId,
      installationId: INSTALLATION_ID,
      accountLogin: 'PACONSULTING-gh',
      suspendedAt: null,
    })
  })

  it('una instalacion desconocida no resuelve a ningun tenant', async () => {
    await expect(findInstallationRouting(UNKNOWN_INSTALLATION_ID)).resolves.toBeUndefined()
  })

  it('un webhook de instalacion desconocida responde 200 y no encola', async () => {
    const deliveryId = randomUUID()
    const body = issuePayload(UNKNOWN_INSTALLATION_ID)

    const response = await post({ body, deliveryId, event: 'issues', signature: sign(body) })

    // 200 y no 4xx: a GitHub no le sirve reintentar algo que solo arregla una
    // persona vinculando la instalacion a un tenant.
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'unmapped' })
    await delay(3_000)
    expect(consumed.filter((job) => job.deliveryId === deliveryId)).toHaveLength(0)
  })

  it('un evento al que no estamos suscritos se ignora', async () => {
    const body = issuePayload(INSTALLATION_ID)
    const response = await post({
      body,
      deliveryId: randomUUID(),
      event: 'star',
      signature: sign(body),
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ignored' })
  })
})

describe('4. latencia', () => {
  it('responde en menos de 500 ms con la base y la cola reales', async () => {
    // Una primera entrega fuera de la medicion: la creacion perezosa de la cola
    // en pg-boss y la primera conexion del pool no son el caso que interesa.
    await postValid(randomUUID())

    const samples: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const startedAt = process.hrtime.bigint()
      const response = await postValid(randomUUID())
      samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6)
      expect(response.status).toBe(200)
    }

    const worst = Math.max(...samples)
    expect(
      worst,
      `la peor de ${String(samples.length)} entregas tardo ${worst.toFixed(1)} ms`,
    ).toBeLessThan(500)
  })
})

describe('5. salud', () => {
  it('/health comprueba de verdad la base y la cola', async () => {
    const response = await fetch(`${baseUrl}/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      checks: { database: true, queue: true },
    })
  })

  it('/health responde 503 cuando la cola esta parada', async () => {
    // Se construye un servidor aparte con una cola sin arrancar: `checkHealth`
    // falla de verdad, no se simula el fallo.
    const stopped = new PgBossQueue({ connectionString: database.superUrl })
    const degraded = buildServer({
      queue: stopped,
      verifySignature: createSignatureVerifier(WEBHOOK_SECRET),
      logger: pino({ level: 'silent' }),
      checkQueue: () => stopped.checkHealth(),
    })
    try {
      const response = await degraded.inject({ method: 'GET', url: '/health' })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({
        status: 'degraded',
        checks: { database: true, queue: false },
      })
    } finally {
      await degraded.close()
    }
  })
})
