import { expect, it } from 'vitest';
import pg from 'pg';
import { settingsStoreContract } from '@second-brain/core/testing';
import { postgresStore } from '../src/index.js';
import { database, subject } from './fixture.js';
for (const test of settingsStoreContract()) it(test.name, () => test.run(async () => { const s = await subject(); await s.db.query("insert into brain.users(id,name,is_self,created_at) values ('01940000-0000-7000-8000-00000000000a','A',1,now()),('01940000-0000-7000-8000-00000000000b','B',0,now())"); return s; }));
it('refuses direct key updates and deletes while permitting value and time updates', async () => {
  const db = await database();
  const store = postgresStore({ databaseUrl: db.appUrl });
  const app = new pg.Client({ connectionString: db.appUrl });
  try {
    await app.connect();
    expect(await store.setSetting({ userId: null, key: 'timezone', value: 'Asia/Seoul', updatedAt: new Date('2026-10-28T01:02:03.456Z') })).toEqual({ ok: true });
    await expect(app.query("update brain.settings set key='other'")).rejects.toThrow('invariant refused');
    await expect(app.query('delete from brain.settings')).rejects.toThrow('invariant refused');
    await expect(app.query("update brain.settings set value='Europe/Paris', updated_at='2026-10-28T02:03:04.567Z'")).resolves.toBeDefined();
    expect(await store.getSetting({ userId: null, key: 'timezone' })).toMatchObject({ ok: true, setting: { key: 'timezone', value: 'Europe/Paris', updatedAt: new Date('2026-10-28T02:03:04.567Z') } });
  } finally { await app.end(); await store.close(); await db.drop(); }
});
it('classifies unavailable and locked settings access', async () => {
  const unavailable = postgresStore({ databaseUrl: 'postgresql://unused@127.0.0.1:1/brain', connectTimeoutMs: 100 });
  try {
    expect(await unavailable.getSetting({ userId: null, key: 'timezone' })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    expect(await unavailable.setSetting({ userId: null, key: 'timezone', value: 'Asia/Seoul', updatedAt: new Date() })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    expect(await unavailable.insertSetting({ userId: null, key: 'probe.unavailable', value: 'x', updatedAt: new Date() })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    expect(await unavailable.getSetting({ userId: null, key: 'probe.unavailable' })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  } finally { await unavailable.close(); }
  const db = await database(); const store = postgresStore({ databaseUrl: db.appUrl, lockTimeoutMs: 40 });
  const blocker = new pg.Client({ connectionString: db.url });
  try {
    const invalidUrl = new URL(db.appUrl); invalidUrl.password = 'synthetic-invalid-password';
    const rejected = postgresStore({ databaseUrl: invalidUrl.toString(), connectTimeoutMs: 1000 });
    try {
      expect(await rejected.insertSetting({ userId: null, key: 'probe.bad-auth', value: 'x', updatedAt: new Date() })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
      expect(await db.rows("select key from brain.settings where key='probe.bad-auth'")).toEqual([]);
    } finally { await rejected.close(); }
    await blocker.connect(); await blocker.query('begin'); await blocker.query('lock table brain.settings in access exclusive mode');
    expect(await store.getSetting({ userId: null, key: 'timezone' })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
    expect(await store.setSetting({ userId: null, key: 'timezone', value: 'Asia/Seoul', updatedAt: new Date() })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
    expect(await store.insertSetting({ userId: null, key: 'probe.locked', value: 'x', updatedAt: new Date() })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  } finally { await blocker.query('rollback').catch(() => {}); try { expect(await db.rows("select key from brain.settings where key='probe.locked'")).toEqual([]); } finally { await blocker.end().catch(() => {}); await store.close(); await db.drop(); } }
});
it('user rows override global rows and insert preserves existing scope value', async () => {
  const db = await database();
  const admin = new pg.Client({ connectionString: db.url });
  const store = postgresStore({ databaseUrl: db.appUrl });
  const userId = '019a0000-0000-7000-8000-000000000001', updatedAt = new Date('2026-01-01T00:00:00Z');
  try {
    await admin.connect();
    await admin.query("insert into brain.users(id,name,is_self,created_at) values ($1,'synthetic',1,now())", [userId]);
    await store.setSetting({ userId: null, key: 'probe.value', value: 'global', updatedAt });
    expect(await store.getSetting({ userId, key: 'probe.value' })).toMatchObject({ setting: { value: 'global' } });
    await store.setSetting({ userId, key: 'probe.value', value: 'user', updatedAt });
    await store.insertSetting({ userId, key: 'probe.value', value: 'default', updatedAt });
    expect(await store.getSetting({ userId, key: 'probe.value' })).toMatchObject({ setting: { value: 'user' } });
    expect(await store.getSetting({ userId: null, key: 'probe.value' })).toMatchObject({ setting: { value: 'global' } });
  } finally { await store.close(); await admin.end(); await db.drop(); }
});
