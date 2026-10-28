import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterEach, expect, it } from 'vitest';
import { drainQueue, planRedaction, planFileRedaction, runDoctor, tableCleanupHandler,
  TABLE_CLEANUP_KIND, retryFailures, type RedactionCurrent, type CleanupTable, type WorkItem } from '@second-brain/core';
import { memorySpool, sequenceIdGen, sampleEnsureSessionInput, sampleIngestBatch,
  sampleSelfUserInput, sampleSessionToken } from '@second-brain/core/testing';
import { postgresStore, postgresTableMaintenance } from '../src/index.js';
import { pgText } from '../src/text.js';
import { database, clock } from './fixture.js';

const id = (n: number) => `01980000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const closes: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const secret = 'hunter2-x';
const control = 'retained-control-text';
async function fixture(body = `${control} ${secret} next`, options = {}, externalStorage = false,
  { maintenanceLockTimeoutMs = 5000, noteTarget = `a\u0000 ${secret} ${control}` } = {}) {
  const db = await database(); closes.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl, ...options }); closes.push(() => store.close());
  const ids = sequenceIdGen({ timestampMs: clock.now().getTime(), start: 100 });
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
  const batch = sampleIngestBatch(); batch.messages[0]!.body = body;
  batch.toolNotes[0]!.harnessMessageId = batch.messages[0]!.harnessMessageId;
  batch.toolNotes[0]!.target = noteTarget;
  if (externalStorage) await db.query('alter table brain.messages alter column body set storage external');
  await store.ingest(batch);
  const messageId = batch.messages[0]!.id;
  const plan = (current: RedactionCurrent, text = secret) => planRedaction(current,
    { mode: 'text', text, kind: 'manual' }, { now: clock.now, newId: () => ids.next() });
  const redact = (text = secret) => store.redactMessage({ messageId, plan: current => plan(current, text) });
  const maintenance = postgresTableMaintenance({ databaseUrl: db.maintenanceUrl, lockTimeoutMs: maintenanceLockTimeoutMs });
  closes.push(() => maintenance.close());
  let currentTime = clock.now();
  const moving = { now: () => currentTime };
  const drain = () => drainQueue({ store, spool: memorySpool(), clock: moving, idGen: ids },
    { budgetMs: 5000, handlers: { [TABLE_CLEANUP_KIND]: tableCleanupHandler({ maintenance }) } });
  const doctor = async () => (await runDoctor(store, { store, clock: moving, schemaVersion: 1 })).checks.find(c => c.id === 'redaction_cleanup');
  const advance = () => { currentTime = new Date(currentTime.getTime() + 3_600_000); };
  return { db, store, ids, batch, messageId, plan, redact, maintenance, drain, doctor, advance, moving };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function client(url: string) {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  closes.push(async () => { await c.query('rollback'); await c.end(); }); return c;
}
async function chunks(f: Fixture, text = secret) {
  for (const [n, offset] of [[1, 0], [2, 1000]] as const) {
    const at = f.batch.messages[0]!.occurredAt;
    await f.db.query(`insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,body) values
      ('${id(100+n)}','${sampleEnsureSessionInput().id}','019a0000-0000-7000-8000-000000000001',
      '${new Date(at.getTime()-offset).toISOString()}','${new Date(at.getTime()+offset).toISOString()}', '${text}')`);
  }
}
async function file(f: Fixture, { chunkSecret = secret, metadataSecret = secret } = {}) {
  await f.db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values
    ('${id(1)}','sha256:${'a'.repeat(64)}',1,'${clock.now().toISOString()}');
    insert into brain.file_names(id,file_id,name_source,text) values ('${id(2)}','${id(1)}','attachment_name','secret-name.pdf');
    insert into brain.file_metadata(id,file_id,key,value) values ('${id(7)}','${id(1)}','title','${metadataSecret}');`);
  // Both closed and open rows retain pieces before redaction.
  await f.db.query(`insert into brain.document_extractions(id,file_id,extractor_version,attempt,started_at,finished_at,status)
    values ('${id(3)}','${id(1)}','test',1,'${clock.now().toISOString()}','${clock.now().toISOString()}','ok'),
      ('${id(4)}','${id(1)}','test',2,'${clock.now().toISOString()}',null,null);
    update brain.files set current_extraction_id='${id(3)}' where id='${id(1)}';
    insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values
      ('${id(5)}','${id(3)}',0,'${chunkSecret}','{"type":"text","start":0,"end":9}'),
      ('${id(6)}','${id(4)}',0,'${chunkSecret}','{"type":"text","start":0,"end":9}');`);
}
function redactFile(f: Fixture) {
  return f.store.redactFile({ fileId: id(1), plan: current => planFileRedaction(current, { clock, idGen: f.ids }) });
}
async function nodes(f: Fixture, tables = ['messages', 'tool_notes', 'chunks']) {
  return f.db.rows<{ relname: string; relfilenode: number }>(`select relname,relfilenode from pg_class
    where oid in (${tables.map(table => `'brain.${table}'::regclass`).join(',')}) order by relname`);
}
async function heaps(f: Fixture, tables: string[]) {
  return f.db.rows<{ table_name: string; relname: string; is_toast: boolean; bytes: Buffer }>(`
    select p.relname as table_name, c.relname, c.oid<>p.oid as is_toast,
           pg_read_binary_file(pg_relation_filepath(c.oid)) as bytes
      from pg_class p join pg_class c on c.oid=p.oid or c.oid=p.reltoastrelid
     where p.oid in (${tables.map(t => `'brain.${t}'::regclass`).join(',')})`);
}

async function recoverAndDrainCleanup(f: Fixture) {
  // Other databases in the shared cluster can retain our dead tuples long
  // enough to exhaust a work item's attempts. Use the same recovery as a user.
  const failures=await f.db.rows("select id from brain.failures where stage='table_cleanup' and resolved_at is null limit 1");
  if (failures.length>0) await retryFailures({store:f.store,clock:f.moving,idGen:f.ids},{targetKind:'table'});
  await f.drain();
  f.advance();
  return (await f.doctor())?.status;
}

