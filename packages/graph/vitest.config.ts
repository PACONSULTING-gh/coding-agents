import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // SIN `passWithNoTests`. Este paquete YA tiene tests: si un glob se rompe o
    // alguien mueve `test/`, el job de CI debe ponerse en ROJO, no en verde con
    // cero tests ejecutados (CLAUDE.md 7).
    //
    // Los tests levantan un Postgres real con testcontainers y uno de ellos
    // carga mas de 10.000 nodos: margen amplio, y ficheros EN SERIE para no
    // arrancar varios contenedores a la vez ni medir latencias con la maquina
    // saturada por otro fichero de test (el criterio de p95 es una medida real,
    // no un adorno).
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
