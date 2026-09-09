import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runWithTenant } from '@coord/core'
import { closeDatabase, configureDatabase, readAuditLog, withTenantConnection } from '@coord/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  GENERATED_TESTS_TAMPERING_ACTION,
  recordGeneratedTestsTampering,
  verifyAndRecordGeneratedTests,
} from '../src/verification/tamper-audit.js'
import type { GeneratedTestsVerification } from '../src/verification/test-manifest.js'
import { startDatabase, type StartedDatabase } from '../../../packages/db/test/support/database.js'

/**
 * La mitad "y se registra" del segundo criterio de aceptacion de T02.
 *
 * Contra un Postgres DE VERDAD (testcontainers), con los mismos dos roles que
 * el despliegue, porque lo que se comprueba —que el evento queda escrito en la
 * tabla append-only y bajo RLS forzada, y que no se ve desde otro tenant— es
 * comportamiento del motor. Con un doble solo se comprobaria que el doble hace
 * lo que le hemos dicho (CLAUDE.md 5).
 */

let database: StartedDatabase
let tenantId: string
let otroTenantId: string

async function createTenant(name: string): Promise<string> {
  const id = randomUUID()
  await runWithTenant({ tenantId: id }, () =>
    withTenantConnection((tx) =>
      tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        id,
        name,
        `${name}-${id.slice(0, 8)}`,
      ]),
    ),
  )
  return id
}

beforeAll(async () => {
  database = await startDatabase()
  configureDatabase({
    connectionString: database.runtimeUrl,
    applicationName: 'coord-agents-test',
    allowExitOnIdle: true,
  })
  tenantId = await createTenant('liberion')
  otroTenantId = await createTenant('otro-cliente')
}, 180_000)

afterAll(async () => {
  await closeDatabase()
  await database?.stop()
})

const MANIPULADO: GeneratedTestsVerification = {
  ok: false,
  signatureChecked: true,
  filesChecked: 2,
  findings: [
    {
      kind: 'modified',
      path: 'packages/db/test/generated/criterio-1.test.ts',
      taskRef: '22',
      detail: 'El contenido no cuadra con el manifiesto.',
    },
    {
      kind: 'missing',
      path: 'packages/db/test/generated/criterio-2.test.ts',
      taskRef: '22',
      detail: 'El manifiesto lo declara y no esta en disco.',
    },
  ],
}

const LIMPIO: GeneratedTestsVerification = {
  ok: true,
  signatureChecked: true,
  filesChecked: 2,
  findings: [],
}

