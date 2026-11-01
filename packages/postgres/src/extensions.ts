import { extensionPublicProjection, validInstallProgress, type ExtensionInstallProgress, type ExtensionRecord, type ExtensionStore } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';
import { closePendingProtectedInputs } from './protected-input.js';
import { ensureWork } from './work.js';
type Row = { name: string; version: string; installed_at: string; enabled: boolean; enabled_changed_at: string; connection_status: 'connected' | 'failed' | null; connection_checked_at: string | null; connection_code: string | null; connection_message: string | null };
const record = (r: Row): ExtensionRecord => ({ name: r.name, version: r.version, installedAt: new Date(r.installed_at), enabled: r.enabled, enabledChangedAt: new Date(r.enabled_changed_at), connectionStatus: r.connection_status, connectionCheckedAt: r.connection_checked_at === null ? null : new Date(r.connection_checked_at), connectionCode: r.connection_code, connectionMessage: r.connection_message });
export function postgresExtensionStore(connect: PgConnect): ExtensionStore {
  return {
    async enqueueExtensionWork({ name, version, work }) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const result = await withWrite(opened.connection, async held => {
        const rows = await sql<{ enabled: boolean; version: string }>`select enabled, version from brain.extensions where name=${name} for update`.execute(held);
        const row = rows.rows[0];
        if (!row) return { state: 'missing' as const };
        if (row.version !== version) return { state: 'changed' as const };
        if (!row.enabled) return { state: 'disabled' as const };
        const found = await sql`select 1 from brain.extension_work_kinds where extension_name=${name} and kind=${work.kind}`.execute(held);
        if (!found.rows.length) return { state: 'changed' as const };
        // 기존 null/다른 직렬화 키의 열린 일감을 새 보호 대상과 합치지 않는다.
        // schedule range 병합이 이미 일어났을 수도 있으므로 savepoint로 되돌린다.
        await sql`savepoint extension_enqueue`.execute(held);
        const queued = await ensureWork(held, work);
        if (!queued.created && work.serializationKey !== undefined && queued.row.serialization_key !== work.serializationKey) {
          await sql`rollback to savepoint extension_enqueue`.execute(held);
          await sql`release savepoint extension_enqueue`.execute(held);
          return { state: 'changed' as const };
        }
        await sql`release savepoint extension_enqueue`.execute(held);
        return { state: 'queued' as const, workId: queued.row.id, created: queued.created };
      });
      return result.ok ? { ok: true, ...result.value } : result;
    },
    async listExtensionInventory() {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<{ name: string }>`select name from (select name from brain.extensions union select name from brain.extension_install_progress) inventory order by name collate "C"`.execute(opened.connection.db);
        return { ok: true, names: result.rows.map(row => row.name) };
      } catch (error) { return databaseFailure(error); }
    },
    async getExtensionPublicStatus(name) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<{ extension: Row | null; progress: ExtensionInstallProgress | null; held_schedules: number; interrupted_work: number; python: { status: 'succeeded' | 'failed'; code: string | null; checked_at: string } | null }>`
          select (select row_to_json(e) from brain.extensions e where e.name = ${name}) as extension,
            (select p.progress from brain.extension_install_progress p where p.name = ${name}) as progress,
            (select row_to_json(p) from brain.extension_python_environment p where p.name = ${name}) as python,
            (select count(*)::int from brain.schedules s join brain.work_hold_groups h on h.name = s.hold_group where h.name = ${'extension:' + name}) as held_schedules,
            (select count(*)::int from brain.work_items w join brain.work_hold_groups h on h.name = w.hold_group where h.name = ${'extension:' + name} and w.completed_at is null) as interrupted_work`.execute(opened.connection.db);
        const row = result.rows[0]!;
        const status = extensionPublicProjection(name, row.extension ? record(row.extension) : null, row.progress && validInstallProgress(row.progress) ? row.progress : null, row.held_schedules, row.interrupted_work, row.python ? { status: row.python.status, code: row.python.code, checkedAt: new Date(row.python.checked_at) } : null);
        if (!/^[a-z][a-z0-9_]{0,30}$/.test(name) || /^(core|brain|public|pg_)/.test(name)) return { ok: false, code: 'DB_UNAVAILABLE', message: '확장 상태를 읽을 수 없습니다' };
        const schema = await sql<{ accessible: boolean }>`select exists(select 1 from pg_namespace where nspname=${name} and has_schema_privilege(current_user,oid,'USAGE')) as accessible`.execute(opened.connection.db);
        const view = schema.rows[0]?.accessible ? await sql<{ present: boolean }>`select to_regclass(${name + '.public_attention_v1'}) is not null as present`.execute(opened.connection.db) : null;
        if (view?.rows[0]?.present) {
          const attention = await sql<{ requires_action: unknown; requires_manual_action: unknown }>`select requires_action,requires_manual_action from ${sql.ref(name + '.public_attention_v1')} limit 2`.execute(opened.connection.db);
          const value = attention.rows[0];
          if (attention.rows.length !== 1 || typeof value?.requires_action !== 'boolean' || typeof value.requires_manual_action !== 'boolean') return { ok: false, code: 'DB_UNAVAILABLE', message: '확장 공개 상태가 올바르지 않습니다' };
          status.attention = { requiresAction: value.requires_action, requiresManualAction: value.requires_manual_action };
        }
        return { ok: true, status };
      } catch (error) { return databaseFailure(error); }
    },
    async setExtensionEnabled({ name, enabled, now }) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const result = await withWrite(opened.connection, async held => {
        if (!enabled) await closePendingProtectedInputs(held, `extension:${name}`);
        const rows = await sql<{ enabled: boolean }>`select enabled from brain.extensions where name=${name} for update`.execute(held);
        const row = rows.rows[0];
        if (!row) return { found: false, changed: false };
        const changed = row.enabled !== enabled;
        if (changed) await sql`update brain.extensions set enabled=${enabled}, enabled_changed_at=${now.toISOString()} where name=${name}`.execute(held);
        const group = `extension:${name}`;
        if (enabled) await sql`delete from brain.work_hold_groups where name=${group}`.execute(held);
        else await sql`insert into brain.work_hold_groups(name, held_at) values (${group}, ${now.toISOString()}) on conflict(name) do nothing`.execute(held);
        return { found: true, changed };
      });
      return result.ok ? { ok: true, ...result.value } : result;
    },
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
