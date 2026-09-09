import { ConflictError } from '@coord/core'
import { appendAuditEntry, withTenantConnection, type AuditLogRow } from '@coord/db'

import { verifyGeneratedTestsOnDisk, type VerifyOnDiskInput } from './generated-tests-fs.js'
import {
  describeFinding,
  type GeneratedTestFinding,
  type GeneratedTestsVerification,
} from './test-manifest.js'

/**
 * La mitad "y se registra" del segundo criterio de aceptacion de T02.
 *
 * El criterio dice: "cuando el agente implementador intenta modificar ficheros
 * de test, entonces el intento SE BLOQUEA Y SE REGISTRA". Las dos mitades viven
 * en sitios distintos a proposito:
 *
 *   * BLOQUEAR lo hace el CI, que corre `verify-generated-tests-cli.ts` y sale
 *     con codigo 1. Un hook local tambien avisa, pero se salta con
 *     `--no-verify`: no es la barrera y no se presenta como tal.
 *   * REGISTRAR lo hace esto, en `audit_log` — la tabla append-only que
 *     CLAUDE.md 4 manda construir desde el principio. No se inventa un registro
 *     nuevo: el que hay es el bueno, y ademas ya tiene API de lectura
 *     (`readAuditLog`), RLS forzada y paginacion.
 *
 * Este modulo NECESITA base de datos, asi que NO lo importa el CLI del CI: el
 * job de CI corre sobre un checkout sin Postgres. Lo llama el lado del hub, que
 * si tiene contexto de tenant. Esa separacion es el motivo de que la deteccion
 * (`test-manifest.ts`) sea pura y no sepa nada de esto.
 *
 * ===========================================================================
 * HOY NINGUN PROCESO DE PRODUCCION LLAMA A ESTO. DILO ASI Y NO DE OTRA FORMA.
 * ===========================================================================
 * `verifyAndRecordGeneratedTests` recorre el camino entero (deteccion -> registro)
 * y su test lo ejercita contra un Postgres real. Pero NADIE lo invoca todavia
 * desde `apps/worker` ni desde el hub, porque no existe la via por la que el
 * resultado del job de CI —que corre sin base de datos— llega al lado que si
 * tiene contexto de tenant. Diseñar esa via es T06 ("flujo de fallo"), no esto.
 *
 * Consecuencia practica, sin adornos: HOY un intento de manipulacion SE BLOQUEA
 * (el job `generated-tests` de CI sale con codigo 1) pero NO QUEDA REGISTRADO en
 * `audit_log`. La mitad "y se registra" del segundo criterio de T02 esta
 * construida y probada, y sin enchufar. Ver docs/estado-epic-05.md.
 */

export const GENERATED_TESTS_TAMPERING_ACTION = 'generated_tests.tampering_detected'
export const GENERATED_TESTS_RESOURCE_TYPE = 'generated_tests'

/**
 * Los tests generados no cuadran con su manifiesto.
 *
 * Es un `ConflictError` (codigo `CONFLICT`) porque es lo mismo que un claim
 * rechazado: el estado del arbol entra en conflicto con lo que se aprobo. Lleva
 * los hallazgos enteros, no un booleano, porque quien lo recibe tiene que poder
 * decir QUE fichero y POR QUE.
 */
export class GeneratedTestsTamperedError extends ConflictError {
  public readonly findings: readonly GeneratedTestFinding[]
  public readonly signatureChecked: boolean

  constructor(verification: GeneratedTestsVerification, options?: { cause?: unknown }) {
    super(
      `Los tests generados no cuadran con su manifiesto (${String(verification.findings.length)} ` +
        `hallazgo(s)):\n${verification.findings.map((finding) => `  - ${describeFinding(finding)}`).join('\n')}`,
      options,
    )
    this.findings = verification.findings
    this.signatureChecked = verification.signatureChecked
  }
}

/** Lanza si hay hallazgos. Es el "se bloquea" para quien llame desde codigo. */
export function assertGeneratedTestsUntampered(verification: GeneratedTestsVerification): void {
  if (!verification.ok) {
    throw new GeneratedTestsTamperedError(verification)
  }
}

export interface RecordTamperingInput {
  readonly verification: GeneratedTestsVerification
  /** Quien detecto: `ci`, `pre-commit`, `worker`... Va al registro tal cual. */
  readonly source: string
  /** Referencia del arbol comprobado: sha del commit, numero de PR, rama. */
  readonly reference?: string | undefined
}

/**
 * Escribe el intento en `audit_log`. Devuelve `undefined` cuando no habia nada
 * que registrar.
 *
 * SOLO se registra cuando hay hallazgos. Registrar tambien las comprobaciones
 * limpias llenaria el log de ruido —corre en cada commit y en cada push— y un
 * log que nadie puede leer es un log que no protege. Lo que hay que poder
 * auditar es el INTENTO, que es lo que pide el criterio.
 *
 * Exige contexto de tenant (`runWithTenant`) como todo lo que toca datos.
 */
export async function recordGeneratedTestsTampering(
  input: RecordTamperingInput,
): Promise<AuditLogRow | undefined> {
  if (input.verification.ok) return undefined

  return withTenantConnection(async (tx) =>
    appendAuditEntry(tx, {
      action: GENERATED_TESTS_TAMPERING_ACTION,
      resourceType: GENERATED_TESTS_RESOURCE_TYPE,
      resourceId: input.reference ?? input.source,
      metadata: {
        source: input.source,
        reference: input.reference ?? null,
        // Se guarda para que quien lea el registro sepa CUANTO vale el hallazgo:
        // sin firma comprobada, un manifiesto que cuadra no demuestra nada.
        signatureChecked: input.verification.signatureChecked,
        filesChecked: input.verification.filesChecked,
        findings: input.verification.findings.map((finding) => ({
          kind: finding.kind,
          path: finding.path ?? null,
          taskRef: finding.taskRef ?? null,
          detail: finding.detail,
        })),
      },
    }),
  )
}

export interface VerifyAndRecordInput extends VerifyOnDiskInput {
  /** Quien comprueba: `ci`, `pre-commit`, `worker`... Va al registro tal cual. */
  readonly source: string
  /** Referencia del arbol comprobado: sha del commit, numero de PR, rama. */
  readonly reference?: string | undefined
}

export interface VerifyAndRecordResult {
  readonly verification: GeneratedTestsVerification
  /** La entrada de auditoria, o `undefined` si no habia nada que registrar. */
  readonly auditEntry: AuditLogRow | undefined
}

/**
 * El camino completo del segundo criterio de aceptacion de T02, en una sola
 * llamada: comprobar el arbol contra su manifiesto y REGISTRAR el intento si no
 * cuadra.
 *
 * Existe para que las dos mitades ("se bloquea" y "se registra") no vivan solo
 * como dos funciones que alguien tendria que acordarse de encadenar. NO lanza:
 * devuelve el veredicto y la entrada escrita, y es quien llama —que es quien
 * sabe si esto bloquea un merge o solo avisa— el que decide con
 * `assertGeneratedTestsUntampered`. Un `throw` aqui haria imposible registrar y
 * seguir.
 *
 * Necesita contexto de tenant (`runWithTenant`), como todo lo que toca datos.
 */
export async function verifyAndRecordGeneratedTests(
  input: VerifyAndRecordInput,
): Promise<VerifyAndRecordResult> {
  const verification = await verifyGeneratedTestsOnDisk(input)
  const auditEntry = await recordGeneratedTestsTampering({
    verification,
    source: input.source,
    reference: input.reference,
  })
  return { verification, auditEntry }
}
