import pg from 'pg';
import { createTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { prepareDatabase, runMigrations, postgresStore } from '../src/index.js';
export const clock = { now: () => new Date('2026-10-28T01:02:03.456Z') };
export async function database(migrate = true): Promise<TestDatabase> {
  const db = await createTestDatabase();
  const prepared = await prepareDatabase({ databaseUrl: db.url, appPassword: 'brain-test-app', maintenancePassword: 'brain-test-maintenance', databaseName: new URL(db.url).pathname.slice(1) });
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
  return { ...store, db,
    async readWorkItem(id: string) {
      const client = new pg.Client({ connectionString: db.appUrl });
      await client.connect();
      try {
        const { rows } = await client.query('select serialization_key as "serializationKey", outcome, completed_at as "completedAt", current_attempt_token as "currentAttemptToken", next_attempt_at as "nextAttemptAt", last_error as "lastError" from brain.work_items where id = $1', [id]);
        return rows[0] ?? null;
      } finally { await client.end(); }
    },
    async close() { await store.close(); await db.drop(); } };

}
