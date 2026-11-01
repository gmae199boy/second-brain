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
    for (const sql of ['select * from brain.extensions', 'select * from brain.extension_install_progress', 'update brain.work_items set attempts=0', 'insert into brain.extensions(name) values (\'x\')', 'update brain.extension_status_public_v1 set enabled=false', 'delete from brain.extension_status_public_v1', 'set role brain_app']) {
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
    const channel = randomUUID(), conversation = randomUUID();
    await admin.query('insert into brain.channels values ($1,$2,$3)', [channel, 'telegram', 'bot']);
    await admin.query('insert into brain.channel_conversations values ($1,$2,$3,null)', [conversation, channel, 'chat']);
    const requestSql = `insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at,source_work_item_id,source_attempt_token) values ($1,$2,$3,$4,'notice','body',now(),$5,$6)`;
    const notificationSql = `insert into brain.channel_legacy_notifications(id,conversation_id,source,dataset,original_table,original_key,import_batch,local_date,event,detail,at,source_work_item_id,source_attempt_token) values ($1,$2,$3,'dataset','notifications',$4,'batch','2026-10-31','event','',now(),$5,$6)`;
    const deliverySql = `insert into brain.channel_legacy_deliveries(id,conversation_id,source,dataset,original_table,original_key,import_batch,original_id,local_date,kind,event,ok,at,source_work_item_id,source_attempt_token) values ($1,$2,$3,'dataset','deliveries',$4,'batch',$4,'2026-10-31','notice','event',true,now(),$5,$6)`;
    const reconcile = 'select brain.reconcile_import_authority($1,$2,$3,$4,$5,$6,$7,$8,$9) as id';
    const authorityId=randomUUID(), authorityArgs=[authorityId,names[0],'acct',null,null,['d'],id,token,false];
    expect((await a.query(reconcile,authorityArgs)).rows).toEqual([{id:authorityId}]);
    expect((await a.query(reconcile,[randomUUID(),names[0],'acct',null,null,['d'],id,token,false])).rows).toEqual([{id:authorityId}]);
    await expect(a.query(reconcile,[randomUUID(),names[1],'acct',null,null,['d'],id,token,false])).rejects.toMatchObject({code:'42501'});
    await expect(a.query(reconcile,[authorityId,names[0],'acct',null,null,['d'],id,randomUUID(),true])).rejects.toMatchObject({code:'BRS01'});
    await expect(a.query(reconcile,[authorityId,names[0],'acct',null,null,['other'],id,token,true])).rejects.toMatchObject({code:'P0001'});
    await expect(a.query('select * from brain.health_authority_rules')).rejects.toMatchObject({code:'42501'});
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
    await store.settleSupervisedAttempt({ id, attemptToken: token, now, outcome: 'died' });
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
        expect(await store.ensureChannel({ id: channel, kind: 'telegram', botRef: 'bot' })).toMatchObject({ ok: true });
        expect(await store.ensureChannelConversation({ id: conversation, channelId: channel, externalRef: 'chat', threadRef: null })).toMatchObject({ ok: true });
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

it('건강 권위는 자기 출처의 현재 시도로만 추가한다', async () => {
  const db = await database(), suffix = randomBytes(5).toString('hex');
  const name = `x${suffix}`, role = `brain_ext_${name}`, password = randomBytes(24).toString('hex');
  const admin = new pg.Client({connectionString:db.url});
  const store = postgresStore({databaseUrl:db.appUrl});
  let ext: pg.Client | undefined;
  try {
    await admin.connect(); await provisionExtension(db.url,name,password);
    const url=new URL(db.url); url.username=role; url.password=password;
    ext=new pg.Client({connectionString:url.toString()}); await ext.connect();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())",[name]);
    await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)',[name,`${name}.import`]);
    const id=randomUUID(), token=randomUUID(), now=clock.now();
    await store.addWork({id,kind:`${name}.import`,targetKind:'import',targetId:'x',createdAt:now,nextAttemptAt:now});
    await store.claimSupervisedWork({now,claimedBy:'test',kinds:[`${name}.import`],attemptToken:token});
    const sql='insert into brain.health_authority_rules(id,source,account,revision,datasets,source_work_item_id,source_attempt_token) values ($1,$2,$3,1,$4,$5,$6)';
    await ext.query(sql,[randomUUID(),name,'one',['D2','D1'],id,token]);
    await expect(ext.query(sql,[randomUUID(),'other','two',['D1'],id,token])).rejects.toMatchObject({code:'BRS01'});
    await expect(ext.query(sql,[randomUUID(),name,'two',['D1'],id,randomUUID()])).rejects.toMatchObject({code:'BRS01'});
    await expect(ext.query('select * from brain.health_authority_rules')).rejects.toMatchObject({code:'42501'});
    await expect(ext.query('update brain.health_authority_rules set revision=2')).rejects.toMatchObject({code:'42501'});
    await provisionExtension(db.url,name,password);
  } finally {
    await ext?.end(); await store.close();
    await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(() => {});
    await admin.end(); await db.drop();
  }
});

