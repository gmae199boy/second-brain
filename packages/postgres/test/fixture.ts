import { createTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { prepareDatabase, runMigrations, postgresStore } from '../src/index.js';
export const clock = { now: () => new Date('2026-10-28T01:02:03.456Z') };
export async function database(migrate = true): Promise<TestDatabase> {
  const db = await createTestDatabase();
  const prepared = await prepareDatabase({ databaseUrl: db.url, appPassword: 'brain-test-app', databaseName: new URL(db.url).pathname.slice(1) });
  if (!prepared.ok) { await db.drop(); throw new Error(prepared.message); }
  if (migrate) {
    const result = await runMigrations({ databaseUrl: db.url, clock });
    if (!result.ok) { await db.drop(); throw new Error(JSON.stringify(result)); }
  }
  return db;
}
export async function subject() {
  const db = await database();
  const store = postgresStore({ databaseUrl: db.appUrl });
  return { ...store, async close() { await store.close(); await db.drop(); } };
}
