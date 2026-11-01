import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('공개 doctor와 수동 release가 독립 보호를 보존한다', async () => {
  const { postgresStore, CORE_SCHEMA_VERSION } = await import('second_brain/postgres');
  const { runDoctor } = await import('second_brain');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome(), controller = new AbortController(), ids = uuidV7IdGen();
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const pending = await fixture.run(['ext','install','garmin','--json']);
    expect(pending.body?.error?.code).toBe('EXTENSION_LOGIN_REQUIRED');
    const authWork = pending.body.data.install.auth_work_id;
    expect(authWork).toMatch(/^[0-9a-f-]{36}$/);
    await fixture.db.query(`update brain.work_items set outcome='succeeded',completed_at=now() where id='${authWork}'`);
    expect((await fixture.run(['ext','install','garmin','--json'])).code).toBe(0);
    const id = randomUUID();
    await fixture.db.query(`insert into garmin.account_protection(id,profile_id,auth_required,rate_day,manual_required,uncertain)
      values ('${id}','fixture',true,'2026-01-01',true,true)`);
    const before = await fixture.run(['ext','status','garmin','--json']);
    expect(before.body.data.attention).toEqual({requires_action:true,requires_manual_action:true});
    const doctor = await runDoctor(store,{store,extensionStore:store,clock:systemClock,schemaVersions:{core:CORE_SCHEMA_VERSION}});
    expect(doctor.checks.find(check => check.id === 'extensions')).toMatchObject({status:'warn',detail:expect.stringContaining('수동 조치 필요')});
    daemon = runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,
      drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const queued = await fixture.run(['ext','run','garmin','release-block','--target','fixture','--json']);
    expect(queued.code,queued.stdout + queued.stderr).toBe(0);
    const work = queued.body.data.work_id;
    expect(work).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect((await fixture.db.rows(`select auth_required,rate_day,manual_required,uncertain from garmin.account_protection where id='${id}'`))[0]).toEqual({auth_required:true,rate_day:null,manual_required:false,uncertain:true});
    expect(await fixture.db.rows(`select work_id from garmin.protection_release_events where work_id='${work}'`)).toEqual([{work_id:work}]);
    const after = await fixture.run(['ext','status','garmin','--json']);
    expect(after.body.data.attention).toEqual({requires_action:true,requires_manual_action:false});
  } finally {
    controller.abort(); await daemon; await store.close(); await fixture.cleanup();
  }
});
