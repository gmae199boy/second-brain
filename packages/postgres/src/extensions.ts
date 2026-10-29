import type { ExtensionRecord, ExtensionStore } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';
type Row = { name: string; version: string; installed_at: string; enabled: boolean; enabled_changed_at: string; connection_status: 'connected' | 'failed' | null; connection_checked_at: string | null; connection_code: string | null; connection_message: string | null };
const record = (r: Row): ExtensionRecord => ({ name: r.name, version: r.version, installedAt: new Date(r.installed_at), enabled: r.enabled, enabledChangedAt: new Date(r.enabled_changed_at), connectionStatus: r.connection_status, connectionCheckedAt: r.connection_checked_at === null ? null : new Date(r.connection_checked_at), connectionCode: r.connection_code, connectionMessage: r.connection_message });
export function postgresExtensionStore(connect: PgConnect): ExtensionStore {
  return {
    async recordExtensionInstall({ name, version, now }) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await withWrite(opened.connection, async held => {
          await sql`insert into brain.extensions(name, version, installed_at, enabled, enabled_changed_at) values (${name}, ${version}, ${now.toISOString()}, true, ${now.toISOString()}) on conflict(name) do update set version=excluded.version`.execute(held);
        });
        return result.ok ? { ok: true } : result;
      } catch (error) { return databaseFailure(error); }
    },
    async recordExtensionConnection({ name, status, code, message, checkedAt }) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await withWrite(opened.connection, async held => (await sql`update brain.extensions set connection_status=${status}, connection_checked_at=${checkedAt.toISOString()}, connection_code=${code}, connection_message=${message} where name=${name} returning name`.execute(held)).rows.length > 0);
        return result.ok ? result.value ? { ok: true } : { ok: false, code: 'DB_UNAVAILABLE', message: '설치 기록이 없습니다' } : result;
      } catch (error) { return databaseFailure(error); }
    },
    async getExtension(name) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try { const r = await sql<Row>`select * from brain.extensions where name=${name}`.execute(opened.connection.db); return { ok: true, extension: r.rows[0] ? record(r.rows[0]) : null }; }
      catch (error) { return databaseFailure(error); }
    },
    async listExtensions() {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try { const r = await sql<Row>`select * from brain.extensions order by name collate "C"`.execute(opened.connection.db); return { ok: true, extensions: r.rows.map(record) }; }
      catch (error) { return databaseFailure(error); }
    },
  };
}
