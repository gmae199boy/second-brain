import { BUSY_TIMEOUT_MS, SQLITE_SCHEMA_VERSION, type BusyTimeoutPath, type SchemaVersions, type Store, type SchemaStore, type SettingsStore, type SqliteStoreOptions } from 'second_brain';
import { resolveStoreUrl, type ReadConfigResult } from '../config/codec.js';
import { failedConfigStore } from '../doctor/store.js';

export interface OpenBrainStoreOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  config: ReadConfigResult;
  path: BusyTimeoutPath;
  lockTimeoutMs?: number;
  createSqliteStore: (options: SqliteStoreOptions) => Store & SchemaStore;
}
export type BrainStore =
  | { kind: 'postgres'; store: Store & SchemaStore & SettingsStore; expected: SchemaVersions; adapterProbeIds: readonly string[] }
  | { kind: 'sqlite'; store: Store & SchemaStore; expected: SchemaVersions };

/** Select the configured adapter once, without loading PostgreSQL for SQLite homes. */
export async function openBrainStore(options: OpenBrainStoreOptions): Promise<BrainStore> {
  const { home, env, config, path, lockTimeoutMs, createSqliteStore } = options;
  if (config.ok && config.config.storeUrlEnv !== undefined) {
    const pg = await import('second_brain/postgres');
    const url = await resolveStoreUrl(home, config.config.storeUrlEnv, env).catch(() => undefined);
    return { kind: 'postgres', expected: pg.EXPECTED_SCHEMA_VERSIONS, adapterProbeIds: pg.POSTGRES_DOCTOR_PROBE_IDS,
      store: pg.postgresStore({ databaseUrl: url || 'postgresql://invalid@127.0.0.1:1/unavailable', path,
        ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }) }) };
  }
  return { kind: 'sqlite', expected: { core: SQLITE_SCHEMA_VERSION },
    store: config.ok ? createSqliteStore({ path: config.config.storePath, busyTimeoutMs: lockTimeoutMs ?? BUSY_TIMEOUT_MS[path] })
      : failedConfigStore('설정을 읽을 수 없어서 데이터베이스 위치를 알 수 없습니다') };
}