it('재provision이 확장 migration의 개별 table 및 function 권한 제한을 보존한다', async () => {
  const db = await database(), name = `x${randomBytes(5).toString('hex')}`;
  const role = `brain_ext_${name}`, password = randomBytes(24).toString('hex');
  const admin = new pg.Client({ connectionString: db.url });
  try {
    await admin.connect();
    await provisionExtension(db.url, name, password);
    // 실제 migration과 같이 brain_owner가 객체를 만들고 개별 권한을 철회한다.
    await admin.query(`set role brain_owner; create table "${name}".restricted(id integer);
      create function "${name}".restricted_fn() returns integer language sql as 'select 1';
      revoke all on "${name}".restricted from public, "${role}";
      revoke all on function "${name}".restricted_fn() from public, "${role}"; reset role`);
    const permissions = async () => (await admin.query(`select has_table_privilege($1,$2,'select,insert,update,delete') as tab,
      has_function_privilege($1,$3,'execute') as fn`, [role, `${name}.restricted`, `${name}.restricted_fn()`])).rows[0];
    expect(await permissions()).toEqual({ tab: false, fn: false });
    await provisionExtension(db.url, name, password);
    expect(await permissions()).toEqual({ tab: false, fn: false });
    await admin.query(`drop owned by "${role}"; drop role "${role}"`);
    await provisionExtension(db.url, name, password);
    expect(await permissions()).toEqual({ tab: false, fn: false });
  } finally {
    await admin.query(`reset role; drop owned by "${role}"; drop role if exists "${role}"`).catch(() => {});
    await admin.end(); await db.drop();
  }
});

