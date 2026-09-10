import { uuidSchema } from '@coord/core'
import { z } from 'zod'

/**
 * Esquemas zod de las filas del esquema SQL, y los tipos TypeScript derivados
 * de ellos con `z.infer`. Una sola definicion por tabla: el validador y el tipo
 * no pueden divergir porque el tipo SE CALCULA del validador.
 *
 * Estos esquemas son la frontera de confianza entre la base de datos y el
 * dominio: todo lo que sale de un `SELECT` se parsea aqui antes de circular.
 */

/** Columnas presentes en toda tabla de datos. `tenants` usa su `id` como tenant. */
const tenantScoped = {
  id: uuidSchema,
  tenantId: uuidSchema,
}

export const tenantRowSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  /**
   * NULL hoy y siempre: significa "este tenant vive en el esquema compartido".
   * Existe para no tener que reescribir la capa de acceso el dia que un cliente
   * exija base de datos propia (CLAUDE.md 4).
   */
  databaseUrl: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type TenantRow = z.infer<typeof tenantRowSchema>

export const userStatusSchema = z.enum(['invited', 'active', 'disabled'])
export type UserStatus = z.infer<typeof userStatusSchema>

export const userRowSchema = z.object({
  ...tenantScoped,
  email: z.email().toLowerCase(),
  displayName: z.string().min(1),
  githubLogin: z.string().nullable(),
  status: userStatusSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type UserRow = z.infer<typeof userRowSchema>

export const teamRowSchema = z.object({
  ...tenantScoped,
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  description: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type TeamRow = z.infer<typeof teamRowSchema>

export const teamMemberRowSchema = z.object({
  ...tenantScoped,
  teamId: uuidSchema,
  userId: uuidSchema,
  joinedAt: z.date(),
})
export type TeamMemberRow = z.infer<typeof teamMemberRowSchema>

export const skillRowSchema = z.object({
  ...tenantScoped,
  name: z.string().min(1),
  category: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type SkillRow = z.infer<typeof skillRowSchema>

export const userSkillRowSchema = z.object({
  ...tenantScoped,
  userId: uuidSchema,
  skillId: uuidSchema,
  level: z.number().int().min(1).max(5),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type UserSkillRow = z.infer<typeof userSkillRowSchema>

/**
 * Claves de los cuatro roles que la migracion 0005 siembra en cada tenant. Un
 * tenant puede crear roles propios, asi que esto NO es el conjunto cerrado de
 * roles posibles: es el conjunto de los que siempre existen.
 */
export const BASE_ROLE_KEYS = ['owner', 'maintainer', 'contributor', 'viewer'] as const
export type BaseRoleKey = (typeof BASE_ROLE_KEYS)[number]

export const roleRowSchema = z.object({
  ...tenantScoped,
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1),
  description: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type RoleRow = z.infer<typeof roleRowSchema>

/** Un permiso es una fila `recurso:accion`. Nunca una columna booleana. */
export const permissionRowSchema = z.object({
  ...tenantScoped,
  resource: z.string().regex(/^[a-z][a-z0-9_]*$/),
  action: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /** Columna generada en SQL: `resource || ':' || action`. */
  key: z.string().regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/),
  createdAt: z.date(),
})
export type PermissionRow = z.infer<typeof permissionRowSchema>

export const rolePermissionRowSchema = z.object({
  ...tenantScoped,
  roleId: uuidSchema,
  permissionId: uuidSchema,
  createdAt: z.date(),
})
export type RolePermissionRow = z.infer<typeof rolePermissionRowSchema>

export const userRoleRowSchema = z.object({
  ...tenantScoped,
  userId: uuidSchema,
  roleId: uuidSchema,
  grantedBy: uuidSchema.nullable(),
  grantedAt: z.date(),
})
export type UserRoleRow = z.infer<typeof userRoleRowSchema>

/** Quien origina un evento auditado. `system` cubre lo que no tiene humano detras. */
export const actorTypeSchema = z.enum(['user', 'agent', 'system'])
export type ActorType = z.infer<typeof actorTypeSchema>

export const auditLogRowSchema = z.object({
  ...tenantScoped,
  occurredAt: z.date(),
  actorId: uuidSchema.nullable(),
  actorType: actorTypeSchema,
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  requestId: z.string().nullable(),
})
export type AuditLogRow = z.infer<typeof auditLogRowSchema>

/** Cuenta de GitHub sobre la que se instala la App. */
export const githubAccountTypeSchema = z.enum(['Organization', 'User'])
export type GithubAccountType = z.infer<typeof githubAccountTypeSchema>

/** `all` = la App ve todos los repos de la cuenta; `selected` = solo los elegidos. */
export const repositorySelectionSchema = z.enum(['all', 'selected'])
export type RepositorySelection = z.infer<typeof repositorySelectionSchema>

export const githubInstallationRowSchema = z.object({
  ...tenantScoped,
  /**
   * `bigint` en SQL, que el driver `pg` devuelve como string para no perder
   * precision. Se convierte aqui: los ids de instalacion reales caben de sobra
   * en un entero seguro de JavaScript, y `.int()` lo comprueba en vez de
   * suponerlo.
   */
  installationId: z.coerce.number().int().positive(),
  accountLogin: z.string().min(1),
  accountType: githubAccountTypeSchema,
  repositorySelection: repositorySelectionSchema,
  suspendedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type GithubInstallationRow = z.infer<typeof githubInstallationRowSchema>

export const webhookDeliveryRowSchema = z.object({
  ...tenantScoped,
  deliveryId: z.string().min(1),
  event: z.string().min(1),
  receivedAt: z.date(),
})
export type WebhookDeliveryRow = z.infer<typeof webhookDeliveryRowSchema>

/** Nombres de las tablas de dominio, en el orden en que se crean. */
export const DOMAIN_TABLES = [
  'tenants',
  'users',
  'teams',
  'team_members',
  'skills',
  'user_skills',
  'roles',
  'permissions',
  'role_permissions',
  'user_roles',
  'audit_log',
  'github_installations',
  'webhook_deliveries',
  'graph_nodes',
  'graph_edges',
  'graph_files',
  'graph_ingestions',
  'claims',
  'acceptance_criteria',
  'acceptance_criteria_approvals',
  'verification_flow',
  'routing_suggestions',
] as const
export type DomainTable = (typeof DOMAIN_TABLES)[number]
