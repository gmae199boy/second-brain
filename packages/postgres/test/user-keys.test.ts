import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { clock, database } from './fixture.js';
import { createSettingsBrain } from '@second-brain/core';
import { CORE_SCHEMA_VERSION, postgresStore, runMigrations } from '../src/index.js';

async function v31() {
  const db = await database(false);
  const dir = await mkdtemp(join(tmpdir(), 'brain-user-keys-'));
  const source = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(source)).filter(f => /^\d{4}_.+\.sql$/.test(f) && f < '0032').sort())
    await copyFile(new URL(file, source), join(dir, file));
  const result = await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory: dir }] });
  if (!result.ok) throw new Error(result.message);
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  return { db, client, async close() { await client.end(); await db.drop(); await rm(dir, { recursive: true, force: true }); } };
}

it('v31 사용자 설정과 대화만 self로 채우고 수집 행을 보존한다', async () => {
  const kit = await v31();
  try {
    const { client, db } = kit, user = randomUUID(), channel = randomUUID(), conversation = randomUUID(), session = randomUUID(), message = randomUUID();
    await client.query("insert into brain.users(id,name,is_self,created_at) values ($1,'synthetic',1,now())", [user]);
    await client.query("insert into brain.settings(key,value,updated_at) values ('timezone','UTC',now()),('testext.limit','7',now()),('testext.shared','shared-value',now()),('doctor.writable','probe',now())");
    await client.query("insert into brain.channels(id,kind,bot_ref) values ($1,'telegram','synthetic')", [channel]);
    await client.query("insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref) values ($1,$2,'chat','thread-synthetic')", [conversation, channel]);
    await client.query("insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ($1,'synthetic','session',$2,'test',now(),'import')", [session, user]);
    await client.query("insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ($1,$2,'message','user','synthetic',now())", [message, session]);
    await client.query("insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok) values ($1,$2,'message',0,'read','synthetic',1)", [randomUUID(), session]);
    await client.query("insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,body) values ($1,$2,'019a0000-0000-7000-8000-000000000003',now(),now(),'synthetic chunk')", [randomUUID(), session]);
    await client.query("insert into brain.transcript_files(id,harness,path,size_bytes,fingerprint,scanned_at) values ($1,'synthetic','synthetic/transcript',1,'hash',now())", [randomUUID()]);
    const settings = (await client.query('select key,value,updated_at from brain.settings order by key')).rows;
    const snapshot = async () => {
      const results: unknown[] = [];
      for (const table of ['sessions', 'messages', 'tool_notes', 'chunks', 'transcript_files', 'message_attachments', 'context_injections', 'files', 'file_locations', 'file_names', 'document_extractions', 'document_chunks', 'projects', 'worktrees', 'workspaces', 'failures', 'redactions', 'log_entries', 'log_entry_edits']) results.push((await client.query(`select count(*)::int as n, md5(coalesce(string_agg(row_to_json(t)::text, ',' order by row_to_json(t)::text),'')) as hash from brain.${table} t`)).rows[0]);
      return results;
    };
    const privilegesFor = async (table: string) => (await client.query("select has_table_privilege('brain_app',$1,'select') as read, has_table_privilege('brain_app',$1,'insert') as insert, has_table_privilege('brain_app',$1,'update') as update, has_table_privilege('brain_app',$1,'delete') as delete", [`brain.${table}`])).rows[0];
    const privilegesBefore = { settings: await privilegesFor('settings'), channel_conversations: await privilegesFor('channel_conversations') };
    const conversationBefore = (await client.query('select id,channel_id,external_ref,thread_ref from brain.channel_conversations order by id')).rows;
    const before = await snapshot();
    // These five tables were seeded above; the remaining related tables are intentionally empty.
    const seeded = ['sessions', 'messages', 'tool_notes', 'chunks', 'transcript_files'];
    const empty = ['message_attachments', 'context_injections', 'files', 'file_locations', 'file_names', 'document_extractions', 'document_chunks', 'projects', 'worktrees', 'workspaces', 'failures', 'redactions', 'log_entries', 'log_entry_edits'];
    for (const table of seeded) expect((await client.query(`select count(*)::int as n from brain.${table}`)).rows[0].n, table).toBeGreaterThan(0);
    for (const table of empty) expect((await client.query(`select count(*)::int as n from brain.${table}`)).rows[0].n, table).toBe(0);
    expect(await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: 32 })).toMatchObject({ ok: true, from: 31, to: 32 });
    expect((await client.query('select key,value,updated_at from brain.settings order by key')).rows).toEqual(settings);
    expect((await client.query('select key,user_id from brain.settings order by key')).rows).toEqual([{ key: 'doctor.writable', user_id: null }, { key: 'testext.limit', user_id: user }, { key: 'testext.shared', user_id: user }, { key: 'timezone', user_id: user }]);
    expect((await client.query('select user_id from brain.channel_conversations where id=$1', [conversation])).rows[0].user_id).toBe(user);
    expect(await snapshot()).toEqual(before);
    expect((await client.query('select id,channel_id,external_ref,thread_ref from brain.channel_conversations order by id')).rows).toEqual(conversationBefore);
    for (const bad of [null, randomUUID()]) {
      const badId = randomUUID();
      await expect(client.query("insert into brain.channel_conversations(id,channel_id,external_ref,user_id) values ($1,$2,'invalid',$3)", [badId, channel, bad])).rejects.toMatchObject({ code: bad === null ? '23502' : '23503' });
      expect((await client.query('select count(*)::int as n from brain.channel_conversations where id=$1', [badId])).rows[0].n).toBe(0);
    }
    const store = postgresStore({ databaseUrl: db.appUrl });
    try {
      const resolved = await store.getSettings({ userId: user, keys: settings.map(row => row.key) });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.settings.map(({ key, value }) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key))).toEqual(settings.map(({ key, value }) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key)));
    } finally { await store.close(); }
    for (const table of ['settings', 'channel_conversations']) {
      const privileges = await privilegesFor(table);
      expect(privileges).toMatchObject({ read: true, insert: true, update: true, delete: true });
      expect(privileges).toEqual(privilegesBefore[table as keyof typeof privilegesBefore]);
    }
    const app = new pg.Client({ connectionString: db.appUrl }); await app.connect();
    try {
      await expect(app.query("delete from brain.settings where key='timezone'")).rejects.toThrow();
      await app.query('begin');
      const deleted = await app.query('delete from brain.channel_conversations where id=$1 returning id', [conversation]);
      expect(deleted.rows).toEqual([{id:conversation}]);
      await app.query('rollback');
      expect((await app.query('select id from brain.channel_conversations where id=$1', [conversation])).rows).toEqual([{id:conversation}]);
    } finally { await app.end(); }
    const otherUser = randomUUID();
    await client.query("insert into brain.users(id,name,is_self,created_at) values ($1,'other',0,now())", [otherUser]);
    await client.query("insert into brain.settings(user_id,key,value,updated_at) values (null,'timezone','global',now())");
    const original = (await client.query("select user_id,key,value,updated_at from brain.settings where key='timezone' order by user_id nulls first")).rows;
    await expect(client.query("update brain.settings set user_id=$1 where key='timezone' and user_id is null", [user])).rejects.toThrow('settings_immutable_update');
    await expect(client.query("update brain.settings set user_id=$1 where key='timezone' and user_id=$2", [otherUser,user])).rejects.toThrow('settings_immutable_update');
    await expect(client.query("insert into brain.settings(user_id,key,value,updated_at) values ($1,'missing.user','x',now())", [randomUUID()])).rejects.toMatchObject({ code: '23503' });
    expect((await client.query("select user_id,key,value,updated_at from brain.settings where key='timezone' order by user_id nulls first")).rows).toEqual(original);
    expect((await client.query("select count(*)::int as n from brain.settings where key='missing.user'")).rows[0].n).toBe(0);
    await expect(client.query("insert into brain.settings(user_id,key,value,updated_at) values (null,'timezone','x',now())")).rejects.toMatchObject({ code: '23505' });
    await expect(client.query("insert into brain.settings(user_id,key,value,updated_at) values ($1,'timezone','x',now())", [user])).rejects.toMatchObject({ code: '23505' });
    await expect(client.query("update brain.settings set user_id=null where user_id=$1 and key='timezone'", [user])).rejects.toThrow('settings_immutable_update');
    await expect(client.query("update brain.settings set key='changed' where user_id=$1 and key='timezone'", [user])).rejects.toThrow('settings_immutable_update');
  } finally { await kit.close(); }
});

