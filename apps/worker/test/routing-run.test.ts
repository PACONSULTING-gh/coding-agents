import { randomUUID } from 'node:crypto'

import { runWithTenant, type LlmPort, type LlmResult } from '@coord/core'
import type { RoutingCandidate } from '@coord/agents'
import {
  closeDatabase,
  configureDatabase,
  readRoutingOutcomes,
  withTenantConnection,
} from '@coord/db'
import type { GithubWebhookJob } from '@coord/github'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { renderShortlistComment, runRouting } from '../src/routing-run.js'

import { startDatabase, type StartedDatabase } from '../../../packages/db/test/support/database.js'

/**
 * El disparador del router, con Postgres de verdad (epic 03 / T03).
 *
 * Lo que se fija aqui es el ORDEN —publicar antes de registrar— porque decide
 * que significa la metrica de acierto de T04, y el caso que ahorra dinero: sin
 * candidatos no se llama al modelo.
 */

const logger = pino({ level: 'silent' })
let database: StartedDatabase
let tenantId: string

beforeAll(async () => {
  database = await startDatabase()
  configureDatabase({ connectionString: database.runtimeUrl })
  tenantId = randomUUID()
  await runWithTenant({ tenantId }, () =>
    withTenantConnection((tx) =>
      tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        'router',
        `router-${tenantId.slice(0, 8)}`,
      ]),
    ),
  )
}, 120_000)

afterAll(async () => {
  await closeDatabase()
  await database?.stop()
})

let siguienteIssue = 1000
function issueAbierto(overrides: Record<string, unknown> = {}): GithubWebhookJob {
  siguienteIssue += 1
  return {
    deliveryId: randomUUID(),
    event: 'issues',
    action: 'opened',
    installationId: 1,
    payload: {
      issue: {
        number: siguienteIssue,
        title: 'Arreglar el reintento de pagos',
        body: 'Cuando el banco rechaza, no se registra el intento.',
        assignees: [],
        ...overrides,
      },
      repository: { full_name: 'liberion-labs/crm' },
    },
  } as unknown as GithubWebhookJob
}

const CANDIDATOS: RoutingCandidate[] = [
  {
    id: 'ana',
    label: 'Ana',
    ownership: [{ path: 'src/pagos.ts', lines: 320, commits: 8 }],
    workload: 3,
    workloadIsComplete: true,
  },
  {
    id: 'bruno',
    label: 'Bruno',
    ownership: [{ path: 'src/pagos.ts', lines: 12, commits: 1 }],
    workload: 1,
    workloadIsComplete: true,
  },
]

