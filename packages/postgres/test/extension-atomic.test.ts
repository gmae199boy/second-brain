import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { subject } from './fixture.js';

it('활성 변경 트랜잭션의 commit 전후 프로세스 종료는 부분 확정을 남기지 않는다', async () => {
  const store = await subject();
  const admin = new pg.Client({ connectionString: store.db.url });
  await admin.connect();
  let child: ReturnType<typeof spawn> | undefined;
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../dist/index.js', import.meta.url))).href;
  const script = `import { postgresStore } from ${JSON.stringify(moduleUrl)}; const store=postgresStore({databaseUrl:process.env.TEST_DB}); const result=await store.setExtensionEnabled({name:'testext',enabled:false,now:new Date()}); console.log(JSON.stringify(result)); setInterval(()=>{},1000);`;
  const start = () => spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TEST_DB: store.db.appUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    expect(await store.recordExtensionInstall({ name: 'testext', version: '1', now: new Date() })).toMatchObject({ ok: true });
    await admin.query(`create function brain.test_pause_hold() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(8136136); return new; end $$`);
    await admin.query('create trigger test_pause_hold before insert on brain.work_hold_groups for each row execute function brain.test_pause_hold()');
    await admin.query('select pg_advisory_lock(8136136)');
    child = start();
    await expect.poll(async () => Number((await admin.query("select count(*) as n from pg_locks where locktype='advisory' and not granted")).rows[0].n), { timeout: 10000 }).toBeGreaterThan(0);
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; child = undefined;
    await admin.query('select pg_advisory_unlock(8136136)');
    expect((await store.getExtensionPublicStatus('testext'))).toMatchObject({ ok: true, status: { enabled: true } });
    expect((await admin.query("select count(*)::int as n from brain.work_hold_groups where name='extension:testext'")).rows[0].n).toBe(0);
    await admin.query('drop trigger test_pause_hold on brain.work_hold_groups');
    child = start();
    let output = ''; child.stdout!.setEncoding('utf8').on('data', data => { output += data; });
    await expect.poll(() => output, { timeout: 10000 }).toContain('"ok":true');
    const closedAfter = once(child, 'close'); child.kill('SIGKILL'); await closedAfter; child = undefined;
    expect((await store.getExtensionPublicStatus('testext'))).toMatchObject({ ok: true, status: { enabled: false } });
    expect((await admin.query("select count(*)::int as n from brain.work_hold_groups where name='extension:testext'")).rows[0].n).toBe(1);
    const now = new Date();
    await store.addWork({ id: '00000000-0000-7000-8000-000000000201', kind: 'schedule_probe', targetKind: 'probe', targetId: 'crash', holdGroup: 'extension:testext', createdAt: now, nextAttemptAt: now });
    expect(await store.claimWork({ now, claimedBy: '00000000-0000-7000-8000-000000000202', kinds: ['schedule_probe'] })).toMatchObject({ ok: true, item: null });
  } finally {
    child?.kill('SIGKILL'); await admin.end(); await store.close();
  }
}, 30000);

