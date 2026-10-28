import { expect, it } from 'vitest';
import pg from 'pg';
import { setTimeout } from 'node:timers/promises';
import { database } from './fixture.js';
import { prepareDatabase } from '../src/index.js';
it('returns a failure value for an invalid database URL', async () => {
  await expect(prepareDatabase({ databaseUrl: 'not a URL', appPassword: 'brain-test-app' }))
    .resolves.toMatchObject({ ok: false, code: 'DB_UNAVAILABLE', message: expect.stringContaining('Invalid URL') });
});
it('prepares role and schema idempotently and keeps owner separate from runtime', async () => {
  const db = await database(false);
  try {
    const prepared = await prepareDatabase({ databaseUrl: db.url, appPassword: 'brain-test-app', databaseName: new URL(db.url).pathname.slice(1) });
    expect(prepared.ok, prepared.ok ? undefined : prepared.message).toBe(true);
    const roles = await db.rows("select rolname,rolcanlogin,rolsuper,rolbypassrls from pg_roles where rolname in ('brain_owner','brain_app') order by rolname");
    expect(roles).toEqual([{ rolname:'brain_app',rolcanlogin:true,rolsuper:false,rolbypassrls:false },{ rolname:'brain_owner',rolcanlogin:false,rolsuper:false,rolbypassrls:false }]);
    expect(await db.rows("select nspowner::regrole::text as owner from pg_namespace where nspname='brain'")).toEqual([{ owner:'brain_owner' }]);
  } finally { await db.drop(); }
});

it.each(['roles', 'schema'] as const)('waits beyond runtime deadlines for administrative %s preparation', async kind => {
  const db = await database(false);
  const url = new URL(db.url);
  if (kind === 'roles') url.pathname = '/postgres';
  const blocker = new pg.Client({ connectionString: url.toString() });
  await blocker.connect();
  let pending: ReturnType<typeof prepareDatabase> | undefined;
  try {
    if (kind === 'roles') await blocker.query('select pg_advisory_lock($1)', [4919270912]);
    else {
      await blocker.query('begin');
      await blocker.query('lock table brain.schema_migrations in access exclusive mode');
    }
    pending = prepareDatabase({ databaseUrl: db.url, appPassword: 'brain-test-app', databaseName: new URL(db.url).pathname.slice(1) });
    // Cross both the default lock (5s) and statement (6s) deadlines.
    await setTimeout(6200);
    if (kind === 'roles') await blocker.query('select pg_advisory_unlock($1)', [4919270912]);
    else await blocker.query('commit');
    const prepared = await pending;
    expect(prepared.ok, prepared.ok ? undefined : prepared.message).toBe(true);
  } finally {
    await blocker.end();
    await pending;
    await db.drop();
  }
});

it('creates a previously absent database owned by brain_owner and supports the app role', async () => {
  const { randomBytes } = await import('node:crypto');
  const { requireAdminDatabaseUrl } = await import('@second-brain/test-db');
  const name = `brain_test_${randomBytes(6).toString('hex')}`;
  const url = requireAdminDatabaseUrl();
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  try {
    expect((await admin.query('select 1 from pg_database where datname=$1', [name])).rows).toEqual([]);
    const prepared = await prepareDatabase({ databaseUrl: url, databaseName: name, appPassword: 'brain-test-app' });
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    expect((await admin.query('select datdba::regrole::text as owner from pg_database where datname=$1', [name])).rows)
      .toEqual([{ owner: 'brain_owner' }]);
    const appUrl = new URL(prepared.databaseUrl); appUrl.username = 'brain_app'; appUrl.password = 'brain-test-app';
    const app = new pg.Client({ connectionString: appUrl.toString() }); await app.connect();
    try {
      expect((await app.query('select * from brain.schema_migrations')).rows).toEqual([]);
      await expect(app.query('create table brain.forbidden(id int)')).rejects.toThrow('permission denied');
    } finally { await app.end(); }
    expect(await prepareDatabase({ databaseUrl: url, databaseName: name, appPassword: 'brain-test-app' })).toEqual(prepared);
  } finally { await admin.query(`drop database if exists "${name}" with (force)`); await admin.end(); }
});
