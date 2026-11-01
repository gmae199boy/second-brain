import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { expect, it } from 'vitest';
import { postgresStore, postgresProtectedMutationStore, provisionExtension, runMigrations } from '../src/index.js';
import { clock } from './fixture.js';
import { isolatedClusterDatabase } from './isolated-cluster.js';
import { prepareProtectedRoles } from '../src/protected-roles.js';

it('Garmin 재provision은 보호 schema의 권한을 되살리지 않는다', async () => {
  const db = await isolatedClusterDatabase();
  const partial = await mkdtemp(join(tmpdir(), 'brain-quarantine-migrations-'));
  const full = await mkdtemp(join(tmpdir(), 'brain-protected-migrations-'));
  const core = await mkdtemp(join(tmpdir(), 'brain-protected-core-'));
  const password = randomBytes(24).toString('hex');
  const store = postgresStore({ databaseUrl: db.appUrl });
  const admin = new pg.Client({ connectionString: db.url });
  const app = new pg.Client({ connectionString: db.appUrl });
  const workerUrl = new URL(db.url); workerUrl.username = 'brain_ext_garmin'; workerUrl.password = password;
  const worker = new pg.Client({ connectionString: workerUrl.toString() });
  try {
    await admin.connect();
    const coreDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const name of await readdir(coreDirectory)) await copyFile(join(coreDirectory, name), join(core, name));
    for (const name of ['0028_protected_work.sql', '0029_protected_auth_revoke.sql', '0030_protected_mutation_read.sql', '0031_protected_mutation_receipts.sql'])
      await copyFile(fileURLToPath(new URL(`../protected-migrations/${name}`, import.meta.url)), join(core, name));
    expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory: core }] })).toMatchObject({ ok: true });
    await prepareProtectedRoles(db.url);
    await prepareProtectedRoles(db.url);
    const protectedRoles = await admin.query("select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname like 'brain_protected_%' order by rolname");
    expect(protectedRoles.rows).toHaveLength(3);
    expect(protectedRoles.rows.every(role => !role.rolcanlogin && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication && !role.rolbypassrls)).toBe(true);
    await admin.query('grant brain_protected_broker to brain_app');
    await expect(prepareProtectedRoles(db.url)).rejects.toThrow('보호 역할 충돌');
    await admin.query('revoke brain_protected_broker from brain_app');
    await provisionExtension(db.url, 'garmin', password);
    await app.connect(); await worker.connect();
    const directory = fileURLToPath(new URL('../../../extensions/garmin/migrations/', import.meta.url));
    for (const name of (await readdir(directory)).filter(name => /^000[1-7]_.*\.sql$/.test(name))) { await copyFile(join(directory, name), join(partial, name)); await copyFile(join(directory, name), join(full, name)); }
    const protectedDirectory = fileURLToPath(new URL('../../../extensions/garmin/protected-migrations/', import.meta.url));
    for (const name of await readdir(protectedDirectory)) await copyFile(join(protectedDirectory, name), join(full, name));
    expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'garmin', directory: partial }] })).toMatchObject({ ok: true });
    await admin.query('grant brain_protected_broker to brain_app');
    expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'garmin', directory: full }] })).toMatchObject({ ok: false, file: '0008_protection_quarantine.sql' });
    await admin.query('revoke brain_protected_broker from brain_app');
    expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'garmin', directory: full }] })).toMatchObject({ ok: true });
    const check = async () => {
      const result = await admin.query(`select
        has_schema_privilege('brain_ext_garmin','garmin','CREATE') as create,
        has_table_privilege('brain_app','garmin.auth_success_evidence','INSERT') as evidence,
        has_function_privilege('brain_ext_garmin','garmin.finish_external_call(uuid,uuid,bigint,text,bigint,uuid,text)','EXECUTE') as finish`);
      expect(result.rows[0]).toEqual({ create: false, evidence: false, finish: false });
    };
    await check();
    const account = randomUUID(), work = randomUUID(), token = randomUUID(), now = clock.now();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('garmin','1',now(),true,now()); insert into brain.extension_work_kinds(extension_name,kind) values ('garmin','garmin.collect')");
    await admin.query("insert into garmin.account_protection(id,profile_id) values ($1,'fixture')", [account]);
    await admin.query("insert into garmin.account_binding(target,protection_id) values ('fixture',$1)", [account]);
    expect(await store.addWork({ id: work, kind: 'garmin.collect', targetKind: 'account', targetId: 'fixture', createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: false });
    await admin.query('set session authorization brain_protected_supervisor');
    await admin.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,attempts,claimed_at,claim_expires_at,claimed_by) values ($1,'garmin.collect','account','fixture',$2,$2,'supervised',1,$2,$2::timestamptz + interval '1 hour','fixture')", [work, now]);
    await admin.query('insert into brain.work_attempts(token,work_item_id,started_at) values ($1,$2,$3)', [token, work, now]);
    await admin.query('update brain.work_items set current_attempt_token=$1 where id=$2', [token, work]);
    const admission = await admin.query("select garmin.reserve_work_admission($1,$2,1,'fixture','UTC') as result", [work, token]);
    expect(admission.rows[0].result).toMatchObject({ state: 'admitted', target: 'fixture' });
    await expect(admin.query("select garmin.start_external_call($1,$2,1,'fixture',1,'data','summary','UTC',null,false)", [work, token])).rejects.toMatchObject({ code: '42501' });
    const authWork = randomUUID(), authToken = randomUUID(), lease = randomUUID();
    await admin.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,attempts,claimed_at,claim_expires_at,claimed_by,hold_group) values ($1,'garmin.auth','extension','garmin',$2,$2,'supervised',1,$2,$2::timestamptz + interval '1 hour','fixture','extension:garmin')", [authWork, now]);
    await admin.query('insert into brain.work_attempts(token,work_item_id,started_at) values ($1,$2,$3)', [authToken, authWork, now]);
    await admin.query('update brain.work_items set current_attempt_token=$1 where id=$2', [authToken, authWork]);
    await admin.query('reset session authorization');
    await expect(app.query('select brain.begin_protected_input_launch($1,$2,1)', [authWork, authToken])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('select brain.close_unstarted_protected_input($1,$2,1)', [authWork, authToken])).rejects.toMatchObject({ code: '42501' });
    // 이 로그인은 격리 시험 DB의 임시 role 설정이며 마지막에 되돌린다.
    await admin.query("alter role brain_protected_supervisor login password 'fixture-supervisor-only'");
    const supervisorUrl = new URL(db.url); supervisorUrl.username = 'brain_protected_supervisor'; supervisorUrl.password = 'fixture-supervisor-only';
    const supervisor = postgresStore({ databaseUrl: supervisorUrl.toString() });
    const mutations = postgresProtectedMutationStore({ databaseUrl: supervisorUrl.toString() });
    try {
      await admin.query("insert into brain.protected_work_kinds(kind,hold_group,extension_name,requires_input_revoke) values ('fixture.auth','extension:fixture','fixture',true)");
      const ids = [randomUUID(),randomUUID()], tokens = [randomUUID(),randomUUID()], leases = [randomUUID(),randomUUID()];
      await admin.query('set session authorization brain_protected_supervisor');
      for (let i=0;i<2;i++) {
        await admin.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,attempts,claimed_at,claim_expires_at,claimed_by,hold_group) values ($1,'fixture.auth','extension',$2,$3,$3,'supervised',1,$3,$3::timestamptz + interval '1 hour','fixture','extension:fixture')",[ids[i],`fixture-${i}`,now]);
        await admin.query('insert into brain.work_attempts(token,work_item_id,started_at) values ($1,$2,$3)',[tokens[i],ids[i],now]);
        await admin.query('update brain.work_items set current_attempt_token=$1 where id=$2',[tokens[i],ids[i]]);
        expect((await admin.query('select brain.begin_protected_input_launch($1,$2,1) as ok',[ids[i],tokens[i]])).rows[0].ok).toBe(true);
        await admin.query('update brain.work_attempts set protected_launch_lease=$1,protected_connection_epoch=1 where token=$2',[leases[i],tokens[i]]);
      }
      await admin.query('reset session authorization');
      const action = { type: 'hold' as const, group: 'extension:fixture' };
      const snapshot = await mutations.list(action);expect(snapshot).toHaveLength(2);
      const changed = snapshot!.map((item,index)=>index===0?{...item,epoch:2}:item);
      expect(await mutations.commit(action,changed,randomUUID())).toEqual({status:'changed'});
      expect((await admin.query("select count(*)::int as count from brain.protected_auth_revocations where work_id=any($1::uuid[])",[ids])).rows[0].count).toBe(0);
      const request=randomUUID();expect(await mutations.commit(action,snapshot!,request)).toEqual({status:'committed',result:{type:'hold',held:true}});
      expect(await mutations.applied(action,snapshot!,request)).toEqual({type:'hold',held:true});
      expect((await admin.query("select count(*)::int as count from brain.protected_auth_revocations where work_id=any($1::uuid[])",[ids])).rows[0].count).toBe(2);
      await expect(app.query('select * from brain.protected_auth_revocations')).rejects.toMatchObject({code:'42501'});
      await expect(app.query('select * from brain.protected_mutation_receipts')).rejects.toMatchObject({code:'42501'});
      await expect(app.query('select brain.record_protected_auth_revoke($1,$2,1,1,$3)',[ids[0],tokens[0],leases[0]])).rejects.toMatchObject({code:'42501'});
      const accountA=randomUUID(),accountB=randomUUID();
      await admin.query("insert into garmin.account_protection(id,profile_id) values ($1,'account-a'),($2,'account-b')",[accountA,accountB]);
      await admin.query("insert into garmin.account_binding(target,protection_id) values ('path-a',$1),('path-b',$2)",[accountA,accountB]);
      const accountWorks=[randomUUID(),randomUUID(),randomUUID()],accountTokens=[randomUUID(),randomUUID(),randomUUID()];
      await admin.query('set session authorization brain_protected_supervisor');
      for(let i=0;i<3;i++) {
        const kind=i===2?'garmin.collect':'garmin.auth',target=i===2?'account-a':i===0?accountA:accountB;
        await admin.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,attempts,claimed_at,claim_expires_at,claimed_by,hold_group) values ($1,$2,'account',$3,$4,$4,'supervised',1,$4,$4::timestamptz + interval '1 hour','fixture','extension:garmin')",[accountWorks[i],kind,target,now]);
        await admin.query('insert into brain.work_attempts(token,work_item_id,started_at) values ($1,$2,$3)',[accountTokens[i],accountWorks[i],now]);
        await admin.query('update brain.work_items set current_attempt_token=$1 where id=$2',[accountTokens[i],accountWorks[i]]);
      }
      await admin.query('reset session authorization');
      expect(await supervisor.reserveExtensionAdmission!({extension:'garmin',workId:accountWorks[0]!,attemptToken:accountTokens[0]!,generation:1,target:'path-b',timeZone:'UTC'})).toMatchObject({ok:true,admitted:false});
      expect(await supervisor.reserveExtensionAdmission!({extension:'garmin',workId:accountWorks[0]!,attemptToken:accountTokens[0]!,generation:1,target:'path-a',timeZone:'UTC'})).toMatchObject({ok:true,admitted:true});
      expect(await supervisor.reserveExtensionAdmission!({extension:'garmin',workId:accountWorks[1]!,attemptToken:accountTokens[1]!,generation:1,target:'path-b',timeZone:'UTC'})).toMatchObject({ok:true,admitted:true});
      expect(await supervisor.reserveExtensionAdmission!({extension:'garmin',workId:accountWorks[2]!,attemptToken:accountTokens[2]!,generation:1,target:'path-a',timeZone:'UTC'})).toMatchObject({ok:true,admitted:false,busy:true});
      await admin.query('delete from garmin.admission_holder where work_id=any($1::uuid[])',[accountWorks]);
      await admin.query('set session authorization brain_protected_supervisor');
      await admin.query('update brain.work_items set current_attempt_token=null where id=any($1::uuid[])',[accountWorks]);
      await admin.query('reset session authorization');
      const process = { id: authWork, attemptToken: authToken, pid: 1234, pgid: 1234, osBootAt: now, osStartedAt: now,
        protectedIdentity: { launchLease: lease, connectionEpoch: 1, startTimeUs: String(BigInt(now.getTime()) * 1000n + 789n) } };
      expect(await supervisor.recordSupervisedProcess({ ...process, attemptToken: randomUUID() })).toMatchObject({ ok: true, outcome: 'lost' });
      expect(await supervisor.recordSupervisedProcess({ ...process, protectedIdentity: { ...process.protectedIdentity, connectionEpoch: 0 } })).toMatchObject({ ok: true, outcome: 'lost' });
      expect(await supervisor.recordSupervisedProcess(process)).toMatchObject({ ok: true, outcome: 'lost' });
      await admin.query('set session authorization brain_protected_supervisor');
      expect((await admin.query('select brain.begin_protected_input_launch($1,$2,1) as started', [authWork, authToken])).rows[0]).toEqual({ started: true });
      await admin.query('reset session authorization');
      const recorded = await supervisor.recordSupervisedProcess(process);
      expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, outcome: 'done' });
      expect(await supervisor.recordSupervisedProcess(process)).toMatchObject({ ok: true, outcome: 'done' });
      expect(await supervisor.recordSupervisedProcess({ ...process, protectedIdentity: { ...process.protectedIdentity, launchLease: randomUUID() } })).toMatchObject({ ok: true, outcome: 'lost' });
      expect(await supervisor.recordSupervisedProcess({ ...process, protectedIdentity: { ...process.protectedIdentity, connectionEpoch: 2 } })).toMatchObject({ ok: true, outcome: 'lost' });
      expect((await admin.query('select protected_launch_lease, protected_connection_epoch, pid, (extract(epoch from os_started_at)*1000000)::bigint::text as start_us from brain.work_attempts where token=$1', [authToken])).rows[0])
        .toEqual({ protected_launch_lease: lease, protected_connection_epoch: '1', pid: 1234, start_us: process.protectedIdentity.startTimeUs });
      const pendingToken = randomUUID();
      await admin.query('set session authorization brain_protected_supervisor');
      await admin.query('update brain.work_items set current_attempt_token=null where id=$1', [authWork]);
      await admin.query('insert into brain.work_attempts(token,work_item_id,started_at) values ($1,$2,$3)', [pendingToken, authWork, now]);
      await admin.query('update brain.work_items set current_attempt_token=$1,attempts=2 where id=$2', [pendingToken, authWork]);
      await admin.query('reset session authorization');
      expect(await supervisor.requestWorkCancel({ id: authWork, now })).toMatchObject({ ok: true, state: 'requested' });
      await admin.query('set session authorization brain_protected_supervisor');
      expect((await admin.query('select brain.begin_protected_input_launch($1,$2,2) as started', [authWork, pendingToken])).rows[0]).toEqual({ started: false });
      await admin.query('reset session authorization');
      // spawn 진입과 취소가 경합해도 같은 attempt에서 둘 다 성공하지 않는다.
      const raceWork = randomUUID(), raceToken = randomUUID();
      await admin.query('set session authorization brain_protected_supervisor');
      await admin.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,attempts,claimed_at,claim_expires_at,claimed_by,hold_group) values ($1,'garmin.auth','extension','race-fixture',$2,$2,'supervised',1,$2,$2::timestamptz + interval '1 hour','fixture','extension:garmin')", [raceWork, now]);
      await admin.query('insert into brain.work_attempts(token,work_item_id,started_at) values ($1,$2,$3)', [raceToken, raceWork, now]);
      await admin.query('update brain.work_items set current_attempt_token=$1 where id=$2', [raceToken, raceWork]);
      await admin.query('reset session authorization');
      const concurrent = new pg.Client({ connectionString: supervisorUrl.toString() });
      await concurrent.connect();
      try {
        const [beginResult, cancelResult] = await Promise.all([
          concurrent.query('select brain.begin_protected_input_launch($1,$2,1) as started', [raceWork, raceToken]),
          supervisor.requestWorkCancel({ id: raceWork, now }),
        ]);
        const began = beginResult.rows[0].started === true;
        const cancelled = cancelResult.ok && cancelResult.state === 'requested';
        expect(began !== cancelled).toBe(true);
        const observed = (await admin.query('select l.state,w.cancel_requested_at is not null as cancelled from brain.protected_input_launches l join brain.work_items w on w.id=l.work_id where l.work_id=$1 and l.attempt_token=$2', [raceWork, raceToken])).rows[0];
        expect(observed).toEqual(began ? { state: 'spawning', cancelled: false } : { state: 'closed', cancelled: true });
      } finally { await concurrent.end(); }
      await admin.query('set session authorization brain_protected_supervisor');
      await admin.query('update brain.work_items set current_attempt_token=null where id=$1', [raceWork]);
      await admin.query('reset session authorization');
      const addPending = async (target: string) => {
        const pendingWork = randomUUID(), pendingAttempt = randomUUID();
        await admin.query('set session authorization brain_protected_supervisor');
        await admin.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,attempts,claimed_at,claim_expires_at,claimed_by,hold_group) values ($1,'garmin.auth','extension',$2,$3,$3,'supervised',1,$3,$3::timestamptz + interval '1 hour','fixture','extension:garmin')", [pendingWork, target, now]);
        await admin.query('insert into brain.work_attempts(token,work_item_id,started_at) values ($1,$2,$3)', [pendingAttempt, pendingWork, now]);
        await admin.query('update brain.work_items set current_attempt_token=$1 where id=$2', [pendingAttempt, pendingWork]);
        await admin.query('reset session authorization');
        return { pendingWork, pendingAttempt };
      };
      const held = await addPending('hold-fixture');
      expect(await supervisor.holdWorkGroup({ group: 'extension:garmin', now })).toMatchObject({ ok: true, held: true });
      await admin.query('set session authorization brain_protected_supervisor');
      expect((await admin.query('select brain.begin_protected_input_launch($1,$2,1) as started', [held.pendingWork, held.pendingAttempt])).rows[0]).toEqual({ started: false });
      await admin.query('update brain.work_items set current_attempt_token=null where id=$1', [held.pendingWork]);
      await admin.query('reset session authorization');
      expect(await supervisor.releaseWorkGroup({ group: 'extension:garmin' })).toMatchObject({ ok: true, released: true });
      const disabled = await addPending('disable-fixture');
      expect(await supervisor.setExtensionEnabled({ name: 'garmin', enabled: false, now })).toMatchObject({ ok: true, found: true, changed: true });
      await admin.query('set session authorization brain_protected_supervisor');
      expect((await admin.query('select brain.begin_protected_input_launch($1,$2,1) as started', [disabled.pendingWork, disabled.pendingAttempt])).rows[0]).toEqual({ started: false });
      await admin.query('update brain.work_items set current_attempt_token=null where id=$1', [disabled.pendingWork]);
      await admin.query('reset session authorization');
      expect(await supervisor.setExtensionEnabled({ name: 'garmin', enabled: true, now })).toMatchObject({ ok: true, found: true, changed: true });
    } finally {
      await mutations.close();
      await supervisor.close();
      await admin.query('alter role brain_protected_supervisor nologin password null');
    }
    await admin.query('set session authorization brain_protected_supervisor');
    await admin.query("update brain.work_items set current_attempt_token=null where id=$1", [authWork]);
    await admin.query('reset session authorization');
    await admin.query('set session authorization brain_protected_broker');
    expect((await admin.query("select garmin.admission_valid($1,$2,1,'fixture',1) as valid", [work, token])).rows[0]).toEqual({ valid: true });
    const intent = (await admin.query("select garmin.start_external_call($1,$2,1,'fixture',1,'data','summary','UTC',null,false) as id", [work, token])).rows[0].id;
    expect((await admin.query("select garmin.finish_external_call($1,$2,1,'fixture',1,$3,'other') as done", [work, token, intent])).rows[0]).toEqual({ done: true });
    await expect(admin.query("select garmin.reserve_work_admission($1,$2,1,'fixture','UTC')", [work, token])).rejects.toMatchObject({ code: '42501' });
    await admin.query('reset session authorization');
    await admin.query('set session authorization brain_protected_worker');
    await expect(admin.query("select garmin.finish_external_call($1,$2,1,'fixture',1,gen_random_uuid(),'success')", [work, token])).rejects.toMatchObject({ code: '42501' });
    await admin.query('reset session authorization');
    await expect(app.query("update brain.work_items set attempts=0 where id=$1", [work])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("update brain.work_attempts set outcome='failed',finished_at=now() where token=$1", [token])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("insert into brain.work_hold_groups(name,held_at) values ('extension:garmin',now())")).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("insert into brain.schedules(kind) values ('garmin.collect')")).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("update brain.extensions set enabled=false where name='garmin'")).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("insert into brain.extension_install_progress(name,revision,progress) values ('garmin',1,'{\"name\":\"garmin\"}')")).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("insert into brain.extension_work_kinds(extension_name,kind) values ('garmin','garmin.forged')")).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('insert into brain.work_dependencies(work_item_id,prerequisite_id) values ($1,$1)', [work])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("insert into garmin.auth_success_evidence(work_id,attempt_token,run_generation,binding_generation,profile_id) values (gen_random_uuid(),gen_random_uuid(),1,1,'fixture')")).rejects.toMatchObject({ code: '42501' });
    await expect(worker.query("select garmin.finish_external_call(gen_random_uuid(),gen_random_uuid(),1,'fixture',1,gen_random_uuid(),'success')")).rejects.toMatchObject({ code: '42501' });
    await provisionExtension(db.url, 'garmin', password);
    await check();
    await admin.query('drop owned by brain_ext_garmin; drop role brain_ext_garmin');
    await provisionExtension(db.url, 'garmin', password);
    await check();
    await expect(worker.query("select garmin.finish_external_call(gen_random_uuid(),gen_random_uuid(),1,'fixture',1,gen_random_uuid(),'success')")).rejects.toMatchObject({ code: '42501' });
    await admin.query('set role brain_owner; create table garmin.quarantine_fixture (id integer); reset role');
    expect((await admin.query("select has_table_privilege('brain_ext_garmin','garmin.quarantine_fixture','INSERT') as allowed")).rows[0]).toEqual({ allowed: false });
  } finally {
    await store.close();
    await rm(partial, { recursive: true, force: true });
    await rm(full, { recursive: true, force: true });
    await rm(core, { recursive: true, force: true });
    await admin.query('revoke brain_protected_broker from brain_app').catch(() => {});
    await app.end().catch(() => {}); await worker.end().catch(() => {});
    await admin.end();
    await db.drop();

  }
}, 60_000);
