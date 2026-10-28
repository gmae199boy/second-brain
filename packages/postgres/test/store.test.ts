import { checkSchema } from '@second-brain/core';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sessionRedactionContract, fileRedactionContract, schemaStoreContract, storeContract, sessionIngestContract, userStoreContract, sampleEnsureSessionInput, sampleSchemaVersions, sampleSelfUserInput, sampleIngestBatch, sampleSessionToken, sampleTranscriptFileInput, sampleCheckoutInput, sampleSessionKey, sessionMetadataContract, transcriptFileStoreContract } from '@second-brain/core/testing';
import { postgresStore, POSTGRES_DOCTOR_PROBE_IDS } from '../src/index.js';
import { database, subject } from './fixture.js';
import type { TestDatabase } from '@second-brain/test-db';
const databases: TestDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.drop())); });
for (const [name, cases] of [['session redaction', sessionRedactionContract()], ['file redaction', fileRedactionContract()], ['ingest', sessionIngestContract()], ['session metadata', sessionMetadataContract()], ['transcript', transcriptFileStoreContract()], ['user', userStoreContract()], ['health', storeContract()], ['schema', schemaStoreContract()]] as const) {
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
  try { expect(await store.readSchemaVersions()).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' }); expect(await store.findSession(sampleEnsureSessionInput().key)).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' }); }
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
      'brain.schema_migrations':()=>checkSchema(store,{ core: 1 }),
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

