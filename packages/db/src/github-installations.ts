import { requireTenant, ValidationError } from '@coord/core'
import { z } from 'zod'

import { getPool } from './pool.js'
import type { Queryable } from './queryable.js'
import { githubInstallationRowSchema, type GithubInstallationRow } from './schema.js'

/**
 * Acceso a `github_installations`, la tabla que dice de que tenant es cada
 * instalacion de la GitHub App.
 *
 * Tiene dos mitades bien distintas y conviene no confundirlas:
 *
 *   - `findInstallationRouting()` corre ANTES de saber el tenant. Es la unica
 *     funcion del repositorio que usa el carve-out de RLS de la migracion 0006
 *     (politica `installation_routing_lookup`). Lee como mucho UNA fila: la de
 *     la instalacion que declara por adelantado.
 *
 *   - El resto son operaciones normales con contexto de tenant: reciben un
 *     `Queryable` que ya viene de `withTenantConnection`, y la RLS las protege
 *     como a cualquier otra tabla.
 */

/** Columnas del SELECT, renombradas a la forma que espera el esquema zod. */
const INSTALLATION_COLUMNS = `
  id,
  tenant_id            AS "tenantId",
  installation_id      AS "installationId",
  account_login        AS "accountLogin",
  account_type         AS "accountType",
  repository_selection AS "repositorySelection",
  suspended_at         AS "suspendedAt",
  created_at           AS "createdAt",
  updated_at           AS "updatedAt"
`

/**
 * Nombre del ajuste que activa la politica `installation_routing_lookup`. Vive
 * aqui y en la migracion 0006, y en ningun otro sitio: si cambia, cambia en los
 * dos a la vez o el lookup deja de devolver filas (falla cerrado, ruidoso).
 */
const ROUTING_LOOKUP_SETTING = 'app.github_installation_lookup'

/**
 * El id de instalacion entra desde el cuerpo de un webhook: frontera de
 * confianza. Se valida aqui, antes de que llegue al servidor.
 */
const installationIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

/** Lo minimo que necesita el listener para enrutar un evento. */
export interface InstallationRouting {
  tenantId: string
  installationId: number
  accountLogin: string
  suspendedAt: Date | null
}

const routingRowSchema = z.object({
  tenantId: z.string().uuid(),
  installationId: z.coerce.number().int().positive(),
  accountLogin: z.string().min(1),
  suspendedAt: z.date().nullable(),
})

/**
 * Resuelve instalacion -> tenant SIN contexto de tenant. Devuelve `undefined`
 * si la instalacion no esta mapeada (caso normal: alguien instalo la App y
 * todavia no la ha vinculado ningun humano; CLAUDE.md 2.1).
 *
 * Abre su propia transaccion, fija el ajuste LOCAL que habilita la politica de
 * enrutado, hace UNA consulta parametrizada y confirma. Al confirmar, Postgres
 * revierte el ajuste solo: el backend vuelve al pool de PgBouncer sin permiso
 * de enrutado y sin tenant (misma disciplina que `withTenantConnection`).
 *
 * No escribe en `audit_log`: es una lectura de enrutado que ocurre en CADA
 * webhook, y convertir el registro de auditoria en un log de trafico lo
 * inutilizaria como registro de auditoria. Lo que si queda registrado —una vez
 * por entrega, ya con tenant— es el evento en si (lo hace apps/worker).
 */
export async function findInstallationRouting(
  installationId: number,
): Promise<InstallationRouting | undefined> {
  const parsed = installationIdSchema.safeParse(installationId)
  if (!parsed.success) {
    throw new ValidationError(
      `installationId invalido: ${JSON.stringify(installationId)}. Debe ser un entero positivo.`,
      { cause: parsed.error },
    )
  }
  const id = parsed.data

  const client = await getPool().connect()
  let discardConnection = false
  try {
    await client.query('BEGIN')
    // `true` = LOCAL a la transaccion. El valor va como parametro, nunca
    // interpolado: `set_config` es una funcion normal y admite parametros.
    await client.query('SELECT set_config($1, $2, true)', [ROUTING_LOOKUP_SETTING, String(id)])

    // Tipado explicito de la fila cruda: `pg` la devuelve como `any` y aqui
    // entra directa a zod, que es quien decide si sirve.
    const result = await client.query<Record<string, unknown>>(
      `SELECT tenant_id     AS "tenantId",
              installation_id AS "installationId",
              account_login AS "accountLogin",
              suspended_at  AS "suspendedAt"
         FROM github_installations
        WHERE installation_id = $1`,
      [id],
    )
    await client.query('COMMIT')

    const [row] = result.rows
    return row === undefined ? undefined : routingRowSchema.parse(row)
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      // No se traga: se reporta con las dos causas y la conexion se descarta,
      // porque tras un ROLLBACK fallido su estado es desconocido.
      discardConnection = true
      console.error(
        '[@coord/db] fallo el ROLLBACK del lookup de enrutado de instalacion. ' +
          'Se propaga el error original y se descarta la conexion.',
        { rollbackError, causaOriginal: error },
      )
    }
    throw error
  } finally {
    client.release(discardConnection)
  }
}

