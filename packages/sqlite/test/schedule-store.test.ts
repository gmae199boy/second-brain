import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { tickSchedules } from '@second-brain/core';
import { sequenceIdGen } from '@second-brain/core/testing';
import { scheduleStoreContract } from '@second-brain/core/testing';
import { openSqlite } from '../src/connect.js';
import { sqliteScheduleStore } from '../src/schedules.js';
import { SQLITE_MIGRATIONS_DIRECTORY, runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function migrated() {
  const root = await mkdtemp(join(tmpdir(), 'brain-schedule-')); roots.push(root);
  const path = join(root, 'brain.db'); expect((await runSqliteMigrations({ path })).ok).toBe(true); return path;
}
const now = new Date('2026-02-03T04:05:06.000Z');
const schedule = { id: 's', kind: 'schedule_probe', targetKind: 'probe', targetId: 's', intervalSeconds: 60,
  nextRunAt: now, lastRunAt: null, createdAt: now };
const firing = { scheduleId: 's', expectedNextRunAt: now, nextRunAt: new Date(now.getTime() + 60000), now,
  work: { id: 'w', kind: 'schedule_probe', targetKind: 'probe', targetId: 's', createdAt: now, nextAttemptAt: now } };

describe('SQLite schedule contract', () => {
  for (const c of scheduleStoreContract()) it(c.name, () => c.run(async () => sqliteStore({ path: await migrated() })));
  for (const table of ['work_items', 'schedules']) it(`rolls back when ${table} refuses its write, then recovers once`, async () => {
    const path = await migrated(); const store = sqliteStore({ path }); const db = new DatabaseSync(path);
    try {
      expect((await store.addSchedule(schedule)).ok).toBe(true);
      const before = db.prepare('select * from schedules').all();
      db.exec(`create trigger reject_schedule before ${table === 'work_items' ? 'insert' : 'update'} on ${table} begin select raise(abort, 'refused'); end`);
      expect(await store.fireSchedule(firing)).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
      expect(db.prepare('select * from schedules').all()).toEqual(before);
      expect(db.prepare('select * from work_items').all()).toEqual([]);
      db.exec('drop trigger reject_schedule');
      expect(await store.fireSchedule(firing)).toEqual({ ok: true, fired: true, created: true });
      expect(await store.fireSchedule(firing)).toEqual({ ok: true, fired: false });
      expect(db.prepare('select * from work_items').all()).toHaveLength(1);
    } finally { db.close(); await store.close(); }
  });
  it('returns DB_LOCKED under another writer and fires exactly once after release', async () => {
    const path = await migrated();
    const opened = openSqlite({ path, busyTimeoutMs: 1 });
    if (!opened.ok) throw new Error(opened.message);
    const connection = opened.connection;
    const store = sqliteScheduleStore(() => ({ ok: true, connection }));
    const other = openSqlite({ path, busyTimeoutMs: 1 });
    if (!other.ok) { await connection.close(); throw new Error(other.message); }
    try {
      expect((await store.addSchedule(schedule)).ok).toBe(true);
      const before = connection.database.prepare('select * from schedules').all();
      other.connection.database.exec('begin immediate');
      try {
        expect(await store.fireSchedule(firing)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
        expect(connection.database.prepare('select * from schedules').all()).toEqual(before);
        expect(connection.database.prepare('select * from work_items').all()).toEqual([]);
      } finally { other.connection.database.exec('rollback'); }
      expect(await store.fireSchedule(firing)).toEqual({ ok: true, fired: true, created: true });
      expect(await store.fireSchedule(firing)).toEqual({ ok: true, fired: false });
      expect(connection.database.prepare('select * from work_items').all()).toHaveLength(1);
      expect(connection.database.prepare('select next_run_at,last_run_at from schedules').get()).toEqual({
        next_run_at: firing.nextRunAt.toISOString(), last_run_at: now.toISOString(),
      });
    } finally { await other.connection.close(); await connection.close(); }
  });
  it('keeps earlier firings committed when a later schedule fails, then retries only the latter', async () => {
    const path = await migrated(); const store = sqliteStore({ path }); const db = new DatabaseSync(path);
    try {
      for (const id of ['a', 'b']) expect((await store.addSchedule({ ...schedule, id, targetId: id })).ok).toBe(true);
      const before = db.prepare("select * from schedules where id='b'").get();
      db.exec("create trigger reject_second before update on schedules when old.id = 'b' begin select raise(abort, 'refused'); end");
      const tick = () => tickSchedules({ store, clock: { now: () => new Date(now) }, idGen });
      const idGen = sequenceIdGen({ timestampMs: now.getTime() });
      expect(await tick()).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE', fired: 1, enqueued: 1 });
      expect(db.prepare('select target_id from work_items order by target_id').all()).toEqual([{ target_id: 'a' }]);
      const first = db.prepare("select * from schedules where id='a'").get();
      expect(first).toMatchObject({ next_run_at: firing.nextRunAt.toISOString(), last_run_at: now.toISOString() });
      expect(db.prepare("select * from schedules where id='b'").get()).toEqual(before);
      db.exec('drop trigger reject_second');
      expect(await tick()).toEqual({ ok: true, fired: 1, enqueued: 1 });
      expect(db.prepare('select target_id from work_items order by target_id').all())
        .toEqual([{ target_id: 'a' }, { target_id: 'b' }]);
      expect(db.prepare("select * from schedules where id='a'").get()).toEqual(first);
      expect(db.prepare("select next_run_at,last_run_at from schedules where id='b'").get()).toEqual({
        next_run_at: firing.nextRunAt.toISOString(), last_run_at: now.toISOString(),
      });
      expect(await tick()).toEqual({ ok: true, fired: 0, enqueued: 0 });
    } finally { db.close(); await store.close(); }
  });
  it('upgrades schema 8 with preserved data, applying only 0009 and then nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brain-schedule-upgrade-')); roots.push(root);
    const path = join(root, 'brain.db'); const directory = join(root, 'migrations');
    await mkdir(directory);
    for (const name of await readdir(SQLITE_MIGRATIONS_DIRECTORY)) {
      if (/^000[1-8]_/.test(name)) await copyFile(join(SQLITE_MIGRATIONS_DIRECTORY, name), join(directory, name));
    }
    expect(await runSqliteMigrations({ path, directory })).toMatchObject({ ok: true, to: 8 });
    const db = new DatabaseSync(path);
    try {
      db.prepare('insert into users(id,name,is_self,created_at) values(?,?,?,?)').run('owner', 'test owner', 1, now.toISOString());
      db.prepare('insert into work_items(id,kind,target_kind,target_id,created_at,attempts,next_attempt_at) values(?,?,?,?,?,?,?)')
        .run('existing-work', 'existing_kind', 'existing_target', 'target-42', now.toISOString(), 0, now.toISOString());
      const users = db.prepare('select * from users').all();
      const work = db.prepare('select * from work_items').all();
      expect(await runSqliteMigrations({ path })).toEqual({ ok: true, from: 8, to: 9, applied: ['0009_schedules.sql'] });
      expect(db.prepare('select * from users').all()).toEqual(users);
      expect(db.prepare('select * from work_items').all()).toEqual(work);
      expect(db.prepare('select * from schedules').all()).toEqual([]);
      expect(await runSqliteMigrations({ path })).toEqual({ ok: true, from: 9, to: 9, applied: [] });
      expect(db.prepare('select * from users').all()).toEqual(users);
      expect(db.prepare('select * from work_items').all()).toEqual(work);
    } finally { db.close(); }
  });
  it.each(['next_run_at', 'last_run_at', 'created_at'] as const)(
    'reports an impossible %s instant instead of normalizing it', async column => {
      const path = await migrated(); const store = sqliteStore({ path }); const db = new DatabaseSync(path);
      try {
        db.prepare('insert into schedules values (?,?,?,?,?,?,?,?)').run(
          'invalid', 'schedule_probe', 'probe', 'invalid', 60, now.toISOString(), null, now.toISOString());
        db.prepare(`update schedules set ${column} = ?`).run('2026-02-30T00:00:00.000Z');
        expect(await store.listDueSchedules({ now: new Date('2026-03-03T00:00:00.000Z'), limit: 100 }))
          .toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
      } finally { db.close(); await store.close(); }
    });
  it('enforces interval, repeating-next-run and all timestamp checks', async () => {
    const path = await migrated(); const db = new DatabaseSync(path);
    try {
      const insert = db.prepare('insert into schedules values (?,?,?,?,?,?,?,?)');
      const good = ['s', 'schedule_probe', 'probe', 's', 60, now.toISOString(), null, now.toISOString()];
      for (const [column, value] of [[4, 0], [4, -1], [5, null], [5, 'bad'], [6, 'bad'], [7, 'bad']] as const) {
        const row = [...good]; row[column] = value; expect(() => insert.run(...row)).toThrow();
      }
      expect(db.prepare("select name from sqlite_master where name='schedules_due_idx'").get()).toBeDefined();
      expect(db.prepare('select version from schema_version').get()).toEqual({ version: 9 });
      expect(db.prepare("select strict from pragma_table_list where name='schedules'").get()).toEqual({ strict: 1 });
    } finally { db.close(); }
  });
});
