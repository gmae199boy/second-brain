import pg from 'pg';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { TestDatabase } from '@second-brain/test-db';
import { database } from './fixture.js';

const AT = '2026-01-01T00:00:00.000Z';
const ids = new Map<string, string>();
function id(name: string): string {
  if (!ids.has(name)) ids.set(name, `019a0000-0000-7000-8000-${String(ids.size + 100).padStart(12, '0')}`);
  return ids.get(name)!;
}
let db: TestDatabase;
let owner: pg.Client;
const query = (sql: string) => owner.query(sql);
async function refused(sql: string, error: string | Record<string, string>) {
  await query('savepoint refusal');
  const result = query(sql);
  if (typeof error === 'string') await expect(result).rejects.toThrow(error);
  else await expect(result).rejects.toMatchObject(error);
  await query('rollback to savepoint refusal');
}
async function redacting(run: () => Promise<void>) {
  await query("set local brain.redacting = 'on'");
  try { await run(); } finally { await query("set local brain.redacting = 'off'"); }
}
beforeEach(async () => {
  db = await database();
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  await query('begin');
});
afterEach(async () => { await owner?.end(); await db?.drop(); });
async function seed() {
  await query(`
    insert into brain.users values ('${id('u')}', 'owner', 1, '${AT}');
    insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source)
      values ('${id('s')}','demo','s','${id('u')}','machine','${AT}','import');
    insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values
      ('${id('m')}','${id('s')}','m','user','body','${AT}'),
      ('${id('other')}','${id('s')}','other','user','body','${AT}');
    insert into brain.files(id,content_hash,size_bytes,first_seen_at) values
      ('${id('f')}','sha256:${'1'.padStart(64, '0')}',1,'${AT}'),
      ('${id('g')}','sha256:${'2'.padStart(64, '0')}',1,'${AT}'),
      ('${id('r')}','sha256:${'3'.padStart(64, '0')}',1,'${AT}');
    insert into brain.message_attachments(id,message_id,ordinal,source_kind,source_ref,display_name,file_id,status) values
      ('${id('stored')}','${id('m')}',0,'path','/demo/file','file','${id('f')}','stored'),
      ('${id('missing')}','${id('m')}',1,'path',null,null,null,'missing_at_ingest'),
      ('${id('pending')}','${id('m')}',2,'path',null,null,null,null),
      ('${id('pending-missing')}','${id('m')}',3,'path',null,null,null,null);
    insert into brain.document_extractions(id,file_id,extractor_version,attempt,started_at,status,finished_at,failed_stage) values
      ('${id('open')}','${id('f')}','v1',1,'${AT}',null,null,null),
      ('${id('current')}','${id('f')}','v1',2,'${AT}','ok','${AT}',null),
      ('${id('failed')}','${id('f')}','v1',3,'${AT}','failed','${AT}','extract'),
      ('${id('old')}','${id('f')}','v1',4,'${AT}','ok','${AT}',null);
    update brain.files set current_extraction_id='${id('current')}' where id='${id('f')}';
    insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator)
      select id,id,0,'body','{"type":"text"}' from brain.document_extractions;
    insert into brain.file_names values
      ('${id('name')}','${id('f')}','attachment_name','file'),
      ('${id('redacted-name')}','${id('r')}','attachment_name','legacy');
    insert into brain.file_metadata values
      ('${id('meta')}','${id('f')}','camera','demo'),
      ('${id('redacted-meta')}','${id('r')}','camera','legacy');
  `);
  await redacting(async () => { await query(`update brain.files set redacted_at='${AT}' where id='${id('r')}'`); });
}

