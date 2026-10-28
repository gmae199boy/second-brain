import { checkSchema } from '@second-brain/core';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { schemaStoreContract, storeContract, sessionIngestContract, userStoreContract, sampleEnsureSessionInput, sampleSelfUserInput, sampleIngestBatch, sampleSessionToken } from '@second-brain/core/testing';
import { postgresStore } from '../src/index.js';
import { database, subject } from './fixture.js';
import type { TestDatabase } from '@second-brain/test-db';
const databases: TestDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.drop())); });
for (const [name, cases] of [['ingest', sessionIngestContract()], ['user', userStoreContract()], ['health', storeContract()], ['schema', schemaStoreContract()]] as const) {
  describe(name, () => { for (const test of cases) it(test.name, () => test.run(subject)); });
}
it('serializes simultaneous collection and preserves ids, timestamps and null workspace', async () => {
  const db = await database(); databases.push(db);
  const a = postgresStore({ databaseUrl: db.appUrl }); const b = postgresStore({ databaseUrl: db.appUrl });
  try {
    expect((await a.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
    expect((await a.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
    const results = await Promise.all([a.ingest(sampleIngestBatch()), b.ingest(sampleIngestBatch())]);
    expect(results.every(r => r.ok)).toBe(true);
    expect(results.reduce((n,r) => n + (r.ok ? r.inserted.messages : 0), 0)).toBe(sampleIngestBatch().messages.length);
    const read = await a.readSession(sampleSessionToken);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.session.workspaceId).toBeNull();
    expect(read.messages.map(m => [m.id, m.occurredAt, m.body])).toEqual(sampleIngestBatch().messages.map(m => [m.id, m.occurredAt, m.body]));
  } finally { await a.close(); await b.close(); }
});
it('denies direct original UPDATE, DELETE and TRUNCATE to brain_app, including a spoofed GUC', async () => {
  const db = await database(); databases.push(db); const store = postgresStore({ databaseUrl: db.appUrl });
  try { await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput()); await store.ingest(sampleIngestBatch()); }
  finally { await store.close(); }
  const app = new pg.Client({ connectionString: db.appUrl }); await app.connect();
  try {
    await app.query("set brain.redacting = 'on'");
    for (const statement of ["update brain.messages set body='changed'", 'delete from brain.messages', 'truncate brain.messages cascade', 'create table brain.forbidden(id int)', 'update brain.schema_migrations set version=9']) await expect(app.query(statement)).rejects.toBeDefined();
    await expect(db.query('truncate brain.messages cascade')).rejects.toThrow('truncate refused');
    await expect(db.query("update brain.messages set body='changed'")).rejects.toThrow('invariant refused');
    const owners = await db.rows<{ rolname: string }>("select r.rolname from pg_class c join pg_roles r on r.oid=c.relowner where c.oid='brain.messages'::regclass");
    expect(owners[0]?.rolname).toBe('brain_owner');
  } finally { await app.end(); }
});
it('rejects invalid workspace FK and returns unavailable for a missing schema', async () => {
  const db = await database(); databases.push(db);
  await expect(db.query("insert into brain.projects(id,remote_identity,identity_key,workspace_id) values ('00000000-0000-7000-8000-000000000001','a','a','00000000-0000-7000-8000-000000000002')")).rejects.toThrow();
  await db.query('drop schema brain cascade'); const store = postgresStore({ databaseUrl: db.appUrl });
  try { expect(await store.readSchemaVersion()).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' }); expect(await store.findSession(sampleEnsureSessionInput().key)).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' }); }
  finally { await store.close(); }
});
it.each([{ connectTimeoutMs: 200 }, { connectTimeoutMs: 200, lockTimeoutMs: 200, queryTimeoutMs: 200 }])('classifies a session advisory lock timeout before other deadlines: %j', async timeouts => {
  const db = await database(); databases.push(db); const store = postgresStore({ databaseUrl: db.appUrl, ...timeouts });
  const blocker = new pg.Client({ connectionString: db.url }); await blocker.connect();
  const input = sampleEnsureSessionInput();
  try {
    await store.ensureSelfUser(sampleSelfUserInput());
    await blocker.query('begin'); await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`${input.key.harness}:${input.key.harnessSessionId}`]);
    expect(await store.ensureSession(input)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  } finally { await blocker.query('rollback'); await blocker.end(); await store.close(); }
});


