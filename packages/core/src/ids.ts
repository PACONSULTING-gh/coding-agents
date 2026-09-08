import { z } from 'zod'

/**
 * Alias de tipos para identificadores del dominio. Todos son UUID en
 * formato string; el alias existe para que las firmas de funcion documenten
 * la intencion sin forzar un wrapper en tiempo de ejecucion.
 */
export type TenantId = string
export type UserId = string
export type TeamId = string
export type SkillId = string
export type RoleId = string

/** Validador zod reutilizable para cualquier identificador UUID del dominio. */
export const uuidSchema = z.string().uuid()
