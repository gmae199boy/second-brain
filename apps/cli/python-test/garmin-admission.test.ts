import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('실제 감독자는 Garmin 인증 worker spawn 전에 admission을 보존한다', async () => {
  const { postgresStore } = await import('second_brain/postgres');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome(), controller = new AbortController(), ids = uuidV7IdGen();
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const canary='plain-nonpattern-72fe1';
    const piped=spawnSync(process.execPath,[fileURLToPath(new URL('../dist/bin.js',import.meta.url)),'ext','auth','garmin','--json'],
      {input:canary,encoding:'utf8',env:fixture.env,timeout:10000});
    expect(piped.status).toBe(1);
    expect(piped.stdout+piped.stderr).not.toContain(canary);
    expect(JSON.parse(piped.stdout).error.code).toBe('AUTH_PEER_UNVERIFIED');
    const unavailable = await fixture.run(['ext','auth','garmin','--json']);
    expect(unavailable.body?.error?.code).toBe('AUTH_PEER_UNVERIFIED');
    expect(await fixture.db.rows('select id from brain.work_items')).toEqual([]);
    const pending = await fixture.run(['ext','install','garmin','--json']);
    expect(pending.body?.error?.code).toBe('EXTENSION_LOGIN_REQUIRED');
    const work = pending.body.data.install.auth_work_id;
    expect(work).toMatch(/^[0-9a-f-]{36}$/);
    await store.setSetting({key:'garmin.timezone',value:'UTC',updatedAt:new Date()});
    const protection = randomUUID();
    await fixture.db.query(`insert into garmin.account_protection(id) values ('${protection}');
      insert into garmin.account_binding(target,protection_id) values ('~/.garmin-pipeline/tokens','${protection}')`);
    await fixture.db.query(`create table garmin.admission_audit(event text, work_id uuid, attempt_token uuid);
      create function garmin.fixture_admission_audit() returns trigger language plpgsql security definer set search_path='' as $$
      begin if tg_op='INSERT' then insert into garmin.admission_audit values ('insert',new.work_id,new.attempt_token); return new;
      else insert into garmin.admission_audit values ('delete',old.work_id,old.attempt_token); return old; end if; end $$;
      create trigger fixture_admission_audit after insert or delete on garmin.admission_holder for each row execute function garmin.fixture_admission_audit()`);
    daemon = runDaemon({ home:fixture.home, env:fixture.env, clock:systemClock, idGen:ids,
      signal:controller.signal, drainPauseMs:25, heartbeatMs:100, supervisor:{pollMs:25} });
    await expect.poll(async () => (await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${work}'`))[0]?.error_code,{timeout:20000}).toBe('AUTH_PEER_UNVERIFIED');
    const history = await fixture.db.rows(`select event,work_id,attempt_token from garmin.admission_audit where work_id='${work}' order by event desc`);
    const attempts = await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${work}'`);
    expect(history).toEqual([{event:'insert',work_id:work,attempt_token:attempts[0]?.token}]);
    expect(await fixture.db.rows(`select work_id from garmin.admission_holder where work_id='${work}'`)).toEqual([{work_id:work}]);
    expect(await fixture.db.rows('select id from garmin.external_call_intent')).toEqual([]);
  } finally {
    controller.abort(); await daemon; await store.close(); await fixture.cleanup();
  }
});