it('installs the complete catalog, five named unique indexes, five search indexes and explicit seed values', async () => {
  const tables = ['file_import_cleanup','file_request_handoffs','file_request_results','file_requests','channel_item_results','channel_legacy_notifications','channel_legacy_deliveries','channels','channel_conversations','channel_requests','channel_gates','channel_attempt_results','extension_install_progress','extension_python_environment','extension_work_kinds','extensions','schema_migrations','workspaces','users','projects','worktrees','sessions','messages','tool_notes','transcript_files','failures','work_items','work_hold_groups','work_dependencies','work_attempts','files','file_locations','message_attachments','redactions','log_entries','log_entry_edits','index_configs','chunks','context_injections','document_extractions','document_chunks','file_names','file_metadata','schedules','schedule_occurrences','settings'];
  expect((await query("select relname from pg_class where relnamespace='brain'::regnamespace and relkind='r' order by relname")).rows.map(r => r.relname)).toEqual(tables.sort());
  const indexes = (await query("select indexname,indexdef from pg_indexes where schemaname='brain'")).rows;
  expect(indexes.filter(r => r.indexdef.includes('UNIQUE') && r.indexname.endsWith('_idx')).map(r => r.indexname).sort()).toEqual(['users_self_idx','tool_notes_call_id_idx','work_items_open_key_idx','document_extractions_running_idx','index_configs_key_idx'].sort());
  const gin = indexes.filter(r => r.indexdef.includes('USING gin'));
  expect(gin).toHaveLength(5);
  for (const [table, col] of [['chunks','body'],['log_entries','text'],['tool_notes','target'],['document_chunks','body'],['file_names','text']]) {
    expect(gin.find(r => r.indexdef.includes(`brain.${table} `))?.indexdef).toContain(`lower(${col}) gin_trgm_ops`);
  }
  expect(indexes.find(r => r.indexname === 'index_configs_key_idx')?.indexdef).toContain('NULLS NOT DISTINCT');
  expect(indexes.find(r => r.indexname === 'schedules_due_idx')?.indexdef).toContain('WHERE (next_run_at IS NOT NULL)');
  expect((await query('select * from brain.index_configs order by id')).rows).toEqual([
    { id:'019a0000-0000-7000-8000-000000000001',kind:'chunk',model:null,dimensions:null,chunk_params:{targetChars:1200,overlapMessages:1,splitMessagesOverChars:2400} },
    { id:'019a0000-0000-7000-8000-000000000002',kind:'document_chunk',model:null,dimensions:null,chunk_params:{targetChars:1200,overlapChars:120} },
    { id:'019a0000-0000-7000-8000-000000000003',kind:'chunk',model:null,dimensions:null,chunk_params:{targetChars:1200,overlapMessages:1,splitMessagesOverChars:2400,rules:{version:1,order:'occurred_at,id',units:'code_points',separator:'newline',boundary:'include_timestamp_group_at_target',split:'split_limit',parts:'range_0_or_1_to_n'}} },
  ]);
  expect((await query("select table_name,column_name,column_default,is_identity,is_generated from information_schema.columns where table_schema='brain' and (column_default is not null or is_identity <> 'NO' or is_generated <> 'NEVER') order by table_name,column_name")).rows).toEqual([
    {table_name:'channel_attempt_results',column_name:'outcome',column_default:"'sent'::text",is_identity:'NO',is_generated:'NEVER'},
    {table_name:'channel_attempt_results',column_name:'sequence',column_default:null,is_identity:'YES',is_generated:'NEVER'},
    {table_name:'channel_legacy_deliveries',column_name:'metadata_missing',column_default:'true',is_identity:'NO',is_generated:'NEVER'},
    {table_name:'channel_legacy_deliveries',column_name:'resend_eligible',column_default:'false',is_identity:'NO',is_generated:'NEVER'},
    {table_name:'channel_legacy_notifications',column_name:'metadata_missing',column_default:'true',is_identity:'NO',is_generated:'NEVER'},
    {table_name:'channel_legacy_notifications',column_name:'resend_eligible',column_default:'false',is_identity:'NO',is_generated:'NEVER'},
    {table_name:'channel_requests',column_name:'status',column_default:"'pending'::text",is_identity:'NO',is_generated:'NEVER'},
    {table_name:'chunks',column_name:'part',column_default:'0',is_identity:'NO',is_generated:'NEVER'},
    {table_name:'file_requests',column_name:'metadata',column_default:"'{}'::jsonb",is_identity:'NO',is_generated:'NEVER'},
    {table_name:'messages',column_name:'is_subagent_report',column_default:'0',is_identity:'NO',is_generated:'NEVER'},
    {table_name:'work_items',column_name:'attempts',column_default:'0',is_identity:'NO',is_generated:'NEVER'},
  ]);
  expect((await query("select relname from pg_class where relnamespace='brain'::regnamespace and relkind='S'")).rows).toEqual([{ relname: 'channel_attempt_results_sequence_seq' }]);
});

