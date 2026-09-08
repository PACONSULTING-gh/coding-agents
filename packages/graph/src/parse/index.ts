import { javascriptLanguageParser } from './javascript.js'
import { pythonLanguageParser } from './python.js'
import { typescriptLanguageParser } from './typescript.js'
import type { LanguageParser } from './types.js'

export * from './types.js'
export { typescriptLanguageParser } from './typescript.js'
export { javascriptLanguageParser } from './javascript.js'
export { pythonLanguageParser } from './python.js'

/**
 * Registro de parsers. Anadir un lenguaje = anadir un modulo en este directorio
 * y una linea en esta lista. El motor de ingesta no cambia.
 */
export const LANGUAGE_PARSERS: readonly LanguageParser[] = [
  typescriptLanguageParser,
  javascriptLanguageParser,
  pythonLanguageParser,
]

const BY_EXTENSION = new Map<string, LanguageParser>()
for (const parser of LANGUAGE_PARSERS) {
  for (const extension of parser.extensions) {
    const previous = BY_EXTENSION.get(extension)
    if (previous !== undefined) {
      // Dos parsers reclamando la misma extension es un error de programacion:
      // el ganador dependeria del orden del array. Falla al cargar el modulo.
      throw new Error(
        `La extension ${extension} la reclaman dos parsers: ${previous.language} y ${parser.language}.`,
      )
    }
    BY_EXTENSION.set(extension, parser)
  }
}

/** Extensiones que el grafo sabe parsear hoy. */
export const SUPPORTED_EXTENSIONS: readonly string[] = [...BY_EXTENSION.keys()]

/**
 * Parser que atiende una ruta, o `undefined` si ese fichero no se indexa.
 * `undefined` NO es un error: un repo tiene imagenes, JSON y markdown, y esos
 * ficheros simplemente no producen nodos en T02.
 */
export function parserForPath(path: string): LanguageParser | undefined {
  const index = path.lastIndexOf('.')
  if (index === -1) return undefined
  return BY_EXTENSION.get(path.slice(index).toLowerCase())
}
