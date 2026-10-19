// The source adapter (AD-10). Every public name is prefixed, because the one
// writing surface re-exports this package beside `@second-brain/postgres` and
// two exports of the same name would be an error there, not a choice.
// `setRedactAllowed` is deliberately absent: `withWrite` is its only caller,
// and leaving it unexported is what makes that a rule rather than a comment
// (AD-11).
export {
  SQLITE_BUSY,
  isBusy,
  openSqlite,
  sqliteErrcode,
  type OpenSqliteOptions,
  type OpenSqliteResult,
  type SqliteConnect,
  type SqliteConnection,
} from './connect.js';
export { withWrite, type WriteOptions, type WriteResult } from './write.js';
export { sqliteStore, type SqliteStoreOptions } from './store.js';
export { sqliteSessionStore } from './sessions.js';
export { sqliteTranscriptFileStore } from './transcript-files.js';
export { sqliteUserStore } from './users.js';
export {
  claimCandidateQuery,
  sqliteWorkStore,
  type WorkItemRow,
} from './work.js';
export {
  SQLITE_MIGRATIONS_DIRECTORY,
  SQLITE_SCHEMA_VERSION,
  runSqliteMigrations,
  type RunSqliteMigrationsOptions,
  type SqliteMigrationResult,
} from './migrate.js';
export type { SqliteSchema } from './driver.js';
