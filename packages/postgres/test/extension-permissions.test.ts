import { sampleSelfUserInput } from '@second-brain/core/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { CORE_SCHEMA_VERSION, provisionExtension, postgresStore } from '../src/index.js';
import { database, clock } from './fixture.js';

it('enforces the role, public view and fenced provenance contracts over real connections', async () => {
  const db = await database();
  const suffix = randomBytes(5).toString('hex');
  const names = [`x${suffix}a`, `x${suffix}b`];
  const roles = names.map(name => `brain_ext_${name}`);
  const password = randomBytes(24).toString('hex');
  const admin = new pg.Client({ connectionString: db.url });
  const clients: pg.Client[] = [];
  const store = postgresStore({ databaseUrl: db.appUrl });
  try {
    await admin.connect();
    const self = await store.ensureSelfUser(sampleSelfUserInput()); if (!self.ok) throw Error(self.message);
    const adminOverride = new URL(db.url);
    adminOverride.searchParams.set('user', adminOverride.username);
    adminOverride.searchParams.set('password', decodeURIComponent(adminOverride.password));
    for (const name of names) await provisionExtension(adminOverride.toString(), name, password);
    for (const role of roles) {
      const url = new URL(db.url); url.username = role; url.password = password;
      const client = new pg.Client({ connectionString: url.toString() }); await client.connect(); clients.push(client);
    }
    const [a, b] = clients as [pg.Client, pg.Client];
    await admin.query(`insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at,connection_status,connection_checked_at,connection_message)
      values ($1,'1',now(),true,now(),'failed',now(),'secret sentinel'),($2,'1',now(),false,now(),null,null,null)`, names);
    expect((await a.query('select * from brain.extension_status_public_v1')).rows).toEqual([{ name: names[0], enabled: true, connection_status: 'failed' }]);
    expect((await b.query('select * from brain.extension_status_public_v1')).rows).toEqual([{ name: names[1], enabled: false, connection_status: null }]);
    const app = new pg.Client({ connectionString: db.appUrl }); await app.connect(); clients.push(app);
    expect((await app.query('select * from brain.extension_status_public_v1')).rows).toHaveLength(2);
    await a.query(`create table "${names[0]}".self_write (value text); insert into "${names[0]}".self_write values ('ok')`);
    for (const sql of ['select * from brain.extensions', 'select package_digest, plugin_version from brain.extensions', 'select * from brain.extension_quiesce', 'select * from brain.extension_install_progress', 'update brain.work_items set attempts=0', 'insert into brain.extensions(name) values (\'x\')', 'update brain.extension_status_public_v1 set enabled=false', 'delete from brain.extension_status_public_v1', 'set role brain_app']) {
      await expect(a.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    await a.query(`create function "${names[0]}".probe(value text) returns boolean language plpgsql as $$ begin
      if value <> '${names[0]}' then raise exception 'leak'; end if; return true; end $$`);
    expect((await a.query(`select * from brain.extension_status_public_v1 where "${names[0]}".probe(name)`)).rows).toHaveLength(1);
    await a.query("set brain.extension = 'forged'; set search_path = brain, public");
    expect((await a.query('select * from extension_status_public_v1')).rows).toHaveLength(1);
    expect((await admin.query('select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication from pg_roles where rolname=$1', [roles[0]])).rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false });
    await admin.query(`grant maintain on brain.work_items to "${roles[0]}"`);
    await expect(provisionExtension(db.url, names[0]!, password)).rejects.toThrow('허용되지 않은 권한');
    await admin.query(`revoke maintain on brain.work_items from "${roles[0]}"`);
    await provisionExtension(db.url, names[0]!, password);
    await admin.query(`alter role "${roles[0]}" bypassrls`);
    await expect(provisionExtension(db.url, names[0]!, password)).rejects.toThrow('역할 충돌');
    await admin.query(`alter role "${roles[0]}" nobypassrls; grant brain_app to "${roles[0]}"`);
    await expect(provisionExtension(db.url, names[0]!, password)).rejects.toThrow('역할 충돌');
    await admin.query(`revoke brain_app from "${roles[0]}"`);
    await admin.query(`create table "${names[1]}".private_data (value text);
      create function "${names[1]}".private_fn() returns integer language sql as 'select 1';
      grant usage on schema "${names[1]}" to "${roles[0]}";
      grant select, insert on "${names[1]}".private_data to "${roles[0]}";
      grant execute on function "${names[1]}".private_fn() to "${roles[0]}"`);
    await a.query(`insert into "${names[1]}".private_data values ('leak'); select * from "${names[1]}".private_data; select "${names[1]}".private_fn()`);
    await expect(provisionExtension(db.url, names[0]!, password)).rejects.toThrow('schema 권한');
    await admin.query(`grant usage on schema "${names[1]}" to public`);
    await expect(provisionExtension(db.url, `x${suffix}c`, password)).rejects.toThrow('schema 권한');
    await admin.query(`revoke usage on schema "${names[1]}" from public`);
    await admin.query(`revoke usage on schema "${names[1]}" from "${roles[0]}";
      revoke all on "${names[1]}".private_data from "${roles[0]}";
      revoke all on function "${names[1]}".private_fn() from "${roles[0]}"`);
    await admin.query(`create schema contract_test; create table contract_test.results (source text, work_item_id uuid, attempt_token uuid);
      alter table contract_test.results enable row level security;
      create policy source on contract_test.results for insert with check (current_user = 'brain_ext_' || source);
      create trigger fence before insert on contract_test.results for each row execute function brain.reject_stale_attempt();
      grant usage on schema contract_test to "${roles[0]}"; grant insert on contract_test.results to "${roles[0]}"`);
    const id = randomUUID(), token = randomUUID(), now = clock.now();
    const workKind = `${names[0]}.import`;
    await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)', [names[0],workKind]);
    expect(await store.addWork({ id, kind: workKind, targetKind: 'probe', targetId: 'extension', createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
    expect(await store.claimSupervisedWork({ now, claimedBy: 'test', kinds: [workKind], attemptToken: token })).toMatchObject({ ok: true, attemptToken: token });
    const manualInput = {start_date:'2026-01-01',end_date:'2026-01-31',send:false};
    await admin.query('insert into brain.extension_work_inputs(work_id,input) values ($1,$2::jsonb)',[id,JSON.stringify(manualInput)]);
    const readInput='select brain.extension_work_input($1,$2) as input';
    expect((await a.query(readInput,[id,token])).rows[0].input).toEqual(manualInput);
    await expect(b.query(readInput,[id,token])).rejects.toMatchObject({code:'42501'});
    await expect(a.query(readInput,[id,randomUUID()])).rejects.toMatchObject({code:'42501'});
    await expect(a.query('select input from brain.extension_work_inputs')).rejects.toMatchObject({code:'42501'});
    const channel = randomUUID(), conversation = randomUUID();
    await admin.query('insert into brain.channels values ($1,$2,$3)', [channel, 'telegram', 'bot']);
    await admin.query('insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ($1,$2,$3,null,$4)', [conversation, channel, 'chat', sampleSelfUserInput().id]);
    const otherUser = randomUUID(), otherConversation = randomUUID();
    await admin.query("insert into brain.users(id,name,is_self,created_at) values ($1,'synthetic',0,now())", [otherUser]);
    await admin.query('insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ($1,$2,$3,null,$4)', [otherConversation, channel, 'other-chat', otherUser]);
    const validate = 'select brain.extension_channel_conversation_valid($1,$2,$3) as valid';
    expect((await a.query(validate, [id,token,conversation])).rows[0].valid).toBe(true);
    for (const target of [otherConversation, randomUUID()]) expect((await a.query(validate, [id,token,target])).rows[0].valid).toBe(false);
    await expect(b.query(validate, [id,token,conversation])).rejects.toMatchObject({code:'42501'});
    const requestSql = `insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at,source_work_item_id,source_attempt_token) values ($1,$2,$3,$4,'notice','body',now(),$5,$6)`;
    const notificationSql = `insert into brain.channel_legacy_notifications(id,conversation_id,source,dataset,original_table,original_key,import_batch,local_date,event,detail,at,source_work_item_id,source_attempt_token) values ($1,$2,$3,'dataset','notifications',$4,'batch','2026-10-31','event','',now(),$5,$6)`;
    const deliverySql = `insert into brain.channel_legacy_deliveries(id,conversation_id,source,dataset,original_table,original_key,import_batch,original_id,local_date,kind,event,ok,at,source_work_item_id,source_attempt_token) values ($1,$2,$3,'dataset','deliveries',$4,'batch',$4,'2026-10-31','notice','event',true,now(),$5,$6)`;
    for (const statement of [requestSql, notificationSql, deliverySql]) {
      await a.query(statement, [randomUUID(), conversation, names[0], randomUUID(), id, token]);
      await expect(a.query(statement, [randomUUID(), conversation, names[1], randomUUID(), id, token])).rejects.toMatchObject({ code: '42501' });
      await expect(a.query(statement, [randomUUID(), conversation, names[0], randomUUID(), id, null])).rejects.toMatchObject({ code: 'BRS01' });
    }
    for (const table of ['channel_requests', 'channel_legacy_notifications', 'channel_legacy_deliveries']) {
      await expect(a.query(`update brain.${table} set id=id`)).rejects.toMatchObject({ code: '42501' });
      await expect(a.query(`delete from brain.${table}`)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(a.query(`insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at,work_item_id,source_work_item_id,source_attempt_token) values ($1,$2,$3,'forged','notice','body',now(),$4,$4,$5)`, [randomUUID(), conversation, names[0], id, token])).rejects.toMatchObject({ code: '42501' });
    await a.query(`insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,bundle,created_at,source_work_item_id,source_attempt_token) values ($1,$2,$3,$4,'report','body',$5,now(),$6,$7)`, [randomUUID(), conversation, names[0], randomUUID(), JSON.stringify({summary:'summary',albums:[],document:{}}), id, token]);
    await expect(a.query('select * from brain.channel_item_results')).rejects.toMatchObject({ code: '42501' });
    await expect(a.query("insert into brain.channel_item_results(request_id,item_index,work_item_id,attempt_token,result,updated_at) values ($1,0,$2,$3,'{}',now())", [randomUUID(),id,token])).rejects.toMatchObject({ code: '42501' });
    await a.query('insert into contract_test.results values ($1,$2,$3)', [names[0], id, token]);
    await expect(a.query('insert into contract_test.results values ($1,$2,$3)', [names[1], id, token])).rejects.toMatchObject({ code: '42501' });
    const publish = 'select brain.extension_channel_publish($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as id';
    const args = [id, token, conversation, `notice:${randomUUID()}`, 'failure', null, 'synthetic', null, null];
    const first = (await a.query(publish, args)).rows[0].id;
    expect((await a.query(publish, args)).rows[0].id).toBe(first);
    await expect(a.query(publish, [...args.slice(0, 6), 'changed', null, null])).rejects.toThrow('publication conflict');
    await expect(b.query(publish, args)).rejects.toMatchObject({ code: '42501' });
    await expect(a.query(publish, [id, token, randomUUID(), ...args.slice(3)])).rejects.toMatchObject({ code: '42501' });
    await expect(a.query(publish, [id, token, conversation, randomUUID(), 'report', null, 'synthetic', randomUUID(), '[]'])).rejects.toThrow('invalid document');
    const fileRequest = randomUUID(), file = randomUUID(), location = randomUUID();
    await a.query(`insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token)
      values ($1,$2,$3,'synthetic','batch',$4,$5,1,'text/markdown',now(),$6,$7)`, [fileRequest,names[0],randomUUID(),'synthetic', 'a'.repeat(64),id,token]);
    await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())', [file, `sha256:${'a'.repeat(64)}`]);
    await admin.query("insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ($1,$2,'local','synthetic','brain',now())", [location,file]);
    await admin.query('update brain.files set home_location_id=$1 where id=$2', [location,file]);
    await admin.query('insert into brain.file_request_results(request_id,file_id,finished_at) values ($1,$2,now())', [fileRequest,file]);
    const bundleArgs = [id,token,conversation,randomUUID(),'report','revision','synthetic',fileRequest,'[]'];
    const bundleId = (await a.query(publish,bundleArgs)).rows[0].id;
    expect((await a.query(publish,bundleArgs)).rows[0].id).toBe(bundleId);
    const bundle = (await admin.query('select bundle from brain.channel_requests where id=$1',[bundleId])).rows[0].bundle;
    expect(bundle).toMatchObject({ summary: 'synthetic', albums: [], document: { filename: 'report.md', location: { ownership: 'brain' } } });
    for (const filename of [null, 42, {}, '', 'bad/name', 'bad\\name', 'bad\nname', 'bad\u007fname']) {
      const albums = JSON.stringify([[{request_id:fileRequest, filename}]]);
      await expect(a.query(publish, [...bundleArgs.slice(0, 3), randomUUID(), ...bundleArgs.slice(4, 8), albums])).rejects.toThrow('invalid photo');
    }
    const photoAlbums = JSON.stringify([[{request_id:fileRequest, filename:'01.png'}]]);
    const photoId = (await a.query(publish, [...bundleArgs.slice(0, 3), randomUUID(), ...bundleArgs.slice(4, 8), photoAlbums])).rows[0].id;
    expect((await admin.query('select bundle from brain.channel_requests where id=$1',[photoId])).rows[0].bundle.albums[0].photos[0].filename).toBe('01.png');

    // The other target has a real completed file from the same extension.
    const otherWork=randomUUID(), otherToken=randomUUID(), otherRequest=randomUUID(), otherFile=randomUUID(), otherLocation=randomUUID();
    expect(await store.addWork({id:otherWork,kind:workKind,targetKind:'probe',targetId:'other',createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});
    expect(await store.claimSupervisedWork({now,claimedBy:'other',kinds:[workKind],attemptToken:otherToken})).toMatchObject({ok:true,item:{id:otherWork}});
    await a.query(`insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token)
      values ($1,$2,$3,'synthetic','batch','other',$4,1,'image/png',now(),$5,$6)`, [otherRequest,names[0],randomUUID(),'b'.repeat(64),otherWork,otherToken]);
    await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())', [otherFile,`sha256:${'b'.repeat(64)}`]);
    await admin.query("insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ($1,$2,'local','other','brain',now())", [otherLocation,otherFile]);
    await admin.query('update brain.files set home_location_id=$1 where id=$2', [otherLocation,otherFile]);
    await admin.query('insert into brain.file_request_results(request_id,file_id,finished_at) values ($1,$2,now())', [otherRequest,otherFile]);
    const otherArgs=[otherWork,otherToken,conversation,randomUUID(),'report','revision','synthetic',otherRequest,JSON.stringify([[{request_id:otherRequest,filename:'other.png'}]])];
    const otherId=(await a.query(publish,otherArgs)).rows[0].id;
    expect((await admin.query('select bundle from brain.channel_requests where id=$1',[otherId])).rows[0].bundle.albums[0].photos[0].filename).toBe('other.png');
    const beforeRequests=(await admin.query('select id,producer_result_id,body,bundle from brain.channel_requests order by id')).rows;
    await expect(a.query(publish,[id,token,conversation,randomUUID(),'report','revision','synthetic',otherRequest,'[]'])).rejects.toThrow('invalid document');
    await expect(a.query(publish,[id,token,conversation,randomUUID(),'report','revision','synthetic',fileRequest,JSON.stringify([[{request_id:otherRequest,filename:'other.png'}]])])).rejects.toThrow('invalid photo');
    expect((await admin.query('select id,producer_result_id,body,bundle from brain.channel_requests order by id')).rows).toEqual(beforeRequests);

    // The topic sender owns its authorization SQL independently of legacy publish.
    const send = 'select brain.extension_channel_send($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz) as id';
    const topic = `${names[0]}.report`;
    const sendArgs = [id,token,topic,randomUUID(),'report','revision','synthetic',fileRequest,photoAlbums,null];
    const accepted = (await a.query(send,sendArgs)).rows[0].id;
    expect((await admin.query('select bundle from brain.channel_dispatches where id=$1',[accepted])).rows[0].bundle).toMatchObject({
      document:{location:{locator:'synthetic',ownership:'brain'}},
      albums:[{photos:[{filename:'01.png',location:{locator:'synthetic',ownership:'brain'}}]}],
    });
    const dispatches = (await admin.query('select * from brain.channel_dispatches order by id')).rows;
    const requests = (await admin.query('select * from brain.channel_requests order by id')).rows;
    await expect(b.query(send,[id,token,`${names[1]}.report`,randomUUID(),'report',null,'synthetic',null,null,null])).rejects.toMatchObject({code:'42501'});
    await expect(a.query(send,[id,token,topic,randomUUID(),'report','revision','synthetic',otherRequest,'[]',null])).rejects.toThrow('invalid document');
    await expect(a.query(send,[id,token,topic,randomUUID(),'report','revision','synthetic',fileRequest,JSON.stringify([[{request_id:otherRequest,filename:'other.png'}]]),null])).rejects.toThrow('invalid photo');
    expect((await admin.query('select * from brain.channel_dispatches order by id')).rows).toEqual(dispatches);
    expect((await admin.query('select * from brain.channel_requests order by id')).rows).toEqual(requests);

    await store.settleSupervisedAttempt({ id, attemptToken: token, now, outcome: 'died' });
    await expect(a.query(readInput,[id,token])).rejects.toMatchObject({code:'42501'});
    await expect(a.query(validate, [id,token,conversation])).rejects.toMatchObject({code:'42501'});
    await expect(a.query(publish, args)).rejects.toMatchObject({ code: '42501' });
    await expect(a.query('insert into contract_test.results values ($1,$2,$3)', [names[0], id, token])).rejects.toMatchObject({ code: 'BRS01' });
    for (const statement of [requestSql, notificationSql, deliverySql]) await expect(a.query(statement, [randomUUID(), conversation, names[0], randomUUID(), id, token])).rejects.toMatchObject({ code: 'BRS01' });
  } finally {
    await Promise.all(clients.map(client => client.end())); await store.close();
    for (const role of roles) await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(() => {});
    await admin.end(); await db.drop();
  }
});

it('grants the approved view to a role provisioned before the view migration', async () => {
  const { mkdtemp, readdir, copyFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { runMigrations } = await import('../src/index.js');
  const db = await database(false), dir = await mkdtemp(join(tmpdir(), 'brain-migrations-'));
  const name = `x${randomBytes(5).toString('hex')}`, role = `brain_ext_${name}`, password = randomBytes(24).toString('hex');
  const admin = new pg.Client({ connectionString: db.url });
  try {
    await admin.connect();
    const source = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const file of (await readdir(source)).filter(file => /^\d{4}_/.test(file) && file < '0015')) await copyFile(join(source, file), join(dir, file));
    expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory: dir }] })).toMatchObject({ ok: true, to: 14 });
    await provisionExtension(db.url, name, password);
    for (const schema of ['brain', 'public']) {
      await admin.query(`grant create on schema "${schema}" to "${role}"`);
      expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: false, file: '0015_extension_status_public.sql' });
      await admin.query(`revoke create on schema "${schema}" from "${role}"`);
    }
    await admin.query(`grant maintain on brain.work_items to "${role}"`);
    expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: false, file: '0015_extension_status_public.sql' });
    await admin.query(`revoke maintain on brain.work_items from "${role}"`);
    expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, to: CORE_SCHEMA_VERSION });
    expect((await admin.query("select has_table_privilege($1,'brain.extension_status_public_v1','select') as allowed", [role])).rows).toEqual([{ allowed: true }]);
    await provisionExtension(db.url, name, password);
    await admin.query(`grant select on brain.work_items to "${role}"`);
    await expect(provisionExtension(db.url, name, password)).rejects.toThrow('허용되지 않은 권한');
  } finally {
    await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(() => {});
    await admin.end(); await db.drop(); await rm(dir, { recursive: true, force: true });
  }
});

