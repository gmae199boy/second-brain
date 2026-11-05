export { postgresStore, POSTGRES_DOCTOR_PROBE_IDS, type PostgresStoreOptions, type PostgresStore, type PostgresIngestStore } from './store.js';
export { CORE_SCHEMA_VERSION, SCHEMA_VERSION, runMigrations, inspectExtensionFence, type MigrationResult, type RunMigrationsOptions, type MigrationOwner } from './migrate.js';
export { prepareDatabase, type PrepareDatabaseOptions, type PrepareDatabaseResult } from './setup.js';
export { postgresTableMaintenance } from './maintenance.js';

export { postgresSettingsStore } from './settings.js';

export { EXPECTED_SCHEMA_VERSIONS } from './migrate.js';
export { provisionExtension } from './extension-provision.js';
export { withExtensionInstallLock } from './extension-install-lock.js';