describe('registro del intento en audit_log', () => {
  it('escribe el intento con sus hallazgos y se lee por su accion', async () => {
    const fila = await runWithTenant({ tenantId }, () =>
      recordGeneratedTestsTampering({
        verification: MANIPULADO,
        source: 'ci',
        reference: 'deadbeef',
      }),
    )
    expect(fila?.action).toBe(GENERATED_TESTS_TAMPERING_ACTION)
    expect(fila?.tenantId).toBe(tenantId)

    const page = await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) =>
        readAuditLog(tx, { actions: [GENERATED_TESTS_TAMPERING_ACTION] }),
      ),
    )
    const entrada = page.entries.find((row) => row.id === fila?.id)
    expect(entrada, 'no se registro el intento').toBeDefined()
    expect(entrada?.resourceType).toBe('generated_tests')
    expect(entrada?.resourceId).toBe('deadbeef')
    expect(entrada?.metadata['source']).toBe('ci')
    expect(entrada?.metadata['signatureChecked']).toBe(true)
    // Los hallazgos viajan enteros: quien lea el registro tiene que poder decir
    // QUE fichero y POR QUE, no solo que "hubo un problema".
    expect(entrada?.metadata['findings']).toEqual([
      {
        kind: 'modified',
        path: 'packages/db/test/generated/criterio-1.test.ts',
        taskRef: '22',
        detail: 'El contenido no cuadra con el manifiesto.',
      },
      {
        kind: 'missing',
        path: 'packages/db/test/generated/criterio-2.test.ts',
        taskRef: '22',
        detail: 'El manifiesto lo declara y no esta en disco.',
      },
    ])
  })

  it('una comprobacion limpia NO escribe nada: el log no se llena de ruido', async () => {
    const antes = await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) =>
        readAuditLog(tx, { actions: [GENERATED_TESTS_TAMPERING_ACTION] }),
      ),
    )
    const fila = await runWithTenant({ tenantId }, () =>
      recordGeneratedTestsTampering({ verification: LIMPIO, source: 'pre-commit' }),
    )
    expect(fila).toBeUndefined()

    const despues = await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) =>
        readAuditLog(tx, { actions: [GENERATED_TESTS_TAMPERING_ACTION] }),
      ),
    )
    expect(despues.entries).toHaveLength(antes.entries.length)
  })

  it('el registro de un tenant no se ve desde otro', async () => {
    await runWithTenant({ tenantId }, () =>
      recordGeneratedTestsTampering({ verification: MANIPULADO, source: 'ci' }),
    )
    const ajeno = await runWithTenant({ tenantId: otroTenantId }, () =>
      withTenantConnection((tx) =>
        readAuditLog(tx, { actions: [GENERATED_TESTS_TAMPERING_ACTION] }),
      ),
    )
    expect(ajeno.entries).toHaveLength(0)
  })

  it('sin contexto de tenant no se registra nada', async () => {
    await expect(
      recordGeneratedTestsTampering({ verification: MANIPULADO, source: 'ci' }),
    ).rejects.toThrow()
  })
})

/**
 * DETECCION -> REGISTRO, el camino entero y sin encadenarlo a mano.
 *
 * Los dos tests de arriba prueban el registro con un veredicto FABRICADO. Aqui
 * el veredicto sale de mirar un arbol de ficheros de verdad en disco, para que
 * quede fijado que las dos mitades del criterio ("se bloquea y se registra")
 * componen. Sigue sin haber ningun proceso de produccion que llame a esto: ver
 * la cabecera de `tamper-audit.ts` y docs/estado-epic-05.md.
 */
describe('verifyAndRecordGeneratedTests: deteccion y registro en una sola llamada', () => {
  async function repoConTestGeneradoSinManifiesto(): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'repo-t02-'))
    const directorio = join(repoRoot, 'packages', 'db', 'test', 'generated')
    await mkdir(directorio, { recursive: true })
    await writeFile(join(directorio, 'colado-a-mano.test.ts'), '// no lo escribio el generador\n')
    return repoRoot
  }

  it('un fichero colado en el arbol del generador acaba en audit_log', async () => {
    const repoRoot = await repoConTestGeneradoSinManifiesto()

    const { verification, auditEntry } = await runWithTenant({ tenantId }, () =>
      verifyAndRecordGeneratedTests({ repoRoot, source: 'worker', reference: 'PR-42' }),
    )

    expect(verification.ok).toBe(false)
    expect(verification.findings.map((f) => f.kind)).toEqual(['untracked'])
    expect(auditEntry?.action).toBe(GENERATED_TESTS_TAMPERING_ACTION)
    expect(auditEntry?.resourceId).toBe('PR-42')
    expect(auditEntry?.metadata['source']).toBe('worker')
    expect(auditEntry?.metadata['findings']).toEqual([
      {
        kind: 'untracked',
        path: 'packages/db/test/generated/colado-a-mano.test.ts',
        taskRef: null,
        detail:
          'Hay ficheros bajo test/generated y no existe ' +
          'verification/generated-tests.manifest.json. El arbol es propiedad del generador: ' +
          'nadie mas escribe ahi.',
      },
    ])
  })

  it('un arbol sin nada generado ni escribe ni finge que hubo hallazgo', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'repo-t02-limpio-'))

    const { verification, auditEntry } = await runWithTenant({ tenantId }, () =>
      verifyAndRecordGeneratedTests({ repoRoot, source: 'worker' }),
    )

    expect(verification.ok).toBe(true)
    expect(auditEntry).toBeUndefined()
  })
})