async function cleanupItems(f: Fixture, tables: readonly string[]) {
  for (const table of tables) expect(await f.store.addWork({id:f.ids.next(),kind:TABLE_CLEANUP_KIND,
    targetKind:'table',targetId:table,createdAt:clock.now(),nextAttemptAt:clock.now()})).toMatchObject({ok:true});
}
async function state(f: Fixture) {
  const tables=['messages','tool_notes','chunks','redactions','files','file_names','file_metadata',
    'document_chunks','document_extractions','file_locations','work_items','failures'];
  return (await f.db.rows(`select jsonb_build_object(${tables.map(table=>
    `'${table}',(select coalesce(jsonb_agg(t order by id),'[]'::jsonb) from brain.${table} t)`).join(',')}) as state`))[0]!.state;
}
async function directPayload(f: Fixture, text = secret) {
  const read=await f.store.readSession(sampleSessionToken);
  if (!read.ok) throw new Error(read.message);
  const message=read.messages.find(m=>m.id===f.messageId)!;
  const plan=f.plan({message,toolNotes:read.toolNotes.filter(n=>n.harnessMessageId===message.harnessMessageId)},text);
  if ('refused' in plan) throw new Error('unexpected refusal');
  return {...plan,body:pgText(plan.body).text,bodyRaw:pgText(plan.body).raw?.toString('hex')??null,
    toolNotes:plan.toolNotes.map(note=>({...note,target:pgText(note.target).text,targetRaw:pgText(note.target).raw?.toString('hex')??null}))};
}

it('removes the redacted string from messages, tool notes, chunks and raw bytes', async () => {
  const f = await fixture(); await chunks(f);
  expect(await f.redact()).toMatchObject({ ok: true, bodySpans: 1, toolNoteSpans: 1, chunksRemoved: 2 });
  const rows = await f.db.rows('select body,body_raw from brain.messages union all select target,target_raw from brain.tool_notes union all select body,null from brain.chunks');
  expect(JSON.stringify(rows)).not.toContain(secret);
  for (const row of rows) if (Buffer.isBuffer(row.body_raw)) expect(row.body_raw.includes(secret)).toBe(false);
  expect((await f.db.rows("select target_id from brain.work_items where kind='table_cleanup' order by target_id")).map(r => r.target_id)).toEqual(['chunks','messages','tool_notes']);
});

it('preserves the body when only tool notes are redacted and queues only their cleanup', async () => {
  const f=await fixture(`unchanged\u0000 ${control}`); await chunks(f);
  const before=await f.db.rows(`select * from brain.messages where id='${f.messageId}'`);
  expect(await f.redact()).toMatchObject({ok:true,bodySpans:0,toolNoteSpans:1,toolNotesChanged:1,chunksRemoved:2});
  expect(await f.db.rows(`select * from brain.messages where id='${f.messageId}'`)).toEqual(before);
  const read=await f.store.readSession(sampleSessionToken);
  expect(read.ok && read.toolNotes.find(n=>n.id===f.batch.toolNotes[0]!.id)?.target).toBe(`a\u0000 [REDACTED:manual] ${control}`);
  expect(await f.db.rows('select * from brain.chunks')).toEqual([]);
  expect(await f.db.rows("select kind,target_kind,target_id from brain.work_items where kind='table_cleanup' order by target_id"))
    .toEqual(['chunks','tool_notes'].map(target_id=>({kind:'table_cleanup',target_kind:'table',target_id})));
});

it('keeps U+0000 outside the span and no secret bytes in body_raw', async () => {
  // Include an escape-like literal to ensure byte validation does not confuse
  // a backslash followed by 000 with the actual NUL byte.
  const f = await fixture(`a\u0000 \\000 ${secret} b`);
  expect(await f.redact()).toMatchObject({ ok: true });
  const read = await f.store.readSession(sampleSessionToken);
  expect(read.ok && read.messages.find(m => m.id===f.messageId)?.body).toBe('a\u0000 \\000 [REDACTED:manual] b');
  const raw = (await f.db.rows<{ body_raw: Buffer }>(`select body_raw from brain.messages where id='${f.messageId}'`))[0]!.body_raw;
  expect(raw.includes(secret)).toBe(false); expect(raw.includes(0)).toBe(true);
});

