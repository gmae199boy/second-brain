import { validInstallProgress, type ExtensionInstallProgress, type ExtensionRecord, type ExtensionStore } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';
type Row = { name: string; version: string; installed_at: string; enabled: boolean; enabled_changed_at: string; connection_status: 'connected' | 'failed' | null; connection_checked_at: string | null; connection_code: string | null; connection_message: string | null };
const record = (r: Row): ExtensionRecord => ({ name: r.name, version: r.version, installedAt: new Date(r.installed_at), enabled: r.enabled, enabledChangedAt: new Date(r.enabled_changed_at), connectionStatus: r.connection_status, connectionCheckedAt: r.connection_checked_at === null ? null : new Date(r.connection_checked_at), connectionCode: r.connection_code, connectionMessage: r.connection_message });
export function postgresExtensionStore(connect: PgConnect): ExtensionStore {
  return {
    async getExtensionInstallProgress(name) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const rows = await sql<{ revision: number; progress: ExtensionInstallProgress }>`select revision, progress from brain.extension_install_progress where name=${name}`.execute(opened.connection.db);
        return { ok: true, journal: rows.rows[0] ?? null };
      } catch (error) { return databaseFailure(error); }
    },
    async writeExtensionInstallProgress({ expectedRevision, progress }) {
      if (!validInstallProgress(progress) || !(expectedRevision === null || (Number.isSafeInteger(expectedRevision) && expectedRevision > 0 && expectedRevision < 2147483647))) return { ok: false, code: 'INVALID_INSTALL_PROGRESS', message: '잘못된 설치 진행 기록입니다' };
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const result = await withWrite(opened.connection, async held => {
        const found = await sql<{ revision: number }>`select revision from brain.extension_install_progress where name=${progress.name} for update`.execute(held);
        const current = found.rows[0]?.revision ?? null;
        if (current !== expectedRevision) return { written: false, revision: current };
        const revision = (current ?? 0) + 1;
        await sql`insert into brain.extension_install_progress(name, revision, progress) values (${progress.name}, ${revision}, ${JSON.stringify(progress)}::jsonb) on conflict(name) do update set revision=excluded.revision, progress=excluded.progress`.execute(held);
        return { written: true, revision };
      }, `extension-install-progress:${progress.name}`);
      return result.ok ? { ok: true, ...result.value } : result;
    },
    async recordExtensionPythonEnvironment({ name, status, code, checkedAt }) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try { const result = await withWrite(opened.connection, async held => { await sql`insert into brain.extension_python_environment(name, status, code, checked_at) values (${name}, ${status}, ${code}, ${checkedAt.toISOString()}) on conflict(name) do update set status=excluded.status, code=excluded.code, checked_at=excluded.checked_at`.execute(held); }); return result.ok ? { ok: true } : result; } catch (error) { return databaseFailure(error); }
    },
    async getExtensionPythonEnvironment(name) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try { const result = await sql<{ status: 'succeeded' | 'failed'; code: string | null; checked_at: string }>`select status, code, checked_at from brain.extension_python_environment where name=${name}`.execute(opened.connection.db); const row = result.rows[0]; return { ok: true, environment: row ? { status: row.status, code: row.code, checkedAt: new Date(row.checked_at) } : null }; } catch (error) { return databaseFailure(error); }
    },
    async recordExtensionInstall({ name, version, now, workKinds }) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await withWrite(opened.connection, async held => {
          await sql`insert into brain.extensions(name, version, installed_at, enabled, enabled_changed_at) values (${name}, ${version}, ${now.toISOString()}, true, ${now.toISOString()}) on conflict(name) do update set version=excluded.version`.execute(held);
          await sql`delete from brain.extension_work_kinds where extension_name=${name}`.execute(held);
          for (const kind of workKinds ?? []) await sql`insert into brain.extension_work_kinds(extension_name, kind) values (${name}, ${kind})`.execute(held);
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
