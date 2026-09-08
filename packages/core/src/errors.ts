/**
 * Error base de dominio. Toda subclase lleva un `code` estable (para que
 * capas superiores -HTTP, jobs- puedan mapearlo sin parsear el mensaje) y
 * propaga `cause` de verdad cuando envuelve un error de origen: nunca se
 * traga la causa (CLAUDE.md 5, "nunca catch silencioso").
 */
export class DomainError extends Error {
  public readonly code: string

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = new.target.name
    this.code = code
  }
}

/** No hay contexto de tenant activo donde uno era obligatorio (ver tenant.ts). */
export class MissingTenantContextError extends DomainError {
  constructor(options?: { cause?: unknown }) {
    super(
      'No hay contexto de tenant activo. Este codigo debe ejecutarse dentro de runWithTenant().',
      'MISSING_TENANT_CONTEXT',
      options,
    )
  }
}

/** El recurso solicitado no existe (o no existe para el tenant activo). */
export class NotFoundError extends DomainError {
  constructor(resource: string, options?: { cause?: unknown }) {
    super(`No encontrado: ${resource}`, 'NOT_FOUND', options)
  }
}

/** La operacion entra en conflicto con el estado actual del recurso. */
export class ConflictError extends DomainError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'CONFLICT', options)
  }
}

/** La entrada no cumple las reglas de validacion de una frontera de confianza. */
export class ValidationError extends DomainError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'VALIDATION', options)
  }
}

/** El actor actual no tiene permiso para realizar la operacion. */
export class UnauthorizedError extends DomainError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'UNAUTHORIZED', options)
  }
}
