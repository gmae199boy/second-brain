import { randomUUID } from 'node:crypto';
import { copyFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it.each(['before_send','after_429','deny_before','deny_after'] as const)('보호 저장 실패·SIGKILL과 재시작은 외부 호출을 늘리지 않는다: %s', async mode => {
  const { postgresStore } = await import('second_brain/postgres');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture=await extHome(), ids=uuidV7IdGen();
  let controller=new AbortController();
  const store=postgresStore({databaseUrl:fixture.db.appUrl});
  const home=await realpath(fixture.home), ext=join(home,'extensions/garmin');
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const pending=await fixture.run(['ext','install','garmin','--json']);
    expect(pending.body?.error?.code).toBe('EXTENSION_LOGIN_REQUIRED');
    const auth=pending.body.data.install.auth_work_id;
    expect(auth).toMatch(/^[0-9a-f-]{36}$/);
    await fixture.db.query(`update brain.work_items set outcome='succeeded',completed_at=now() where id='${auth}'`);
    expect((await fixture.run(['ext','install','garmin','--json'])).code).toBe(0);
    for (const file of ['collect_fixture.py','protection_fixture.py'])
      await copyFile(fileURLToPath(new URL(`../../../extensions/garmin/tests/${file}`,import.meta.url)),join(ext,file));
    const manifestPath=join(ext,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    manifest.work.find((work:{kind:string}) => work.kind==='garmin.collect').entry='protection_fixture.py';
    await writeFile(manifestPath,JSON.stringify(manifest));
    const url=new URL(fixture.db.url);
    await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify({home,database:url.pathname.slice(1),host:url.hostname,port:url.port,protection_mode:mode}));
    await store.setSetting({key:'garmin.tokenstore',value:'different-configured-target',updatedAt:new Date()});
    await store.setSetting({key:'garmin.timezone',value:'UTC',updatedAt:new Date()});
    const account=randomUUID();
    await fixture.db.query(`insert into garmin.account_protection(id,profile_id) values ('${account}','fixture');
      insert into garmin.account_binding(target,protection_id) values ('fixture-target','${account}')`);
    if (mode==='deny_before') await fixture.db.query('revoke execute on function garmin.start_external_call(uuid,uuid,bigint,text,bigint,text,text,text,date,boolean) from brain_ext_garmin');
    if (mode==='deny_after') await fixture.db.query('revoke execute on function garmin.finish_external_call(uuid,uuid,bigint,text,bigint,uuid,text) from brain_ext_garmin');
    const work=ids.next(), now=new Date();
    expect(await store.addWork({id:work,kind:'garmin.collect',targetKind:'account',targetId:'fixture',createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});
    daemon=runDaemon({home,env:{...fixture.env,PYTHONDONTWRITEBYTECODE:'1'},clock:systemClock,idGen:ids,signal:controller.signal,
      drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const calls=async () => (await readFile(join(home,'protection-calls'),'utf8').catch(()=>'' )).split('\n').filter(Boolean).length;
    let token: string;
    if (mode==='before_send' || mode==='after_429') {
      await expect.poll(async () => readFile(join(home,'protection-reached'),'utf8').then(()=>true).catch(()=>false),{timeout:20000}).toBe(true);
      const reached=JSON.parse(await readFile(join(home,'protection-reached'),'utf8')) as {pid:number;token:string};
      expect(Number.isSafeInteger(reached.pid)).toBe(true);
      const attempt=(await fixture.db.rows(`select pid,token from brain.work_attempts where work_item_id='${work}' and token='${reached.token}'`))[0];
      expect(attempt).toMatchObject({pid:reached.pid,token:reached.token});
      token=reached.token;
      process.kill(reached.pid,'SIGKILL');
      await expect.poll(() => { try { process.kill(reached.pid,0); return false; } catch { return true; } },{timeout:20000}).toBe(true);
      await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_attempts where token='${token}'`))[0]?.outcome,{timeout:20000}).toBe('died');
    } else {
      await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome,{timeout:20000}).toBe('failed');
      token=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${work}'`))[0]!.token as string;
    }
    const intents=await fixture.db.rows(`select outcome from garmin.external_call_intent where work_id='${work}'`);
    expect(intents).toEqual(mode==='deny_before'?[]:[{outcome:mode==='after_429'?'429':null}]);
    expect(await calls()).toBe(mode==='after_429'||mode==='deny_after'?1:0);
    expect(await fixture.db.rows(`select work_id from garmin.admission_holder where work_id='${work}'`)).toEqual([{work_id:work}]);
    expect((await fixture.db.rows(`select rate_day is not null as blocked from garmin.account_protection where id='${account}'`))[0]).toEqual({blocked:mode==='after_429'});
    // daemon을 실제로 중지하고 새 supervisor를 시작해도 holder가 남는다.
    controller.abort(); await daemon;
    controller=new AbortController();
    daemon=runDaemon({home,env:{...fixture.env,PYTHONDONTWRITEBYTECODE:'1'},clock:systemClock,idGen:ids,signal:controller.signal,
      drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    // 별도 auth의 선택 경로를 기존 holder에 맞춘다.
    await store.setSetting({key:'garmin.tokenstore',value:'fixture-target',updatedAt:new Date()});
    // 새로운 auth 일감은 같은 account holder가 남아 있으므로 시작되지 않는다.
    const second=ids.next(), later=new Date();
    expect(await store.addWork({id:second,kind:'garmin.auth',targetKind:'extension',targetId:'garmin',createdAt:later,nextAttemptAt:later})).toMatchObject({ok:true,created:true});
    await expect.poll(async () => (await fixture.db.rows(`select count(*)::int n from brain.work_attempts where work_item_id='${second}' and outcome='cancelled'`))[0]?.n,{timeout:20000}).toBeGreaterThan(0);
    expect(await calls()).toBe(mode==='after_429'||mode==='deny_after'?1:0);
    expect(await fixture.db.rows(`select outcome from garmin.external_call_intent where work_id='${work}'`)).toEqual(intents);
  } finally {
    await writeFile(join(home,'protection-release'),'release').catch(()=>{});
    controller.abort(); await daemon; await store.close();
    if (mode==='deny_before') await fixture.db.query('grant execute on function garmin.start_external_call(uuid,uuid,bigint,text,bigint,text,text,text,date,boolean) to brain_ext_garmin').catch(()=>{});
    if (mode==='deny_after') await fixture.db.query('grant execute on function garmin.finish_external_call(uuid,uuid,bigint,text,bigint,uuid,text) to brain_ext_garmin').catch(()=>{});
    await fixture.cleanup();
  }
},60_000);

it('실제 supervisor 합성 403 세 번 뒤 다음 일감도 전송하지 않는다', async () => {
  const { postgresStore } = await import('second_brain/postgres');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture=await extHome(), ids=uuidV7IdGen(), controller=new AbortController();
  const store=postgresStore({databaseUrl:fixture.db.appUrl});
  const home=await realpath(fixture.home), ext=join(home,'extensions/garmin');
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const pending=await fixture.run(['ext','install','garmin','--json']);
    expect(pending.body?.error?.code).toBe('EXTENSION_LOGIN_REQUIRED');
    const auth=pending.body.data.install.auth_work_id;
    expect(auth).toMatch(/^[0-9a-f-]{36}$/);
    await fixture.db.query(`update brain.work_items set outcome='succeeded',completed_at=now() where id='${auth}'`);
    expect((await fixture.run(['ext','install','garmin','--json'])).code).toBe(0);
    for (const file of ['collect_fixture.py','protection_fixture.py'])
      await copyFile(fileURLToPath(new URL(`../../../extensions/garmin/tests/${file}`,import.meta.url)),join(ext,file));
    const manifestPath=join(ext,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    manifest.work.find((work:{kind:string}) => work.kind==='garmin.collect').entry='protection_fixture.py';
    await writeFile(manifestPath,JSON.stringify(manifest));
    const url=new URL(fixture.db.url);
    await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify({home,database:url.pathname.slice(1),host:url.hostname,port:url.port,protection_mode:'three_403'}));
    await store.setSetting({key:'garmin.tokenstore',value:'fixture-target',updatedAt:new Date()});
    await store.setSetting({key:'garmin.timezone',value:'UTC',updatedAt:new Date()});
    const account=randomUUID();
    await fixture.db.query(`insert into garmin.account_protection(id,profile_id) values ('${account}','fixture');
      insert into garmin.account_binding(target,protection_id) values ('fixture-target','${account}')`);
    const queue=async () => { const id=ids.next(),now=new Date(); expect(await store.addWork({id,kind:'garmin.collect',targetKind:'account',targetId:'fixture',createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true,created:true}); return id; };
    const first=await queue();
    daemon=runDaemon({home,env:{...fixture.env,PYTHONDONTWRITEBYTECODE:'1'},clock:systemClock,idGen:ids,signal:controller.signal,
      drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${first}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    const calls=async () => (await readFile(join(home,'protection-calls'),'utf8').catch(()=>'' )).split('\n').filter(Boolean).length;
    expect(await calls()).toBe(3);
    expect((await fixture.db.rows(`select consecutive_403,rate_day is not null as blocked from garmin.account_protection where id='${account}'`))[0]).toEqual({consecutive_403:3,blocked:true});
    const second=await queue();
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${second}'`))[0]?.outcome,{timeout:20000}).toBe('failed');
    expect(await calls()).toBe(3);
  } finally {
    controller.abort(); await daemon; await store.close(); await fixture.cleanup();
  }
},60_000);
