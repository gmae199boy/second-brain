import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { expect, it } from 'vitest';
import { postgresStore, provisionExtension, runMigrations } from '../src/index.js';
import { clock, database } from './fixture.js';
import { prepareProtectedRoles } from '../src/protected-roles.js';

it('Garmin 재provision은 보호 schema의 권한을 되살리지 않는다', async () => {
  const db = await database();
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
    await copyFile(fileURLToPath(new URL('../protected-migrations/0028_protected_work.sql', import.meta.url)), join(core, '0028_protected_work.sql'));
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
    const cleanupUrl = new URL(db.url);
    cleanupUrl.pathname = '/postgres';
    const cleanup = new pg.Client({ connectionString: cleanupUrl.toString() });
    await cleanup.connect();
    try {
      const marker = `second-brain extension:${new URL(db.url).pathname.slice(1)}`;
      const owned = await cleanup.query("select shobj_description(oid,'pg_authid') as marker from pg_roles where rolname='brain_ext_garmin'");
      if (owned.rows[0]?.marker === marker) await cleanup.query('drop role brain_ext_garmin');
    } finally { await cleanup.end(); }
  }
}, 60_000);
