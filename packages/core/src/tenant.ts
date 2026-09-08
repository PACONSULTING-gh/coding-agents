import { AsyncLocalStorage } from 'node:async_hooks'

import { MissingTenantContextError } from './errors.js'
import type { TenantId } from './ids.js'

/**
 * Contexto de tenant que viaja implicitamente a traves de una cadena de
 * llamadas asincronas (requests HTTP, jobs de cola, etc.) usando
 * AsyncLocalStorage de la stdlib de Node. Ningun acceso a datos debe
 * ejecutarse sin que este contexto este activo (ver CLAUDE.md 2.6).
 */
export interface TenantContext {
  tenantId: TenantId
  actorId?: string
  requestId?: string
}

const storage = new AsyncLocalStorage<TenantContext>()

/**
 * Ejecuta `fn` con `ctx` como contexto de tenant activo durante toda la
 * cadena asincrona que cuelga de `fn`, incluyendo despues de cualquier
 * `await`. El contexto NUNCA se filtra entre ejecuciones concurrentes:
 * cada llamada a `runWithTenant` tiene su propio contexto aislado.
 */
export function runWithTenant<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn)
}

/**
 * Devuelve el contexto de tenant activo, o `undefined` si no hay ninguno
 * (por ejemplo, si se llama fuera de `runWithTenant`).
 */
export function currentTenant(): TenantContext | undefined {
  return storage.getStore()
}

/**
 * Igual que `currentTenant`, pero lanza si no hay contexto activo. Usar en
 * cualquier frontera que necesite garantizar aislamiento de tenant (capa de
 * acceso a datos, handlers de jobs, etc.).
 */
export function requireTenant(): TenantContext {
  const ctx = storage.getStore()
  if (!ctx) {
    throw new MissingTenantContextError()
  }
  return ctx
}