it('returns only requested redacted hashes through brain_app', async () => {
  const db = await database(); databases.push(db);
  const hashes = ['a', 'b', 'c'].map(letter => 'sha256:' + letter.repeat(64));
  for (const [index, hash] of hashes.entries()) {
    await db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at,redacted_at)
      values ('01940000-0000-7000-8000-00000000090${index}','${hash}',0,'2026-10-28T00:00:00.000Z',${index === 1 ? 'null' : "'2026-10-28T01:00:00.000Z'"})`);
  }
  const store = postgresStore({ databaseUrl: db.appUrl });
  try {
    expect(await store.listRedactedContentHashes([hashes[0]!, hashes[1]!, 'sha256:' + 'd'.repeat(64)]))
      .toEqual({ ok: true, hashes: [hashes[0]] });
  } finally { await store.close(); }
});

it('keeps newer transcript history when an older smaller read finishes late', async () => {
  const db = await database(); databases.push(db);
  const store = postgresStore({ databaseUrl: db.appUrl });
  try {
    const first = sampleTranscriptFileInput();
    const expected = { id: first.id, harness: first.harness, path: first.path,
      sizeBytes: first.sizeBytes, fingerprint: first.fingerprint, cursor: first.cursor, scannedAt: first.scannedAt };
    expect(await store.recordTranscriptFile(first)).toEqual({ ok: true, file: expected });
    const grown = sampleTranscriptFileInput({ id: '01940000-0000-7000-8000-000000000901', sizeBytes: 2048,
      fingerprint: 'sha256:' + 'c'.repeat(64), cursor: { lastHarnessMessageId: 'm4', fingerprint: 'sha256:' + 'd'.repeat(64) },
      scannedAt: new Date('2026-02-03T05:05:06.000Z') });
    const newer = { ...expected, sizeBytes: grown.sizeBytes, fingerprint: grown.fingerprint,
      cursor: grown.cursor, scannedAt: grown.scannedAt };
    expect(await store.recordTranscriptFile(grown)).toEqual({ ok: true, file: newer });
    for (const scannedAt of [first.scannedAt, grown.scannedAt]) {
      expect(await store.recordTranscriptFile(sampleTranscriptFileInput({ sizeBytes: 512,
        fingerprint: 'sha256:' + 'e'.repeat(64), cursor: null, scannedAt })))
        .toEqual({ ok: true, file: newer });
    }
    expect(await db.rows('select * from brain.transcript_files')).toEqual([{
      id: first.id, harness: first.harness, path: first.path, size_bytes: grown.sizeBytes,
      fingerprint: grown.fingerprint, last_harness_message_id: grown.cursor!.lastHarnessMessageId, last_harness_message_id_raw: null,
      cursor_fingerprint: grown.cursor!.fingerprint, scanned_at: grown.scannedAt,
    }]);
  } finally { await store.close(); }
});

it('persists identity work only when ensureSession creates the session', async () => {
  const db = await database(); databases.push(db);
  const store = postgresStore({ databaseUrl: db.appUrl });
  try {
    expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
    const at = new Date('2026-01-02T03:06:00.000Z');
    const work = { id: '01940000-0000-7000-8000-000000000810', kind: 'session_identity',
      targetKind: 'session', targetId: sampleSessionToken, createdAt: at, nextAttemptAt: at };
    expect(await store.ensureSession(sampleEnsureSessionInput({ identityWork: work }))).toMatchObject({ ok: true, created: true });
    expect(await store.ensureSession(sampleEnsureSessionInput({ identityWork: { ...work,
      id: '01940000-0000-7000-8000-000000000811', targetId: 'demo:late' } })))
      .toMatchObject({ ok: true, created: false });
    expect(await db.rows('select * from brain.work_items')).toEqual([{
      id: work.id, kind: work.kind, target_kind: work.targetKind, target_id: work.targetId,
      created_at: at, attempts: 0, next_attempt_at: at, claimed_at: null,
      claim_expires_at: null, claimed_by: null, last_error: null, completed_at: null,
    }]);
  } finally { await store.close(); }
});

it('round trips first cwd and transcript cursors with NUL and preserves the first evidence', async () => {
  const db = await database(); databases.push(db);
  const store = postgresStore({ databaseUrl: db.appUrl });
  try {
    expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
    expect((await store.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
    const firstCwd = 'cwd-a\u0000b';
    const filled = await store.fillSessionTags({ key: sampleSessionKey, firstCwd,
      checkout: sampleCheckoutInput(), tagSource: 'cwd' });
    expect(filled).toMatchObject({ ok: true, filled: true, session: { firstCwd } });
    expect(await store.fillSessionTags({ key: sampleSessionKey, firstCwd: 'changed', checkout: null, tagSource: null }))
      .toMatchObject({ ok: true, filled: false, session: { firstCwd, tagSource: 'cwd' } });
    expect(await store.findSession(sampleSessionKey)).toMatchObject({ ok: true, session: { firstCwd } });
    const rows = await db.rows<{ first_cwd: string; first_cwd_raw: Buffer }>('select first_cwd, first_cwd_raw from brain.sessions');
    expect(rows).toEqual([{ first_cwd: 'cwd-a\ufffdb', first_cwd_raw: Buffer.from(firstCwd) }]);
    const cursor = { lastHarnessMessageId: 'cursor-a\u0000b', fingerprint: 'sha256:' + 'a'.repeat(64) };
    expect((await store.recordTranscriptFile(sampleTranscriptFileInput({ cursor }))).ok).toBe(true);
    expect(await store.listTranscriptFiles({ harness: sampleTranscriptFileInput().harness }))
      .toMatchObject({ ok: true, files: [{ cursor }] });
  } finally { await store.close(); }
});

it('orders stale session ids and transcript paths by bytes across case and Korean text', async () => {
  const db = await database(); databases.push(db);
  const store = postgresStore({ databaseUrl: db.appUrl });
  const names = ['한글', 'a', '가', 'Z', 'A', 'z'];
  try {
    expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
    for (const [i, name] of names.entries()) {
      const id = `01940000-0000-7000-8000-${String(9000 + i).padStart(12, '0')}`;
      expect((await store.ensureSession(sampleEnsureSessionInput({ id,
        key: { harness: 'demo', harnessSessionId: name } }))).ok).toBe(true);
      expect((await store.recordTranscriptFile(sampleTranscriptFileInput({ id, path: name }))).ok).toBe(true);
    }
    const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(await store.listStaleSessions({ harness: 'demo', parserVersion: 'current' }))
      .toEqual({ ok: true, sessions: sorted.map(harnessSessionId => ({ harnessSessionId })) });
    const files = await store.listTranscriptFiles({ harness: sampleTranscriptFileInput().harness });
    expect(files.ok && files.files.map(file => file.path)).toEqual(sorted);
  } finally { await store.close(); }
});

it('excludes completed identity work from open targets but still excludes its session from candidates', async () => {
  const db = await database(); databases.push(db);
  const store = postgresStore({ databaseUrl: db.appUrl });
  try {
    await store.ensureSelfUser(sampleSelfUserInput());
    const now = new Date('2026-10-28T00:00:00.000Z');
    const work = { id: '01940000-0000-7000-8000-000000000810', kind: 'session_identity',
      targetKind: 'session', targetId: sampleSessionToken, createdAt: now, nextAttemptAt: now };
    expect((await store.ensureSession(sampleEnsureSessionInput({ identityWork: work }))).ok).toBe(true);
    expect(await store.listOpenWorkTargets({ kind: 'other' })).toEqual({ ok: true, targets: [] });
    await db.query("update brain.work_items set completed_at='2026-10-28T01:00:00.000Z'");
    expect(await store.listOpenWorkTargets({ kind: work.kind })).toEqual({ ok: true, targets: [] });
    expect(await store.listIdentityCandidates()).toEqual({ ok: true, sessions: [] });
  } finally { await store.close(); }
});

it('returns DB_UNAVAILABLE values from every added verb when the database is unreachable', async () => {
  const store = postgresStore({ databaseUrl: 'postgresql://brain_app:unused@127.0.0.1:1/unavailable', connectTimeoutMs: 100 });
  try {
    const results = await Promise.all([
      store.listStaleSessions({ harness: 'demo', parserVersion: 'current' }), store.listIdentityCandidates(),
      store.countUntaggedSessions(), store.fillSessionTags({ key: sampleSessionKey, checkout: null, firstCwd: null, tagSource: null }),
      store.listTranscriptFiles({ harness: 'demo' }), store.listOpenWorkTargets({ kind: 'session_identity' }),
    ]);
    for (const result of results) expect(result).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  } finally { await store.close(); }
});

it('fillSessionTags uses the same session advisory lock as ingest', async () => {
  const db = await database(); databases.push(db);
  const store = postgresStore({ databaseUrl: db.appUrl, lockTimeoutMs: 50 });
  const blocker = new pg.Client({ connectionString: db.url });
  await blocker.connect();
  try {
    await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
    await blocker.query('begin');
    await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [sampleSessionToken]);
    expect(await store.fillSessionTags({ key: sampleSessionKey, checkout: sampleCheckoutInput(), firstCwd: 'new', tagSource: 'cwd' }))
      .toMatchObject({ ok: false, code: 'DB_LOCKED' });
    expect(await store.findSession(sampleSessionKey)).toMatchObject({ ok: true, session: { firstCwd: null, projectId: null } });
  } finally { await blocker.query('rollback'); await blocker.end(); await store.close(); }
});

it.each(['brain.sessions', 'brain.transcript_files', 'brain.work_items', 'brain.failures'])('maps read lock failures on %s to DB_LOCKED', async table => {
  const db = await database(); databases.push(db);
  const store = postgresStore({ databaseUrl: db.appUrl, lockTimeoutMs: 40, queryTimeoutMs: 1000 });
  const blocker = new pg.Client({ connectionString: db.url }); await blocker.connect();
  try {
    await blocker.query('begin');
    await blocker.query(`lock table ${table} in access exclusive mode`);
    const reads = table === 'brain.sessions' ? [
      () => store.listStaleSessions({ harness: 'demo', parserVersion: 'current' }),
      () => store.listIdentityCandidates(), () => store.countUntaggedSessions(),
    ] : table === 'brain.transcript_files' ? [
      () => store.listTranscriptFiles({ harness: 'demo' }),
    ] : table === 'brain.failures' ? [
      () => store.listFailures({ includeResolved: false }),
    ] : [() => store.listOpenWorkTargets({ kind: 'session_identity' })];
    for (const read of reads) expect(await read()).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  } finally { await blocker.query('rollback'); await blocker.end(); await store.close(); }
});

it('reads the highest migration version for every owner', async () => {
  const db = await database(); databases.push(db);
  await db.query("insert into brain.schema_migrations(owner,version,name,checksum,applied_at) values ('garmin',1,'first','a','2026-01-03T00:00:00Z'),('garmin',3,'third','b','2026-01-02T00:00:00Z')");
  const store = postgresStore({ databaseUrl: db.appUrl });
  try {
    const versions = await store.readSchemaVersions();
    expect(versions.ok && Object.keys(versions.versions)).toEqual(['core', 'garmin']);
    expect(versions).toMatchObject({ ok: true, versions: { core: { version: 1 }, garmin: { version: 3, appliedAt: new Date('2026-01-02T00:00:00Z') } } });
    expect(await checkSchema(store, { core: 1, garmin: 3 })).toMatchObject({ ok: true });
    expect(await checkSchema(store, { core: 1 })).toMatchObject({ ok: true });
  } finally { await store.close(); }
});

describe('schema owner maxima contract', () => {
  for (const test of schemaStoreContract(sampleSchemaVersions())) it(test.name, () => test.run(async () => {
    const db = await database();
    await db.query("insert into brain.schema_migrations(owner,version,name,checksum,applied_at) values ('garmin',1,'first','a','2026-01-01T00:00:00Z'),('garmin',3,'third','b','2026-01-02T00:00:00Z')");
    const store = postgresStore({ databaseUrl: db.appUrl });
    return { ...store, async close() { await store.close(); await db.drop(); } };
  }));
});

it('checks writable as brain_app and rolls back every probe row', async () => {
  const db = await database(); databases.push(db);
  const store = postgresStore({ databaseUrl: db.appUrl });
  try {
    const health = await store.checkHealth();
    expect(health).toMatchObject({ ok: true, source: { probes: expect.arrayContaining([{ id: 'writable', ok: true, detail: expect.any(String) }]) } });
    if (health.ok) expect(health.source.probes.map(probe => probe.id)).toEqual(POSTGRES_DOCTOR_PROBE_IDS);
    expect(await db.rows("select * from brain.settings where key='doctor.writable'")).toEqual([]);
  } finally { await store.close(); }
});
it('warns when the writable probe exceeds its lock budget and still rolls back', async () => {
  const db = await database(); databases.push(db);
  const blocker = new pg.Client({ connectionString: db.url }); await blocker.connect();
  const store = postgresStore({ databaseUrl: db.appUrl, lockTimeoutMs: 40, queryTimeoutMs: 1000 });
  try {
    await blocker.query('begin');
    await blocker.query("insert into brain.settings(key,value,updated_at) values ('doctor.writable','locked','2000-01-01Z')");
    expect(await store.checkHealth()).toMatchObject({ ok: true, source: { probes: expect.arrayContaining([{ id: 'writable', ok: true, warn: true, detail: expect.any(String) }]) } });
  } finally { await blocker.query('rollback'); await blocker.end(); await store.close(); }
  expect(await db.rows("select * from brain.settings where key='doctor.writable'")).toEqual([]);
});
it.each(['read-only', 'permission-denied'])('reports a failed writable probe without warning for %s and keeps the other probes', async mode => {
  const db = await database(); databases.push(db);
  const url = new URL(db.appUrl);
  if (mode === 'read-only') url.searchParams.set('options', '-c default_transaction_read_only=on');
  else await db.query('revoke insert, update on brain.settings from brain_app');
  const store = postgresStore({ databaseUrl: url.toString() });
  try {
    const health = await store.checkHealth();
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    expect(health.source.probes.map(probe => probe.id)).toEqual(POSTGRES_DOCTOR_PROBE_IDS);
    const writable = health.source.probes.find(probe => probe.id === 'writable');
    expect(writable).toMatchObject({ ok: false });
    expect(writable).not.toHaveProperty('warn');
    expect(health.source.probes.filter(probe => probe.id !== 'writable')).toEqual([
      { id: 'pg_trgm', ok: true, detail: 'pg_trgm' },
      { id: 'redaction_cleanup', ok: true, warn: false, detail: '저장본 정리가 끝났습니다' },
    ]);
  } finally { await store.close(); }
});
