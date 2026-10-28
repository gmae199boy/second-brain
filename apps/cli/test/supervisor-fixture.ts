import { postgresStore } from 'second_brain/postgres';
import { pgHome } from './pg-home.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { PgTestClient } from './pg-client.js';
/** Reusable isolated home, probe enqueue, and administrative attempt inspection. */
export async function supervisorFixture(home: string) {
  const db = await pgHome(home);
  const client = new PgTestClient(db.url);
  return {
    db, env: db.env,
    async enqueueProbe(durationMs = 1500) {
      const id = uuidV7IdGen().next(); const now = new Date();
      const store = postgresStore({ databaseUrl: db.appUrl });
      try {
        const added = await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: String(durationMs), createdAt: now, nextAttemptAt: now });
        if (!added.ok) throw new Error(added.message);
        return added.item.id;
      } finally { await store.close(); }
    },
    async item(id: string) { return client.prepare('select * from work_items where id=$1').get(id); },
    async attempts(id: string) { return client.prepare('select * from work_attempts where work_item_id=$1 order by started_at').all(id); },
    async close() { await client.close(); await db.drop(); },
  };
}
