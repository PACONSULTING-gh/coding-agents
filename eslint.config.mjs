// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      // Skills de terceros instaladas con version fijada (ver scripts/install-archify.sh).
      // Son codigo vendorizado que no mantenemos: ni se lintan ni se formatean.
      '.claude/skills/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.stryker-tmp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Catch vacio ya lo caza no-empty (allowEmptyCatch:false). no-useless-catch
      // ademas prohibe un catch que solo re-lanza sin anadir nada: si vas a atrapar
      // un error, tienes que hacer algo real con el (loggear, envolver, propagar
      // con contexto). Nunca tragartelo en silencio (CLAUDE.md 2.4 y 5).
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-useless-catch': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    /**
     * `unsafeWithoutTenantScope` abre una transaccion SIN `app.tenant_id`. Su
     * nombre feo es la capa de guia; esto es el check determinista que exige
     * CLAUDE.md ("si una regla de aqui importa de verdad, tiene que existir
     * tambien como check determinista"). Sin el, su acotacion dependia de que
     * alguien lo viera en review.
     *
     * Fuera de `packages/db`, TODO acceso a datos pasa por
     * `withTenantConnection`. Anadir un llamante nuevo exige tocar esta lista y,
     * por tanto, pasar por revision humana.
     */
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
    ignores: ['packages/db/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@coord/db',
              importNames: ['unsafeWithoutTenantScope'],
              message:
                'unsafeWithoutTenantScope consulta SIN contexto de tenant y solo vale para ' +
                'operaciones administrativas dentro de packages/db. Usa withTenantConnection.',
            },
          ],
        },
      ],
    },
  },
  {
    // Ficheros de config (raiz y de cada paquete/app) y scripts de tooling en
    // scripts/: ninguno forma parte del rootDir "src" de ningun tsconfig
    // (scripts/ no tiene composite ni esta en las referencias de tsconfig.json),
    // asi que se lintean sin chequeo de tipos.
    files: ['*.mjs', '*.cjs', '*.ts', '**/vitest.config.ts', 'scripts/**/*.mjs', 'scripts/**/*.ts'],
    ignores: ['packages/*/src/**', 'apps/*/src/**'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // scripts/*.mjs corren con `node` directamente (fuera de cualquier
    // tsconfig, ver el bloque de arriba), asi que ESLint no conoce sus
    // globales de entorno por defecto. Solo los dos que se usan de verdad:
    // anadir "globals" como dependencia para esto seria una talla XXL para
    // un problema de dos nombres (CLAUDE.md 2.4).
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // Ficheros CommonJS de config en la raiz (dependency-cruiser): declara
    // sourceType commonjs para que ESLint reconozca module/require/exports.
    files: ['*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  eslintConfigPrettier,
)
