import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { postgresStore } from 'second_brain/postgres';
import { extHome } from './ext-fixture.js';
import { runPgCommand } from './pg-home.js';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

it('실제 CLI 비활성이 데몬 일감과 예약을 보류하고 재활성이 일감을 재개한다', async () => {
  const fixture = await extHome();
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  const controller = new AbortController();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const sourceRoot = join(fixture.home, 'fixture-packages');
    const source = join(sourceRoot, 'extdisable');
    await mkdir(sourceRoot);
    await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
    for (const path of ['manifest.json', 'migrations/0001_testext.sql', 'bin/check.mjs']) {
      const file = join(source, path);
      await writeFile(file, (await readFile(file, 'utf8')).replaceAll('testext', 'extdisable'));
    }
    const sourceManifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
    sourceManifest.work = [{ kind: 'extdisable.sync', execution: 'supervised', runtime: 'node', entry: 'bin/sync.mjs' }];
    await writeFile(join(source, 'manifest.json'), JSON.stringify(sourceManifest));
    await writeFile(join(source, 'bin/sync.mjs'), `console.log(JSON.stringify({abi:1,type:'progress'})); setTimeout(() => console.log(JSON.stringify({abi:1,type:'result'})), Number(process.env.BRAIN_TARGET_ID));\n`);
    fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sourceRoot;
    const installed = await fixture.run(['ext', 'install', 'extdisable', '--json']);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    const canary = 'canary-secret-diagnostic';
    expect(await store.setSetting({ userId: null, key: 'extdisable.secret', value: canary, updatedAt: new Date() })).toMatchObject({ ok: true });
    await fixture.db.query("update brain.extensions set connection_status='failed', connection_code='EXTENSION_WORKER_ERROR', connection_message='canary-secret-diagnostic' where name='extdisable'");
    const manifest = join(fixture.home, 'extensions/extdisable/manifest.json');
    const hash = () => readFile(manifest).then(data => createHash('sha256').update(data).digest('hex'));
    const beforeHash = await hash();
    await fixture.db.query('insert into extdisable.checks(id, checked_at) values (1, now())');
    const beforeRows = await fixture.db.rows('select count(*)::int as count from extdisable.checks');
    const now = new Date(), ids = uuidV7IdGen();
    const runningId = ids.next(), pendingId = ids.next(), otherId = ids.next(), scheduleId = ids.next();
    const add = (id: string, targetId: string, group: string, key: string, kind = 'extdisable.sync') => store.addWork({ id, kind, targetKind: 'probe', targetId, holdGroup: group, serializationKey: key, createdAt: now, nextAttemptAt: now });
    expect(await add(runningId, '10000', 'extension:extdisable', 'same')).toMatchObject({ ok: true });
    daemon = runDaemon({ home: fixture.home, env: fixture.env, clock: systemClock, idGen: ids, signal: controller.signal,
      drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 50, cancelPollMs: 50, cancelGraceMs: 100, groupConfirmMs: 1000 } });
    await expect.poll(async () => (await fixture.db.rows(`select current_attempt_token from brain.work_items where id='${runningId}'`))[0]?.current_attempt_token, { timeout: 15000 }).toBeTruthy();
    expect(await add(pendingId, '50', 'extension:extdisable', 'same')).toMatchObject({ ok: true });
    expect(await add(otherId, '75', 'extension:otherext', 'other', 'process_probe')).toMatchObject({ ok: true });
    expect(await store.addSchedule({ id: scheduleId, kind: 'schedule_probe', holdGroup: 'extension:extdisable', targetKind: 'probe', targetId: 'held-schedule', localTime: null, timeZone: null, intervalSeconds: 3600, nextRunAt: new Date(now.getTime() + 3600000), lastRunAt: null, createdAt: now })).toMatchObject({ ok: true });
    const disabled = await fixture.run(['ext', 'disable', 'extdisable', '--json']);
    expect(disabled.code, disabled.stdout + disabled.stderr).toBe(0);
    expect((await fixture.run(['ext', 'disable', 'extdisable', '--json'])).body.data.changed).toBe(false);
    await fixture.db.query(`update brain.schedules set next_run_at=now()-interval '1 minute' where id='${scheduleId}'`);
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_attempts where work_item_id='${runningId}' order by started_at desc limit 1`))[0]?.outcome, { timeout: 15000 }).toBe('cancelled');
    await expect.poll(async () => (await fixture.db.rows(`select completed_at from brain.work_items where id='${otherId}'`))[0]?.completed_at, { timeout: 15000 }).toBeTruthy();
    const status = await fixture.run(['ext', 'status', 'extdisable', '--json']);
    expect(status.body.data).toMatchObject({ enabled: false, interrupted_work_count: 2, held_schedule_count: 1 });
    expect(status.stdout).not.toContain(canary);
    expect((await fixture.run(['ext', 'list', '--json'])).stdout).not.toContain(canary);
    expect(JSON.stringify(await store.getExtensionPublicStatus('extdisable'))).not.toContain(canary);
    const doctor = await runPgCommand(['doctor', 'run', '--json'], fixture.env);
    expect(doctor.stdout).not.toContain(canary);
    expect(doctor.stdout).toContain('extdisable: 비활성, 중단 일감 2건, 보류 예약 1건');
    const queue = await fixture.run(['queue', 'list', '--json']);
    expect(JSON.stringify(queue.body)).toContain('extension_disabled');
    expect((await fixture.db.rows(`select attempts,completed_at from brain.work_items where id='${pendingId}'`))[0]).toMatchObject({ attempts: 0, completed_at: null });
    expect((await fixture.db.rows(`select next_run_at,last_run_at from brain.schedules where id='${scheduleId}'`))[0]?.last_run_at).toBeNull();
    expect(await fixture.db.rows('select count(*)::int as count from extdisable.checks')).toEqual(beforeRows);
    expect(await hash()).toBe(beforeHash);
    expect((await fixture.run(['ext', 'enable', 'missingext', '--json'])).body.error.code).toBe('EXTENSION_NOT_FOUND');
    const enabled = await fixture.run(['ext', 'enable', 'extdisable', '--json']); expect(enabled.code).toBe(0);
    expect((await fixture.run(['ext', 'enable', 'extdisable', '--json'])).body.data.changed).toBe(false);
    await expect.poll(async () => (await fixture.db.rows(`select completed_at from brain.work_items where id='${pendingId}'`))[0]?.completed_at, { timeout: 15000 }).toBeTruthy();
  } finally {
    controller.abort(); await daemon; await store.close(); await fixture.cleanup();
  }
}, 45000);

it('실제 설치 전 실패와 활성 로그인·연결 실패를 SDK, 상태 명령과 doctor가 구분한다', async () => {
  const fixture = await extHome();
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  try {
    const { publicExtensionStatus } = await import('second_brain');
    const now = new Date(); const canary = 'EXT_DIAGNOSTIC_SECRET_CANARY';
    const failed = await fixture.run(['ext', 'install', 'missingdiag', '--json']);
    expect(failed.body.error.code).toBe('EXTENSION_NOT_FOUND');
    expect(await store.setSetting({ userId: null, key: 'logindiag.secret', value: canary, updatedAt: now })).toMatchObject({ ok: true });
    await store.recordExtensionInstall({ name: 'logindiag', version: '1', now });
    await store.writeExtensionInstallProgress({ expectedRevision: null, progress: { name: 'logindiag', packageDigest: 'a'.repeat(64), result: 'login_required', failedStage: null,
      lastFailure: null, stages: { login: { status: 'pending', code: 'LOGIN_REQUIRED', at: now.toISOString() } }, authWorkId: null, scheduleIds: [] } });
    await store.recordExtensionInstall({ name: 'connectdiag', version: '1', now });
    await store.recordExtensionConnection({ name: 'connectdiag', status: 'failed', code: 'REFUSED', message: canary, checkedAt: now });
    const missing = await publicExtensionStatus({ store }, { name: 'missingdiag' });
    const login = await publicExtensionStatus({ store }, { name: 'logindiag' });
    const connection = await publicExtensionStatus({ store }, { name: 'connectdiag' });
    expect(missing).toMatchObject({ ok: true, status: { installed: false, journalPresent: true, installResult: 'failed', failedStage: 'package', lastFailure: { code: 'EXTENSION_NOT_FOUND' } } });
    expect(login).toMatchObject({ ok: true, status: { enabled: true, installResult: 'login_required', login: { status: 'pending', code: 'LOGIN_REQUIRED' } } });
    expect(connection).toMatchObject({ ok: true, status: { enabled: true, connection: { status: 'failed', code: 'REFUSED' } } });
    const missingCli = await fixture.run(['ext', 'status', 'missingdiag', '--json']);
    const loginCli = await fixture.run(['ext', 'status', 'logindiag', '--json']);
    const connectionCli = await fixture.run(['ext', 'status', 'connectdiag', '--json']);
    expect(missingCli.body.data).toMatchObject({ installed: false, install: { result: 'failed', failed_stage: 'package', last_failure: { code: 'EXTENSION_NOT_FOUND' } } });
    expect(loginCli.body.data).toMatchObject({ enabled: true, install: { result: 'login_required' }, login: { status: 'pending', code: 'LOGIN_REQUIRED' } });
    expect(connectionCli.body.data).toMatchObject({ enabled: true, connection: { status: 'failed', code: 'REFUSED' } });
    const doctor = await runPgCommand(['doctor', 'run', '--json'], fixture.env);
    const check = JSON.parse(doctor.stdout).data.checks.find((item: { id: string }) => item.id === 'extensions');
    expect(check.status).toBe('warn');
    for (const text of ['missingdiag: 미설치', '설치 결과 failed', 'package (EXTENSION_NOT_FOUND)', 'logindiag: 활성', '설치 결과 login_required', '로그인 pending (LOGIN_REQUIRED)', 'connectdiag: 활성', '연결 failed (REFUSED)']) expect(check.detail).toContain(text);
    expect(JSON.stringify({ missing, login, connection, missingCli, loginCli, connectionCli, doctor })).not.toContain(canary);
  } finally { await store.close(); await fixture.cleanup(); }
}, 30000);