it('checks locator JSON safely and preserves its exact text bytes', async () => {
  await seed();
  const insert = (locator: string | null, page: number | null) => owner.query('insert into brain.document_chunks values ($1,$2,1,$3,$4,$5)', [id('locator'),id('open'),page,'body',locator]);
  for (const [locator,page,code] of [[null,null,'23502'],['{',null,'23514'],['[]',null,'23514'],['{}',null,'23514'],['{"type":"alien"}',null,'23514'],['{"type":"pdf","page":2}',3,'23514'],['{"type":"pdf","page":"3"}',3,'23514'],['{"type":"text"}',3,'23514']] as const) {
    await query('savepoint locator');
    await expect(insert(locator,page)).rejects.toMatchObject({code});
    await query('rollback to savepoint locator');
  }
  for (const [locator,page] of [['{ "type": "pdf", "page": 3, "extra": true }',3],['{"type":"text","start":0,"end":5}',null]] as const) {
    await insert(locator,page);
    expect((await query(`select chunk_locator from brain.document_chunks where id='${id('locator')}'`)).rows[0]?.chunk_locator).toBe(locator);
    await query(`update brain.document_chunks set ordinal=2 where id='${id('locator')}'`);
    await redacting(async () => { await query(`delete from brain.document_chunks where id='${id('locator')}'`); });
  }
});

it('preserves attachment provenance and finalized outcomes, allowing first fills and no-op updates (0008)', async () => {
  await seed();
  for (const change of [`id='${id('changed')}'`,`message_id='${id('other')}'`,'ordinal=10',"source_kind='inline'",'source_ref=null','display_name=null',`file_id='${id('g')}'`,'status=null,file_id=null']) {
    await refused(`update brain.message_attachments set ${change} where id='${id('stored')}'`, 'message_attachments');
  }
  await refused(`update brain.message_attachments set status='stored',file_id='${id('f')}' where id='${id('missing')}'`, 'message_attachments');
  await refused(`update brain.message_attachments set source_ref='new' where id='${id('pending')}'`, 'message_attachments');
  for (const name of ['stored','missing','pending']) await refused(`delete from brain.message_attachments where id='${id(name)}'`,'message_attachments');
  await query(`update brain.message_attachments set status='stored',file_id='${id('f')}' where id='${id('pending')}'; update brain.message_attachments set status='missing_at_ingest' where id='${id('pending-missing')}'; update brain.message_attachments set status=status,file_id=file_id`);
  expect((await query(`select status,file_id from brain.message_attachments where id='${id('pending')}'`)).rows).toEqual([{status:'stored',file_id:id('f')}]);
  await refused(`update brain.message_attachments set status=null where id='${id('pending-missing')}'`,'message_attachments');
});

it('allows open-generation progress and freezes identity and closed fields even under redaction (0008)', async () => {
  await seed();
  for (const change of [`id='${id('changed')}'`,`file_id='${id('g')}'`,"extractor_version='v2'",'attempt=10',"started_at='2026-01-02T00:00:00.000Z'"]) await refused(`update brain.document_extractions set ${change} where id='${id('open')}'`,'document_extractions');
  await refused(`update brain.document_extractions set status='failed',finished_at='${AT}' where id='${id('open')}'`,'failed_stage');
  await refused(`insert into brain.document_extractions(id,file_id,extractor_version,attempt,started_at,status,finished_at) values ('${id('bad-failed')}','${id('g')}','v1',1,'${AT}','failed','${AT}')`,'failed_stage');
  await query(`update brain.document_extractions set media_type='text/plain',error='reading' where id='${id('open')}'; update brain.document_extractions set status='failed',finished_at='${AT}',failed_stage='read',error='failed' where id='${id('open')}'`);
  const check = async () => {
    for (const name of ['current','failed','open']) {
      for (const change of ["media_type='other'","error='changed'",'status=null,finished_at=null',"finished_at='2026-01-02T00:00:00.000Z'","failed_stage='index'"]) await refused(`update brain.document_extractions set ${change} where id='${id(name)}'`,'document_extractions');
      await refused(`update brain.document_extractions set index_config_id='019a0000-0000-7000-8000-000000000001' where id='${id(name)}'`, {message:'document_extractions_immutable_update: invariant refused'});
    }
  };
  await check(); await redacting(check);
  await query('update brain.document_extractions set error=error');
});

