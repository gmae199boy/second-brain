import type { HealthStore, SchemaStore, SessionIngestStore, SessionStore, TranscriptFileStore, WorkStore, UserStore } from '@second-brain/core';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPool, databaseFailure, describe, type CreatePoolOptions, type PgSchema, type PgConnect } from './connect.js';
import { postgresSessionStore } from './sessions.js';
import { postgresUserStore } from './users.js';
import { postgresTranscriptFileStore } from './transcript-files.js';
import { postgresAttachmentStore } from './attachments.js';
import { postgresOpenWorkStore } from './ingest-work.js';
export type PostgresStoreOptions = CreatePoolOptions;
export type PostgresIngestStore = SessionIngestStore & UserStore & HealthStore & SchemaStore;
export type PostgresStore = PostgresIngestStore & Omit<SessionStore, 'redactMessage'> & TranscriptFileStore & Pick<WorkStore, 'listOpenWorkTargets'>;
export function postgresStore(options: PostgresStoreOptions): PostgresStore {
  const pool = createPool(options);
  const db = new Kysely<PgSchema>({ dialect: new PostgresDialect({ pool }) });
  const connect: PgConnect = () => ({ ok: true, connection: { db } });
  return {
    ...postgresOpenWorkStore(connect), ...postgresSessionStore(connect), ...postgresUserStore(connect),
    ...postgresTranscriptFileStore(connect), ...postgresAttachmentStore(connect),
    async checkHealth() {
      try {
        const version = await sql<{ version: string }>`select current_setting('server_version') as version`.execute(db);
        const trgm = await sql<{ similarity: number }>`select public.similarity('brain','brain') as similarity`.execute(db);
        const url = new URL(options.databaseUrl);
        return { ok: true, serverVersion: version.rows[0]!.version, source: {
          location: `${url.hostname}:${url.port}${url.pathname}`,
          probes: [{ id: 'pg_trgm', ok: trgm.rows[0]?.similarity === 1, detail: 'pg_trgm' }],
        } };
      } catch (error) { return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) }; }
    },
    async readSchemaVersion() {
      try {
        const read = await sql<{ version: number; applied_at: string }>`select version, applied_at from brain.schema_migrations where owner='core' order by version desc limit 1`.execute(db);
        const row = read.rows[0];
        return { ok: true, version: row === undefined ? null : { version: row.version, appliedAt: new Date(row.applied_at) } };
      } catch (error) { return databaseFailure(error); }
    },
    async close() { await db.destroy(); },
  };
}
