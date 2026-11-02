import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('합성 정상·재실행·legacy coverage·회수 및 격리 실패를 실제 감독자와 검사한다', async () => {
  const { postgresStore } = await import('second_brain/postgres');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const { extensionDatabaseUrl } = await import('../src/config/codec.js');
  const fixture = await extHome(), ids = uuidV7IdGen(), controller = new AbortController();
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  let daemon: ReturnType<typeof runDaemon> | undefined;
  const home = await realpath(fixture.home), ext = join(home, 'extensions/garmin');
  const markerPath = join(home, '.garmin-collect-fixture.json');
  const response = { totalSteps: 1234, totalDistanceMeters: null, activeKilocalories: null, moderateIntensityMinutes: null, vigorousIntensityMinutes: null, minHeartRate: null, maxHeartRate: null, note: '합성' };
  const marker = { home, database: new URL(fixture.db.url).pathname.slice(1), host: new URL(fixture.db.url).hostname, port: new URL(fixture.db.url).port, response, barrier: false };
  const writeMarker = () => writeFile(markerPath, JSON.stringify(marker));
  const calls = async () => (await readFile(join(home, 'collect-calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const counts = async () => (await fixture.db.rows('select (select count(*)::int from garmin.raw_payloads) raw,(select count(*)::int from brain.health_observations) health,(select count(*)::int from garmin.collect_state) state'))[0];
  try {
    const installed = await fixture.run(['ext', 'install', 'garmin', '--json']);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/collect_fixture.py', import.meta.url)), join(ext, 'collect_fixture.py'));
    const manifestPath = join(ext, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.work.find((w: {kind:string}) => w.kind === 'garmin.collect').entry = 'collect_fixture.py';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeMarker();
    await store.setSetting({key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    const url = await extensionDatabaseUrl(home, 'garmin', fixture.db.appUrl);
    const python = join(ext, '.venv/bin/python');
    const queue = async (account: string, day: string) => {
      const id = ids.next(), now = new Date();
      expect(await store.addWork({id,kind:'garmin.collect',targetKind:'account',targetId:account,createdAt:now,nextAttemptAt:new Date(Date.now()+3600000)})).toMatchObject({ok:true});
      await fixture.db.query(`update brain.work_items set local_date_from='${day}',local_date_to='${day}',local_time_zone='Asia/Seoul',next_attempt_at=now() where id='${id}'`);
      return id;
    };
    daemon = runDaemon({home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const first = await queue('collect-test', '2026-01-01');
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${first}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect(await calls()).toBe(1);
    expect((await fixture.db.rows(`select last_progress_at from brain.work_attempts where work_item_id='${first}'`))[0]?.last_progress_at).not.toBeNull();
    const raw = await fixture.db.rows("select key,body from garmin.raw_records where account='collect-test'");
    expect(raw).toEqual([{key:'day/2026-01-01',body:'{"totalSteps": 1234, "totalDistanceMeters": null, "activeKilocalories": null, "moderateIntensityMinutes": null, "vigorousIntensityMinutes": null, "minHeartRate": null, "maxHeartRate": null, "note": "합성"}'}]);
    expect(await fixture.db.rows("select value,normalization_version from brain.health_current_v1 where account='collect-test'")).toEqual([{value:1234,normalization_version:8}]);
    const before = await counts();
    const second = await queue('collect-test', '2026-01-01');
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${second}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect(await calls()).toBe(1); expect(await counts()).toEqual(before);
    await fixture.db.query("insert into garmin.datasets(dataset,account,account_confirmed) values ('legacy-collect-test','legacy-account',true); insert into garmin.import_batches values ('legacy-collect-test','legacy-collect-test',now()); insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,fetched_at_ms,checked_at_ms,library_version,body) values ('legacy-collect-test','legacy-collect-test','legacy-account','day','2026-01-02','user_summary',1,1,'legacy','{}')");
    const legacy = await queue('legacy-account', '2026-01-02');
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${legacy}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect(await calls()).toBe(1);
    marker.barrier = true; await writeMarker();
    const revoke = await queue('revoke-account', '2026-01-03');
    await expect.poll(async () => readFile(join(home,'collect-reached')).then(() => true).catch(() => false),{timeout:20000}).toBe(true);
    const workerPid = Number(await readFile(join(home,'collect-reached'),'utf8'));
    const token = (await fixture.db.rows(`select current_attempt_token from brain.work_items where id='${revoke}'`))[0]!.current_attempt_token;
    const beforeRevoke = await counts();
    await fixture.db.query(`update brain.work_items set current_attempt_token=null where id='${revoke}'; update brain.work_attempts set outcome='failed',finished_at=now() where token='${token}'`);
    await writeFile(join(home,'collect-release'), 'release');
    await expect.poll(async () => readFile(join(home,`collect-exited-${token}`)).then(() => true).catch(() => false),{timeout:20000}).toBe(true);
    await expect.poll(() => { try { process.kill(workerPid, 0); return false; } catch { return true; } },{timeout:20000}).toBe(true);
    expect((await fixture.db.rows(`select outcome from brain.work_attempts where token='${token}'`))[0]?.outcome).toBe('failed');
    expect(JSON.parse(await readFile(join(home,`collect-error-${token}`),'utf8'))).toMatchObject({abi:1,type:'error',code:'COLLECT_INVALID_ATTEMPT',retryable:false});
    expect(await counts()).toEqual(beforeRevoke);
    const baseEnv = {...process.env,BRAIN_ABI_VERSION:'1',BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:revoke,BRAIN_ATTEMPT_TOKEN:token,BRAIN_WORK_KIND:'garmin.collect',BRAIN_TARGET_KIND:'account',BRAIN_TARGET_ID:'revoke-account',BRAIN_RUN_GENERATION:'1',BRAIN_RANGE_FROM:'2026-01-03',BRAIN_RANGE_TO:'2026-01-03',BRAIN_SETTINGS_SNAPSHOT:JSON.stringify({version:1,extension:'garmin',values:{'garmin.timezone':'Asia/Seoul'}}),BRAIN_EXTENSION_HOME:ext};
    const replay = spawnSync(python,[join(ext,'collect_fixture.py')],{encoding:'utf8',env:baseEnv,timeout:5000});
    expect(replay.status).toBe(1); expect(JSON.parse(replay.stdout)).toMatchObject({type:'error',code:'COLLECT_INVALID_ATTEMPT',retryable:false});
    const beforeIsolation = await calls();
    const beforeConnections = await readFile(join(home,'collect-connections'),'utf8');
    const alias = join(home, 'default-alias'); await symlink(join(homedir(),'.second_brain'), alias);
    for (const badEnv of [{...baseEnv,BRAIN_EXTENSION_HOME:join(homedir(),'.second_brain/extensions/garmin')},{...baseEnv,BRAIN_EXTENSION_HOME:join(alias,'extensions/garmin')},{...baseEnv,BRAIN_DATABASE_URL:fixture.db.url.replace(/\/brain_test_[^/?]+/, '/postgres')},{...baseEnv,BRAIN_DATABASE_URL:url.replace(new URL(url).hostname,'192.0.2.1')},{...baseEnv,BRAIN_DATABASE_URL:url + '?hostaddr=192.0.2.1'},{...baseEnv,BRAIN_DATABASE_URL:url + '?service=override'}]) {
      const bad = spawnSync(python,[join(ext,'collect_fixture.py')],{encoding:'utf8',env:badEnv,timeout:5000});
      expect(bad.status).toBe(1); expect(JSON.parse(bad.stdout)).toMatchObject({type:'error',code:'COLLECT_INVALID',retryable:false});
      expect(bad.stdout + bad.stderr).not.toContain('revoke-account');
    }
    expect(await calls()).toBe(beforeIsolation); expect(await counts()).toEqual(beforeRevoke);
    expect(await readFile(join(home,'collect-connections'),'utf8')).toBe(beforeConnections);
    expect(await readFile(join(home,'collect-outbound'),'utf8').catch(() => '')).toBe('');

    // The test-only wrapper calls the same session repeatedly so a single
    // supervisor attempt can exercise the legacy consecutive-403 boundary.
    await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/collect_guard_fixture.py', import.meta.url)), join(ext, 'collect_guard_fixture.py'));
    await mkdir(join(home, 'guard-tokens'));
    Object.assign(marker, {guard_fail:true, guard_date:'2026-11-02'}); await writeMarker();
    manifest.work.find((w: {kind:string}) => w.kind === 'garmin.collect').entry = 'collect_guard_fixture.py';
    await writeFile(manifestPath, JSON.stringify(manifest));
    const guarded = await queue('guard-account', '2026-01-04');
    await expect.poll(async () => (await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${guarded}'`))[0]?.error_code,{timeout:20000}).toBe('BLOCKED_403');
    expect((await readFile(join(home,'guard-calls'),'utf8')).trim().split('\n')).toHaveLength(3);
    expect(JSON.parse(await readFile(join(home,'guard-tokens/block.json'),'utf8'))).toMatchObject({local_date:'2026-11-02',reason:'blocked_403'});
    const blocked = await queue('guard-account', '2026-01-05');
    await expect.poll(async () => (await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${blocked}'`))[0]?.error_code,{timeout:20000}).toBe('SESSION_BLOCKED');
    expect((await readFile(join(home,'guard-calls'),'utf8')).trim().split('\n')).toHaveLength(3);
    Object.assign(marker, {guard_fail:false, guard_date:'2026-11-03'}); await writeMarker();
    const next = await queue('guard-account', '2026-01-06');
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${next}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect((await readFile(join(home,'guard-calls'),'utf8')).trim().split('\n')).toHaveLength(4);
    expect((await readFile(join(home,'process-audit'),'utf8')).trim().split('\n')).toEqual(['collect: clean','collect: clean','collect: clean']);
    const publicRecords = JSON.stringify(await fixture.db.rows('select * from brain.work_attempts'));
    expect(publicRecords).not.toContain('synthetic-password-canary');
    expect(publicRecords).not.toContain('synthetic-token-canary');
    expect(JSON.stringify(await fixture.db.rows('select * from brain.failures'))).not.toMatch(/synthetic-(password|token)-canary/);
    async function scan(directory: string): Promise<void> {
      for (const entry of await readdir(directory, {withFileTypes:true})) {
        const path = join(directory, entry.name);
        if (path === join(home, 'guard-tokens')) continue;
        if (entry.isDirectory()) await scan(path);
        else if (entry.isFile()) {
          const bytes = await readFile(path);
          expect(bytes.includes(Buffer.from('synthetic-password-canary')), path).toBe(false);
          expect(bytes.includes(Buffer.from('synthetic-token-canary')), path).toBe(false);
        }
      }
    }
    await scan(home);

  } finally {
    await writeFile(join(home,'collect-release'), 'release').catch(() => {});
    controller.abort(); await daemon; await store.close(); await fixture.cleanup();
  }
});