it('v18의 확장 역할을 v19로 이전하고 최소 권한으로 재설정한다', async () => {
  const { mkdtemp, readdir, copyFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { runMigrations } = await import('../src/index.js');
  const db = await database(false), dir = await mkdtemp(join(tmpdir(), 'brain-v18-role-'));
  const name = `x${randomBytes(5).toString('hex')}`, role = `brain_ext_${name}`, password = randomBytes(24).toString('hex');
  const admin = new pg.Client({ connectionString: db.url });
  let owned = false;
  try {
    await admin.connect();
    const source = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const file of (await readdir(source)).filter(file => /^\d{4}_/.test(file) && file < '0019')) await copyFile(join(source, file), join(dir, file));
    expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory: dir }] })).toMatchObject({ ok: true, to: 18 });
    await provisionExtension(db.url, name, password); owned = true;
    expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 18, to: CORE_SCHEMA_VERSION });
    await provisionExtension(db.url, name, password);
    const url = new URL(db.url); url.username = role; url.password = password;
    const ext = new pg.Client({ connectionString: url.toString() }); await ext.connect();
    try {
      expect((await ext.query('select current_user as role')).rows[0]).toEqual({ role });
      const store = postgresStore({ databaseUrl: db.appUrl });
      const work = randomUUID(), token = randomUUID(), channel = randomUUID(), conversation = randomUUID();
      try {
        await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())",[name]);
        const workKind = `${name}.import`;
        await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)',[name,workKind]);
        const self = await store.ensureSelfUser(sampleSelfUserInput()); if (!self.ok) throw Error(self.message);
        expect(await store.ensureChannel({ id: channel, kind: 'telegram', botRef: 'bot' })).toMatchObject({ ok: true });
        expect(await store.ensureChannelConversation({ userId: '01940000-0000-7000-8000-00000000000a', id: conversation, channelId: channel, externalRef: 'chat', threadRef: null })).toMatchObject({ ok: true });
        expect(await store.addWork({ id: work, kind: workKind, targetKind: 'probe', targetId: 'test', createdAt: clock.now(), nextAttemptAt: clock.now() })).toMatchObject({ ok: true });
        expect(await store.claimSupervisedWork({ now: clock.now(), kinds: [workKind], claimedBy: 'test', attemptToken: token })).toMatchObject({ ok: true, item: { id: work } });
        await ext.query(`insert into brain.channel_legacy_deliveries(id,conversation_id,source,dataset,original_table,original_key,import_batch,original_id,local_date,kind,event,ok,at,source_work_item_id,source_attempt_token) values ($1,$2,$5,'data','deliveries','1','batch','1','2026-10-31','notice',null,true,now(),$3,$4)`, [randomUUID(), conversation, work, token, name]);
        expect(await store.readChannelLegacy({ type: 'delivery', dataset: 'data', originalTable: 'deliveries', originalKey: '1' })).toMatchObject({ ok: true, record: { source: name, event: null, conversationId: conversation } });
      } finally { await store.close(); }

      for (const table of ['channel_requests', 'channel_legacy_notifications', 'channel_legacy_deliveries']) {
        expect((await admin.query(`select has_column_privilege($1,'brain.${table}','id','insert') as allowed, has_table_privilege($1,'brain.${table}','update') as can_update, has_table_privilege($1,'brain.${table}','delete') as can_delete`, [role])).rows[0]).toEqual({ allowed: true, can_update: false, can_delete: false });
      }
    } finally { await ext.end(); }
  } finally {
    if (owned) await admin.query(`drop owned by "${role}"; drop role "${role}"`);
    await admin.end(); await db.drop(); await rm(dir, { recursive: true, force: true });
  }
});