it('deletes chunks only after closure, pointer replacement or with the local marker (0008)', async () => {
  await seed();
  for (const name of ['open','current']) await refused(`delete from brain.document_chunks where id='${id(name)}'`,'document_chunks');
  await query(`delete from brain.document_chunks where id='${id('failed')}'; update brain.document_extractions set status='failed',finished_at='${AT}',failed_stage='chunk' where id='${id('open')}'; delete from brain.document_chunks where id='${id('open')}'; update brain.files set current_extraction_id='${id('old')}' where id='${id('f')}'; delete from brain.document_chunks where id='${id('current')}'`);
  await refused(`delete from brain.document_chunks where id='${id('old')}'`,'document_chunks');
  await redacting(async () => { await query(`delete from brain.document_chunks where id='${id('old')}'`); });
  expect((await query('select count(*)::int n from brain.document_chunks')).rows).toEqual([{n:0}]);
  await query('commit');
  expect((await query("select current_setting('brain.redacting',true) as marker")).rows[0]?.marker).not.toBe('on');
});

it('refuses names and metadata for redacted targets and permits regeneration elsewhere (0008)', async () => {
  await seed();
  const check = async () => {
    for (const table of ['file_names','file_metadata']) {
      await refused(`update brain.${table} set file_id='${id('r')}' where file_id='${id('f')}'`,table);
      await refused(`update brain.${table} set file_id=file_id where file_id='${id('r')}'`,table);
    }
    await refused(`insert into brain.file_names values ('${id('new')}','${id('r')}','attachment_name','new')`,'file_names');
    await refused(`insert into brain.file_metadata values ('${id('new')}','${id('r')}','key','value')`,'file_metadata');
  };
  await check(); await redacting(check);
  await query(`delete from brain.file_names; delete from brain.file_metadata; insert into brain.file_names values ('${id('name')}','${id('f')}','attachment_name','rebuilt'); insert into brain.file_metadata values ('${id('meta')}','${id('f')}','camera','rebuilt'); update brain.file_names set text='renamed'; update brain.file_metadata set value='updated'`);
  expect((await query('select text from brain.file_names')).rows).toEqual([{text:'renamed'}]);
  expect((await query('select value from brain.file_metadata')).rows).toEqual([{value:'updated'}]);
});

it('enforces same-file extraction pointers, running uniqueness, recurring schedules and config keys', async () => {
  await seed();
  await refused(`update brain.files set current_extraction_id='${id('current')}' where id='${id('g')}'`,'files_extraction_check');
  await refused(`insert into brain.files(id,content_hash,size_bytes,first_seen_at,current_extraction_id) values ('${id('new-file')}','sha256:${'4'.repeat(64)}',1,'${AT}','${id('current')}')`,'files_extraction_check_insert');
  await refused(`insert into brain.document_extractions(id,file_id,extractor_version,attempt,started_at) values ('${id('second-open')}','${id('f')}','v2',5,'${AT}')`,{code:'23505'});
  for (const [interval,next] of [[10,'null'],[0,`'${AT}'`],[-1,`'${AT}'`]]) await refused(`insert into brain.schedules values ('${id('schedule')}','demo','file','f',${interval},${next},null,'${AT}')`,{code:'23514'});
  await query(`insert into brain.schedules values ('${id('schedule')}','demo','file','f',null,null,null,'${AT}')`);
  for (const params of ['[]','{}','{"targetChars":1,"overlapChars":null}','{"targetChars":1,"overlapChars":"2"}','{"targetChars":1,"overlapChars":2,"extra":3}']) await refused(`insert into brain.index_configs values ('${id('bad-config')}','document_chunk',null,null,'${params}')`,{code:'23514'});
  await refused(`insert into brain.index_configs values ('${id('duplicate-config')}','document_chunk',null,null,'{"overlapChars":120,"targetChars":1200}')`,{code:'23505'});
  for (const kind of ['chunk','embedding']) {
    for (const params of ['{"targetChars":1200,"overlapMessages":1}', '{"targetChars":1200,"overlapMessages":1,"splitMessagesOverChars":2400,"extra":3}', '{"targetChars":1200,"overlapMessages":"1","splitMessagesOverChars":2400}']) {
      await refused(`insert into brain.index_configs values ('${id('bad-config')}','${kind}',null,null,'${params}')`, {code:'23514'});
    }
  }
  await query(`insert into brain.index_configs values ('${id('embedding-config')}','embedding','test-model',1536,'{"targetChars":1200,"overlapMessages":1,"splitMessagesOverChars":2400}')`);
  expect((await query(`select kind,model,dimensions from brain.index_configs where id='${id('embedding-config')}'`)).rows).toEqual([{kind:'embedding',model:'test-model',dimensions:1536}]);
});