export const installationInputSchema = z.object({
  installationId: installationIdSchema,
  accountLogin: z.string().min(1).max(39),
  accountType: z.enum(['Organization', 'User']),
  repositorySelection: z.enum(['all', 'selected']),
  suspendedAt: z.date().nullish(),
})
export type InstallationInput = z.input<typeof installationInputSchema>

/**
 * Crea o actualiza el mapeo de una instalacion para el TENANT ACTIVO.
 *
 * Es la operacion que ejecuta un humano al vincular una instalacion recien
 * hecha con su cliente (CLAUDE.md 2.1: los agentes proponen, el humano decide).
 * El `ON CONFLICT` cubre la reinstalacion y los cambios de nombre de la cuenta.
 *
 * Ojo con la clave del conflicto: `installation_id` es unico GLOBALMENTE. Si la
 * instalacion ya pertenece a OTRO tenant, el `DO UPDATE` choca con la clausula
 * USING de la politica `tenant_isolation` y Postgres lanza
 * "new row violates row-level security policy". Ese error se propaga tal cual:
 * es exactamente lo que tiene que pasar, y lo comprueba
 * `test/github-installations.test.ts`.
 *
 * La comprobacion de "no devolvio fila" que hay mas abajo es una segunda red,
 * para el caso de que una politica futura convierta ese choque en un silencio.
 */
export async function upsertInstallation(
  db: Queryable,
  input: InstallationInput,
): Promise<GithubInstallationRow> {
  const { tenantId } = requireTenant()
  const parsed = installationInputSchema.parse(input)

  const result = await db.query(
    `INSERT INTO github_installations (
       tenant_id, installation_id, account_login, account_type, repository_selection, suspended_at
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (installation_id) DO UPDATE
        SET account_login        = EXCLUDED.account_login,
            account_type         = EXCLUDED.account_type,
            repository_selection = EXCLUDED.repository_selection,
            suspended_at         = EXCLUDED.suspended_at
     RETURNING ${INSTALLATION_COLUMNS}`,
    [
      tenantId,
      parsed.installationId,
      parsed.accountLogin,
      parsed.accountType,
      parsed.repositorySelection,
      parsed.suspendedAt ?? null,
    ],
  )

  const [row] = result.rows
  if (row === undefined) {
    throw new ValidationError(
      `La instalacion ${String(parsed.installationId)} no se pudo mapear al tenant ${tenantId}: ` +
        'o ya pertenece a otro tenant, o el contexto de tenant no coincide con app.tenant_id.',
    )
  }
  return githubInstallationRowSchema.parse(row)
}

export const installationStateSchema = z.object({
  installationId: installationIdSchema,
  repositorySelection: z.enum(['all', 'selected']).optional(),
  suspendedAt: z.date().nullable().optional(),
})
export type InstallationState = z.input<typeof installationStateSchema>

/**
 * Actualiza el estado de una instalacion YA mapeada, dentro del tenant activo.
 * Devuelve `undefined` si el tenant activo no tiene esa instalacion — el
 * llamante decide si eso es un error o un evento que ignorar.
 */
export async function updateInstallationState(
  db: Queryable,
  state: InstallationState,
): Promise<GithubInstallationRow | undefined> {
  const { tenantId } = requireTenant()
  const parsed = installationStateSchema.parse(state)

  const result = await db.query(
    `UPDATE github_installations
        SET repository_selection = COALESCE($3, repository_selection),
            suspended_at         = CASE WHEN $4::boolean THEN $5 ELSE suspended_at END
      WHERE tenant_id = $1 AND installation_id = $2
      RETURNING ${INSTALLATION_COLUMNS}`,
    [
      tenantId,
      parsed.installationId,
      parsed.repositorySelection ?? null,
      // `suspendedAt` ausente y `suspendedAt: null` significan cosas distintas
      // (no tocar / desuspender), y COALESCE no sabe distinguirlas.
      parsed.suspendedAt !== undefined,
      parsed.suspendedAt ?? null,
    ],
  )

  const [row] = result.rows
  return row === undefined ? undefined : githubInstallationRowSchema.parse(row)
}

/**
 * Borra el mapeo de una instalacion del tenant activo. Devuelve `true` si
 * habia algo que borrar.
 *
 * Se borra en vez de marcar: cuando GitHub manda `installation.deleted`, la
 * instalacion ha dejado de existir y sus eventos no deben enrutarse a nadie.
 * Una reinstalacion recibe un `installation_id` NUEVO, asi que no hay nada que
 * conservar. El rastro de que existio queda en `audit_log`, que es append-only.
 */
export async function deleteInstallation(db: Queryable, installationId: number): Promise<boolean> {
  const { tenantId } = requireTenant()
  const id = installationIdSchema.parse(installationId)

  const result = await db.query(
    `DELETE FROM github_installations
      WHERE tenant_id = $1 AND installation_id = $2
      RETURNING id`,
    [tenantId, id],
  )
  return result.rows.length > 0
}
