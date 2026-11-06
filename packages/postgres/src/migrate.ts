import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMigrationNames, type Clock } from '@second-brain/core';
import { createPool, describe, type ConnectionOptions } from './connect.js';
export const CORE_SCHEMA_VERSION = 40;
export const SCHEMA_VERSION = CORE_SCHEMA_VERSION;
export interface MigrationOwner { owner: string; directory: string }
export interface RunMigrationsOptions extends ConnectionOptions {
  clock: Clock;
  owners?: readonly MigrationOwner[];
  coreMaxVersion?: number;
  /** Validate files and applied history without running SQL migrations. */
  validateOnly?: boolean;
}
/** Read legacy schema state before any core migration changes it. */
export async function inspectExtensionFence(databaseUrl: string): Promise<{ names: string[]; gateNames: string[]; fenceReady: boolean; progressReady: boolean }> {
  const pool = createPool({ databaseUrl });
  try {
    const tables = await pool.query<{ registry: string | null; gate: string | null; ledger: string | null; progress: string | null }>("select to_regclass('brain.extensions')::text as registry, to_regclass('brain.extension_quiesce')::text as gate, to_regclass('brain.schema_migrations')::text as ledger, to_regclass('brain.extension_install_progress')::text as progress");
    const { registry, gate, ledger, progress } = tables.rows[0]!;
    const gateRows = gate ? (await pool.query<{ name: string }>('select name from brain.extension_quiesce')).rows.map(row => row.name) : [];
    if (!registry) return { names: [], gateNames: gateRows, fenceReady: false, progressReady: !!progress };
    const rows = await pool.query<{ name: string }>('select name from brain.extensions order by name collate "C"');
    if (!gate || !ledger) return { names: rows.rows.map(row => row.name), gateNames: gateRows, fenceReady: false, progressReady: !!progress };
    const version = await pool.query<{ ready: boolean }>("select exists(select 1 from brain.schema_migrations where owner='core' and version=35) as ready");
    return { names: rows.rows.map(row => row.name), gateNames: gateRows, fenceReady: version.rows[0]!.ready, progressReady: !!progress };
  } catch (error) {
    if ((error as { code?: string }).code === '3D000') return { names: [], gateNames: [], fenceReady: false, progressReady: false };
    throw error;
  } finally { await pool.end(); }
}
/** Read only schema-27 tables; a held group may be any existing user hold. */
export async function inspectLegacyExtensionPrerequisites(databaseUrl: string): Promise<{ name: string; enabled: boolean; held: boolean; unheld_schedules: number; unheld_work: number; running: number; open_attempts: number }[]> {
  const pool = createPool({ databaseUrl });
  try {
    const result = await pool.query<{ name: string; enabled: boolean; held: boolean; unheld_schedules: number; unheld_work: number; running: number; open_attempts: number }>(`select e.name, e.enabled,
      exists(select 1 from brain.work_hold_groups h where h.name = 'extension:' || e.name) as held,
      (select count(*)::int from brain.schedules s where split_part(s.kind,'.',1)=e.name and position('.' in s.kind)>0 and not exists(select 1 from brain.work_hold_groups h where h.name=s.hold_group)) as unheld_schedules,
      (select count(*)::int from brain.work_items w where split_part(w.kind,'.',1)=e.name and position('.' in w.kind)>0 and w.completed_at is null and not exists(select 1 from brain.work_hold_groups h where h.name=w.hold_group)) as unheld_work,
      (select count(*)::int from brain.work_items w where split_part(w.kind,'.',1)=e.name and position('.' in w.kind)>0 and w.completed_at is null and (w.claimed_by is not null or w.current_attempt_token is not null)) as running,
      (select count(*)::int from brain.work_attempts a join brain.work_items w on w.id=a.work_item_id where split_part(w.kind,'.',1)=e.name and position('.' in w.kind)>0 and a.finished_at is null) as open_attempts
      from brain.extensions e order by e.name collate "C"`);
    return result.rows;
  } finally { await pool.end(); }
}
export type MigrationResult = { ok: true; from: number; to: number; applied: string[] }
  | { ok: false; code: 'DB_UNAVAILABLE' | 'MIGRATION_FAILED'; message: string; file?: string };
