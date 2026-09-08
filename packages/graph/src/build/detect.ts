import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { BuildTool } from './types.js'

/**
 * Deteccion de que herramienta de build nativa tiene el repo, mirando sus
 * ficheros de configuracion en la raiz. Ausencia total no es un error: el
 * criterio de T03 es explicito, "la ingesta de build no aporta aristas", no
 * que falle.
 *
 * ---------------------------------------------------------------------------
 * POR QUE NO HAY UN `bazel.ts`
 * ---------------------------------------------------------------------------
 * El epic permite declinarlo si resulta desproporcionado, y lo es: Bazel no se
 * consulta con un comando que vuelca un JSON normalizado como Nx o
 * `turbo query` (GraphQL). `bazel query --output=proto` exige compilar el
 * `.proto` de Bazel, generar bindings, y resolver que version de Bazel hay
 * instalada (el formato del proto varia entre versiones) para un cliente que
 * hoy no lo usa. Un `detectBuildTools` que reconociera `WORKSPACE`/`BUILD.bazel`
 * pero no lo ingiriera seria peor que no detectarlo: parecería soportado y no
 * lo esta. Si algun dia hace falta, el disparador es medible (CLAUDE.md 4):
 * un cliente real con Bazel.
 */
export async function detectBuildTools(repoPath: string): Promise<BuildTool[]> {
  const tools: BuildTool[] = []
  if (await fileExists(path.join(repoPath, 'nx.json'))) tools.push('nx')
  if (await fileExists(path.join(repoPath, 'turbo.json'))) tools.push('turborepo')
  return tools
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    // ENOENT es la respuesta esperada de "no hay build nativo aqui": no es un
    // fallo, es la mitad de lo que esta funcion existe para contestar. Culquier
    // OTRO error (permisos, disco) SI se propaga: CLAUDE.md 5, nunca catch
    // silencioso de lo que no se sabe manejar.
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
