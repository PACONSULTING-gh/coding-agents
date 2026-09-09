import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ValidationError } from '@coord/core'
import { afterEach, describe, expect, it } from 'vitest'

import { createGitHubApp } from '../src/app.js'
import {
  publishPullRequestComment,
  type PullRequestCommentTarget,
} from '../src/pull-request-comments.js'

/**
 * Igual que `installation-tokens.test.ts`: servidor HTTP real en localhost, la
 * App apuntada a el con `baseUrl`, clave RSA generada al vuelo. NUNCA contra
 * la API de GitHub de verdad — no hay una App registrada en esta maquina. Ver
 * la cabecera de `../src/pull-request-comments.ts`.
 *
 * El doble tiene que responder a DOS peticiones, en orden, porque es lo que
 * hace `getInstallationOctokit` por dentro: primero canjea el JWT de la App
 * por un token de instalacion, y con ESE token llama al endpoint de
 * comentarios. Probar solo el segundo paso con un token inventado no
 * demostraria que el camino completo funciona.
 */

const INSTALLATION_ID = 777

function generatePrivateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return privateKey
}

interface CommentRequest {
  readonly authorization: string | undefined
  readonly path: string
  readonly body: { owner?: string; repo?: string; body?: string }
}

interface FakeGitHub {
  baseUrl: string
  readonly commentRequests: CommentRequest[]
  close: () => Promise<void>
}

async function startFakeGitHub(
  onComment?: (request: CommentRequest) => { status: number; body: unknown },
): Promise<FakeGitHub> {
  const commentRequests: CommentRequest[] = []

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')

      if (
        request.method === 'POST' &&
        request.url === `/app/installations/${String(INSTALLATION_ID)}/access_tokens`
      ) {
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            token: `ghs_${randomBytes(8).toString('hex')}`,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { issues: 'write' },
            repository_selection: 'all',
          }),
        )
        return
      }

      if (
        request.method === 'POST' &&
        request.url === '/repos/liberion-labs/coord-platform/issues/42/comments'
      ) {
        const parsedBody = rawBody === '' ? {} : (JSON.parse(rawBody) as Record<string, unknown>)
        const record: CommentRequest = {
          authorization: request.headers.authorization,
          path: request.url,
          body: parsedBody,
        }
        commentRequests.push(record)
        const outcome = onComment?.(record) ?? {
          status: 201,
          body: {
            id: 991,
            html_url: 'https://github.com/liberion-labs/coord-platform/pull/42#issuecomment-991',
          },
        }
        response.writeHead(outcome.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(outcome.body))
        return
      }

      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'Not Found' }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    commentRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      }),
  }
}

function newApp(baseUrl: string): ReturnType<typeof createGitHubApp> {
  return createGitHubApp({
    appId: 1,
    privateKey: generatePrivateKey(),
    webhookSecret: randomBytes(16).toString('hex'),
    baseUrl,
  })
}

const TARGET: PullRequestCommentTarget = {
  installationId: INSTALLATION_ID,
  owner: 'liberion-labs',
  repo: 'coord-platform',
  pullNumber: 42,
}

let fake: FakeGitHub | undefined

afterEach(async () => {
  await fake?.close()
  fake = undefined
})

describe('publishPullRequestComment contra un servidor HTTP real', () => {
  it('canjea el token de instalacion y publica el cuerpo tal cual, autenticado', async () => {
    fake = await startFakeGitHub()
    const app = newApp(fake.baseUrl)

    const result = await publishPullRequestComment(app, TARGET, '# Informe\n\nAPTO')

    expect(result).toEqual({
      id: 991,
      url: 'https://github.com/liberion-labs/coord-platform/pull/42#issuecomment-991',
    })
    expect(fake.commentRequests).toHaveLength(1)
    const sent = fake.commentRequests[0]
    expect(sent).toBeDefined()
    expect(sent?.body).toEqual({ body: '# Informe\n\nAPTO' })
    // El token de instalacion, no el JWT de la App: la peticion de comentario
    // va autenticada como la instalacion, que es la que tiene permiso de
    // escribir en el repo del PR.
    expect(sent?.authorization).toMatch(/^(token|Bearer) ghs_/)
  })

  it('propaga el error si GitHub rechaza el comentario (p.ej. sin permiso)', async () => {
    fake = await startFakeGitHub(() => ({
      status: 403,
      body: { message: 'Resource not accessible' },
    }))
    const app = newApp(fake.baseUrl)

    await expect(publishPullRequestComment(app, TARGET, 'cuerpo')).rejects.toThrow()
  })

  it('rechaza un cuerpo vacio antes de llamar a GitHub', async () => {
    fake = await startFakeGitHub()
    const app = newApp(fake.baseUrl)

    await expect(publishPullRequestComment(app, TARGET, '   ')).rejects.toThrow(ValidationError)
    expect(fake.commentRequests).toHaveLength(0)
  })

  it('rechaza un numero de PR invalido antes de llamar a GitHub', async () => {
    fake = await startFakeGitHub()
    const app = newApp(fake.baseUrl)

    await expect(
      publishPullRequestComment(app, { ...TARGET, pullNumber: 0 }, 'cuerpo'),
    ).rejects.toThrow(ValidationError)
    expect(fake.commentRequests).toHaveLength(0)
  })
})
