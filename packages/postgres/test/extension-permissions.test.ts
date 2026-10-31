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
    expect(await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: 'extension', createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
    expect(await store.claimSupervisedWork({ now, claimedBy: 'test', kinds: ['process_probe'], attemptToken: token })).toMatchObject({ ok: true, attemptToken: token });
    await a.query('insert into contract_test.results values ($1,$2,$3)', [names[0], id, token]);
    await expect(a.query('insert into contract_test.results values ($1,$2,$3)', [names[1], id, token])).rejects.toMatchObject({ code: '42501' });
    await store.settleSupervisedAttempt({ id, attemptToken: token, now, outcome: 'died' });
    await expect(a.query('insert into contract_test.results values ($1,$2,$3)', [names[0], id, token])).rejects.toMatchObject({ code: 'BRS01' });
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