it('self 없는 기존 행은 migration 전체를 rollback한다', async () => {
  const kit = await v31();
  try {
    await kit.client.query("insert into brain.settings(key,value,updated_at) values ('timezone','UTC',now())");
    const result = await runMigrations({ databaseUrl: kit.db.url, clock, coreMaxVersion: 32 });
    expect(result).toMatchObject({ ok: false, code: 'MIGRATION_FAILED', file: '0032_user_keys.sql', message: expect.stringContaining('USER_MISSING') });
    expect((await kit.client.query("select max(version)::int as version from brain.schema_migrations where owner='core'")).rows[0].version).toBe(31);
    expect((await kit.client.query("select count(*)::int as n from information_schema.columns where table_schema='brain' and table_name='settings' and column_name='user_id'")).rows[0].n).toBe(0);
  } finally { await kit.close(); }
});

it('빈 DB는 self 생성 전 0032를 적용할 수 있고 새 설정과 대화에 self를 기록한다', async () => {
  const db = await database();
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    const user = randomUUID(), channel = randomUUID(), conversation = randomUUID();
    const store = postgresStore({ databaseUrl: db.appUrl });
    try {
      expect(await store.ensureSelfUser({ id: user, name: 'synthetic', createdAt: clock.now() })).toMatchObject({ ok: true });
      const brain = createSettingsBrain({ store, clock, schemaVersions: { core: CORE_SCHEMA_VERSION } });
      expect(await brain.config.set({ key: 'timezone', value: 'UTC' })).toMatchObject({ ok: true });
      expect(await store.ensureChannel({ id: channel, kind: 'telegram', botRef: 'synthetic' })).toMatchObject({ ok: true });
      expect(await store.ensureChannelConversation({ id: conversation, channelId: channel, externalRef: 'chat', threadRef: null, userId: user })).toMatchObject({ ok: true });
    } finally { await store.close(); }
    expect((await client.query("select user_id from brain.settings where key='timezone'")).rows[0].user_id).toBe(user);
    expect((await client.query('select user_id from brain.channel_conversations where id=$1', [conversation])).rows[0].user_id).toBe(user);
  } finally { await client.end(); await db.drop(); }
});