const defaultOwners: readonly MigrationOwner[] = [{ owner: 'core', directory: fileURLToPath(new URL('../migrations/', import.meta.url)) }];
/** Validate the whole package and applied history before the first pending DDL.
 * 적용된 baseline은 바꾸지 않는다. 바꿀 것은 0002_*.sql로.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationResult> {
  let files: { owner: string; name: string; version: number; body: string; checksum: string }[] = [];
  try {
    if (options.coreMaxVersion !== undefined && (!Number.isInteger(options.coreMaxVersion) || options.coreMaxVersion < 1 || options.coreMaxVersion > CORE_SCHEMA_VERSION)) throw new Error('core 마이그레이션 상한이 올바르지 않습니다');
    const owners = options.owners ?? defaultOwners;
    if (new Set(owners.map(o => o.owner)).size !== owners.length) throw new Error('마이그레이션 소유자가 중복됩니다');
    for (const owner of owners) {
      const names = validateMigrationNames(await readdir(owner.directory));
      for (const name of names) {
        const version = Number(name.slice(0, 4));
        const body = await readFile(join(owner.directory, name), 'utf8');
        files.push({ owner: owner.owner, name, version, body, checksum: createHash('sha256').update(body).digest('hex') });
      }
    }
    if (options.owners === undefined) {
      const highest = Math.max(0, ...files.map(file => file.version));
      if (highest !== CORE_SCHEMA_VERSION) throw new Error(`core: 마이그레이션 버전 ${highest}이 CORE_SCHEMA_VERSION ${CORE_SCHEMA_VERSION}과 다릅니다`);
    }
  } catch (error) { return { ok: false, code: 'MIGRATION_FAILED', message: describe(error) }; }
  const pool = createPool({ ...options, lockTimeoutMs: 0, queryTimeoutMs: 0 });
  let client;
  try { client = await pool.connect(); }
  catch (error) { await pool.end(); return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) }; }
  let attempting = '';
  let from = 0; let to = 0; const applied: string[] = [];
  try {
    // Setup owns roles and the ledger. The runner never creates either.
    await client.query('set role brain_owner');
    const validate = async () => {
      const rows = (await client.query<{ owner: string; version: number; name: string; checksum: string }>('select owner, version, name, checksum from brain.schema_migrations')).rows;
      for (const row of rows.filter(r => (options.owners ?? defaultOwners).some(o => o.owner === r.owner))) {
        const file = files.find(f => f.owner === row.owner && f.version === row.version);
        if (!file || file.name !== row.name || file.checksum !== row.checksum) throw new Error(`${row.owner}/${row.version}: 적용한 파일의 checksum 또는 번호가 다릅니다`);
      }
      for (const owner of options.owners ?? defaultOwners) {
        const history = rows.filter(r => r.owner === owner.owner).sort((a,b) => a.version - b.version);
        if (history.some((row,index) => row.version !== index + 1)) throw new Error(`${owner.owner}: 적용한 번호가 연속되지 않습니다`);
      }
      return rows;
    };
    const initial = await validate();
    if (options.validateOnly) {
      const version = Math.max(0, ...initial.filter(row => row.owner === 'core').map(row => row.version));
      return { ok: true, from: version, to: version, applied: [] };
    }
    for (const file of files) {
      if (file.owner === 'core' && options.coreMaxVersion !== undefined && file.version > options.coreMaxVersion) continue;
      attempting = file.name;
      await client.query('begin');
      try {
        await client.query('select pg_advisory_xact_lock($1)', [4919270911]);
        const rows = await validate();
        const version = Math.max(0, ...rows.filter(r => r.owner === file.owner).map(r => r.version));
        if (file.owner === 'core') { if (file.version === 1) from = version; to = version; }
        if (file.version > version) {
          if (file.version !== version + 1) throw new Error('적용한 번호에 누락이 있습니다');
          await client.query(file.body);
          await client.query('insert into brain.schema_migrations(owner,version,name,checksum,applied_at) values ($1,$2,$3,$4,$5)', [file.owner, file.version, file.name, file.checksum, options.clock.now().toISOString()]);
          applied.push(file.name);
          if (file.owner === 'core') to = file.version;
        }
        await client.query('commit');
      } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    }
    return { ok: true, from, to, applied };
  } catch (error) { return { ok: false, code: 'MIGRATION_FAILED', file: attempting, message: describe(error) }; }
  finally { client.release(); await pool.end().catch(() => {}); }
}

export const EXPECTED_SCHEMA_VERSIONS = { core: CORE_SCHEMA_VERSION } as const;
