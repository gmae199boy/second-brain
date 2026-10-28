import { expect, it } from 'vitest';
import { database } from './fixture.js';
import { prepareDatabase } from '../src/index.js';
it('prepares role and schema idempotently and keeps owner separate from runtime', async () => {
  const db = await database(false);
  try {
    expect((await prepareDatabase({ databaseUrl: db.url, appPassword: 'brain-test-app', databaseName: new URL(db.url).pathname.slice(1) })).ok).toBe(true);
    const roles = await db.rows("select rolname,rolcanlogin,rolsuper,rolbypassrls from pg_roles where rolname in ('brain_owner','brain_app') order by rolname");
    expect(roles).toEqual([{ rolname:'brain_app',rolcanlogin:true,rolsuper:false,rolbypassrls:false },{ rolname:'brain_owner',rolcanlogin:false,rolsuper:false,rolbypassrls:false }]);
    expect(await db.rows("select nspowner::regrole::text as owner from pg_namespace where nspname='brain'")).toEqual([{ owner:'brain_owner' }]);
  } finally { await db.drop(); }
});
