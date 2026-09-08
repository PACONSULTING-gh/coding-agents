import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createGitHubApp } from '../src/app.js'
import {
  InstallationTokenCache,
  installationTokenFetcher,
  type InstallationToken,
} from '../src/installation-tokens.js'

/**
 * La API de GitHub es un servicio externo que no controlamos, asi que NO se
 * mockea el cliente de octokit (CLAUDE.md 5): se levanta un servidor HTTP de
 * verdad en localhost y se apunta la App a el con `baseUrl`. Lo que se prueba
 * es el camino completo — firmar el JWT, hacer la peticion, leer la respuesta —
 * y no que un doble devuelva lo que le hemos dicho.
 *
 * La clave privada se genera al vuelo, en memoria, en cada ejecucion. En el
 * repositorio no hay ninguna clave, ni en tests ni en fixtures (CLAUDE.md 5).
 */

const INSTALLATION_ID = 4242
const HOUR_MS = 60 * 60 * 1000

function generatePrivateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return privateKey
}

interface FakeGitHub {
  baseUrl: string
  /** Peticiones al endpoint de tokens de instalacion. */
  tokenRequests: number
  /** Instante (ms) que se usa para calcular `expires_at` de la siguiente respuesta. */
  issuedAt: number
  close: () => Promise<void>
}

/**
 * Doble de la API de GitHub: solo el endpoint de tokens de instalacion.
 * Devuelve un token distinto en cada peticion para poder comprobar que la
 * renovacion realmente sustituye el que habia.
 */
async function startFakeGitHub(): Promise<FakeGitHub> {
  const state = { tokenRequests: 0, issuedAt: Date.now() }

  const server: Server = createServer((request, response) => {
    if (
      request.method === 'POST' &&
      request.url === `/app/installations/${String(INSTALLATION_ID)}/access_tokens`
    ) {
      state.tokenRequests += 1
      const body = JSON.stringify({
        token: `ghs_${randomBytes(8).toString('hex')}`,
        expires_at: new Date(state.issuedAt + HOUR_MS).toISOString(),
        permissions: { issues: 'write' },
        repository_selection: 'all',
      })
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(body)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ message: 'Not Found' }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    get tokenRequests() {
      return state.tokenRequests
    },
    get issuedAt() {
      return state.issuedAt
    },
    set issuedAt(value: number) {
      state.issuedAt = value
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      }),
  }
}

let fake: FakeGitHub | undefined

afterEach(async () => {
  await fake?.close()
  fake = undefined
})

