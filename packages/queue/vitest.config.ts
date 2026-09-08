import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // SIN `passWithNoTests`. Este paquete YA tiene tests: si un glob se rompe,
    // se renombra `test/` o alguien mueve ficheros, el job de CI debe ponerse
    // en ROJO, no en verde con cero tests ejecutados. Un gate que se aprueba a
    // si mismo cuando deja de ejecutar codigo es exactamente la senal de alarma
    // de CLAUDE.md 7.
    // Testcontainers levanta un Postgres real: margen amplio y ficheros en
    // serie, para no arrancar varios contenedores a la vez.
    testTimeout: 90_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