it("removes a redacted file's names and pieces and queues cleanup for its tables", async () => {
  const f = await fixture(); await file(f);
  await f.db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at)
    values('${id(20)}','sha256:${'b'.repeat(64)}',2,'${clock.now().toISOString()}');
    insert into brain.file_metadata(id,file_id,key,value) values
      ('${id(21)}','${id(20)}','title','other file title'),('${id(22)}','${id(20)}','author','other author')`);
  const otherFile=await f.db.rows(`select * from brain.files where id='${id(20)}'`);
  const otherMetadata=await f.db.rows(`select * from brain.file_metadata where file_id='${id(20)}' order by id`);
  expect(await redactFile(f)).toMatchObject({ ok: true, extractionsRemoved: 1, chunksRemoved: 2, namesRemoved: 1, metadataRemoved: 1 });
  expect(await f.db.rows('select id from brain.document_extractions')).toEqual([{ id: id(4) }]);
  expect(await f.db.rows('select * from brain.document_chunks')).toEqual([]);
  expect(await f.db.rows('select * from brain.file_names')).toEqual([]);
  expect(await f.db.rows(`select * from brain.file_metadata where file_id='${id(1)}'`)).toEqual([]);
  expect(await f.db.rows(`select * from brain.files where id='${id(20)}'`)).toEqual(otherFile);
  expect(await f.db.rows(`select * from brain.file_metadata where file_id='${id(20)}' order by id`)).toEqual(otherMetadata);
  expect((await f.db.rows("select target_id from brain.work_items where kind='table_cleanup' order by target_id")).map(r=>r.target_id)).toEqual(['document_chunks','document_extractions','file_metadata','file_names']);
});

it('clears the marker when the redact function returns, so a plain UPDATE on the same connection is refused', async () => {
  const f = await fixture(); const c = await client(f.db.url);
  await cleanupItems(f, ['messages', 'chunks']);
  await c.query('begin');
  const payload = f.plan({ message: { ...f.batch.messages[0]!, sessionId: sampleEnsureSessionInput().id }, toolNotes: [] });
  if ('refused' in payload) throw new Error('unexpected refusal');
  await c.query('select brain.redact_message($1,$2)', [f.messageId, JSON.stringify(payload)]);
  expect((await c.query("select current_setting('brain.redacting',true) as marker")).rows[0].marker).not.toBe('on');
  await expect(c.query("update brain.messages set body='plain'")).rejects.toThrow('invariant refused');
  await c.query('rollback');
  // An existing caller value must also be restored exactly.
  await c.query("set brain.redacting='off'"); await c.query('begin');
  await c.query('select brain.redact_message($1,$2)', [f.messageId, JSON.stringify(payload)]);
  expect((await c.query("select current_setting('brain.redacting',true) as marker")).rows[0].marker).toBe('off');
  await c.query('rollback');
});

it('leaves no marker and no change after a refused redaction rolls back', async () => {
  const f = await fixture(); await chunks(f); const c = await client(f.db.url);
  await cleanupItems(f, ['messages', 'tool_notes', 'chunks']);
  const before = await state(f);
  await c.query('begin'); await c.query('savepoint refused');
  await expect(c.query('select brain.redact_message($1,$2)', [f.messageId, JSON.stringify({ body: 'invented', toolNotes: [], redactions: [] })])).rejects.toThrow('invariant refused');
  await c.query('rollback to refused');
  expect((await c.query("select current_setting('brain.redacting',true) as marker")).rows[0].marker).not.toBe('on');
  await c.query('commit');
  expect(await f.store.redactMessage({ messageId: f.messageId, plan: current => {
    const p=f.plan(current); if ('refused' in p) throw new Error('unexpected refusal'); return {...p,body:'invented'};
  } })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect((await f.db.rows(`select body from brain.messages where id='${f.messageId}'`))[0]!.body).toContain(secret);
  expect(await f.db.rows('select * from brain.redactions')).toEqual([]);
  expect(await state(f)).toEqual(before);
  expect(await f.db.rows('select id from brain.chunks')).toHaveLength(2);
});

it('refuses brain_app every way around the triggers and every table rewrite', async () => {
  const f = await fixture(); await file(f); const c=await client(f.db.appUrl);
  const before=await nodes(f, ['messages','files','document_chunks']);
  await c.query("set brain.redacting='on'");
  for (const statement of ["update brain.messages set body='changed'", "update brain.tool_notes set target='changed'",
    'update brain.files set redacted_at=current_timestamp', 'delete from brain.document_chunks', 'cluster brain.messages using messages_session_occurred_idx',
    'reindex table brain.messages', 'checkpoint', 'set session_replication_role=replica']) await expect(c.query(statement)).rejects.toThrow();
  await expect(c.query('select brain.redact_message($1,$2)',[f.messageId,JSON.stringify({body:'forged',toolNotes:[],redactions:[]})])).rejects.toThrow('invariant refused');
  // PostgreSQL emits a warning and skips VACUUM without MAINTAIN.
  await c.query('vacuum (full) brain.messages');
  expect(await nodes(f,['messages','files','document_chunks'])).toEqual(before);
  expect((await f.db.rows('select count(*)::int as n from brain.document_chunks'))[0]!.n).toBe(2);
  for (const role of ['brain_app','public']) for (const table of ['messages','tool_notes','chunks','document_chunks','document_extractions','file_names','file_metadata']) {
    expect((await f.db.rows(`select has_table_privilege('${role}','brain.${table}','MAINTAIN') as allowed`))[0]!.allowed).toBe(false);
  }
});

it('warns in doctor until the cleanup drain rewrites the tables, then reports ok', async () => {
  const bodySecret=`${secret}-only-in-toast`;
  const noteSecret=`${secret}-only-in-tool-target`;
  const chunkSecret=`${secret}-only-in-chunks`;
  const documentSecret=`${secret}-only-in-document`;
  const metadataSecret=`${secret}-only-in-metadata`;
  const f=await fixture(`${control} ${randomBytes(12000).toString('hex')} ${bodySecret}`, {}, true,
    {noteTarget:`a\u0000 ${noteSecret} ${control}`});
  await chunks(f,chunkSecret); await file(f,{chunkSecret:documentSecret,metadataSecret});
  const tables=['messages','tool_notes','chunks','document_chunks','document_extractions','file_names','file_metadata'];
  await f.db.query('checkpoint');
  const before=await nodes(f,tables);
  expect(await f.redact()).toMatchObject({ok:true}); expect(await redactFile(f)).toMatchObject({ok:true});
  expect(await f.doctor()).toMatchObject({status:'warn'});
  const beforeBytes=await heaps(f,tables);
  expect(beforeBytes.some(r=>r.bytes.includes(secret))).toBe(true);
  expect(beforeBytes.some(r=>r.table_name==='messages' && r.is_toast && r.bytes.includes(bodySecret))).toBe(true);
  const places=[['tool_notes',noteSecret],['chunks',chunkSecret],['document_chunks',documentSecret],
    ['file_metadata',metadataSecret],['file_names','secret-name.pdf']] as const;
  for (const [table,uniqueSecret] of places) {
    expect(beforeBytes.some(r=>r.table_name===table && r.bytes.includes(uniqueSecret))).toBe(true);
  }
  await expect.poll(()=>recoverAndDrainCleanup(f),{timeout:30000,interval:25}).toBe('ok');
  const after=await nodes(f,tables);
  for (const row of after) expect(row.relfilenode).not.toBe(before.find(r=>r.relname===row.relname)!.relfilenode);
  const bytes=await heaps(f,tables);
  const bodyToast=bytes.filter(r=>r.table_name==='messages' && r.is_toast);
  expect(bodyToast.length).toBeGreaterThan(0);
  expect(bodyToast.some(r=>r.bytes.includes(bodySecret))).toBe(false);
  for (const uniqueSecret of [bodySecret,...places.map(([,value])=>value)]) {
    expect(bytes.filter(r=>r.bytes.includes(uniqueSecret)).map(r=>r.relname)).toEqual([]);
  }
  expect(bytes.filter(r=>r.bytes.includes(secret)).map(r=>r.relname)).toEqual([]);
  expect(bytes.some(r=>r.bytes.includes('secret-name.pdf'))).toBe(false);
  expect(bytes.some(r=>r.bytes.includes(control))).toBe(true);
},40000);

it('keeps warning while cleanup waits on a lock, then finishes', async () => {
  const f=await fixture(undefined, {}, false, { maintenanceLockTimeoutMs: 40 }); await f.redact(); const c=await client(f.db.url);
  await c.query('begin'); await c.query('lock brain.messages in access share mode');
  expect(await f.maintenance.cleanup('messages')).toMatchObject({ok:false,code:'DB_LOCKED'});
  await f.drain(); expect(await f.doctor()).toMatchObject({status:'warn'});
  expect((await f.db.rows("select completed_at from brain.work_items where target_id='messages'"))[0]!.completed_at).toBeNull();
  await c.query('rollback'); f.advance();
  await expect.poll(()=>recoverAndDrainCleanup(f),{timeout:30000,interval:25}).toBe('ok');
},40000);

it('keeps warning when cleanup lacks MAINTAIN, even after the failure is recorded', async () => {
  const f=await fixture(); await f.redact();
  await f.db.query('revoke maintain on brain.messages from brain_maintenance');
  const before=await nodes(f);
  await expect.poll(async()=>{
    await f.drain(); f.advance();
    return (await f.db.rows("select id from brain.work_items where kind='table_cleanup' and completed_at is null")).length;
  },{timeout:15000,interval:25}).toBe(0);
  expect((await f.db.rows("select attempts from brain.work_items where kind='table_cleanup' and target_id='messages'"))[0]!.attempts).toBe(10);
  expect((await nodes(f)).find(r=>r.relname==='messages')).toEqual(before.find(r=>r.relname==='messages'));
  expect(await f.db.rows("select * from brain.work_items where kind='table_cleanup' and completed_at is null")).toEqual([]);
  expect(await f.db.rows("select * from brain.failures where stage='table_cleanup' and resolved_at is null")).toHaveLength(1);
  expect(await f.doctor()).toMatchObject({status:'warn',detail:expect.stringContaining('messages')});
  await f.db.query('grant maintain on brain.messages to brain_maintenance');
  expect(await retryFailures({store:f.store,clock:f.moving,idGen:f.ids})).toMatchObject({ok:true,added:1,skipped:[]});
  await expect.poll(()=>recoverAndDrainCleanup(f),{timeout:30000,interval:25}).toBe('ok');
  expect(await f.db.rows("select * from brain.failures where stage='table_cleanup' and resolved_at is null")).toEqual([]);
  expect(await f.db.rows("select resolved_at from brain.failures where stage='table_cleanup'")).toEqual([{resolved_at:expect.any(Date)}]);
},40000);

it('does not close a cleanup that was running when a new redaction committed', async () => {
  const f=await fixture(); await f.redact();
  const claim=await f.store.claimWork({now:clock.now(),kinds:['table_cleanup'],claimedBy:'running'});
  expect(claim.ok && claim.item).toBeTruthy(); if (!claim.ok || claim.item===null) throw new Error('missing claim');
  expect(claim.item.targetId).toBe('messages');
  // Another message's redaction invalidates the table's existing claim.
  const batch=sampleIngestBatch(); const m=batch.messages[1]!;
  expect(await f.store.redactMessage({messageId:m.id,plan:current=>{
    const body=current.message.body;
    return planRedaction(current,{mode:'text',text:body,kind:'manual'},{now:clock.now,newId:()=>f.ids.next()});
  }})).toMatchObject({ok:true});
  expect(await f.store.completeWork({id:claim.item.id,claimedBy:'running',now:clock.now()})).toMatchObject({ok:true,outcome:'lost'});
  expect(await f.db.rows(`select id from brain.work_items where id='${claim.item.id}' and completed_at is null`)).toHaveLength(1);
  expect(await f.doctor()).toMatchObject({status:'warn'});
});

it('serializes two redactions of one message', async () => {
  const f=await fixture(); const other=postgresStore({databaseUrl:f.db.appUrl}); closes.push(()=>other.close());
  const results=await Promise.all([f.redact(),other.redactMessage({messageId:f.messageId,plan:current=>f.plan(current,'next')})]);
  expect(results.every(r=>r.ok)).toBe(true);
  const read=await f.store.readSession(sampleSessionToken);
  expect(read.ok && read.messages.find(m=>m.id===f.messageId)?.body).toBe(`${control} [REDACTED:manual] [REDACTED:manual]`);
  const spans=await f.db.rows(`select start,"end" from brain.redactions where message_id='${f.messageId}' order by start`);
  expect(spans[0]).toEqual({start:22,end:31});
  expect([{start:40,end:44},{start:32,end:36}]).toContainEqual(spans[1]);
});

it('answers DB_LOCKED and DB_UNAVAILABLE from both redact verbs without changing anything', async () => {
  const f=await fixture(undefined,{lockTimeoutMs:40}); await file(f); const c=await client(f.db.url);
  await c.query('begin');
  const key=sampleEnsureSessionInput().key;
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`${key.harness}:${key.harnessSessionId}`]);
  await c.query('select id from brain.files where id=$1 for no key update',[id(1)]);
  expect(await f.redact()).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect(await redactFile(f)).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect(await f.db.rows('select id from brain.redactions')).toEqual([]);
  await c.query('rollback'); await f.db.query('drop schema brain cascade');
  expect(await f.redact()).toMatchObject({ok:false,code:'DB_UNAVAILABLE'});
  expect(await redactFile(f)).toMatchObject({ok:false,code:'DB_UNAVAILABLE'});
  const absent=postgresStore({databaseUrl:'postgres://brain_app:x@127.0.0.1:1/no_db',connectTimeoutMs:40}); closes.push(()=>absent.close());
  expect(await absent.redactMessage({messageId:f.messageId,plan:f.plan})).toMatchObject({ok:false,code:'DB_UNAVAILABLE'});
  expect(await absent.redactFile({fileId:id(1),plan:current=>planFileRedaction(current,{clock,idGen:f.ids})})).toMatchObject({ok:false,code:'DB_UNAVAILABLE'});
});

it('keeps cleanup open while an older snapshot retains dead rows, then removes their bytes', async () => {
  const f=await fixture(); await chunks(f); const snapshot=await client(f.db.url);
  await f.db.query('checkpoint');
  await snapshot.query('begin isolation level repeatable read');
  await snapshot.query('select pg_current_snapshot()');
  await f.redact();
  const before=await nodes(f);
  expect(await f.maintenance.cleanup('messages')).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect((await nodes(f)).find(r=>r.relname==='messages')!.relfilenode).not.toBe(before.find(r=>r.relname==='messages')!.relfilenode);
  await f.drain();
  expect(await f.doctor()).toMatchObject({status:'warn'});
  expect(await f.db.rows("select id from brain.work_items where kind='table_cleanup' and completed_at is null")).toHaveLength(3);
  expect((await heaps(f,['messages'])).some(r=>r.bytes.includes(secret))).toBe(true);
  await snapshot.query('rollback');
  await expect.poll(()=>recoverAndDrainCleanup(f),{timeout:30000,interval:25}).toBe('ok');
  expect((await heaps(f,['messages','tool_notes','chunks'])).filter(r=>r.bytes.includes(secret)).map(r=>r.relname)).toEqual([]);
},40000);

it.each(['message','file'] as const)('refuses a valid direct brain_app %s redaction without cleanup items', async verb => {
  const f=await fixture(); await chunks(f); await file(f);
  const c=await client(f.db.appUrl);
  const payload=verb==='message' ? await directPayload(f) : planFileRedaction({
    file:{id:id(1),contentHash:`sha256:${'a'.repeat(64)}`,redactedAt:null},locations:[],
  },{clock,idGen:f.ids}).redaction;
  const before=await state(f);
  await expect(c.query(`select brain.redact_${verb}($1,$2)`,
    [verb==='message'?f.messageId:id(1),JSON.stringify(payload)])).rejects.toThrow('invariant refused');
  expect(await state(f)).toEqual(before);
});

it.each(['message','file'] as const)('rolls back all %s writes and queued work after a late SQL failure', async verb => {
  const f=await fixture(`a\u0000 ${secret} b`); await chunks(f); await file(f);
  // A deferred trigger runs after every function write, including chunk
  // deletion and adapter queue writes, when the transaction tries to commit.
  await f.db.query(`create function brain.refuse_test_redaction() returns trigger language plpgsql as $$
    begin raise exception 'test redaction insert: invariant refused'; end $$;
    create constraint trigger refuse_test_redaction after insert on brain.redactions
    deferrable initially deferred for each row execute function brain.refuse_test_redaction()`);
  const before=await state(f);
  expect(await (verb==='message'?f.redact():redactFile(f))).toMatchObject({ok:false,code:'DB_UNAVAILABLE'});
  expect(await state(f)).toEqual(before);
});

it.each(['span past end','overlapping spans','another message tool note','missing tool note',
  'old bodyRaw','old targetRaw'] as const)('refuses %s from a direct brain_app call without changing any row', async scenario => {
  const f=await fixture(`a\u0000 ${secret} b`); await chunks(f);
  const payload=await directPayload(f);
  await cleanupItems(f,['messages','tool_notes','chunks']);
  const bodyRecord=payload.redactions.find(r=>r.messageId===f.messageId)!;
  const noteRecord=payload.redactions.find(r=>r.toolNoteId!==null)!;
  if (scenario==='span past end') bodyRecord.end=10000;
  if (scenario==='overlapping spans') payload.redactions.push({...bodyRecord,id:f.ids.next(),start:bodyRecord.start!+1});
  if (scenario==='another message tool note') {
    const other=f.batch.messages[1]!;
    const noteId=f.ids.next();
    await f.db.query(`insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok)
      values('${noteId}','${sampleEnsureSessionInput().id}','${other.harnessMessageId}',99,'read','${secret}',1)`);
    noteRecord.toolNoteId=noteId;
    payload.toolNotes[0]!.id=noteId;
  }
  if (scenario==='missing tool note') payload.toolNotes=[];
  if (scenario==='old bodyRaw') payload.bodyRaw=Buffer.from(f.batch.messages[0]!.body).toString('hex');
  if (scenario==='old targetRaw') payload.toolNotes[0]!.targetRaw=Buffer.from(f.batch.toolNotes[0]!.target).toString('hex');
  const before=await state(f);
  const c=await client(f.db.appUrl);
  await expect(c.query('select brain.redact_message($1,$2)',[f.messageId,JSON.stringify(payload)])).rejects.toThrow('invariant refused');
  expect(await state(f)).toEqual(before);
});

it('records checkpoint permission failures without stopping the drain as unwritable', async () => {
  const f=await fixture(); await f.redact();
  // Role membership is cluster-wide. Hold setup's lock so another fixture
  // cannot grant pg_checkpoint back while this test is exercising its loss.
  const adminUrl=new URL(f.db.url); adminUrl.pathname='/postgres';
  const admin=await client(adminUrl.toString());
  await admin.query('select pg_advisory_lock($1)',[4919270912]);
  try {
    await admin.query('revoke pg_checkpoint from brain_maintenance');
    for (let attempt=0;attempt<10;attempt++) {
      expect(await f.drain()).toMatchObject({stopped:'empty',released:0,spooled:0});
      f.advance();
    }
    expect(await f.db.rows("select attempts,completed_at from brain.work_items where kind='table_cleanup' order by target_id"))
      .toEqual(Array.from({length:3},()=>({attempts:10,completed_at:expect.any(Date)})));
    expect(await f.db.rows("select code from brain.failures where stage='table_cleanup' and resolved_at is null"))
      .toEqual(Array.from({length:3},()=>({code:'TABLE_CLEANUP_FAILED'})));
    expect(await f.doctor()).toMatchObject({status:'warn'});
  } finally {
    await admin.query('grant pg_checkpoint to brain_maintenance');
    await admin.query('select pg_advisory_unlock($1)',[4919270912]);
  }
});

it('redacts a large U+0000 body with linear raw-byte validation', async () => {
  const body=`${'a'.repeat(256000)}\u0000 ${secret} ${'🙂'.repeat(16000)}`;
  const f=await fixture(body);
  expect(await f.redact()).toMatchObject({ok:true});
  const read=await f.store.readSession(sampleSessionToken);
  expect(read.ok && read.messages.find(m=>m.id===f.messageId)?.body).toBe(body.replace(secret,'[REDACTED:manual]'));
  const raw=(await f.db.rows<{body_raw:Buffer}>(`select body_raw from brain.messages where id='${f.messageId}'`))[0]!.body_raw;
  expect(raw.includes(secret)).toBe(false);
});

it.each(['message','file'] as const)('invalidates every old cleanup claim when a direct %s redaction commits after VACUUM', async verb => {
  const f=await fixture(); await chunks(f); await file(f);
  const tables: readonly CleanupTable[]=verb==='message' ? ['messages','tool_notes','chunks']
    : ['document_chunks','document_extractions','file_names','file_metadata'];
  await cleanupItems(f,tables);
  const claimed: WorkItem[]=[];
  for (const _table of tables) {
    const result=await f.store.claimWork({now:clock.now(),kinds:[TABLE_CLEANUP_KIND],claimedBy:'old-worker'});
    if (!result.ok || result.item===null) throw new Error('missing claim');
    claimed.push(result.item);
  }
  const before=await nodes(f,[...tables]);
  for (const item of claimed) expect(await f.maintenance.cleanup(item.targetId as CleanupTable)).toEqual({ok:true});
  for (const row of await nodes(f,[...tables])) expect(row.relfilenode).not.toBe(before.find(r=>r.relname===row.relname)!.relfilenode);
  const payload=verb==='message' ? await directPayload(f) : planFileRedaction({
    file:{id:id(1),contentHash:`sha256:${'a'.repeat(64)}`,redactedAt:null},locations:[],
  },{clock,idGen:f.ids}).redaction;
  const c=await client(f.db.appUrl);
  await c.query(`select brain.redact_${verb}($1,$2)`,[verb==='message'?f.messageId:id(1),JSON.stringify(payload)]);
  for (const item of claimed) {
    expect(await f.store.recordFailure({id:f.ids.next(),targetKind:'table',targetId:item.targetId,stage:TABLE_CLEANUP_KIND,
      fingerprint:'new-redaction',harness:null,sessionId:null,code:'TABLE_CLEANUP_FAILED',message:'new failure',occurredAt:clock.now()})).toMatchObject({ok:true});
  }
  const failures=await f.db.rows('select * from brain.failures order by id');
  // A stale handler reporting success must not settle this newer work's failure.
  const staleHandler=tableCleanupHandler({maintenance:{cleanup:async()=>({ok:true})}});
  for (const item of claimed) {
    expect(await staleHandler(item)).toEqual({ok:true});
    expect(await f.store.completeWork({id:item.id,claimedBy:'old-worker',now:clock.now()})).toEqual({ok:true,outcome:'lost'});
  }
  expect(await f.db.rows('select * from brain.failures order by id')).toEqual(failures);
  expect(await f.db.rows("select claimed_at,claim_expires_at,claimed_by,completed_at from brain.work_items where kind='table_cleanup'"))
    .toEqual(tables.map(()=>({claimed_at:null,claim_expires_at:null,claimed_by:null,completed_at:null})));
  await f.db.query('checkpoint');
  expect((await heaps(f,[...tables])).some(row=>row.bytes.includes(secret))).toBe(true);
  expect(await f.doctor()).toMatchObject({status:'warn'});
});

it('refuses duplicate tool note ids before any row or cleanup claim is changed', async () => {
  const f=await fixture(); await chunks(f);
  const payload=await directPayload(f);
  const first=payload.toolNotes[0]!;
  const chars=Array.from(first.target!);
  for (const r of payload.redactions.filter(r=>r.toolNoteId===first.id).sort((a,b)=>b.start!-a.start!)) {
    chars.splice(r.start!,r.end!-r.start!,`[REDACTED:${r.kind}]`);
  }
  payload.toolNotes.push({...first,target:chars.join(''),targetRaw:null});
  await cleanupItems(f,['messages','tool_notes','chunks']);
  expect(await f.store.claimWork({now:clock.now(),kinds:[TABLE_CLEANUP_KIND],claimedBy:'worker'})).toMatchObject({ok:true,item:{claimedBy:'worker'}});
  const before=await state(f);
  const c=await client(f.db.appUrl);
  await expect(c.query('select brain.redact_message($1,$2)',[f.messageId,JSON.stringify(payload)])).rejects.toThrow('duplicate tool target: invariant refused');
  expect(await state(f)).toEqual(before);
});

it.each([
  {marker:null,refuse:false},{marker:'off',refuse:false},
  {marker:null,refuse:true},{marker:'off',refuse:true},
])('restores the file redaction marker and refuses an ordinary UPDATE (marker=$marker, refused=$refuse)', async ({marker,refuse}) => {
  const f=await fixture(); await file(f);
  await cleanupItems(f,['document_chunks','document_extractions','file_names','file_metadata']);
  const payload=planFileRedaction({file:{id:id(1),contentHash:`sha256:${'a'.repeat(64)}`,redactedAt:null},locations:[]},
    {clock,idGen:f.ids}).redaction;
  if (refuse) await f.db.query(`create function brain.refuse_file_redaction() returns trigger language plpgsql as $$
    begin raise exception 'test file redaction: invariant refused'; end $$;
    create trigger refuse_file_redaction before insert on brain.redactions
      for each row execute function brain.refuse_file_redaction()`);
  const before=await state(f);
  const c=await client(f.db.url);
  if (marker!==null) await c.query("set brain.redacting='off'");
  await c.query('begin'); await c.query('savepoint redaction');
  if (refuse) {
    await expect(c.query('select brain.redact_file($1,$2)',[id(1),JSON.stringify(payload)])).rejects.toThrow('test file redaction: invariant refused');
    await c.query('rollback to redaction');
    expect(await state(f)).toEqual(before);
  } else {
    expect((await c.query('select brain.redact_file($1,$2) as counts',[id(1),JSON.stringify(payload)])).rows[0].counts)
      .toMatchObject({chunksRemoved:2,extractionsRemoved:1,namesRemoved:1,metadataRemoved:1});
    expect((await c.query('select redacted_at from brain.files where id=$1',[id(1)])).rows[0].redacted_at).toEqual(clock.now());
  }
  const restored=(await c.query("select current_setting('brain.redacting',true) as marker")).rows[0].marker;
  if (marker===null) expect(restored).not.toBe('on'); else expect(restored).toBe(marker);
  await expect(c.query("update brain.messages set body='plain'")).rejects.toThrow('invariant refused');
  await c.query('rollback');
  expect(await state(f)).toEqual(before);
});

it('resolves only the redacted file document_extract failures at its occurredAt', async () => {
  const f=await fixture(); await file(f);
  await f.db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at)
    values('${id(20)}','sha256:${'b'.repeat(64)}',1,'${clock.now().toISOString()}')`);
  for (const [n,targetKind,targetId,stage] of [
    [600,'file',id(1),'document_extract'],[601,'file',id(1),'document_extract'],
    [602,'file',id(20),'document_extract'],[603,'file',id(1),'blob_delete'],
    [604,'file',id(1),'document_extract'],[605,'other',id(1),'document_extract'],
  ] as const) expect(await f.store.recordFailure({id:id(n),targetKind,targetId,stage,fingerprint:`cause-${n}`,
    harness:null,sessionId:null,code:'error',message:'failed',occurredAt:clock.now()})).toMatchObject({ok:true});
  await f.db.query(`update brain.failures set resolved_at='${clock.now().toISOString()}' where id='${id(604)}'`);
  const before=await f.db.rows('select * from brain.failures order by id');
  const occurredAt=new Date(clock.now().getTime()+12345);
  expect(await f.store.redactFile({fileId:id(1),plan:current=>planFileRedaction(current,
    {clock:{now:()=>occurredAt},idGen:f.ids})})).toMatchObject({ok:true,failuresResolved:2});
  const after=before.map(row=>[id(600),id(601)].includes(row.id as string)?{...row,resolved_at:occurredAt}:row);
  expect(await f.db.rows('select * from brain.failures order by id')).toEqual(after);
  expect(await redactFile(f)).toMatchObject({ok:true,alreadyRedacted:true,failuresResolved:0});
  expect(await f.db.rows('select * from brain.failures order by id')).toEqual(after);
});