it('topic 접수는 확장 소유 attempt·접두사·파일 권한을 검증하고 예약을 생산자 종료 뒤 인계한다', async () => {
  const db=await database(),name='x'+randomBytes(5).toString('hex'),role='brain_ext_'+name,password=randomBytes(24).toString('hex');
  const admin=new pg.Client({connectionString:db.url}),store=postgresStore({databaseUrl:db.appUrl});
  let client:pg.Client|undefined;
  try {
    await admin.connect(); await store.ensureSelfUser(sampleSelfUserInput()); await provisionExtension(db.url,name,password);
    const url=new URL(db.url);url.username=role;url.password=password;client=new pg.Client({connectionString:url.toString()});await client.connect();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values($1,'1',now(),true,now())",[name]);
    const kind=name+'.report',work=randomUUID(),attempt=randomUUID(),m=randomUUID(),c=randomUUID();
    await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values($1,$2)',[name,kind]);
    await store.addWork({id:work,kind,targetKind:'report',targetId:'synthetic',createdAt:clock.now(),nextAttemptAt:clock.now()});
    await store.claimSupervisedWork({now:clock.now(),kinds:[kind],claimedBy:'test',attemptToken:attempt});
    await store.ensureChannel({id:m,kind:'telegram',botRef:'legacy'});await store.ensureChannelConversation({id:c,channelId:m,userId:sampleSelfUserInput().id,externalRef:'synthetic',threadRef:null});
    const send='select brain.extension_channel_send($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz) as id';
    const args=[work,attempt,name+'.report','one','report',null,'summary',null,null,null];
    const first=(await client.query(send,args)).rows[0].id;
    expect((await client.query(send,[...args.slice(0,6),'changed',null,null,null])).rows[0].id).toBe(first);
    expect(await store.readChannelStatus(first)).toMatchObject({request:{delivery:'unrouted'}});
    for(const table of ['messenger_credentials','channel_routes','channel_dispatches']) await expect(client.query(`select * from brain.${table}`)).rejects.toMatchObject({code:'42501'});
    await expect(client.query(send,[work,attempt,'other.report','wrong','report',null,'summary',null,null,null])).rejects.toMatchObject({code:'42501'});
    await expect(client.query(send,[work,randomUUID(),name+'.report','wrong','report',null,'summary',null,null,null])).rejects.toMatchObject({code:'42501'});
    await expect(client.query(send,[work,attempt,name+'.report','file','report',null,'summary',randomUUID(),'[]',null])).rejects.toThrow('invalid document');
    expect(await store.channelControl!.route({action:'set',topic:name+'.report',messengerId:m,channelId:c})).toMatchObject({ok:true});
    expect(await store.listUnhandedChannelRequests(clock.now())).toEqual({ok:true,requestIds:[]});
    const due=new Date(clock.now().getTime()+60000);
    const scheduled=(await client.query(send,[work,attempt,name+'.report','scheduled','report','garmin:synthetic','scheduled',null,null,due.toISOString()])).rows[0].id;
    await store.settleSupervisedAttempt({id:work,attemptToken:attempt,now:clock.now(),outcome:'died'});
    await expect(client.query(send,args)).rejects.toMatchObject({code:'42501'});
    expect(await store.listUnhandedChannelRequests(clock.now())).toEqual({ok:true,requestIds:[]});
    expect(await store.listUnhandedChannelRequests(due)).toEqual({ok:true,requestIds:[scheduled]});
    expect(await store.readChannelRequest(scheduled)).toMatchObject({request:{revision:'garmin:synthetic'},channel:{id:m},conversation:{id:c}});
    expect(await store.channelControl!.sendPending({topic:name+'.report',id:first,now:due})).toEqual({ok:true,count:1});
    expect(await store.channelControl!.sendPending({topic:name+'.report',id:first,now:due})).toEqual({ok:true,count:0});
    await provisionExtension(db.url,name,password);
  }finally{await client?.end();await store.close();await admin.query(`drop owned by "${role}";drop role if exists "${role}"`).catch(()=>{});await admin.end();await db.drop();}
});