it('Garmin migration의 감독자 admission 제한과 실제 attempt fence를 재provision 뒤에도 지킨다', async () => {
  const { fileURLToPath } = await import('node:url');
  const { runMigrations } = await import('../src/index.js');
  const db = await database(), name = 'garmin', role = 'brain_ext_garmin', password = randomBytes(24).toString('hex');
  const admin = new pg.Client({ connectionString: db.url }), app = new pg.Client({ connectionString: db.appUrl });
  const store = postgresStore({ databaseUrl: db.appUrl });
  let ext: pg.Client | undefined;
  try {
    await admin.connect(); await app.connect();
    await provisionExtension(db.url, name, password);
    const directory = fileURLToPath(new URL('../../../extensions/garmin/migrations/', import.meta.url));
    expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: name, directory }] })).toMatchObject({ ok: true, applied: expect.arrayContaining(['0007_account_protection.sql']) });
    await provisionExtension(db.url, name, password);
    const url = new URL(db.url); url.username = role; url.password = password;
    ext = new pg.Client({ connectionString: url.toString() }); await ext.connect();
    await expect(ext.query('select * from garmin.admission_holder')).rejects.toMatchObject({ code: '42501' });
    await expect(ext.query('select garmin.reserve_admission($1,$2,1,$3,1)', [randomUUID(),randomUUID(),'fixture'])).rejects.toMatchObject({ code: '42501' });
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('garmin','1',now(),true,now())");
    await admin.query("insert into brain.extension_work_kinds(extension_name,kind) values ('garmin','garmin.collect'),('garmin','garmin.auth')");
    const account = randomUUID(), work = randomUUID(), token = randomUUID(), now = clock.now();
    const legacy = randomUUID();
    expect(await store.enqueueExtensionWork({name:'garmin',version:'1',work:{id:legacy,kind:'garmin.collect',targetKind:'account',targetId:'merge-test',createdAt:now,nextAttemptAt:now}})).toMatchObject({ok:true,state:'queued',created:true});
    expect(await store.enqueueExtensionWork({name:'garmin',version:'1',work:{id:randomUUID(),kind:'garmin.collect',targetKind:'account',targetId:'merge-test',serializationKey:'guarded',createdAt:now,nextAttemptAt:now}})).toEqual({ok:true,state:'changed'});
    expect((await admin.query('select serialization_key from brain.work_items where id=$1',[legacy])).rows[0]).toEqual({serialization_key:null});
    await store.requestWorkCancel({id:legacy,now});
    await admin.query("insert into garmin.account_protection(id,profile_id) values ($1,'fixture')",[account]);
    await admin.query("insert into garmin.account_binding(target,protection_id) values ('fixture',$1)",[account]);
    expect(await store.addWork({ id: work, kind: 'garmin.collect', targetKind: 'account', targetId: 'fixture', createdAt: now, nextAttemptAt: now })).toMatchObject({ ok:true });
    expect(await store.claimSupervisedWork({ now, kinds:['garmin.collect'], claimedBy:'fixture', attemptToken:token })).toMatchObject({ ok:true, attemptToken:token });
    expect(await store.reserveExtensionAdmission!({ extension:'garmin',workId:work,attemptToken:token,generation:1,target:'fixture' })).toEqual({ ok:true, admitted:true });
    const competing = randomUUID(), competingToken = randomUUID();
    await store.addWork({id:competing,kind:'garmin.auth',targetKind:'extension',targetId:'garmin',createdAt:now,nextAttemptAt:now});
    expect(await store.claimSupervisedWork({now,kinds:['garmin.auth'],claimedBy:'fixture',attemptToken:competingToken})).toMatchObject({ok:true,attemptToken:competingToken});
    expect(await store.reserveExtensionAdmission!({extension:'garmin',workId:competing,attemptToken:competingToken,generation:1,target:'fixture'})).toEqual({ok:true,admitted:false,busy:true});
    expect(await store.deferSupervisedAdmission!({id:competing,attemptToken:competingToken,now})).toMatchObject({ok:true,outcome:'done'});
    expect((await admin.query('select attempts,current_attempt_token from brain.work_items where id=$1',[competing])).rows[0]).toEqual({attempts:0,current_attempt_token:null});
    await store.requestWorkCancel({id:competing,now});
    const valid = () => ext!.query("select garmin.admission_valid($1,$2,1,'fixture',1) as ok",[work,token]);
    expect((await valid()).rows[0]).toEqual({ ok:true });
    await expect(ext.query('update garmin.account_protection set auth_required=false')).rejects.toMatchObject({code:'42501'});
    await expect(ext.query("insert into garmin.external_call_intent(id) values ($1)",[randomUUID()])).rejects.toMatchObject({code:'42501'});
    await expect(ext.query("select garmin.start_external_call($1,$2,1,'fixture',1,'data','summary','Asia/Seoul',null,false)",[work,token])).rejects.toMatchObject({code:'P0001'});
    const guarded = (await ext.query("select garmin.start_external_call($1,$2,1,'fixture',1,'data','summary','UTC',null,false) as id",[work,token])).rows[0].id;
    expect((await ext.query("select garmin.finish_external_call($1,$2,1,'fixture',1,$3,'other') as ok",[work,token,guarded])).rows[0]).toEqual({ok:true});
    expect((await ext.query("select garmin.release_protection($1,$2,'fixture') as ok",[work,token])).rows[0]).toEqual({ok:false});
    const intent = randomUUID();
    await admin.query("insert into garmin.external_call_intent(id,protection_id,work_id,attempt_token,run_generation,binding_generation,stage,endpoint,started_at) values ($1,$2,$3,$4,1,1,'data','fixture',now())",[intent,account,work,token]);
    expect(await store.releaseExtensionAdmission!({extension:'garmin',workId:work,attemptToken:token})).toEqual({ok:true,released:false});
    await admin.query('delete from garmin.external_call_intent where id=$1',[intent]);
    await store.requestWorkCancel({ id:work, now });
    expect((await valid()).rows[0]).toEqual({ ok:false });
    expect(await store.releaseExtensionAdmission!({extension:'garmin',workId:work,attemptToken:token})).toEqual({ok:true,released:true});
    // 실제 auth attempt와 discovery holder를 canonical 계정으로 합친다.
    const discovery = randomUUID(), authWork = randomUUID(), authToken = randomUUID();
    await admin.query('insert into garmin.account_protection(id) values ($1)',[discovery]);
    await admin.query("insert into garmin.account_binding(target,protection_id) values ('discover',$1)",[discovery]);
    await store.addWork({id:authWork,kind:'garmin.auth',targetKind:'extension',targetId:'garmin',createdAt:now,nextAttemptAt:now});
    expect(await store.claimSupervisedWork({now,kinds:['garmin.auth'],claimedBy:'fixture',attemptToken:authToken})).toMatchObject({ok:true,attemptToken:authToken});
    expect(await store.reserveExtensionAdmission!({extension:'garmin',workId:authWork,attemptToken:authToken,generation:1,target:'discover'})).toEqual({ok:true,admitted:true});
    await admin.query("update garmin.account_protection set auth_required=true,rate_day='2026-01-01' where id=$1",[account]);
    const binding = (await ext.query("select garmin.bind_admitted_profile($1,$2,1,'discover',1,'fixture') as generation",[authWork,authToken])).rows[0].generation;
    expect(Number(binding)).toBe(2);
    expect((await ext.query("select garmin.admission_valid($1,$2,1,'discover',2) as ok",[authWork,authToken])).rows[0]).toEqual({ok:true});
    expect((await admin.query("select auth_required,rate_day::text from garmin.account_protection p join garmin.account_binding b on b.protection_id=p.id where b.target='discover'")).rows[0]).toEqual({auth_required:true,rate_day:'2026-01-01'});
    const completeAuth = () => ext!.query("select garmin.complete_verified_auth($1,$2,1,'discover',2,'fixture') as ok",[authWork,authToken]);
    expect((await completeAuth()).rows[0]).toEqual({ok:false});
    await expect(ext.query('select * from garmin.auth_success_evidence')).rejects.toMatchObject({code:'42501'});
    await admin.query("update garmin.account_protection set uncertain=true where id=$1",[account]);
    await admin.query("insert into garmin.external_call_intent(id,protection_id,work_id,attempt_token,run_generation,binding_generation,stage,endpoint,started_at,finished_at,outcome) values ($1,$2,$3,$4,1,2,'auth','profile',now(),now(),'success')",[randomUUID(),account,authWork,authToken]);
    await app.query("insert into garmin.auth_success_evidence(work_id,attempt_token,run_generation,binding_generation,profile_id) values ($1,$2,1,2,'fixture')",[authWork,authToken]);
    expect((await completeAuth()).rows[0]).toEqual({ok:true});
    expect((await completeAuth()).rows[0]).toEqual({ok:false});
    expect((await admin.query("select auth_required,rate_day::text,uncertain from garmin.account_protection where id=$1",[account])).rows[0]).toEqual({auth_required:false,rate_day:'2026-01-01',uncertain:true});
    expect(await store.releaseExtensionAdmission!({extension:'garmin',workId:authWork,attemptToken:authToken})).toEqual({ok:true,released:true});
    // 실제 supervisor가 launcher.start를 호출할 때 이미 durable 행이 보여야 한다.
    const { runSupervisor } = await import('../../core/src/queue/supervisor.js');
    const { manualTime } = await import('../../core/src/testing/fakes/clock.js');
    const { sequenceIdGen } = await import('../../core/src/testing/fakes/id-gen.js');
    const { fakeProcessInspector } = await import('../../core/src/testing/fakes/process.js');
    const other = randomUUID(), otherWork = randomUUID();
    await admin.query("insert into garmin.account_protection(id,profile_id) values ($1,'other')",[other]);
    await admin.query("insert into garmin.account_binding(target,protection_id) values ('other',$1)",[other]);
    await store.addWork({ id:otherWork, kind:'garmin.collect', targetKind:'account', targetId:'other', createdAt:now, nextAttemptAt:now });
    const controller = new AbortController(); let observed = false;
    const running = runSupervisor({ store, schemaVersions:{ core:CORE_SCHEMA_VERSION }, ...manualTime(now),
      idGen:sequenceIdGen({timestampMs:now.getTime()}), inspector:fakeProcessInspector(), signal:controller.signal,
      launches:{}, launcher:{ async start() {
        observed = (await admin.query('select count(*)::int as n from garmin.admission_holder where work_id=$1',[otherWork])).rows[0].n === 1;
        return {ok:false, message:'fixture stop'};
      } }, protectedLaunches:{ 'garmin.collect': { extension:'garmin', declarations:{}, errorCodes:[],
        async prepare(item,token) { return {ok:true, spec:{command:'fixture',args:[],env:{
          BRAIN_ABI_VERSION:'1',BRAIN_DATABASE_URL:'postgres://localhost/fixture',BRAIN_WORK_ID:item.id,
          BRAIN_ATTEMPT_TOKEN:token,BRAIN_WORK_KIND:item.kind,BRAIN_TARGET_KIND:item.targetKind,BRAIN_TARGET_ID:item.targetId,
          BRAIN_RUN_GENERATION:String(item.attempts),BRAIN_SETTINGS_SNAPSHOT:'{"version":1,"extension":"garmin","values":{}}',
        }}}; },
        async admit(item,token) { return store.reserveExtensionAdmission!({extension:'garmin',workId:item.id,attemptToken:token,generation:item.attempts,target:'other'}); },
      }} });
    try { await expect.poll(() => observed,{timeout:5000}).toBe(true); }
    finally { controller.abort(); await running; }
  } finally {
    await ext?.end(); await store.close(); await app.end();
    await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(() => {});
    await admin.end(); await db.drop();
  }
});

