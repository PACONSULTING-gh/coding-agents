import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createGitHubApp, type PullRequestCommentTarget } from '@coord/github'
import { afterEach, describe, expect, it } from 'vitest'

import { buildConformanceReport } from '../src/verification/report.js'
import { renderConformanceReportMarkdown } from '../src/verification/report-render.js'
import { publishConformanceReport } from '../src/verification/report-publisher.js'
import { makeVerdicts, makeVerificationResult } from './support/report-fixtures.js'

/**
 * T05 — que `publishConformanceReport` de verdad reutiliza `@coord/github` y
 * publica EL MISMO texto que produce `renderConformanceReportMarkdown`, no una
 * version aparte que pudiera divergir.
 *
 * Mismo patron que `packages/github/test/pull-request-comments.test.ts`:
 * servidor HTTP local que habla el protocolo de la App, clave RSA generada al
 * vuelo, NUNCA la API de GitHub de verdad. Ver la cabecera de
 * `../src/verification/report-publisher.ts`: esto demuestra que la peticion
 * sale bien formada, no que se haya publicado nunca un comentario real.
 */

const INSTALLATION_ID = 555
const TARGET: PullRequestCommentTarget = {
  installationId: INSTALLATION_ID,
  owner: 'liberion-labs',
  repo: 'coord-platform',
  pullNumber: 25,
}

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
  readonly bodies: string[]
  close: () => Promise<void>
}

async function startFakeGitHub(): Promise<FakeGitHub> {
  const bodies: string[] = []

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
        request.url ===
          `/repos/${TARGET.owner}/${TARGET.repo}/issues/${String(TARGET.pullNumber)}/comments`
      ) {
        const parsed = JSON.parse(rawBody) as { body: string }
        bodies.push(parsed.body)
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            id: 123,
            html_url: `https://github.com/${TARGET.owner}/${TARGET.repo}/pull/${String(TARGET.pullNumber)}#issuecomment-123`,
          }),
        )
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
    bodies,
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

describe('publishConformanceReport', () => {
  it('publica exactamente el texto de renderConformanceReportMarkdown', async () => {
    fake = await startFakeGitHub()
    const app = createGitHubApp({
      appId: 1,
      privateKey: generatePrivateKey(),
      webhookSecret: randomBytes(16).toString('hex'),
      baseUrl: fake.baseUrl,
    })

    const report = buildConformanceReport(
      makeVerificationResult(makeVerdicts(5, { failCount: 1 }), { taskRef: 'issue-25' }),
    )
    const expected = renderConformanceReportMarkdown(report)

    const result = await publishConformanceReport(app, TARGET, report)

    expect(result.rendered.text).toBe(expected.text)
    expect(result.comment).toEqual({
      id: 123,
      url: `https://github.com/${TARGET.owner}/${TARGET.repo}/pull/${String(TARGET.pullNumber)}#issuecomment-123`,
    })
    expect(fake.bodies).toEqual([expected.text])
  })
})