/** Un modelo que contesta "sin match claro", que es una respuesta legitima. */
function modeloQueNoVeMatch(): LlmPort {
  return {
    complete: (): Promise<LlmResult> =>
      Promise.resolve({
        text: '',
        structured: {
          outcome: 'no_match',
          noMatchReason:
            'Nadie ha tocado nunca el área de facturación electrónica en la ventana de historial ' +
            'reciente, así que no hay evidencia de autoría sobre la que sugerir a nadie.',
        },
        reasoningSummary: undefined,
        stopReason: 'end_turn' as const,
        model: 'modelo-de-prueba',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
  }
}

function modeloQueSugiere(): LlmPort {
  return {
    complete: (): Promise<LlmResult> =>
      Promise.resolve({
        text: '',
        structured: {
          outcome: 'shortlist',
          candidates: [
            {
              candidateId: 'ana',
              reasoning:
                'Ana ha escrito 320 de las líneas de src/pagos.ts en la ventana reciente, que es ' +
                'justo el fichero donde vive el reintento que hay que arreglar.',
              evidenceFiles: ['src/pagos.ts'],
              leadingSignal: 'ownership',
              rank: 1,
            },
            {
              candidateId: 'bruno',
              reasoning:
                'Bruno ha tocado el fichero de pasada y va menos cargado, pero su evidencia de ' +
                'autoria es mucho mas floja que la de Ana.',
              evidenceFiles: ['src/pagos.ts'],
              leadingSignal: 'workload',
              rank: 2,
            },
          ],
        },
        reasoningSummary: undefined,
        stopReason: 'end_turn' as const,
        model: 'modelo-de-prueba',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
  }
}

function deps(overrides: Partial<Parameters<typeof runRouting>[1]> = {}) {
  const publicados: { issueNumber: number; body: string }[] = []
  return {
    llm: modeloQueSugiere(),
    filesForIssue: () => Promise.resolve(['src/pagos.ts']),
    candidatesFor: () => Promise.resolve(CANDIDATOS),
    publishComment: (issueNumber: number, body: string) => {
      publicados.push({ issueNumber, body })
      return Promise.resolve()
    },
    logger,
    publicados,
    ...overrides,
  }
}

describe('cuando NO toca sugerir', () => {
  it.each([
    ['ya tiene a alguien asignado', { assignees: [{ login: 'bruno' }] }],
    ['es un pull request', { pull_request: { url: 'x' } }],
  ])('%s: ni se mira el modelo', async (_caso, overrides) => {
    const d = deps()
    const espia = vi.spyOn(d.llm, 'complete')

    const resultado = await runWithTenant({ tenantId }, () =>
      runRouting(issueAbierto(overrides), d),
    )

    expect(resultado.kind).toBe('skipped')
    expect(espia).not.toHaveBeenCalled()
    expect(d.publicados).toEqual([])
  })
})

describe('los otros dos motivos para no sugerir', () => {
  it('un evento que no es `issues` se omite', async () => {
    const d = deps()
    const espia = vi.spyOn(d.llm, 'complete')
    const job = { ...issueAbierto(), event: 'pull_request' } as unknown as GithubWebhookJob

    const resultado = await runWithTenant({ tenantId }, () => runRouting(job, d))

    expect(resultado).toEqual({ kind: 'skipped', reason: 'not_an_issue_event' })
    expect(espia).not.toHaveBeenCalled()
  })

  it('un issue EDITADO no vuelve a disparar el shortlist', async () => {
    // Se publica UNA vez, al abrirse. Comentar en cada edicion convierte la
    // ayuda en ruido: quien edita un issue tres veces mientras lo redacta no
    // quiere tres shortlists.
    const d = deps()
    const job = { ...issueAbierto(), action: 'edited' } as unknown as GithubWebhookJob

    const resultado = await runWithTenant({ tenantId }, () => runRouting(job, d))

    expect(resultado).toEqual({ kind: 'skipped', reason: 'not_opened' })
    expect(d.publicados).toEqual([])
  })
})

describe('sin candidatos no se llama al modelo', () => {
  it('se publica el no_match y se registra, pero sin gastar una llamada', async () => {
    // La unica respuesta posible seria `no_match`. Gastar esfuerzo alto para
    // que el modelo diga lo que ya se sabe es tirar limites de suscripcion.
    const d = deps({ candidatesFor: () => Promise.resolve([]) })
    const espia = vi.spyOn(d.llm, 'complete')

    const resultado = await runWithTenant({ tenantId }, () => runRouting(issueAbierto(), d))

    expect(resultado.kind).toBe('no_match')
    expect(espia).not.toHaveBeenCalled()
    // Pero SI se registra: T04 cuenta los no_match aparte, y NO como fallo.
    expect(d.publicados).toHaveLength(1)
  }, 120_000)
})

describe('el camino normal', () => {
  it('publica el shortlist y lo registra para la metrica', async () => {
    const d = deps()
    const job = issueAbierto()

    const resultado = await runWithTenant({ tenantId }, () => runRouting(job, d))

    expect(resultado).toMatchObject({ kind: 'suggested', first: 'ana', candidates: 2 })
    expect(d.publicados[0]?.body).toContain('ana')
    expect(d.publicados[0]?.body).toContain('ownership')

    const hechos = await runWithTenant({ tenantId }, () => readRoutingOutcomes({}))
    const suyo = hechos.find((h) => h.taskRef === String(d.publicados[0]?.issueNumber))
    expect(suyo?.suggestedFirst).toBe('ana')
  }, 120_000)

  it('si la publicacion falla, NO se registra la sugerencia', async () => {
    // Una sugerencia que nadie vio contando en el denominador bajaria la tasa
    // de acierto para siempre: nadie pudo aceptarla. El denominador solo
    // cuenta aquello sobre lo que un humano pudo decidir.
    const d = deps({
      publishComment: () => Promise.reject(new Error('GitHub devolvio 502')),
    })
    const job = issueAbierto()
    const numero = String((job.payload['issue'] as { number: number }).number)

    await expect(runWithTenant({ tenantId }, () => runRouting(job, d))).rejects.toThrow(/502/)

    const hechos = await runWithTenant({ tenantId }, () => readRoutingOutcomes({}))
    expect(hechos.some((h) => h.taskRef === numero)).toBe(false)
  }, 120_000)
})

describe('un no_match DEL MODELO tambien se registra', () => {
  it('se publica y se cuenta, porque T04 lo cuenta aparte y no como fallo', async () => {
    // Es distinto del no_match por falta de candidatos: aqui el modelo SI
    // miro y dijo que no ve match. Las dos cosas son datos y las dos cuentan.
    const d = deps({ llm: modeloQueNoVeMatch() })
    const job = issueAbierto()
    const numero = String((job.payload['issue'] as { number: number }).number)

    const resultado = await runWithTenant({ tenantId }, () => runRouting(job, d))

    expect(resultado.kind).toBe('no_match')
    expect(d.publicados[0]?.body).toContain('facturación electrónica')

    const hechos = await runWithTenant({ tenantId }, () => readRoutingOutcomes({}))
    const suyo = hechos.find((h) => h.taskRef === numero)
    expect(suyo).toBeDefined()
    // Sin candidato sugerido: no lo hubo.
    expect(suyo?.suggestedFirst).toBeUndefined()
  }, 120_000)
})

describe('el comentario que ve la persona', () => {
  it('dice que es una sugerencia y como se confirma', () => {
    // Un shortlist que no se presenta como sugerencia se lee como una decision
    // tomada, y entonces nadie lo discute.
    const texto = renderShortlistComment({
      kind: 'shortlist',
      entries: [
        {
          rank: 1,
          candidateId: 'ana',
          reasoning: 'Ha escrito la mayor parte del fichero.',
          evidenceFiles: ['src/pagos.ts'],
          leadingSignal: 'ownership',
        },
      ],
    })

    expect(texto).toContain('no una decisión')
    expect(texto).toContain('Se confirma asignando')
  })

  it('cada puesto lleva SU SEÑAL, que es el criterio de aceptacion', () => {
    const texto = renderShortlistComment({
      kind: 'shortlist',
      entries: [
        {
          rank: 1,
          candidateId: 'ana',
          reasoning: 'x',
          evidenceFiles: ['a.ts'],
          leadingSignal: 'both',
        },
      ],
    })
    expect(texto).toContain('`both`')
  })

  it('un no_match NO se presenta como un fallo', () => {
    const texto = renderShortlistComment({ kind: 'no_match', reason: 'Nadie ha tocado eso.' })
    expect(texto).toContain('No es un fallo')
  })

  it('un candidato sin ficheros citados lo dice, en vez de dejar el hueco', () => {
    const texto = renderShortlistComment({
      kind: 'shortlist',
      entries: [
        {
          rank: 1,
          candidateId: 'ana',
          reasoning: 'x',
          evidenceFiles: [],
          leadingSignal: 'workload',
        },
      ],
    })
    expect(texto).toContain('Sin ficheros citados')
  })
})