it('보류 쓰기 실패는 활성 변경을 되돌리고 오류를 전달한다', async () => {
  const store = await subject(); const admin = new pg.Client({ connectionString: store.db.url }); await admin.connect();
  try {
    await store.recordExtensionInstall({ name: 'testext', version: '1', now: new Date() });
    await admin.query(`create function brain.test_fail_hold() returns trigger language plpgsql as $$ begin raise exception '시험 실패'; end $$`);
    await admin.query('create trigger test_fail_hold before insert on brain.work_hold_groups for each row execute function brain.test_fail_hold()');
    expect(await store.setExtensionEnabled({ name: 'testext', enabled: false, now: new Date() })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    expect(await store.getExtensionPublicStatus('testext')).toMatchObject({ ok: true, status: { enabled: true } });
    expect((await admin.query('select count(*)::int as n from brain.work_hold_groups')).rows[0].n).toBe(0);
  } finally { await admin.end(); await store.close(); }
});

it('활성 변경과 청구·예약 발화 경합 후 보류된 그룹은 다시 청구하거나 발화하지 않는다', async () => {
  const store = await subject();
  try {
    const now = new Date();
    await store.ensureSelfUser({id:'01940000-0000-7000-8000-00000000000a',name:'synthetic',createdAt:now});
    await store.recordExtensionInstall({ name: 'testext', version: '1', now });
    const work = { id: '00000000-0000-7000-8000-000000000211', kind: 'schedule_probe', targetKind: 'probe', targetId: 'race', holdGroup: 'extension:testext', createdAt: now, nextAttemptAt: now };
    const scheduleId = '00000000-0000-7000-8000-000000000212';
    await store.addWork(work);
    await store.addSchedule({ id: scheduleId, kind: 'schedule_probe', holdGroup: 'extension:testext', targetKind: 'probe', targetId: 'race-schedule', triggerKind: 'interval' as const, cronExpr: null, runAt: null, timeZoneSource: null, extension: null, scheduleKey: null, userId: '01940000-0000-7000-8000-00000000000a', enabled: true, removedAt: null, timeZone: null, intervalSeconds: 60, nextRunAt: now, lastRunAt: null, createdAt: now });
    const fire = { expectedTriggerKind:'interval' as const,expectedTimeZone:null,expectedCronExpr:null, occurrences: [{ occurrenceAt: now, status: 'pending' as const }], scheduleId, expectedNextRunAt: now, nextRunAt: new Date(now.getTime() + 60000), now, work: { ...work, id: '00000000-0000-7000-8000-000000000213', targetId: 'race-schedule' } };
    const [disabled, claimed, fired] = await Promise.all([
      store.setExtensionEnabled({ name: 'testext', enabled: false, now }),
      store.claimWork({ now, claimedBy: '00000000-0000-7000-8000-000000000214', kinds: ['schedule_probe'] }),
      store.fireSchedule(fire),
    ]);
    expect(disabled).toMatchObject({ ok: true }); expect(claimed).toMatchObject({ ok: true }); expect(fired).toMatchObject({ ok: true });
    expect(await store.claimWork({ now, claimedBy: '00000000-0000-7000-8000-000000000215', kinds: ['schedule_probe'] })).toMatchObject({ ok: true, item: null });
    expect(await store.fireSchedule(fire)).toEqual({ ok: true, fired: false });
    expect(await store.listDueSchedules({ now: new Date(now.getTime() + 120000), limit: 10 })).toMatchObject({ ok: true, schedules: [] });
  } finally { await store.close(); }
});

it('비활성 확장의 보류는 일반 해제에 유지되고 활성 뒤 청구와 예약이 재개된다', async () => {
  const store = await subject();
  try {
    const now = new Date(); const group = 'extension:testext';
    await store.ensureSelfUser({id:'01940000-0000-7000-8000-00000000000a',name:'synthetic',createdAt:now});
    await store.recordExtensionInstall({ name: 'testext', version: '1', now });
    await store.addWork({ id: '00000000-0000-7000-8000-000000000221', kind: 'schedule_probe', targetKind: 'probe', targetId: 'held', holdGroup: group, createdAt: now, nextAttemptAt: now });
    await store.addSchedule({ id: '00000000-0000-7000-8000-000000000222', kind: 'schedule_probe', holdGroup: group, targetKind: 'probe', targetId: 'scheduled', triggerKind: 'interval' as const, cronExpr: null, runAt: null, timeZoneSource: null, extension: null, scheduleKey: null, userId: '01940000-0000-7000-8000-00000000000a', enabled: true, removedAt: null, timeZone: null, intervalSeconds: 60, nextRunAt: now, lastRunAt: null, createdAt: now });
    expect(await store.setExtensionEnabled({ name: 'testext', enabled: false, now })).toMatchObject({ ok: true });
    expect(await store.releaseWorkGroup({ group })).toEqual({ ok: true, released: false });
    expect(await store.claimWork({ now, claimedBy: '00000000-0000-7000-8000-000000000223', kinds: ['schedule_probe'] })).toMatchObject({ ok: true, item: null });
    expect(await store.listDueSchedules({ now, limit: 10 })).toMatchObject({ ok: true, schedules: [] });
    expect(await store.setExtensionEnabled({ name: 'testext', enabled: true, now })).toMatchObject({ ok: true });
    expect(await store.claimWork({ now, claimedBy: '00000000-0000-7000-8000-000000000223', kinds: ['schedule_probe'] })).toMatchObject({ ok: true, item: { targetId: 'held' } });
    expect(await store.listDueSchedules({ now, limit: 10 })).toMatchObject({ ok: true, schedules: [expect.objectContaining({ targetId: 'scheduled' })] });
    for (const name of ['extension:testext', 'extension:missing', 'general']) {
      await store.holdWorkGroup({ group: name, now });
      expect(await store.releaseWorkGroup({ group: name })).toEqual({ ok: true, released: true });
    }
  } finally { await store.close(); }
});
