import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('실제 감독자가 최초 수집과 재진입 및 부분 실패를 처리한다', async () => {
  const { postgresStore } = await import('second_brain/postgres');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const { extensionDatabaseUrl } = await import('../src/config/codec.js');
  const fixture = await extHome(), ids = uuidV7IdGen(), controller = new AbortController();
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  const home = await realpath(fixture.home), ext = join(home,'extensions/garmin');
  const response = { totalSteps:1234,totalDistanceMeters:null,activeKilocalories:null,moderateIntensityMinutes:null,vigorousIntensityMinutes:null,minHeartRate:null,maxHeartRate:null };
  const marker = { home,database:new URL(fixture.db.url).pathname.slice(1),host:new URL(fixture.db.url).hostname,port:new URL(fixture.db.url).port,response,fail_endpoint:'',guard_status:0,publish_failure:false,sleep_payload:{ok:true} as Record<string,unknown> | null };
  const writeMarker = () => writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
  const calls = async () => (await readFile(join(home,'collect-calls'),'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed = await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const installedAgain = await fixture.run(['ext','install','garmin','--json']);
    expect(installedAgain.code, installedAgain.stdout + installedAgain.stderr).toBe(0);
    expect((await fixture.db.rows("select kind from brain.schedules where kind like 'garmin.collect%' order by kind")).map(x=>x.kind)).toEqual(['garmin.collect','garmin.collect_retry']);
    await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/collect_fixture.py',import.meta.url)),join(ext,'collect_fixture.py'));
    const manifestPath=join(ext,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    for (const w of manifest.work) if (w.kind.startsWith('garmin.collect')) w.entry='collect_fixture.py';
    await writeFile(manifestPath,JSON.stringify(manifest)); await writeMarker();
    await store.setSetting({key:'garmin.timezone',value:'UTC',updatedAt:new Date()});
    const tokenDir=join(home,'fake-tokens'); await mkdir(tokenDir);
    await writeFile(join(tokenDir,'garmin_tokens.json'),'synthetic-token-canary');
    await store.setSetting({key:'garmin.tokenstore',value:tokenDir,updatedAt:new Date()});
    const queue = async (account:string,day:string,kind='garmin.collect') => {
      const id=ids.next(), now=new Date();
      expect(await store.addWork({id,kind,targetKind:'account',targetId:account,createdAt:now,nextAttemptAt:new Date(Date.now()+3600000)})).toMatchObject({ok:true});
      await fixture.db.query(`update brain.work_items set local_date_from='${day}',local_date_to='${day}',local_time_zone='UTC',next_attempt_at=now() where id='${id}'`);
      return id;
    };
    daemon=runDaemon({home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const first=await queue('collect-test','2026-01-31');
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${first}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    const fetched=await calls();
    expect(new Set(fetched.map(x=>x[1])).size).toBe(10);
    expect(fetched[0]).toEqual(['day','2026-01-31','sleep_data']);
    expect(fetched.filter(x=>x[2]==='daily_weigh_ins')).toHaveLength(3);
    expect((await fixture.db.rows("select count(*)::int n from garmin.raw_payloads where account='collect-test'"))[0]?.n).toBe(96);
    expect((await fixture.db.rows("select value from garmin.collect_meta where key='history_start'"))[0]?.value).toBe('2026-01-01');
    expect((await fixture.db.rows("select count(*)::int n from brain.health_observations where account='collect-test'"))[0]?.n).toBe(10);
    const second=await queue('collect-test','2026-01-31');
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${second}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect(await calls()).toHaveLength(fetched.length);
    const firstToken=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${first}'`))[0]!.token;
    for (const stream of ['stdout','stderr']) expect(await readFile(join(home,`collect-${stream}-${firstToken}`),'utf8')).not.toContain('synthetic-token-canary');
    const previousRaw=(await fixture.db.rows("select dataset,body from garmin.raw_payloads where account='collect-test' and original_key='2026-01-31' and endpoint='user_summary'"))[0]!;
    const revision=createHash('sha256').update(String(previousRaw.body)).digest('hex');
    await fixture.db.query(`insert into garmin.collect_state(dataset,account,day,endpoint,revision,fetched_at_ms) values ('${previousRaw.dataset}','collect-test','2026-01-31','user_summary','${revision}',1); delete from garmin.collect_published where dataset='${previousRaw.dataset}' and day='2026-01-31'`);
    const migration=await readFile(fileURLToPath(new URL('../../../extensions/garmin/migrations/0007_collect_runs.sql',import.meta.url)),'utf8');
    await fixture.db.query(migration.slice(migration.lastIndexOf('insert into garmin.collect_published')));
    await fixture.db.query(`update garmin.raw_payloads set checked_at_ms=1 where dataset='${previousRaw.dataset}' and original_key='2026-01-31' and endpoint='user_summary'`);
    const callsBeforeRepeat=(await calls()).length;
    const repeat=await queue('collect-test','2026-01-31','garmin.collect_recent');
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${repeat}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect((await calls()).slice(callsBeforeRepeat).some(x=>x[1]==='2026-01-31' && x[2]==='user_summary')).toBe(true);
    expect((await fixture.db.rows("select count(*)::int n from brain.health_observations where account='collect-test'"))[0]?.n).toBe(10);
    expect((await fixture.db.rows(`select count(*)::int n from garmin.collect_published where dataset='${previousRaw.dataset}' and day='2026-01-31' and revision='${revision}'`))[0]?.n).toBe(1);
    marker.publish_failure=true; await writeMarker();
    const failed=await queue('atomic-failure','2026-01-31');
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${failed}'`))[0]?.outcome,{timeout:20000}).toBe('failed');
    expect((await fixture.db.rows("select count(*)::int n from garmin.raw_payloads where account='atomic-failure' and endpoint='user_summary'"))[0]?.n).toBe(0);
    expect((await fixture.db.rows("select count(*)::int n from brain.health_observations where account='atomic-failure'"))[0]?.n).toBe(0);
    expect((await fixture.db.rows("select count(*)::int n from garmin.collect_published p join garmin.datasets d on d.dataset=p.dataset where d.account='atomic-failure'"))[0]?.n).toBe(0);
    marker.publish_failure=false; await writeMarker();
    const manual=ids.next(), manualNow=new Date();
    await store.addWork({id:manual,kind:'garmin.collect',targetKind:'extension',targetId:'default',createdAt:manualNow,nextAttemptAt:manualNow});
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${manual}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect((await fixture.db.rows("select account from garmin.collect_targets where target_kind='extension' and target_id='default'"))[0]?.account).toBe('fixture-account');
    await fixture.db.query(`insert into garmin.datasets(dataset,account,account_confirmed) values ('legacy-fixture','legacy-account',true);
      insert into garmin.import_batches(id,dataset,imported_at) values ('legacy-fixture','legacy-fixture',now());
      insert into garmin.import_checkpoints(batch,dataset,source_hash,schema_version,importer_version,manifest_fingerprint,source_role) values ('legacy-fixture','legacy-fixture','hash',1,1,'fingerprint','D2');
      insert into garmin.preserved_rows(id,dataset,original_table,original_key,values_json) values (gen_random_uuid(),'legacy-fixture','meta','history_start','{"key":{"type":"text","value":"history_start"},"value":{"type":"text","value":"2026-01-30"}}');
      insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,fetched_at_ms,checked_at_ms,library_version,body) values ('legacy-fixture','legacy-fixture','legacy-account','day','2026-01-31','sleep_data',1769904000000,1769990400000,'legacy','{"old": true}')`);
    const beforeLegacy=(await calls()).length;
    const legacy=await queue('legacy-account','2026-01-31');
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${legacy}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    const legacyCalls=(await calls()).slice(beforeLegacy);
    expect(legacyCalls.some(x=>x[1]==='2026-01-31' && x[2]==='sleep_data')).toBe(false);
    expect(new Set(legacyCalls.map(x=>x[1])).size).toBe(2);
    expect((await fixture.db.rows("select body from garmin.raw_payloads where dataset='legacy-fixture'"))[0]?.body).toBe('{"old": true}');
    for (const [label,payload] of [['same',{ok:true}],['nodata',null],['changed',{ok:false}]] as const) {
      const account=`transition-${label}`, dataset=`legacy-${label}`, batch=`batch-${label}`;
      await fixture.db.query(`insert into garmin.datasets(dataset,account,account_confirmed) values ('${dataset}','${account}',true);
        insert into garmin.import_batches(id,dataset,imported_at) values ('${batch}','${dataset}',now());
        insert into garmin.import_checkpoints(batch,dataset,source_hash,schema_version,importer_version,manifest_fingerprint,source_role) values ('${batch}','${dataset}','hash',1,1,'fingerprint','D2');
        insert into garmin.preserved_rows(id,dataset,original_table,original_key,values_json) values (gen_random_uuid(),'${dataset}','meta','history_start','{"key":{"type":"text","value":"history_start"},"value":{"type":"text","value":"2026-01-31"}}');
        insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,fetched_at_ms,checked_at_ms,library_version,body) values ('${dataset}','${batch}','${account}','day','2026-01-31','sleep_data',1000,1000,'legacy','{"ok": true}')`);
      marker.sleep_payload=payload; await writeMarker();
      const id=await queue(account,'2026-01-31');
      await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
      const rows=await fixture.db.rows(`select dataset,body,fetched_at_ms,checked_at_ms,library_version from garmin.raw_payloads where account='${account}' and endpoint='sleep_data' order by dataset`);
      expect(rows).toHaveLength(2);
      const old=rows.find(r=>r.dataset===dataset)!, current=rows.find(r=>r.dataset!==dataset)!;
      expect(old).toMatchObject({body:'{"ok": true}',fetched_at_ms:'1000',checked_at_ms:'1000',library_version:'legacy'});
      if (label==='changed') {
        expect(current).toMatchObject({body:'{"ok": false}',library_version:'fixture-v1'});
        expect(Number(current.fetched_at_ms)).toBe(Number(current.checked_at_ms));
      } else {
        expect(current).toMatchObject({body:'{"ok": true}',fetched_at_ms:'1000',library_version:'legacy'});
        expect(Number(current.checked_at_ms)).toBeGreaterThan(1000);
      }
    }
    marker.sleep_payload={ok:true};
    marker.fail_endpoint='sleep_data'; await writeMarker();
    const partial=await queue('partial-test','2026-02-01');
    await expect.poll(async () => (await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${partial}'`))[0]?.error_code,{timeout:20000}).toBe('COLLECT_PARTIAL');
    expect((await fixture.db.rows("select count(*)::int n from garmin.collect_fetch_errors where kind='transient'"))[0]?.n).toBe(10);
    expect((await fixture.db.rows("select count(*)::int n from garmin.raw_payloads where account='partial-test' and endpoint='hrv_data'"))[0]?.n).toBe(10);
    const partialToken=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${partial}'`))[0]!.token;
    expect(JSON.parse(await readFile(join(home,`collect-error-${partialToken}`),'utf8'))).toMatchObject({code:'COLLECT_PARTIAL',retryable:false});
    expect(JSON.stringify(await fixture.db.rows('select * from garmin.collect_fetch_errors'))).not.toContain('synthetic-token-canary');
    expect(JSON.stringify(await fixture.db.rows('select * from brain.work_attempts'))).not.toContain('synthetic-token-canary');
    expect(await readFile(join(home,'collect-outbound'),'utf8').catch(()=> '')).toBe('');
    for (const [status, code, state, expectedCalls] of [[429,'RATE_LIMITED','rate_limited',1],[403,'BLOCKED_403','blocked_403',3],[401,'LOGIN_REQUIRED','auth_failed',0]] as const) {
      const guardTokens=join(home,`guard-${status}`); await mkdir(guardTokens);
      await writeFile(join(guardTokens,'garmin_tokens.json'),'synthetic-token-canary');
      await store.setSetting({key:'garmin.tokenstore',value:guardTokens,updatedAt:new Date()});
      marker.guard_status=status; marker.fail_endpoint=''; await writeMarker();
      const before=(await readFile(join(home,'guard-calls'),'utf8').catch(()=> '')).split('\n').filter(Boolean).length;
      const id=await queue(`guard-${status}`,'2026-02-02');
      await expect.poll(async () => (await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${id}'`))[0]?.error_code,{timeout:20000}).toBe(code);
      expect((await fixture.db.rows(`select status from garmin.collect_runs where work_id='${id}'`))[0]?.status).toBe(state);
      if (status===403) {
        const blocked=await queue('guard-403','2026-02-02');
        await expect.poll(async () => (await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${blocked}'`))[0]?.error_code,{timeout:20000}).toBe('SESSION_BLOCKED');
        expect((await fixture.db.rows(`select status from garmin.collect_runs where work_id='${blocked}'`))[0]?.status).toBe('skipped_blocked');
      }
      expect((await readFile(join(home,'guard-calls'),'utf8').catch(()=> '')).split('\n').filter(Boolean).length-before).toBe(expectedCalls);
      const token=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${id}'`))[0]!.token;
      await expect.poll(async()=>readFile(join(home,`collect-exited-${token}`)).then(()=>true).catch(()=>false),{timeout:10000}).toBe(true);
      for (const stream of ['error','stdout','stderr']) expect(await readFile(join(home,`collect-${stream}-${token}`),'utf8')).not.toContain('synthetic-token-canary');
    }
    const url=await extensionDatabaseUrl(home,'garmin',fixture.db.appUrl);
    const attempt=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${first}' limit 1`))[0]!.token;
    const baseEnv={...process.env,BRAIN_ABI_VERSION:'1',BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:first,BRAIN_ATTEMPT_TOKEN:attempt,BRAIN_WORK_KIND:'garmin.collect',BRAIN_TARGET_KIND:'account',BRAIN_TARGET_ID:'collect-test',BRAIN_RUN_GENERATION:'1',BRAIN_RANGE_FROM:'2026-01-31',BRAIN_RANGE_TO:'2026-01-31',BRAIN_SETTINGS_SNAPSHOT:JSON.stringify({version:1,extension:'garmin',values:{'garmin.timezone':'UTC'}}),BRAIN_EXTENSION_HOME:ext};
    const beforeConnections=await readFile(join(home,'collect-connections'),'utf8');
    const alias=join(home,'default-alias'); await symlink(join(homedir(),'.second_brain'),alias);
    for (const badEnv of [{...baseEnv,BRAIN_EXTENSION_HOME:join(homedir(),'.second_brain/extensions/garmin')},{...baseEnv,BRAIN_EXTENSION_HOME:join(alias,'extensions/garmin')},{...baseEnv,BRAIN_EXTENSION_HOME:join(home,'not-garmin')},{...baseEnv,BRAIN_DATABASE_URL:fixture.db.url.replace(/\/brain_test_[^/?]+/,'/postgres')},{...baseEnv,BRAIN_DATABASE_URL:url.replace(new URL(url).hostname,'192.0.2.1')},{...baseEnv,BRAIN_DATABASE_URL:url+'?hostaddr=192.0.2.1'}]) {
      const bad=spawnSync(join(ext,'.venv/bin/python'),[join(ext,'collect_fixture.py')],{encoding:'utf8',env:badEnv,timeout:5000});
      expect(bad.status).toBe(1); expect(JSON.parse(bad.stdout)).toMatchObject({type:'error',code:'COLLECT_INVALID'});
      expect(bad.stdout+bad.stderr).not.toContain('synthetic-token-canary');
    }
    expect(await readFile(join(home,'collect-connections'),'utf8')).toBe(beforeConnections);
    expect(JSON.stringify(await fixture.db.rows('select * from brain.work_attempts'))).not.toContain('synthetic-token-canary');
    expect(JSON.stringify(await fixture.db.rows('select * from garmin.collect_fetch_errors'))).not.toContain('synthetic-token-canary');

  } finally {
    controller.abort(); await daemon; await store.close(); await fixture.cleanup();
  }
});
