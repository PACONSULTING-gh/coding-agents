import path from 'node:path'

import { z } from 'zod'

/**
 * Identidad de un repositorio tal como lo nombra GitHub (`owner/repo`) y su
 * checkout local, en un solo sitio: lo necesitan tanto `apps/worker` (T02,
 * para clonar/leer antes de ingerir) como `packages/graph/src/mcp/` (T05,
 * `who_last_touched` necesita `git log` sobre un checkout real). Vivia
 * duplicado en `apps/worker/src/graph-ingestion.ts`; una comprobacion de
 * seguridad como la de `resolveCheckoutPath` NO se duplica (peldano 2 de la
 * escalera, CLAUDE.md 2.4): si diverge, diverge la proteccion contra
 * path traversal.
 */

/** `owner/repo`, tal cual lo manda GitHub. Nunca con `..` ni fuera de forma. */
export const REPO_FULL_NAME_PATTERN = /^[\w.-]+\/[\w.-]+$/

export const repositorySchema = z
  .string()
  .trim()
  .regex(
    REPO_FULL_NAME_PATTERN,
    'El repositorio se identifica como "owner/repo", tal cual lo da GitHub.',
  )

/**
 * Resuelve el checkout local y comprueba que NO se sale de la raiz. El nombre
 * del repositorio lo elige quien instala la GitHub App (o quien llama a una
 * herramienta MCP), no nosotros: sin esta comprobacion, un nombre con `..`
 * leeria directorios de la maquina. Es validacion en frontera de confianza, de
 * las que no se recortan nunca (CLAUDE.md 2.4).
 */
export function resolveCheckoutPath(checkoutRoot: string, repository: string): string {
  const root = path.resolve(checkoutRoot)
  const candidate = path.resolve(root, repository)
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(`El checkout de ${repository} caeria fuera de ${root}.`)
  }
  return candidate
}