it('serializes direct SQL and Store redactions on the same session advisory key', async () => {
  const storeName='redaction-session-lock-store';
  const directName='redaction-session-lock-direct';
  const f=await fixture(undefined,{applicationName:storeName});
  await cleanupItems(f,['messages','tool_notes','chunks']);
  const payload=await directPayload(f,'next');
  const blocker=await client(f.db.url);
  const blockerPid=(await blocker.query('select pg_backend_pid() as pid')).rows[0].pid as number;
  const key=sampleEnsureSessionInput().key;
  await blocker.query('begin');
  await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`${key.harness}:${key.harnessSessionId}`]);
  const direct=await client(f.db.appUrl);
  await direct.query(`set application_name='${directName}'`);
  await direct.query('begin');
  const directCall=direct.query('select brain.redact_message($1,$2) as removed',[f.messageId,JSON.stringify(payload)]);
  void directCall.catch(()=>{});
  let storeCall: ReturnType<typeof f.redact> | undefined;
  try {
    // Queue direct SQL first, then Store, against the actual session key.
    // Compare their pg_locks identities to the blocker, not just wait events.
    const waitingOnKey=async()=> (await f.db.rows<{n:number}>(`select count(*)::int as n
      from pg_stat_activity a join pg_locks waiting on waiting.pid=a.pid
      join pg_locks held on held.pid=${blockerPid} and held.granted and held.locktype='advisory'
        and waiting.database=held.database and waiting.classid=held.classid
        and waiting.objid=held.objid and waiting.objsubid=held.objsubid
      where a.datname=current_database() and a.application_name in ('${directName}','${storeName}')
        and waiting.locktype='advisory' and not waiting.granted`))[0]!.n;
    await expect.poll(waitingOnKey,{timeout:2000,interval:10}).toBe(1);
    storeCall=f.redact();
    await expect.poll(waitingOnKey,{timeout:2000,interval:10}).toBe(2);
    await blocker.query('rollback');
    expect((await directCall).rows[0].removed).toBe(0);
    // Direct SQL retains its transaction lock after returning; Store waits
    // until commit, then plans from the body containing the first replacement.
    expect((await f.db.rows<{n:number}>(`select count(*)::int as n from pg_stat_activity
      where datname=current_database() and application_name='${storeName}'
        and wait_event_type='Lock' and wait_event='advisory'`))[0]!.n).toBe(1);
    await direct.query('commit');
    expect(await storeCall).toMatchObject({ok:true,bodySpans:1,toolNoteSpans:1});
  } finally {
    await blocker.query('rollback');
    await direct.query('rollback');
    await Promise.allSettled([directCall,...(storeCall===undefined?[]:[storeCall])]);
  }
  const read=await f.store.readSession(sampleSessionToken);
  expect(read.ok && read.messages.find(m=>m.id===f.messageId)?.body).toBe(`${control} [REDACTED:manual] [REDACTED:manual]`);
});

