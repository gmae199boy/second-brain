import { expect, it } from 'vitest';
import pg from 'pg';
import { settingsStoreContract } from '@second-brain/core/testing';
import { postgresStore } from '../src/index.js';
import { database, subject } from './fixture.js';
for (const test of settingsStoreContract()) it(test.name, () => test.run(subject));
it('refuses direct key updates and deletes while permitting value and time updates', async () => {
  const db = await database();
  const store = postgresStore({ databaseUrl: db.appUrl });
  const app = new pg.Client({ connectionString: db.appUrl });
  try {
    await app.connect();
    expect(await store.setSetting({ key: 'timezone', value: 'Asia/Seoul', updatedAt: new Date('2026-10-28T01:02:03.456Z') })).toEqual({ ok: true });
    await expect(app.query("update brain.settings set key='other'")).rejects.toThrow('invariant refused');
    await expect(app.query('delete from brain.settings')).rejects.toThrow('invariant refused');
    await expect(app.query("update brain.settings set value='Europe/Paris', updated_at='2026-10-28T02:03:04.567Z'")).resolves.toBeDefined();
    expect(await store.getSetting({ key: 'timezone' })).toMatchObject({ ok: true, setting: { key: 'timezone', value: 'Europe/Paris', updatedAt: new Date('2026-10-28T02:03:04.567Z') } });
  } finally { await app.end(); await store.close(); await db.drop(); }
});
it('classifies unavailable and locked settings access', async () => {
  const unavailable = postgresStore({ databaseUrl: 'postgresql://unused@127.0.0.1:1/brain', connectTimeoutMs: 100 });
  try {
    expect(await unavailable.getSetting({ key: 'timezone' })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    expect(await unavailable.setSetting({ key: 'timezone', value: 'Asia/Seoul', updatedAt: new Date() })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  } finally { await unavailable.close(); }
  const db = await database(); const store = postgresStore({ databaseUrl: db.appUrl, lockTimeoutMs: 40 });
  const blocker = new pg.Client({ connectionString: db.url });
  try {
    await blocker.connect(); await blocker.query('begin'); await blocker.query('lock table brain.settings in access exclusive mode');
    expect(await store.getSetting({ key: 'timezone' })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
    expect(await store.setSetting({ key: 'timezone', value: 'Asia/Seoul', updatedAt: new Date() })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  } finally { await blocker.query('rollback'); await blocker.end(); await store.close(); await db.drop(); }
});