it('실제 supervisor에서 같은 계정 auth/collect는 대기하고 다른 계정은 병렬 실행된다', async () => {
  const { fileURLToPath } = await import('node:url');
  const { runMigrations } = await import('../src/index.js');
  const { runSupervisor } = await import('../../core/src/queue/supervisor.js');
  const { manualTime } = await import('../../core/src/testing/fakes/clock.js');
  const { sequenceIdGen } = await import('../../core/src/testing/fakes/id-gen.js');
  const { fakeProcessInspector, fakeProcessLauncher } = await import('../../core/src/testing/fakes/process.js');
  const db = await database(), role = 'brain_ext_garmin', password = randomBytes(24).toString('hex');
  const admin = new pg.Client({connectionString:db.url}), store = postgresStore({databaseUrl:db.appUrl});
  const controller = new AbortController(), launcher = fakeProcessLauncher(), time = manualTime(clock.now());
  let running: Promise<void> | undefined; let releaseResult: unknown = 'not-called';
  try {
    await admin.connect(); await provisionExtension(db.url,'garmin',password);
    const directory = fileURLToPath(new URL('../../../extensions/garmin/migrations/',import.meta.url));
    expect(await runMigrations({databaseUrl:db.url,clock,owners:[{owner:'garmin',directory}]})).toMatchObject({ok:true});
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('garmin','1',now(),true,now())");
    await admin.query("insert into brain.extension_work_kinds(extension_name,kind) values ('garmin','garmin.collect'),('garmin','garmin.auth')");
    const a=randomUUID(), b=randomUUID();
    await admin.query("insert into garmin.account_protection(id,profile_id) values ($1,'a'),($2,'b')",[a,b]);
    await admin.query("insert into garmin.account_binding(target,protection_id) values ('path-a',$1),('path-b',$2)",[a,b]);
    const now=time.clock.now();
    for (const [kind,targetKind,targetId] of [['garmin.auth','extension','garmin'],['garmin.collect','account','a'],['garmin.collect','account','b']] as const)
      await store.addWork({id:randomUUID(),kind,targetKind,targetId,createdAt:now,nextAttemptAt:now});
    const launch = {extension:'garmin',declarations:{},errorCodes:[],
      async prepare(item: import('../../core/src/domain/work-item.js').WorkItem, token:string) { return {ok:true as const,spec:{command:'fixture',args:[],env:{
        BRAIN_ABI_VERSION:'1',BRAIN_DATABASE_URL:'postgres://localhost/fixture',BRAIN_WORK_ID:item.id,BRAIN_ATTEMPT_TOKEN:token,
        BRAIN_WORK_KIND:item.kind,BRAIN_TARGET_KIND:item.targetKind,BRAIN_TARGET_ID:item.targetId,BRAIN_RUN_GENERATION:String(item.attempts),
        BRAIN_SETTINGS_SNAPSHOT:'{"version":1,"extension":"garmin","values":{}}',
      }}}; },
      async admit(item: import('../../core/src/domain/work-item.js').WorkItem,token:string) {
        return store.reserveExtensionAdmission!({extension:'garmin',workId:item.id,attemptToken:token,generation:item.attempts,target:'path-a'});
      },
      async releaseAdmission(item: import('../../core/src/domain/work-item.js').WorkItem,token:string) {
        const result = await store.releaseExtensionAdmission!({extension:'garmin',workId:item.id,attemptToken:token}); releaseResult=result; return result;
      },
    };
    running = runSupervisor({store,schemaVersions:{core:CORE_SCHEMA_VERSION},...time,idGen:sequenceIdGen({timestampMs:now.getTime()}),
      inspector:fakeProcessInspector(launcher),launcher,signal:controller.signal,launches:{},
      protectedLaunches:{'garmin.auth':launch,'garmin.collect':launch},pollMs:25});
    await expect.poll(() => launcher.processes.length,{timeout:5000}).toBe(2);
    expect((await admin.query('select count(*)::int as n from garmin.admission_holder')).rows[0].n).toBe(2);
    expect(launcher.specs.some(spec => spec.env.BRAIN_TARGET_ID==='b')).toBe(true);
    const index=launcher.specs.findIndex(spec => spec.env.BRAIN_TARGET_ID!=='b');
    const runningWork=launcher.specs[index]!.env.BRAIN_WORK_ID;
    await expect.poll(async () => (await admin.query('select pid from brain.work_attempts where work_item_id=$1',[runningWork])).rows[0]?.pid,{timeout:5000}).toEqual(expect.any(Number));
    launcher.processes[index]!.push('{"abi":1,"type":"result","summary":"ok"}');
    launcher.processes[index]!.exit(0);
    await expect.poll(() => releaseResult,{timeout:5000}).toEqual({ok:true,released:true});
    time.advance(30_100);
    await expect.poll(() => launcher.processes.length,{timeout:5000}).toBe(3);
    const active = (await admin.query("select p.profile_id,count(*)::int n from garmin.admission_holder h join garmin.account_protection p on p.id=h.protection_id group by p.profile_id order by p.profile_id")).rows;
    expect(active).toEqual([{profile_id:'a',n:1},{profile_id:'b',n:1}]);
  } finally {
    controller.abort();
    for (const child of launcher.processes) child.exit(0);
    await running; await store.close();
    await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(() => {});
    await admin.end(); await db.drop();
  }
},20_000);