it.each(['ingest','redact'] as const)('serializes actual ingest and redaction on their shared session key (%s starts first)', async first => {
  const f=await fixture(undefined,{applicationName:'redaction-session-key'});
  const other=postgresStore({databaseUrl:f.db.appUrl,applicationName:'ingest-session-key'});
  closes.push(()=>other.close());
  const blocker=await client(f.db.url);
  const key=sampleEnsureSessionInput().key;
  await blocker.query('begin');
  await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`${key.harness}:${key.harnessSessionId}`]);
  const batch=structuredClone(f.batch);
  batch.messages=[...batch.messages,{...batch.messages[0]!,id:f.ids.next(),harnessMessageId:'concurrent-new-message',body:'new message control'}];
  const ingest=()=>other.ingest(batch);
  const [a,b]=first==='ingest' ? [ingest(),f.redact()] : [f.redact(),ingest()];
  try {
    await expect.poll(async()=> (await f.db.rows<{n:number}>(`select count(*)::int as n from pg_stat_activity
      where datname=current_database() and application_name in ('redaction-session-key','ingest-session-key')
        and wait_event_type='Lock' and wait_event='advisory'`))[0]!.n,{timeout:2000,interval:10}).toBe(2);
  } finally { await blocker.query('rollback'); }
  const results=await Promise.all([a,b]);
  const [ingested,redacted]=first==='ingest'?results:[results[1]!,results[0]!];
  expect(ingested).toMatchObject({ok:true,inserted:{messages:1,toolNotes:0}});
  expect(redacted).toMatchObject({ok:true,bodySpans:1,toolNoteSpans:1});
  expect(await other.ingest(batch)).toMatchObject({ok:true,inserted:{messages:0,toolNotes:0}});
  const read=await f.store.readSession(sampleSessionToken);
  expect(read.ok && read.messages.find(m=>m.id===f.messageId)?.body).toBe(`${control} [REDACTED:manual] next`);
  expect(read.ok && read.messages.some(m=>m.body==='new message control')).toBe(true);
  expect(read.ok && read.toolNotes.find(n=>n.id===f.batch.toolNotes[0]!.id)?.target).toBe(`a\u0000 [REDACTED:manual] ${control}`);
  for (const row of await f.db.rows('select body,body_raw from brain.messages union all select target,target_raw from brain.tool_notes')) {
    expect(row.body).not.toContain(secret);
    if (Buffer.isBuffer(row.body_raw)) expect(row.body_raw.includes(secret)).toBe(false);
  }
});

