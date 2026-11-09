import { driveBarrier } from './drive-barrier.js';
import { postgresSourceStore } from './sources.js';
import { postgresDriveStore } from './drive.js';
import { postgresImportStore } from './imports.js';
import { postgresChannelStore } from './channels.js';
import { postgresRecallStore } from './recall.js';
import { postgresConversationIndexStore } from './conversation-index.js';
import { postgresExtensionStore } from './extensions.js';
import type { ExtensionStore } from '@second-brain/core';
import { postgresSettingsStore } from './settings.js';
import type { SettingsStore, AttachmentStore, ExtractionStore, HealthStore, SchemaStore, SessionIngestStore, SessionStore, TranscriptFileStore, WorkStore, ScheduleStore, UserStore } from '@second-brain/core';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPool, databaseFailure, describe, type CreatePoolOptions, type PgSchema, type PgConnect } from './connect.js';
import { postgresSessionStore } from './sessions.js';
import { postgresUserStore } from './users.js';
import { postgresTranscriptFileStore } from './transcript-files.js';
import { postgresAttachmentStore } from './attachments.js';
import { postgresExtractionStore } from './extractions.js';
import { postgresWorkStore } from './work.js';
import { postgresScheduleStore } from './schedules.js';
export type PostgresStoreOptions = CreatePoolOptions;
export type PostgresIngestStore = SessionIngestStore & UserStore & HealthStore & SchemaStore;
export type PostgresStore = import('@second-brain/core').SourceStore & import('@second-brain/core').DriveMigrationStore & { driveUploads: import('@second-brain/core').DriveUploadStore } & { imports: import('@second-brain/core').ImportStore } & import('@second-brain/core').ChannelStore & import('@second-brain/core').RecallStore & import('@second-brain/core').DocumentRecallStore & import('@second-brain/core').ConversationIndexStore & ExtensionStore & PostgresIngestStore & import('@second-brain/core').DriveRetentionSettingsStore & SessionStore & TranscriptFileStore & WorkStore & ScheduleStore & AttachmentStore & ExtractionStore;
/** Ordered adapter probes shared by health checks and doctor assembly. */
export const POSTGRES_DOCTOR_PROBE_IDS = ['writable', 'pg_trgm', 'redaction_cleanup'] as const;
const [writableProbeId, trgmProbeId, cleanupProbeId] = POSTGRES_DOCTOR_PROBE_IDS;
export function postgresStore(options: PostgresStoreOptions): PostgresStore {
  const pool = createPool(options);
  const db = new Kysely<PgSchema>({ dialect: new PostgresDialect({ pool }) });
  const barrier = driveBarrier(options);
  const connect: PgConnect = () => ({ ok: true, connection: { db } });
  return {
    ...postgresSourceStore(connect, barrier),
    imports: postgresImportStore(connect),
    ...postgresDriveStore(connect, barrier),
    ...postgresChannelStore(connect), ...postgresRecallStore(connect), ...postgresConversationIndexStore(connect), ...postgresExtensionStore(connect), ...postgresSettingsStore(connect), ...postgresExtractionStore(connect), ...postgresWorkStore(connect), ...postgresScheduleStore(connect), ...postgresSessionStore(connect), ...postgresUserStore(connect),
    ...postgresTranscriptFileStore(connect), ...postgresAttachmentStore(connect),
    async checkHealth() {
      try {
        const version = await sql<{ version: string }>`select current_setting('server_version') as version`.execute(db);
        let writable: import('@second-brain/core').StoreProbe;
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query("insert into brain.settings(key,value,updated_at) values ('doctor.writable', 'probe', '2000-01-01T00:00:00Z') on conflict(user_id,key) do update set value=excluded.value");
          writable = { id: writableProbeId, ok: true, detail: '쓰기 확인 뒤 되돌렸습니다' };
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (!['55P03', '42501', '25006'].includes(code ?? '')) throw error;
          const locked = code === '55P03';
          writable = { id: writableProbeId, ok: locked, ...(locked ? { warn: true } : {}), detail: locked ? '잠금 대기 한도를 넘겨 쓰기를 확인하지 못했습니다' : '읽기 전용이거나 쓰기 권한이 없습니다' };
        } finally {
          try { await client.query('rollback'); }
          catch (error) {
            client.release(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
          client.release();
        }
        const trgm = await sql<{ similarity: number }>`select public.similarity('brain','brain') as similarity`.execute(db);
        const cleanup = await sql<{ target_id: string }>`select target_id from brain.work_items
          where kind='table_cleanup' and completed_at is null
          union select target_id from brain.failures where stage='table_cleanup' and resolved_at is null`.execute(db);
        const pending = cleanup.rows.map(row => row.target_id).sort();
        const url = new URL(options.databaseUrl);
        return { ok: true, serverVersion: version.rows[0]!.version, source: {
          location: `${url.hostname}:${url.port}${url.pathname}`,
          probes: [writable, { id: trgmProbeId, ok: trgm.rows[0]?.similarity === 1, detail: 'pg_trgm' },
            { id: cleanupProbeId, ok: true, warn: pending.length > 0, detail: pending.length > 0 ? `저장본 정리가 남은 표: ${pending.join(', ')}` : '저장본 정리가 끝났습니다' }],
        } };
      } catch (error) { return { ...databaseFailure(error), message: describe(error) }; }
    },
    async readSchemaMigrationVersions(owner) {
      try { const read = await sql<{ version: number }>`select version from brain.schema_migrations where owner=${owner} order by version`.execute(db); return { ok: true as const, versions: read.rows.map(row => row.version) }; }
      catch (error) { return databaseFailure(error); }
    },
    async readSchemaVersions() {
      try {
        const read = await sql<{ owner: string; version: number; applied_at: string }>`select distinct on (owner) owner, version, applied_at from brain.schema_migrations order by owner, version desc`.execute(db);
        return { ok: true, versions: Object.fromEntries(read.rows.map(row =>
          [row.owner, { version: row.version, appliedAt: new Date(row.applied_at) }])) };
      } catch (error) { return databaseFailure(error); }
    },
    async close() { await db.destroy(); },
  };
}
