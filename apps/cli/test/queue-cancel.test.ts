import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { supervisorFixture } from './supervisor-fixture.js';
import { runPgCommand } from './pg-home.js';
import { HOME_ENV } from '../src/config/paths.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { postgresStore } from 'second_brain/postgres';
it('cancels waiting work, requests running work, reports closed/missing ids and rejects malformed UUIDs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'brain-cancel-')); const f = await supervisorFixture(home);
  const env = { ...process.env, ...f.env, [HOME_ENV]: home };
  const cancel = (id: string) => runPgCommand(['queue', 'cancel', id, '--json'], env);
  try {
    const id = await f.enqueueProbe();
    const cancelled = await cancel(id); expect(cancelled.code).toBe(0); expect(JSON.parse(cancelled.stdout).data).toEqual({ id, state: 'cancelled' });
    expect(await f.item(id)).toMatchObject({ outcome: 'cancelled', current_attempt_token: null });
    expect(JSON.parse((await cancel(id)).stdout).data.state).toBe('already_closed');
    const runningId = await f.enqueueProbe(2000); const store = postgresStore({ databaseUrl: f.db.appUrl });
    const token = uuidV7IdGen().next();
    try {
      await store.claimSupervisedWork({ now: new Date(), claimedBy: uuidV7IdGen().next(), kinds: ['process_probe'], attemptToken: token });
      expect(JSON.parse((await cancel(runningId)).stdout).data.state).toBe('requested');
      const requested = await runPgCommand(['queue', 'cancel', runningId], env);
      expect(requested.code).toBe(0); expect(requested.stdout.trim()).toBe('취소 요청을 접수했습니다.');
      expect(await store.settleSupervisedAttempt({ id: runningId, attemptToken: token, now: new Date(), outcome: 'unknown' }))
        .toEqual({ ok: true, outcome: 'done' });
      const unknown = await runPgCommand(['queue', 'cancel', runningId], env);
      expect(unknown.code).toBe(0); expect(unknown.stdout.trim()).toBe('취소 요청을 접수했습니다.');
      expect(await f.item(runningId)).toMatchObject({ current_attempt_token: token, completed_at: null });
      expect(await f.attempts(runningId)).toMatchObject([{ outcome: 'unknown' }]);
    }
    finally { await store.close(); }
    const missing = await cancel(uuidV7IdGen().next()); expect(missing.code).toBe(1); expect(JSON.parse(missing.stdout).error.code).toBe('WORK_NOT_FOUND');
    const malformed = await cancel('bad'); expect(malformed.code).toBe(2); expect(JSON.parse(malformed.stdout).error.code).toBe('USAGE');
  } finally { await f.close(); await rm(home, { recursive: true, force: true }); }
});
