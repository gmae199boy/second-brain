import type { ProcessInspector } from 'second_brain';
import { systemProcessInspector } from '../src/runtime/process-inspector.js';
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
    async enqueueProbe(durationMs = 1500, serializationKey?: string | null) {
      const id = uuidV7IdGen().next(); const now = new Date();
      const store = postgresStore({ databaseUrl: db.appUrl });
      try {
        const added = await store.addWork({ id, serializationKey, kind: 'process_probe', targetKind: 'probe', targetId: String(durationMs), createdAt: now, nextAttemptAt: now });
        if (!added.ok) throw new Error(added.message);
        return added.item.id;
      } finally { await store.close(); }
    },
    async claimProcess(id: string, pid: number, options: { inspector?: ProcessInspector; startedAt?: Date } = {}) {
      const store = postgresStore({ databaseUrl: db.appUrl }); const token = uuidV7IdGen().next();
      try {
        const claimed = await store.claimSupervisedWork({ now: new Date(), claimedBy: uuidV7IdGen().next(), kinds: ['process_probe'], attemptToken: token });
        if (!claimed.ok || claimed.item?.id !== id) throw new Error('시험용 시도 청구 실패');
        const inspector = options.inspector ?? systemProcessInspector;
        const boot = await inspector.bootTime(); const start = await inspector.startedAt(pid);
        const recorded = await store.recordSupervisedProcess({ id, attemptToken: token, pid, pgid: pid,
          osBootAt: boot.state === 'found' ? boot.value : null, osStartedAt: options.startedAt ?? (start.state === 'found' ? start.value : null) });
        if (!recorded.ok) throw new Error(recorded.message);
        return token;
      } finally { await store.close(); }
    },
    async item(id: string) { return client.prepare('select * from work_items where id=$1').get(id); },
    async attempts(id: string) { return client.prepare('select * from work_attempts where work_item_id=$1 order by started_at').all(id); },
    async close() { await client.close(); await db.drop(); },
  };
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
export function killGroup(pid: number): void {
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
