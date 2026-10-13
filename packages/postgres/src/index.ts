export { postgresStore, type PostgresStoreOptions } from './store.js';
export {
  SCHEMA_VERSION,
  runMigrations,
  type MigrationResult,
  type RunMigrationsOptions,
} from './migrate.js';
export {
  DEFAULT_CHUNK_PARAMS,
  ensureDefaultIndexConfig,
  ensureVectorExtension,
  type EnsureDefaultIndexConfigOptions,
  type EnsureDefaultIndexConfigResult,
  type EnsureVectorResult,
  type VectorExtension,
} from './setup.js';
