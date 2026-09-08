import { z } from 'zod'

/**
 * Ruta de fichero validada en la frontera de confianza (T05: lo que llega lo
 * escribe un LLM). Mismo patron que `relativePathSchema` en `../claims.ts`:
 * sin absolutas, sin `..`, sin espacios de borde.
 *
 * Aqui protege DOS usos con motor real detras:
 *   - `blast_radius` / el `path` de un `node`: igualdad exacta contra
 *     `graph_nodes.path` (parametrizada; sin riesgo de inyeccion SQL, pero una
 *     ruta absoluta o con `..` no puede identificar nunca un nodo real).
 *   - `who_last_touched`: `git log -- <ruta>` sobre un checkout real. Git ya
 *     rechaza una ruta que se salga del repositorio, pero validar aqui evita
 *     ademas depender de esa proteccion y da un mensaje legible al LLM en vez
 *     de un error crudo de git.
 */
export const relativeFilePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => p === p.trim(), 'La ruta no puede llevar espacios al principio ni al final.')
  .refine((p) => !p.startsWith('/'), 'La ruta tiene que ser RELATIVA a la raiz del repo.')
  .refine((p) => !/^[A-Za-z]:[\\/]/.test(p), 'La ruta tiene que ser RELATIVA a la raiz del repo.')
  .refine((p) => !/(^|\/)\.\.(\/|$)/.test(p), 'La ruta no puede tener segmentos "..".')