describe('InstallationTokenCache contra un servidor HTTP real', () => {
  it('pide el token una vez y lo reutiliza mientras siga fresco', async () => {
    fake = await startFakeGitHub()
    const app = createGitHubApp({
      appId: 1,
      privateKey: generatePrivateKey(),
      webhookSecret: randomBytes(16).toString('hex'),
      baseUrl: fake.baseUrl,
    })
    const now = Date.now()
    const cache = new InstallationTokenCache({
      fetch: installationTokenFetcher(app),
      now: () => now,
    })

    const first = await cache.getToken(INSTALLATION_ID)
    const second = await cache.getToken(INSTALLATION_ID)

    expect(first.token).not.toBe('')
    expect(second.token).toBe(first.token)
    expect(fake.tokenRequests).toBe(1)
  })

  it('renueva de forma transparente cuando el token entra en el margen', async () => {
    fake = await startFakeGitHub()
    const app = createGitHubApp({
      appId: 1,
      privateKey: generatePrivateKey(),
      webhookSecret: randomBytes(16).toString('hex'),
      baseUrl: fake.baseUrl,
    })

    // Reloj inyectado: el test controla el paso del tiempo en vez de esperarlo.
    let clock = Date.now()
    fake.issuedAt = clock
    const cache = new InstallationTokenCache({
      fetch: installationTokenFetcher(app),
      renewMarginMs: 5 * 60 * 1000,
      now: () => clock,
    })

    const first = await cache.getToken(INSTALLATION_ID)
    expect(fake.tokenRequests).toBe(1)

    // 56 minutos despues: al token le quedan 4, menos que el margen de 5.
    clock += 56 * 60 * 1000
    fake.issuedAt = clock
    const renewed = await cache.getToken(INSTALLATION_ID)

    expect(fake.tokenRequests).toBe(2)
    expect(renewed.token).not.toBe(first.token)
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime())
    // Y el nuevo se cachea: la siguiente llamada no vuelve a pedirlo.
    await cache.getToken(INSTALLATION_ID)
    expect(fake.tokenRequests).toBe(2)
  })

  it('dos llamadas concurrentes con el token caducado provocan UNA peticion', async () => {
    fake = await startFakeGitHub()
    const app = createGitHubApp({
      appId: 1,
      privateKey: generatePrivateKey(),
      webhookSecret: randomBytes(16).toString('hex'),
      baseUrl: fake.baseUrl,
    })
    const now = Date.now()
    const cache = new InstallationTokenCache({
      fetch: installationTokenFetcher(app),
      now: () => now,
    })

    const [a, b, c] = await Promise.all([
      cache.getToken(INSTALLATION_ID),
      cache.getToken(INSTALLATION_ID),
      cache.getToken(INSTALLATION_ID),
    ])

    expect(fake.tokenRequests).toBe(1)
    expect(a.token).toBe(b.token)
    expect(b.token).toBe(c.token)
  })

  it('propaga el error si GitHub no da el token, y no lo cachea', async () => {
    fake = await startFakeGitHub()
    const app = createGitHubApp({
      appId: 1,
      privateKey: generatePrivateKey(),
      webhookSecret: randomBytes(16).toString('hex'),
      baseUrl: fake.baseUrl,
    })
    const cache = new InstallationTokenCache({ fetch: installationTokenFetcher(app) })

    // Instalacion que el doble no conoce: responde 404.
    await expect(cache.getToken(999)).rejects.toThrow()
    expect(cache.size).toBe(0)
  })
})

/**
 * Estos dos casos ejercitan la CACHE en aislamiento, con un proveedor de tokens
 * instrumentado. No es un doble de GitHub —eso es el servidor de arriba— sino
 * el puerto propio `InstallationTokenFetcher`, que si controlamos: es la unica
 * forma de demostrar que la deduplicacion la hace ESTA clase y no una capa de
 * mas abajo.
 */
describe('InstallationTokenCache: politica de renovacion', () => {
  it('una sola llamada al proveedor aunque lleguen diez a la vez', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const cache = new InstallationTokenCache({
      fetch: async (): Promise<InstallationToken> => {
        calls += 1
        await gate
        return { token: 'token-1', expiresAt: new Date(Date.now() + HOUR_MS) }
      },
    })

    const pending = Array.from({ length: 10 }, () => cache.getToken(INSTALLATION_ID))
    release?.()
    const tokens = await Promise.all(pending)

    expect(calls).toBe(1)
    expect(new Set(tokens.map((entry) => entry.token)).size).toBe(1)
  })

  it('un token que caduca dentro del margen se considera no fresco', async () => {
    let clock = 1_000_000
    let issued = 0
    const cache = new InstallationTokenCache({
      renewMarginMs: 60_000,
      now: () => clock,
      fetch: (): Promise<InstallationToken> => {
        issued += 1
        return Promise.resolve({
          token: `token-${String(issued)}`,
          expiresAt: new Date(clock + 120_000),
        })
      },
    })

    expect((await cache.getToken(INSTALLATION_ID)).token).toBe('token-1')
    // Quedan 61 s > 60 s de margen: sigue fresco.
    clock += 59_000
    expect((await cache.getToken(INSTALLATION_ID)).token).toBe('token-1')
    // Quedan 59 s < 60 s de margen: se renueva.
    clock += 2_000
    expect((await cache.getToken(INSTALLATION_ID)).token).toBe('token-2')
    expect(issued).toBe(2)
  })
})
