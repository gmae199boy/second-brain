import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMigrationNames, type Clock } from '@second-brain/core';
import { createPool, describe, type ConnectionOptions } from './connect.js';
export const CORE_SCHEMA_VERSION = 35;
export const SCHEMA_VERSION = CORE_SCHEMA_VERSION;
export interface MigrationOwner { owner: string; directory: string }
export interface RunMigrationsOptions extends ConnectionOptions {
  clock: Clock;
  owners?: readonly MigrationOwner[];
  coreMaxVersion?: number;
}
/** Read legacy schema state before any core migration changes it. */
export async function inspectExtensionFence(databaseUrl: string): Promise<{ names: string[]; gateNames: string[]; fenceReady: boolean }> {
  const pool = createPool({ databaseUrl });
  try {
    const tables = await pool.query<{ registry: string | null; gate: string | null; ledger: string | null }>("select to_regclass('brain.extensions')::text as registry, to_regclass('brain.extension_quiesce')::text as gate, to_regclass('brain.schema_migrations')::text as ledger");
    const { registry, gate, ledger } = tables.rows[0]!;
    const gateRows = gate ? (await pool.query<{ name: string }>('select name from brain.extension_quiesce')).rows.map(row => row.name) : [];
    if (!registry) return { names: [], gateNames: gateRows, fenceReady: false };
    const rows = await pool.query<{ name: string }>('select name from brain.extensions order by name collate "C"');
    if (!gate || !ledger) return { names: rows.rows.map(row => row.name), gateNames: gateRows, fenceReady: false };
    const version = await pool.query<{ ready: boolean }>("select exists(select 1 from brain.schema_migrations where owner='core' and version=35) as ready");
    return { names: rows.rows.map(row => row.name), gateNames: gateRows, fenceReady: version.rows[0]!.ready };
  } catch (error) {
    if ((error as { code?: string }).code === '3D000') return { names: [], gateNames: [], fenceReady: false };
    throw error;
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
    await validate();
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