it.each(['brain.sessions','brain.users','brain.message_attachments','brain.files','brain.schema_migrations'])('preserves DB_LOCKED from reads blocked on %s',async table=>{
  const db=await database();databases.push(db);
  const store=postgresStore({databaseUrl:db.appUrl,lockTimeoutMs:40,queryTimeoutMs:1000});
  const blocker=new pg.Client({connectionString:db.url});await blocker.connect();
  try {
    await blocker.query('begin');await blocker.query(`lock table ${table} in access exclusive mode`);
    const reads:Record<string,()=>Promise<{ok:boolean;code?:string}>>={
      'brain.sessions':()=>store.findSession(sampleEnsureSessionInput().key),
      'brain.users':()=>store.readSelfUser(),
      'brain.message_attachments':()=>store.listMessageAttachments(sampleEnsureSessionInput().id),
      'brain.files':()=>store.listRedactedContentHashes(['sha256:'+ 'a'.repeat(64)]),
      'brain.schema_migrations':()=>checkSchema(store,1),
    };
    expect(await reads[table]!()).toMatchObject({ok:false,code:'DB_LOCKED'});
  } finally {await blocker.query('rollback');await blocker.end();await store.close();}
});
it('rejects a caller-set redaction marker on files but allows the ingestion home pointer',async()=>{
  const db=await database();databases.push(db);
  const id='01940000-0000-7000-8000-000000000777';
  await db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${id}','sha256:${'a'.repeat(64)}',0,'2026-10-28T00:00:00.000Z')`);
  const app=new pg.Client({connectionString:db.appUrl});await app.connect();
  try {
    await app.query("set brain.redacting='on'");
    await expect(app.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at,redacted_at) values ('01940000-0000-7000-8000-000000000778','sha256:${'b'.repeat(64)}',0,'2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z')`)).rejects.toThrow('permission denied');
    await expect(app.query(`update brain.files set redacted_at='2026-10-28T00:00:00.000Z' where id='${id}'`)).rejects.toThrow('permission denied');
    await expect(app.query(`update brain.files set home_location_id=null where id='${id}'`)).resolves.toBeDefined();
    expect(await db.rows('select redacted_at from brain.files')).toEqual([{redacted_at:null}]);
  } finally {await app.end();}
});

it('writes attachment metadata under the restricted runtime column grants and replays it once',async()=>{
  const db=await database();databases.push(db);const store=postgresStore({databaseUrl:db.appUrl});
  try {
    await store.ensureSelfUser(sampleSelfUserInput());await store.ensureSession(sampleEnsureSessionInput());
    const batch=sampleIngestBatch();const attachment={
      id:'01940000-0000-7000-8000-000000000881',harnessMessageId:batch.messages[0]!.harnessMessageId,ordinal:0,
      sourceKind:'file',sourceRef:'fixture.txt',displayName:'fixture.txt',
      file:{id:'01940000-0000-7000-8000-000000000882',contentHash:'sha256:'+'c'.repeat(64),sizeBytes:1,
        location:{id:'01940000-0000-7000-8000-000000000883',storeKind:'local' as const,ownership:'brain' as const,locator:'cc/cc/fixture.txt'},external:null},
    };
    const input={...batch,attachments:[attachment]};
    expect((await store.ingest(input)).ok).toBe(true);expect((await store.ingest(input)).ok).toBe(true);
    const listed=await store.listMessageAttachments(batch.messages[0]!.id);
    expect(listed).toMatchObject({ok:true,attachments:[{id:attachment.id,status:'stored',file:{id:attachment.file.id,home:{locator:'cc/cc/fixture.txt'}}}]});
    expect(await db.rows('select count(*)::int as n from brain.message_attachments')).toEqual([{n:1}]);
  } finally {await store.close();}
});