it('설정 없이 기존 대화만 있어도 self 누락 시 rollback한다', async () => {
  const kit = await v31();
  try {
    const channel = randomUUID();
    await kit.client.query("insert into brain.channels(id,kind,bot_ref) values ($1,'telegram','synthetic')", [channel]);
    await kit.client.query("insert into brain.channel_conversations(id,channel_id,external_ref) values ($1,$2,'chat')", [randomUUID(), channel]);
    expect(await runMigrations({ databaseUrl: kit.db.url, clock, coreMaxVersion: 32 })).toMatchObject({ ok: false, code: 'MIGRATION_FAILED', message: expect.stringContaining('USER_MISSING') });
    expect((await kit.client.query("select max(version)::int as version from brain.schema_migrations where owner='core'")).rows[0].version).toBe(31);
  } finally { await kit.close(); }
});

it('setup ordering creates self between schema 31 and 32 and backfills old rows', async () => {
  const kit = await v31();
  const store = postgresStore({ databaseUrl: kit.db.appUrl });
  try {
    const user = randomUUID(), channel = randomUUID(), conversation = randomUUID();
    await kit.client.query("insert into brain.settings(key,value,updated_at) values ('timezone','UTC',now())");
    await kit.client.query("insert into brain.channels(id,kind,bot_ref) values ($1,'telegram','synthetic')", [channel]);
    await kit.client.query("insert into brain.channel_conversations(id,channel_id,external_ref) values ($1,$2,'chat')", [conversation, channel]);
    expect(await runMigrations({ databaseUrl: kit.db.url, clock, coreMaxVersion: 31 })).toMatchObject({ ok: true, to: 31 });
    expect(await store.ensureSelfUser({ id: user, name: 'synthetic', createdAt: clock.now() })).toMatchObject({ ok: true });
    expect(await runMigrations({ databaseUrl: kit.db.url, clock, coreMaxVersion: 32 })).toMatchObject({ ok: true, from: 31, to: 32 });
    expect((await kit.client.query("select user_id from brain.settings where key='timezone'")).rows[0].user_id).toBe(user);
    expect((await kit.client.query('select user_id from brain.channel_conversations where id=$1', [conversation])).rows[0].user_id).toBe(user);
  } finally { await store.close(); await kit.close(); }
});

