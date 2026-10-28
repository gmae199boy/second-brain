import type { BusyTimeoutPath, SchemaVersions, Store, SchemaStore, SettingsStore } from 'second_brain';
import { resolveStoreUrl, type ReadConfigResult } from '../config/codec.js';
import { failedConfigStore } from '../doctor/store.js';

export interface OpenBrainStoreOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  config: ReadConfigResult;
  path: BusyTimeoutPath;
  lockTimeoutMs?: number;
  createStore?: (options: import('second_brain/postgres').PostgresStoreOptions) => Store & SchemaStore & SettingsStore;
}
export type BrainStore = { store: Store & SchemaStore & SettingsStore; expected: SchemaVersions; adapterProbeIds: readonly string[] };

/** Open the primary store lazily; importing the CLI never opens PostgreSQL. */
export async function openBrainStore(options: OpenBrainStoreOptions): Promise<BrainStore> {
  const { home, env, config, path, lockTimeoutMs } = options;
  if (!config.ok) return { expected: { core: 2 }, adapterProbeIds: [], store: failedConfigStore('설정을 읽을 수 없어서 데이터베이스 위치를 알 수 없습니다') };
  const pg = await import('second_brain/postgres');
  const url = await resolveStoreUrl(home, config.config.storeUrlEnv, env).catch(() => undefined);
  return { expected: pg.EXPECTED_SCHEMA_VERSIONS, adapterProbeIds: pg.POSTGRES_DOCTOR_PROBE_IDS,
    store: (options.createStore ?? pg.postgresStore)({ databaseUrl: url || 'postgresql://invalid@127.0.0.1:1/unavailable', path,
      ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }) }) };
}
