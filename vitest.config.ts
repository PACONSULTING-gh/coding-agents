import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Testcontainers arranca un Postgres real para varios paquetes: 60s de margen.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: ['**/node_modules/**', '**/dist/**'],
    projects: ['packages/*', 'apps/*'],
  },
})