it('수동 일감 입력 migration은 현재 DB 소유 확장 역할에만 권한을 부여한다', async()=>{
  const {runMigrations}=await import('../src/index.js');
  const db=await database(false), admin=new pg.Client({connectionString:db.url});
  const own=`x${randomBytes(5).toString('hex')}`, foreign=`brain_ext_x${randomBytes(5).toString('hex')}`, password=randomBytes(24).toString('hex');
  try {
    await admin.connect();
    expect(await runMigrations({databaseUrl:db.url,clock,coreMaxVersion:45})).toMatchObject({ok:true,to:45});
    await provisionExtension(db.url,own,password);
    await admin.query(`create role "${foreign}" login; comment on role "${foreign}" is 'second-brain extension:synthetic_other_database'`);
    expect(await runMigrations({databaseUrl:db.url,clock})).toMatchObject({ok:true,to:46,applied:['0046_extension_work_inputs.sql']});
    const allowed=async(role:string)=>(await admin.query("select has_function_privilege($1,'brain.extension_work_input(uuid,uuid)','execute') as allowed",[role])).rows[0].allowed;
    expect(await allowed(`brain_ext_${own}`)).toBe(true); expect(await allowed(foreign)).toBe(false);
    await provisionExtension(db.url,own,password);
  } finally {
    for(const role of [`brain_ext_${own}`,foreign]) await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(()=>{});
    await admin.end(); await db.drop();
  }
});
