import { randomUUID } from 'node:crypto'

import {
  LlmRefusalError,
  runWithTenant,
  type Claim,
  type EscalationNotice,
  type LlmPort,
  type LlmResult,
  type NotificationPort,
} from '@coord/core'
import {
  approveCriteria,
  closeDatabase,
  configureDatabase,
  readCriteria,
  setCriteria,
  withTenantConnection,
} from '@coord/db'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { runVerification } from '../src/verification-run.js'

import { createTempRepo, type TempRepo } from '../../../packages/graph/test/support/git-repo.js'
import { startDatabase, type StartedDatabase } from '../../../packages/db/test/support/database.js'

/**
 * La pasada de verificacion ENTERA, con todo lo que se puede tener de verdad:
 * Postgres de verdad para los criterios y el estado, un repositorio git de
 * verdad para la entrega, y los tests de la entrega ejecutandose de verdad.
 *
 * Lo unico doblado es el MODELO, y no por comodidad: una llamada real cuesta
 * limites de suscripcion y devuelve algo distinto cada vez, asi que un test que
 * dependiera de ella no podria afirmar nada estable. Lo que el modelo contesta
 * de verdad se mide aparte, en el banco de trampas.
 *
 * Esto es lo que cierra T06: hasta ahora ninguna pieza llamaba a la siguiente.
 */

const logger = pino({ level: 'silent' })

class NotificadorDePrueba implements NotificationPort {
  readonly avisos: EscalationNotice[] = []
  async notifyEscalation(notice: EscalationNotice): Promise<void> {
    this.avisos.push(notice)
    return Promise.resolve()
  }
}

let database: StartedDatabase
let tenantId: string
let actorId: string
const REPO_ID = randomUUID()

beforeAll(async () => {
  database = await startDatabase()
  configureDatabase({ connectionString: database.runtimeUrl })
  tenantId = randomUUID()
  actorId = randomUUID()
  await runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      await tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        'pasada',
        `pasada-${tenantId.slice(0, 8)}`,
      ])
      await tx.query(
        'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
        [actorId, tenantId, `lead-${actorId.slice(0, 8)}@ejemplo.test`, 'Lead'],
      )
    }),
  )
}, 120_000)

afterAll(async () => {
  await closeDatabase()
  await database?.stop()
})

let repo: TempRepo | undefined

async function limpiar(): Promise<void> {
  await repo?.cleanup()
  repo = undefined
}

const TEST_VERDE = ['node', '-e', 'console.log("1 passed")']
const TEST_ROJO = ['node', '-e', 'console.log("1 failed"); process.exit(1)']

const CRITERIO = {
  given: 'un pago rechazado por el banco',
  when: 'el worker lo reintenta',
  then: 'queda registrado el intento con su motivo',
} as const

/** Repo con una entrega que añade la linea que el criterio pide. */
async function repoConEntrega(): Promise<TempRepo> {
  const r = await createTempRepo('pasada')
  await r.write('src/pagos.ts', 'export function reintentar() {}\n')
  await r.commit('base')
  await ejecutar(r, ['checkout', '-q', '-b', 'entrega'])
  await r.write(
    'src/pagos.ts',
    'export function reintentar(pago) {\n  registrarIntento(pago.id, pago.motivo)\n}\n',
  )
  await r.commit('registrar el intento')
  return r
}

async function ejecutar(r: TempRepo, args: readonly string[]): Promise<void> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  await promisify(execFile)('git', ['-C', r.path, ...args])
}

async function tareaConCriteriosAprobados(taskRef: string): Promise<string> {
  return runWithTenant({ tenantId, actorId }, async () => {
    await setCriteria({ taskRef, criteria: [CRITERIO] })
    await approveCriteria({ taskRef })
    const { criteria } = await readCriteria(taskRef)
    return criteria[0]?.id ?? ''
  })
}