it('protects the eight invariant tables against TRUNCATE and existing originals against mutation', async () => {
  await seed();
  await query(`insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok) values ('${id('tool')}','${id('s')}','m',0,'read','target',1); insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${id('location')}','${id('f')}','local','fixture','brain','${AT}'); insert into brain.redactions(id,message_id,start,"end",kind,content_hash,occurred_at) values ('${id('redaction')}','${id('m')}',0,1,'manual','hash','${AT}')`);
  const protectedTables = ['messages','tool_notes','redactions','files','file_locations','message_attachments','document_extractions','document_chunks'];
  expect((await query(`select c.relname from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where c.relnamespace='brain'::regnamespace and t.tgfoid='brain.refuse_truncate()'::regprocedure
      and not t.tgisinternal and t.tgenabled in ('O','A') and t.tgtype=34
    order by c.relname`)).rows.map(row => row.relname)).toEqual([...protectedTables].sort());
  for (const table of protectedTables) await refused(`truncate brain.${table} cascade`,'truncate refused');
  for (const table of ['messages','tool_notes','redactions','files','file_locations']) await refused(`delete from brain.${table}`,'invariant refused');
  for (const [table,change] of [['messages',"body='changed'"],['tool_notes',"target='changed'"],['redactions',"kind='changed'"],['files','size_bytes=9'],['file_locations',"locator='changed'"]]) await refused(`update brain.${table} set ${change}`,'invariant refused');
});

it('refuses chunk deletion after a concurrent transaction publishes its generation', async () => {
  await seed();
  await query('commit');
  const deleter = new pg.Client({ connectionString: db.url });
  await deleter.connect();
  const deleterPid = (await deleter.query('select pg_backend_pid() as pid')).rows[0]!.pid;
  try {
    await query('begin');
    await query(`update brain.files set current_extraction_id='${id('old')}' where id='${id('f')}'`);
    await deleter.query('begin');
    const deletion = deleter.query(`delete from brain.document_chunks where id='${id('old')}'`)
      .then(() => null, (error: Error) => error);
    await expect.poll(async () => (await query(`select pg_backend_pid() = any(pg_blocking_pids(${deleterPid})) as blocked`)).rows[0]?.blocked).toBe(true);
    await query('commit');
    expect(await deletion).toMatchObject({ message: 'document_chunks_delete_rule: invariant refused' });
    await deleter.query('rollback');
    expect((await query(`select id from brain.document_chunks where id='${id('old')}'`)).rows).toEqual([{id:id('old')}]);
  } finally {
    await query('rollback');
    await deleter.query('rollback');
    await deleter.end();
  }
});

it('allows only the granted extraction pointer updates through brain_app', async () => {
  await seed();
  await query('commit');
  const app = new pg.Client({ connectionString: db.appUrl });
  await app.connect();
  try {
    await app.query(`update brain.files set current_extraction_id='${id('old')}' where id='${id('f')}'`);
    expect((await app.query(`select current_extraction_id from brain.files where id='${id('f')}'`)).rows).toEqual([{current_extraction_id:id('old')}]);
    await expect(app.query(`update brain.files set current_extraction_id='${id('current')}' where id='${id('g')}'`))
      .rejects.toMatchObject({message:'files_extraction_check: invariant refused'});
    await expect(app.query(`update brain.files set current_extraction_id='${id('current')}',redacted_at='${AT}' where id='${id('f')}'`))
      .rejects.toMatchObject({code:'42501',message:'permission denied for table files'});
  } finally { await app.end(); }
});

