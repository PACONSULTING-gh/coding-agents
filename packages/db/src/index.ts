export * from './schema.js'
export * from './queryable.js'
export * from './audit.js'
export * from './acceptance-criteria.js'
export * from './client.js'
export * from './github-installations.js'
export * from './webhook-deliveries.js'

/**
 * De `pool.js` se exporta la configuracion y el cierre, pero NO `getPool()`:
 * el `Pool` de `pg` se queda dentro del paquete. Si saliera, cualquiera podria
 * consultar sin fijar el tenant, y `withTenantConnection` pasaria de ser la
 * unica via a ser la via recomendada. No es lo mismo.
 */
export {
  configureDatabase,
  resolveRuntimeConnectionString,
  closeDatabase,
  pingDatabase,
  getPoolStats,
  DEFAULT_POOL_MAX,
  type DatabaseConfig,
  type PoolStats,
} from './pool.js'