/** Un modelo que contesta lo que se le diga, con citas que existen de verdad. */
function modeloQueDice(criterionId: string, verdict: 'PASS' | 'FAIL' | 'SIN_EVIDENCIA'): LlmPort {
  return {
    complete: (): Promise<LlmResult> =>
      Promise.resolve({
        text: '',
        structured: {
          verdicts: [
            {
              criterionId,
              reasoning:
                'El criterio pide que quede registrado el intento con su motivo; el diff ' +
                'introduce la llamada que lo registra, y la salida de tests la ejercita.',
              criterionQuote: CRITERIO.then,
              evidenceSource: 'diff' as const,
              evidenceQuote: 'registrarIntento(pago.id, pago.motivo)',
              verdict,
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

function deps(llm: LlmPort, notifications = new NotificadorDePrueba()) {
  return {
    llm,
    notifications,
    logger,
    activeIssueClaims: vi.fn(() => Promise.resolve([] as Claim[])),
    issueAssignees: vi.fn(() => Promise.resolve(['bruno'])),
  }
}

function peticion(taskRef: string, repoPath: string, testCommand: readonly string[]) {
  return {
    taskRef,
    repoId: REPO_ID,
    repoPath,
    baseRef: 'main',
    headRef: 'entrega',
    testCommand,
    maxAttempts: 1,
  }
}

describe('el lazo entero, de un repo git a un estado nuevo', () => {
  it('todo en verde: la tarea queda hecha y no se molesta a nadie', async () => {
    const taskRef = `9${String(Math.floor(Math.random() * 10_000))}`
    const criterionId = await tareaConCriteriosAprobados(taskRef)
    repo = await repoConEntrega()
    const d = deps(modeloQueDice(criterionId, 'PASS'))

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      runVerification(peticion(taskRef, repo?.path ?? '', TEST_VERDE), d),
    )

    expect(resultado.row.state).toBe('done')
    expect(resultado.notified).toBe(false)
    // Y el veredicto viene del Verifier de verdad, con sus citas comprobadas
    // caracter a caracter contra el criterio y el diff.
    expect(resultado.verification?.verdicts[0]?.verdict).toBe('PASS')
    await limpiar()
  }, 180_000)

  it('un FAIL del Verifier avisa con el INFORME dentro', async () => {
    // El informe es lo que sustituye al diff para el humano. Si no viajara
    // hasta el aviso, el escalado diria "no apto" y obligaria a abrir el PR,
    // que es justo lo que el epic 05 existe para evitar.
    const taskRef = `9${String(Math.floor(Math.random() * 10_000))}`
    const criterionId = await tareaConCriteriosAprobados(taskRef)
    repo = await repoConEntrega()
    const d = deps(modeloQueDice(criterionId, 'FAIL'))

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      runVerification(peticion(taskRef, repo?.path ?? '', TEST_VERDE), d),
    )

    expect(resultado.row.lastOutcome).toBe('verifier_fail')
    expect(resultado.notified).toBe(true)
    expect(d.notifications.avisos[0]?.reportMarkdown).toContain('Veredicto global: NO APTO')
    await limpiar()
  }, 180_000)

  it('con los tests en ROJO ni se llama al Verifier', async () => {
    // Gastar una llamada cara para que diga lo que el gate ya ha dicho es
    // tirar dinero, y encima el Verifier veria una suite roja sin contexto.
    const taskRef = `9${String(Math.floor(Math.random() * 10_000))}`
    const criterionId = await tareaConCriteriosAprobados(taskRef)
    repo = await repoConEntrega()
    const llm = modeloQueDice(criterionId, 'PASS')
    const espia = vi.spyOn(llm, 'complete')
    const d = deps(llm)

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      runVerification(peticion(taskRef, repo?.path ?? '', TEST_ROJO), d),
    )

    expect(espia).not.toHaveBeenCalled()
    expect(resultado.row.lastOutcome).toBe('gate_failed')
    expect(resultado.row.attempts).toBe(1)
    await limpiar()
  }, 180_000)

  it('una negativa del modelo NO le gasta un intento al agente', async () => {
    // Es el issue #27 convertido en comportamiento: se ha visto que el
    // rechazo no es determinista, asi que esto no es un caso hipotetico.
    const taskRef = `9${String(Math.floor(Math.random() * 10_000))}`
    await tareaConCriteriosAprobados(taskRef)
    repo = await repoConEntrega()
    const d = deps({
      complete: () => Promise.reject(new LlmRefusalError({ category: 'reasoning_extraction' })),
    })

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      runVerification(peticion(taskRef, repo?.path ?? '', TEST_VERDE), d),
    )

    expect(resultado.row.lastOutcome).toBe('verifier_unavailable')
    expect(resultado.row.attempts).toBe(0)
    expect(resultado.row.state).toBe('human')
    expect(d.notifications.avisos[0]?.detail).toContain('reasoning_extraction')
    await limpiar()
  }, 180_000)

  it('una entrega vacia es fallo del GATE, no del Verifier', async () => {
    // Es trabajo mal hecho del agente, asi que vuelve a el y le gasta un
    // intento. Tratarlo como `verifier_unavailable` lo escalaria a un humano
    // y le regalaria el intento a quien no entrego nada.
    const taskRef = `9${String(Math.floor(Math.random() * 10_000))}`
    const criterionId = await tareaConCriteriosAprobados(taskRef)
    repo = await createTempRepo('pasada-vacia')
    await repo.write('a.txt', 'igual\n')
    await repo.commit('unico')
    const d = deps(modeloQueDice(criterionId, 'PASS'))

    const resultado = await runWithTenant({ tenantId, actorId }, () =>
      runVerification({ ...peticion(taskRef, repo?.path ?? '', TEST_VERDE), headRef: 'main' }, d),
    )

    expect(resultado.row.lastOutcome).toBe('gate_failed')
    expect(resultado.row.attempts).toBe(1)
    await limpiar()
  }, 180_000)
})

describe('una averia NUESTRA no le cuesta un intento al agente', () => {
  it('si leer la entrega revienta por algo que no es trabajo mal hecho, se propaga', async () => {
    // `ValidationError` al leer la entrega significa que el agente entrego
    // mal —nada, o demasiado— y eso es `gate_failed`, que le gasta un intento.
    // Cualquier OTRO fallo —git no esta instalado, la ruta no existe, el
    // disco esta lleno— es una averia de la plataforma. Convertirla en
    // `gate_failed` le cobraria al agente un intento por algo que no hizo, y
    // dos averias seguidas escalarian su tarea a un humano con un
    // diagnostico falso.
    const taskRef = `9${String(Math.floor(Math.random() * 10_000))}`
    const criterionId = await tareaConCriteriosAprobados(taskRef)
    repo = await repoConEntrega()
    const d = {
      ...deps(modeloQueDice(criterionId, 'PASS')),
      readDelivery: () => Promise.reject(new Error('ENOENT: git no esta instalado')),
    }

    await expect(
      runWithTenant({ tenantId, actorId }, () =>
        runVerification(peticion(taskRef, repo?.path ?? '', TEST_VERDE), d),
      ),
    ).rejects.toThrow(/ENOENT/)

    // Y NO se ha escrito ningun estado: la tarea sigue donde estaba.
    expect(d.notifications.avisos).toEqual([])
    await limpiar()
  }, 180_000)
})

describe('sin criterios aprobados no se verifica', () => {
  it('se lanza en vez de producir un informe sobre nada', async () => {
    // Un informe sin criterios se leeria como una aprobacion, y sirve para
    // aprobar un merge. No es un desenlace del flujo: es una precondicion.
    const taskRef = `9${String(Math.floor(Math.random() * 10_000))}`
    await runWithTenant({ tenantId, actorId }, () => setCriteria({ taskRef, criteria: [CRITERIO] }))
    repo = await repoConEntrega()
    const d = deps(modeloQueDice('x', 'PASS'))

    await expect(
      runWithTenant({ tenantId, actorId }, () =>
        runVerification(peticion(taskRef, repo?.path ?? '', TEST_VERDE), d),
      ),
    ).rejects.toThrow(/no estan aprobados|aprobad/i)
    await limpiar()
  }, 180_000)
})
