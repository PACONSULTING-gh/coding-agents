import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Testcontainers arranca un Postgres real para varios paquetes: 60s de margen.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: ['**/node_modules/**', '**/dist/**'],
    projects: [
      'packages/*',
      'apps/*',
      // `scripts/` no es un paquete del workspace, asi que `pnpm -r test` no lo
      // alcanza: se corre aparte con `pnpm test:scripts`, y el CI lo ejecuta en
      // el job `test`. Sin esta entrada, el test del gate de integridad no lo
      // correria nadie — que es peor que no tenerlo.
      {
        test: {
          name: 'scripts',
          include: ['scripts/**/*.test.ts'],
        },
      },
    ],
  },
})
