import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TestDatabase } from '@second-brain/test-db';
import { runMigrations } from '../src/index.js';
import { clock, database } from './fixture.js';
const databases: TestDatabase[] = []; const folders: string[] = [];
afterEach(async () => { await Promise.all([...databases.splice(0).map(db => db.drop()), ...folders.splice(0).map(f => rm(f, { recursive: true, force: true }))]); });
async function fresh() { const db = await database(false); databases.push(db); return db; }
async function owner(names: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-')); folders.push(directory);
  for (const name of names) await writeFile(join(directory,name), 'select 1;');
  return { owner: 'example', directory };
}
it('records checksums and the injected clock and applies nothing on repeat', async () => {
  const db = await fresh(); const options = { databaseUrl: db.url, clock };
  expect(await runMigrations(options)).toMatchObject({ ok: true, from: 0, to: 1, applied: ['0001_initial.sql'] });
  expect(await runMigrations(options)).toMatchObject({ ok: true, from: 1, to: 1, applied: [] });
  expect(await db.rows('select owner,version,length(checksum) as length,applied_at from brain.schema_migrations')).toEqual([{ owner: 'core', version: 1, length: 64, applied_at: clock.now() }]);
});
it('applies each file only once under simultaneous runners', async () => {
  const db = await fresh(); const options = { databaseUrl: db.url, clock };
  const results = await Promise.all([runMigrations(options), runMigrations(options)]);
  expect(results.every(r => r.ok)).toBe(true);
  expect(results.flatMap(r => r.ok ? r.applied : []).length).toBe(1);
});
it.each([['0001_a.sql','0001_b.sql'], ['0001_a.sql','0003_c.sql'], ['0002_b.sql']])('rejects duplicate or missing sequence before applying %j', async (...names) => {
  const db = await fresh(); const source = await owner(names);
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [source] })).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
  expect(await db.rows('select * from brain.schema_migrations')).toEqual([]);
});
it('supports another owner and refuses changed checksums before any pending file', async () => {
  const db = await fresh(); const source = await owner(['0001_a.sql']); const options = { databaseUrl: db.url, clock, owners: [source] };
  expect((await runMigrations(options)).ok).toBe(true);
  await writeFile(join(source.directory,'0001_a.sql'),'select 2;');
  await writeFile(join(source.directory,'0002_b.sql'),'create table brain.should_not_exist(id int);');
  expect(await runMigrations(options)).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
  expect((await db.rows("select to_regclass('brain.should_not_exist') as name"))[0]).toEqual({ name: null });
});
it('rejects a gap in an applied owner history', async () => {
  const db = await fresh(); const source = await owner(['0001_a.sql','0002_b.sql']); const options = { databaseUrl: db.url, clock, owners: [source] };
  expect((await runMigrations(options)).ok).toBe(true); await db.query("delete from brain.schema_migrations where owner='example' and version=1");
  expect(await runMigrations(options)).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
});
it('rolls back the current file on DDL failure', async () => {
  const db = await fresh(); const source = await owner(['0001_a.sql']);
  await writeFile(join(source.directory,'0001_a.sql'),'create table brain.rolled_back(id int); select missing_column;');
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [source] })).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
  expect(await db.rows('select * from brain.schema_migrations')).toEqual([]);
  expect((await db.rows("select to_regclass('brain.rolled_back') as name"))[0]).toEqual({ name: null });
});