it.each([
  ['file_names', 'insert'], ['file_names', 'update'],
  ['file_metadata', 'insert'], ['file_metadata', 'update'],
] as const)('serializes concurrent redaction with %s %s in both lock orders', async (table, operation) => {
  await query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values
    ('${id('race-target')}','sha256:${'a'.repeat(64)}',1,'${AT}'),
    ('${id('race-source')}','sha256:${'b'.repeat(64)}',1,'${AT}')`);
  const insert = (file: string) => table === 'file_names'
    ? `insert into brain.file_names values ('${id('race-derived')}','${id(file)}','attachment_name','name')`
    : `insert into brain.file_metadata values ('${id('race-derived')}','${id(file)}','camera','value')`;
  if (operation === 'update') await query(insert('race-source'));
  await query('commit');
  const writer = new pg.Client({ connectionString: db.url });
  await writer.connect();
  const writerPid = (await writer.query('select pg_backend_pid() as pid')).rows[0]!.pid;
  const derivedWrite = operation === 'insert' ? insert('race-target')
    : `update brain.${table} set file_id='${id('race-target')}' where id='${id('race-derived')}'`;
  const redact = `update brain.files set redacted_at='${AT}' where id='${id('race-target')}'`;
  const waitForBlock = async () => {
    await expect.poll(async () => (await query(`select cardinality(pg_blocking_pids(${writerPid})) > 0 as blocked`)).rows[0]?.blocked).toBe(true);
  };
  try {
    // The target looks unredacted to the other connection until this commits.
    await query('begin');
    await query("set local brain.redacting='on'");
    await query(redact);
    await writer.query('begin');
    const refusedWrite = writer.query(derivedWrite).then(() => null, (error: Error) => error);
    await waitForBlock();
    await query('commit');
    expect(await refusedWrite).toMatchObject({ message: `${table}_redacted_${operation}: invariant refused` });
    await writer.query('rollback');
    expect((await query(`select count(*)::int n from brain.${table} where file_id='${id('race-target')}'`)).rows).toEqual([{ n: 0 }]);

    // A successful write to an unredacted row holds FOR SHARE until commit.
    await query('begin');
    await query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${id('race-next')}','sha256:${'c'.repeat(64)}',1,'${AT}')`);
    await query('commit');
    await query('begin');
    await query(operation === 'insert' ? insert('race-next')
      : `update brain.${table} set file_id='${id('race-next')}' where id='${id('race-derived')}'`);
    await writer.query('begin');
    await writer.query("set local brain.redacting='on'");
    const pendingRedaction = writer.query(`update brain.files set redacted_at='${AT}' where id='${id('race-next')}'`);
    await waitForBlock();
    await query('commit');
    await pendingRedaction;
    await writer.query(`delete from brain.${table} where file_id='${id('race-next')}'`);
    await writer.query('commit');
    expect((await query(`select count(*)::int n from brain.${table} where file_id='${id('race-next')}'`)).rows).toEqual([{ n: 0 }]);
  } finally {
    // Release the blocker first so a failed assertion cannot strand a query.
    await query('rollback');
    await writer.query('rollback');
    await writer.end();
  }
});
it('constrains work outcomes and positive process identifiers without generated identity defaults', async () => {
  await query(`insert into brain.work_items (id,kind,target_kind,target_id,created_at,attempts,next_attempt_at,execution_class)
    values ('${id('cancel-work')}','process_probe','probe','test','${AT}',0,'${AT}','supervised')`);
  await query(`insert into brain.work_attempts (token,work_item_id,started_at) values ('${id('cancel-attempt')}','${id('cancel-work')}','${AT}')`);
  for (const column of ['pid', 'pgid']) for (const invalid of [0, -1]) await refused(`update brain.work_attempts set ${column}=${invalid}`, { code: '23514' });
  await refused("update brain.work_items set outcome='alien'", { code: '23514' });
  await refused("update brain.work_items set outcome='cancelled'", { code: '23514' });
  for (const outcome of ['succeeded', 'failed', 'cancelled', 'dependency_failed']) await query(`update brain.work_items set completed_at='${AT}',outcome='${outcome}'`);
  expect((await query(`select column_default from information_schema.columns where table_schema='brain' and
    ((table_name='work_attempts' and column_name in ('incarnation','pid','pgid','os_boot_at','os_started_at')) or
     (table_name='work_items' and column_name in ('outcome','cancel_requested_at')))`)).rows).toEqual(Array.from({ length: 7 }, () => ({ column_default: null })));
});