it('migrates a doctor probe without self and leaves its value and timestamp global', async () => {
  const kit = await v31();
  try {
    await kit.client.query("insert into brain.settings(key,value,updated_at) values ('doctor.writable','probe','2026-01-01T00:00:00Z')");
    const before = (await kit.client.query("select key,value,updated_at from brain.settings where key='doctor.writable'")).rows;
    expect(await runMigrations({ databaseUrl: kit.db.url, clock, coreMaxVersion: 32 })).toMatchObject({ ok: true, from: 31, to: 32 });
    expect((await kit.client.query("select key,value,updated_at from brain.settings where key='doctor.writable'")).rows).toEqual(before);
    expect((await kit.client.query("select user_id from brain.settings where key='doctor.writable'")).rows).toEqual([{ user_id: null }]);
    expect((await kit.client.query('select count(*)::int as n from brain.users where is_self=1')).rows[0].n).toBe(0);
  } finally { await kit.close(); }
});

it('backfills settings and conversation to self even when a non-self user was inserted first', async () => {
  const kit = await v31();
  try {
    const other = randomUUID(), self = randomUUID(), channel = randomUUID(), conversation = randomUUID();
    await kit.client.query("insert into brain.users(id,name,is_self,created_at) values ($1,'other',0,now())", [other]);
    await kit.client.query("insert into brain.users(id,name,is_self,created_at) values ($1,'self',1,now())", [self]);
    await kit.client.query("insert into brain.settings(key,value,updated_at) values ('timezone','UTC',now()),('testext.limit','7',now()),('doctor.writable','probe',now())");
    await kit.client.query("insert into brain.channels(id,kind,bot_ref) values ($1,'telegram','synthetic')", [channel]);
    await kit.client.query("insert into brain.channel_conversations(id,channel_id,external_ref) values ($1,$2,'chat')", [conversation, channel]);
    expect(await runMigrations({ databaseUrl: kit.db.url, clock, coreMaxVersion: 32 })).toMatchObject({ ok: true, from: 31, to: 32 });
    expect((await kit.client.query('select key,user_id from brain.settings order by key')).rows).toEqual([{ key: 'doctor.writable', user_id: null }, { key: 'testext.limit', user_id: self }, { key: 'timezone', user_id: self }]);
    expect((await kit.client.query('select user_id from brain.channel_conversations where id=$1', [conversation])).rows).toEqual([{ user_id: self }]);
    expect((await kit.client.query('select count(*)::int as n from brain.settings where user_id=$1', [other])).rows[0].n).toBe(0);
    expect((await kit.client.query('select count(*)::int as n from brain.channel_conversations where user_id=$1', [other])).rows[0].n).toBe(0);
  } finally { await kit.close(); }
});
