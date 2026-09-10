import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ValidationError } from '@coord/core'
import { afterEach, describe, expect, it } from 'vitest'

import { createGitHubApp } from '../src/app.js'
import { readIssueAssignees, type IssueAssigneesTarget } from '../src/issue-assignees.js'

/**
 * Mismo patron que `pull-request-comments.test.ts`: servidor HTTP real en
 * localhost, la App apuntada a el con `baseUrl`, clave RSA al vuelo. NUNCA
 * contra la API de GitHub de verdad — no hay una App registrada en esta
 * maquina.
 *
 * El doble responde DOS peticiones en orden, que es lo que hace
 * `getInstallationOctokit` por dentro: canjea el JWT de la App por un token de
 * instalacion y con ESE token llama al endpoint del issue.
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

interface FakeGitHub {
  baseUrl: string
  readonly issueRequests: string[]
  close: () => Promise<void>
}

async function startFakeGitHub(issue: { status: number; body: unknown }): Promise<FakeGitHub> {
  const issueRequests: string[] = []

  const server: Server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (
        request.method === 'POST' &&
        request.url === `/app/installations/${String(INSTALLATION_ID)}/access_tokens`
      ) {
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            token: `ghs_${randomBytes(8).toString('hex')}`,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { issues: 'read' },
            repository_selection: 'all',
          }),
        )
        return
      }

      if (
        request.method === 'GET' &&
        request.url === '/repos/liberion-labs/coord-platform/issues/42'
      ) {
        issueRequests.push(request.url)
        response.writeHead(issue.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(issue.body))
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
    issueRequests,
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

const TARGET: IssueAssigneesTarget = {
  installationId: INSTALLATION_ID,
  owner: 'liberion-labs',
  repo: 'coord-platform',
  issueNumber: 42,
}

let fake: FakeGitHub | undefined

afterEach(async () => {
  await fake?.close()
  fake = undefined
})

describe('lo que devuelve', () => {
  it('los logins, en el orden de GitHub y sin recortar', async () => {
    // Sin recortar a proposito: quien decide a quien se avisa necesita ver que
    // hay tres para poder decirlo, en vez de elegir uno en silencio.
    fake = await startFakeGitHub({
      status: 200,
      body: { assignees: [{ login: 'ana' }, { login: 'bruno' }, { login: 'carla' }] },
    })

    expect(await readIssueAssignees(newApp(fake.baseUrl), TARGET)).toEqual([
      'ana',
      'bruno',
      'carla',
    ])
  })

  it('un issue sin asignar devuelve la lista vacia', async () => {
    fake = await startFakeGitHub({ status: 200, body: { assignees: [] } })
    expect(await readIssueAssignees(newApp(fake.baseUrl), TARGET)).toEqual([])
  })

  it('si GitHub no manda `assignees`, se trata como vacio y no revienta', async () => {
    fake = await startFakeGitHub({ status: 200, body: { number: 42 } })
    expect(await readIssueAssignees(newApp(fake.baseUrl), TARGET)).toEqual([])
  })

  it('un login en blanco se descarta: no se puede mencionar a nadie con el', async () => {
    fake = await startFakeGitHub({
      status: 200,
      body: { assignees: [{ login: '  ' }, { login: 'ana' }] },
    })
    expect(await readIssueAssignees(newApp(fake.baseUrl), TARGET)).toEqual(['ana'])
  })

  it('se lee la API, no un payload: la peticion sale de verdad', async () => {
    fake = await startFakeGitHub({ status: 200, body: { assignees: [{ login: 'ana' }] } })
    await readIssueAssignees(newApp(fake.baseUrl), TARGET)

    expect(fake.issueRequests).toEqual(['/repos/liberion-labs/coord-platform/issues/42'])
  })
})

describe('los errores NO se convierten en "no hay nadie"', () => {
  it('un 404 se propaga en vez de devolver lista vacia', async () => {
    // Devolver `[]` diria "nadie es responsable", y lo cierto es "no se ha
    // podido preguntar". Son afirmaciones muy distintas, y la primera acabaria
    // en un aviso que afirma algo falso.
    fake = await startFakeGitHub({ status: 404, body: { message: 'Not Found' } })
    await expect(readIssueAssignees(newApp(fake.baseUrl), TARGET)).rejects.toThrow()
  })

  it('un 403 tambien', async () => {
    fake = await startFakeGitHub({ status: 403, body: { message: 'Forbidden' } })
    await expect(readIssueAssignees(newApp(fake.baseUrl), TARGET)).rejects.toThrow()
  })
})

describe('la frontera de entrada', () => {
  it.each([
    ['owner vacio', { ...TARGET, owner: '  ' }],
    ['repo vacio', { ...TARGET, repo: '' }],
    ['issue 0', { ...TARGET, issueNumber: 0 }],
    ['issue negativo', { ...TARGET, issueNumber: -1 }],
    ['issue no entero', { ...TARGET, issueNumber: 1.5 }],
    ['installationId 0', { ...TARGET, installationId: 0 }],
  ])('%s se rechaza antes de tocar la red', async (_caso, target) => {
    fake = await startFakeGitHub({ status: 200, body: { assignees: [] } })
    await expect(readIssueAssignees(newApp(fake.baseUrl), target)).rejects.toThrow(ValidationError)
    expect(fake.issueRequests).toEqual([])
  })
})