it('refuses a direct file redaction with a mismatched audit hash before changing any row or claim', async () => {
  const f=await fixture(); await file(f);
  await cleanupItems(f,['document_chunks','document_extractions','file_names','file_metadata']);
  await f.store.claimWork({now:clock.now(),kinds:[TABLE_CLEANUP_KIND],claimedBy:'worker'});
  const record=planFileRedaction({file:{id:id(1),contentHash:`sha256:${'b'.repeat(64)}`,redactedAt:null},locations:[]},
    {clock,idGen:f.ids}).redaction;
  const before=await state(f);
  const c=await client(f.db.appUrl);
  await expect(c.query('select brain.redact_file($1,$2)',[id(1),JSON.stringify(record)])).rejects.toThrow('redaction file: invariant refused');
  expect(await state(f)).toEqual(before);
});

it('limits EXECUTE to app entry points and refuses direct internal validation calls', async () => {
  const f=await fixture();
  for (const signature of ['brain.redact_message(uuid,jsonb)','brain.redact_file(uuid,jsonb)']) {
    expect((await f.db.rows(`select has_function_privilege('public','${signature}','EXECUTE') as allowed`))[0]!.allowed).toBe(false);
    expect((await f.db.rows(`select has_function_privilege('brain_app','${signature}','EXECUTE') as allowed`))[0]!.allowed).toBe(true);
  }
  const c=await client(f.db.appUrl);
  for (const [signature,statement] of [
    ['brain.redacted_text(text,jsonb)',"select brain.redacted_text('body','[]'::jsonb)"],
    ['brain.redaction_raw_valid(bytea,bytea,text)',"select brain.redaction_raw_valid(null::bytea,null::bytea,'body')"],
  ]) {
    for (const role of ['public','brain_app']) {
      expect((await f.db.rows(`select has_function_privilege('${role}','${signature}','EXECUTE') as allowed`))[0]!.allowed).toBe(false);
    }
    await expect(c.query(statement!)).rejects.toMatchObject({code:'42501'});
  }
});
