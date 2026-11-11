/** Full 21.5 contract on owned DB/home with fake Garmin, Codex and Telegram.
 * Registered for 21.8; no live accounts, network or production state. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFile, chmod, copyFile, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { tickSchedules } from 'second_brain';
import { postgresStore } from 'second_brain/postgres';
import { extHome } from '../test/ext-fixture.js';
import { cronCalculator } from '../src/runtime/cron.js';
import { runDaemon } from '../src/daemon/run.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { systemClock } from '../src/runtime/clock.js';
import { readDaemonLock } from '../src/daemon/lock.js';
import { daemonLiveness } from '../src/daemon/liveness.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const pkg = join(repo, 'plugins/garmin/package');
const self = '01940000-0000-7000-8000-00000000000a';

const scenarios = ['2026-11-09', '2026-11-10', '2026-11-11'].flatMap(day =>
  ['database', 'exit'].map(interruption => ({ day, interruption })));

it.each(scenarios)('report $day: package → cron recovers $interruption interruption → files/channel → lifecycle', async ({ day, interruption }) => {
  const world = await extHome(), ids = uuidV7IdGen(), store = postgresStore({ databaseUrl: world.db.appUrl });
  const controller = new AbortController(); let daemon: ReturnType<typeof runDaemon> | undefined;
  let realController: AbortController | undefined, realDaemon: ReturnType<typeof runDaemon> | undefined;
  const messages: string[] = []; const requests: {method:string; contentType:string; bytes:Buffer}[] = []; let failDocument = true; let diagnosticClock = () => 0;
  const responses: {method:string; status:number; clock:number; mediaCount?:number}[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(Buffer.from(chunk))); req.on('end', () => {
      const method = req.url?.split('/').at(-1) ?? ''; messages.push(method);
      requests.push({method, contentType:req.headers['content-type'] ?? '', bytes:Buffer.concat(chunks)});
      if (method === 'sendDocument' && failDocument) { failDocument = false; responses.push({method,status:500,clock:diagnosticClock()}); res.writeHead(500).end(); return; }
      let mediaCount: number | undefined;
      if (method === 'sendMediaGroup') {
        const body=Buffer.concat(chunks).toString('latin1');
        const media=body.match(/name="media"\r\n\r\n([^\r]+)\r\n/);
        if (!media) { res.writeHead(400).end(); return; }
        const entries: unknown=JSON.parse(media[1]!);
        if (!Array.isArray(entries) || entries.length < 2 || entries.length > 10) { res.writeHead(400).end(); return; }
        mediaCount=entries.length;
      }
      responses.push({method,status:200,clock:diagnosticClock(),...(mediaCount === undefined ? {} : {mediaCount})});
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok:true, result:mediaCount === undefined ? {message_id:1} : Array.from({length:mediaCount},(_,index)=>({message_id:index+1})) }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing fake address');
  try {
    const absent = spawn('sh', [join(repo,'plugins/garmin/bin/install.sh')], {env:{HOME:world.home,PATH:'/usr/bin:/bin',SECOND_BRAIN_HOME:join(world.home,'absent'),CLAUDE_PLUGIN_ROOT:join(repo,'plugins/garmin')},stdio:['ignore','pipe','pipe']});
    let notice=''; absent.stdout.setEncoding('utf8').on('data', text=>{notice+=text;});
    expect(await new Promise<number|null>(resolve=>absent.once('close',resolve))).toBe(0); expect(notice).toMatch(/core.*먼저 설치/);
    const install = await world.run(['ext','install','--package',pkg,'--json']);
    expect(install.code, install.stdout+install.stderr).toBe(0);
    const home=await realpath(world.home), ext=join(home,'extensions/garmin');
    const manifest=JSON.parse(await readFile(join(ext,'manifest.json'),'utf8'));
    const plugin=JSON.parse(await readFile(join(repo,'plugins/garmin/.claude-plugin/plugin.json'),'utf8'));
    expect(manifest.plugin_version).toBe(plugin.version);
    expect(manifest.default_schedules).toEqual(expect.arrayContaining([
      expect.objectContaining({key:'collect',cron:'0 11 * * *',time_zone:'Asia/Seoul'}),
      expect.objectContaining({key:'report',cron:'30 11 * * *',after_schedule:'collect',time_zone:'Asia/Seoul'}),
    ]));
    const account=ids.next(), channel=ids.next(), conversation=ids.next();
    const collectAt=new Date(`${day}T02:00:00.000Z`), reportAt=new Date(`${day}T02:30:00.000Z`);
    const prior1=new Date(collectAt.getTime()-86400000).toISOString().slice(0,10), prior2=new Date(collectAt.getTime()-2*86400000).toISOString().slice(0,10);
    let time=reportAt.getTime()+1000; diagnosticClock = () => time; const clock={now:()=>new Date(time)};
    const tokenstore=join(ext,'tokenstore'), token=Buffer.from('synthetic-token');
    await mkdir(tokenstore,{recursive:true,mode:0o700}); await chmod(tokenstore,0o700);
    await writeFile(join(tokenstore,'garmin_tokens.json'),token,{mode:0o600});
    await writeFile(join(tokenstore,'brain-account-binding.json'),JSON.stringify({version:1,user_id:self,connection_id:account,external_identity:'12345',token_sha256:createHash('sha256').update(token).digest('hex')}),{mode:0o600});
    const storeSource=await readFile(join(repo,'extensions/garmin/src/garmin_pipeline/store/__init__.py'),'utf8');
    const normalizeVersion=storeSource.match(/^NORMALIZE_VERSION\s*=\s*(\d+)\s*$/m)?.[1];
    if (!normalizeVersion) throw Error('missing normalize version');
    await world.db.query(`insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values ('${self}','${account}','12345','Asia/Seoul');
      insert into garmin.meta(user_id,connection_id,key,value) values ('${self}','${account}','history_start','${day}'),('${self}','${account}','normalize_version','${normalizeVersion}');
      insert into garmin.day_summary(user_id,connection_id,date,sleep_total_s) values ('${self}','${account}','${prior1}',24000),('${self}','${account}','${prior2}',25000);
      insert into brain.channels values ('${channel}','telegram','synthetic');
      insert into brain.channel_conversations(id,channel_id,external_ref,user_id) values ('${conversation}','${channel}','synthetic-chat','${self}'); insert into brain.channel_subscriptions(event,conversation_id) values ('garmin.report.completed','${conversation}')`);
    for (const [key,value] of Object.entries({'garmin.timezone':'Asia/Seoul','garmin.connection_id':account,'garmin.analysis_model':'synthetic'}))
      expect(await store.setSetting({userId:self,key,value,updatedAt:clock.now()})).toMatchObject({ok:true});
    await world.db.query(`update brain.schedules set next_run_at=case schedule_key when 'collect' then '${collectAt.toISOString()}'::timestamptz else '${reportAt.toISOString()}'::timestamptz end where extension='garmin'`);
    const originalCollectRuntime=await readFile(join(ext,'src/collect_runtime.py'));
    const datesPath=join(ext,'src/garmin_pipeline/dates.py');
    const originalDates=await readFile(datesPath);
    await appendFile(datesPath, `\nfrom datetime import date as _fixture_date\ntoday = lambda cfg: _fixture_date.fromisoformat('${day}')\n`);
    const source=join(repo,'extensions/garmin/tests/supervised_fake_network.py');
    await copyFile(source,join(ext,'src/supervised_fake_network.py'));
    await appendFile(join(ext,'src/collect_runtime.py'),`\nimport supervised_fake_network\nimport psycopg as _test_psycopg\nfrom datetime import date as _test_date\nfrom garmin_pipeline import dates as _test_dates, normalize as _test_normalize\n_test_dates.today = lambda cfg: _test_date.fromisoformat('${day}')\n_test_dates.now_ms = lambda: ${reportAt.getTime()}\n_original_normalize_run = _test_normalize.run\ndef _synthetic_normalize_run(*args, **kwargs):\n    marker = Path(os.environ['BRAIN_EXTENSION_HOME']) / 'synthetic-normalize-interrupt'\n    if marker.exists():\n        if marker.read_text() == 'exit': os._exit(71)\n        raise _test_psycopg.OperationalError('synthetic db failure')\n    return _original_normalize_run(*args, **kwargs)\n_test_normalize.run = _synthetic_normalize_run\n_original_normalize_item = _test_normalize._normalize_item\ndef _synthetic_normalize_item(*args, **kwargs):\n    if (Path(os.environ['BRAIN_EXTENSION_HOME']) / 'synthetic-normalize-fail').exists():\n        raise ValueError('synthetic normalize failure')\n    return _original_normalize_item(*args, **kwargs)\n_test_normalize._normalize_item = _synthetic_normalize_item\n`);
    await writeFile(join(ext,'synthetic-hold'),'hold');
    await writeFile(join(tokenstore,'block.json'),JSON.stringify({schema_version:1,local_date:day,reason:'rate_limited'}),{mode:0o600});
    const bin=join(home,'fake-bin'), control=join(ext,'report-fixture'); await mkdir(bin,{recursive:true}); await mkdir(control,{recursive:true});
    await copyFile(join(repo,'extensions/garmin/tests/report-fixture/codex'),join(bin,'codex')); await chmod(join(bin,'codex'),0o700);
    await store.setSetting({userId:null,key:'agent.codex_path',value:join(bin,'codex'),updatedAt:clock.now()});
    const profile=join(ext,'reports/accounts',self,account); await mkdir(profile,{recursive:true}); await writeFile(join(profile,'profile.md'),'synthetic profile');
    const deps={store,clock,idGen:ids,cron:cronCalculator,readTimeZone:async()=>({ok:true as const,value:'Asia/Seoul'})};
    expect(await tickSchedules(deps)).toMatchObject({ok:true, enqueued:2});
    daemon=runDaemon({home,env:{...world.env,HOME:home,PATH:`${bin}:${world.env.PATH ?? ''}`,BRAIN_TELEGRAM_BOT_TOKEN:'synthetic-token',BRAIN_TELEGRAM_CHAT_ID:'synthetic-chat'},clock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,channelTestEndpoint:`http://127.0.0.1:${address.port}`}});
    const calls=async()=>readFile(join(control,'calls.jsonl'),'utf8').then(s=>s.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {scope:string;work:string})).catch(()=>[]);
    let collectWork='', blockedAttempt='';
    await expect.poll(async()=> {const row=(await world.db.rows("select w.id,a.token,a.outcome,a.error_code,a.finished_at from brain.schedule_occurrences o join brain.schedules s on s.id=o.schedule_id join brain.work_items w on w.id=o.work_id join brain.work_attempts a on a.work_item_id=w.id where s.extension='garmin' and s.schedule_key='collect' order by a.started_at,a.token limit 1"))[0]; if(!row?.finished_at) return false; collectWork=String(row.id); blockedAttempt=String(row.token); expect(row).toMatchObject({outcome:'failed',error_code:'COLLECT_INCOMPLETE'}); return true;},{timeout:90000}).toBe(true);
    expect(await calls()).toEqual([]);
    expect((await world.db.rows(`select status from brain.schedule_occurrences where work_id='${collectWork}'`))[0]?.status).not.toBe('done');
    expect((await world.db.rows(`select status from garmin.run where user_id='${self}' and connection_id='${account}' and local_date='${day}' order by id desc limit 1`))[0]?.status).toBe('skipped_blocked');
    await writeFile(join(ext,'synthetic-normalize-fail'),'fail');
    await writeFile(join(ext,'synthetic-normalize-interrupt'),interruption);
    await unlink(join(tokenstore,'block.json'));
    await world.db.query(`update brain.work_items set next_attempt_at='${new Date(time-1000).toISOString()}' where id='${collectWork}' and completed_at is null and current_attempt_token is null`); time+=60000;
    await expect.poll(()=>readFile(join(ext,'synthetic-pids.json'),'utf8').then(()=>true).catch(()=>false),{timeout:60000}).toBe(true);
    const active=(await world.db.rows("select id,current_attempt_token from brain.work_items where kind='garmin.collect' and completed_at is null"))[0]!;
    expect(active.id).toBe(collectWork); const interruptedAttempt=String(active.current_attempt_token);
    expect(interruptedAttempt).not.toBe('null');
    expect(interruptedAttempt).not.toBe(blockedAttempt);
    expect(await calls()).toEqual([]);
    expect((await world.db.rows(`select count(*)::int n from garmin.evaluation_revisions where connection_id='${account}'`))[0]?.n).toBe(0);
    await unlink(join(ext,'synthetic-hold'));
    await expect.poll(async()=> (await world.db.rows(`select finished_at from brain.work_attempts where token='${interruptedAttempt}'`))[0]?.finished_at,{timeout:90000}).toBeTruthy();
    const interruptionRow=(await world.db.rows(`select outcome from brain.work_attempts where token='${interruptedAttempt}'`))[0];
    expect(['failed','died']).toContain(interruptionRow?.outcome);
    const evidence=await world.db.rows(`select w.work_id,w.user_id,w.connection_id,w.local_date,w.run_id,r.status from garmin.collect_work_runs w join garmin.run r on (r.user_id,r.connection_id,r.id)=(w.user_id,w.connection_id,w.run_id) where w.work_id='${collectWork}'`);
    expect(evidence).toHaveLength(1); expect(evidence[0]).toMatchObject({work_id:collectWork,user_id:self,connection_id:account,local_date:day,status:'success'});
    expect((await world.db.rows(`select count(*)::int n from garmin.normalize_result where user_id='${self}' and connection_id='${account}' and normalized_at=${reportAt.getTime()}`))[0]?.n).toBe(0);
    const ledgerBefore=await readFile(join(ext,'synthetic-requests.jsonl'),'utf8');
    expect(await calls()).toEqual([]);
    expect((await world.db.rows("select status from brain.schedule_occurrences o join brain.schedules s on s.id=o.schedule_id where s.extension='garmin' and s.schedule_key='collect'"))[0]?.status).not.toBe('done');
    await unlink(join(ext,'synthetic-normalize-interrupt'));
    await world.db.query(`update brain.work_items set next_attempt_at='${new Date(time-1000).toISOString()}' where id='${collectWork}' and completed_at is null and current_attempt_token is null`); time+=60000;
    let normalizeAttempt='';
    await expect.poll(async()=> {const row=(await world.db.rows(`select token from brain.work_attempts where work_item_id='${collectWork}' and token not in ('${blockedAttempt}','${interruptedAttempt}') and finished_at is not null order by started_at desc limit 1`))[0]; if(!row) return false; normalizeAttempt=String(row.token); return true;},{timeout:90000}).toBe(true);
    const normalizeResult=(await world.db.rows(`select outcome,error_code,finished_at from brain.work_attempts where work_item_id='${collectWork}' and token='${normalizeAttempt}'`))[0];
    expect(normalizeResult).toMatchObject({outcome:'failed',error_code:'COLLECT_INCOMPLETE',finished_at:expect.anything()});
    expect(await readFile(join(ext,'synthetic-requests.jsonl'),'utf8')).toBe(ledgerBefore);
    expect((await world.db.rows(`select count(*)::int n from garmin.normalize_result where user_id='${self}' and connection_id='${account}' and ok=0 and normalized_at=${reportAt.getTime()}`))[0]?.n).toBeGreaterThan(0);
    expect(await calls()).toEqual([]);
    expect((await world.db.rows("select status from brain.schedule_occurrences o join brain.schedules s on s.id=o.schedule_id where s.extension='garmin' and s.schedule_key='collect'"))[0]?.status).not.toBe('done');
    await unlink(join(ext,'synthetic-normalize-fail'));
    await world.db.query(`update brain.work_items set next_attempt_at='${new Date(time-1000).toISOString()}' where kind='garmin.collect' and completed_at is null and current_attempt_token is null`); time+=60000;
    await expect.poll(async()=> (await world.db.rows(`select status from brain.schedule_occurrences o join brain.schedules s on s.id=o.schedule_id where s.extension='garmin' and s.schedule_key='collect'`))[0]?.status,{timeout:90000}).toBe('done');
    const successfulAttempts=await world.db.rows(`select token,outcome,finished_at from brain.work_attempts where work_item_id='${collectWork}' and token not in ('${blockedAttempt}','${interruptedAttempt}','${normalizeAttempt}') and outcome='succeeded' and finished_at is not null`);
    expect(successfulAttempts).toHaveLength(1);
    expect((await world.db.rows(`select count(*)::int n from garmin.normalize_result where user_id='${self}' and connection_id='${account}' and ok=0`))[0]?.n).toBe(0);
    expect(await readFile(join(ext,'synthetic-requests.jsonl'),'utf8')).toBe(ledgerBefore);
    expect(await world.db.rows(`select date,sleep_total_s from garmin.day_summary where user_id='${self}' and connection_id='${account}' and date in ('${prior1}','${prior2}') order by date`)).toEqual([{date:prior2,sleep_total_s:25000},{date:prior1,sleep_total_s:24000}]);
    await expect.poll(async()=> (await world.db.rows(`select count(*)::int n from garmin.evaluation_revisions where connection_id='${account}'`))[0]?.n,{timeout:120000}).toBe(4);
    expect((await calls()).map(c=>c.scope)).toEqual(['day','7d','30d','all']);
    // File handoff and retry are asynchronous; accelerate only this owned test queue.
    await expect.poll(async()=>{ await world.db.query(`update brain.work_items set next_attempt_at='${new Date(time-1000).toISOString()}' where kind='garmin.report' and completed_at is null and current_attempt_token is null`); if (failDocument) time+=1000; return (await world.db.rows("select count(*)::int n from brain.result_events where event='garmin.report.completed'"))[0]?.n; },{timeout:120000,interval:500}).toBe(1);
    const event=(await world.db.rows("select id,requested,subject_date::text,created_at from brain.result_events where event='garmin.report.completed'"))[0]!;
    expect(event).toMatchObject({requested:false,subject_date:day});
    // 고정 과거 날짜의 cron 결과는 보관된다. 명시적 core 요청으로 같은 전달·재시도 경로를 검증한다.
    const localToday=(await world.db.rows("select (now() at time zone 'Asia/Seoul')::date::text as day"))[0]!.day;
    if(day!==localToday) expect(await world.db.rows("select id from brain.channel_requests where producer='garmin' and purpose='event'")).toEqual([]);
    expect(await store.channelControl!.sendPending({event:'garmin.report.completed',id:String(event.id),now:clock.now()})).toMatchObject({ok:true});
    expect((await world.db.rows("select count(*)::int n from brain.channel_requests where producer='garmin' and purpose='event'"))[0]?.n).toBe(1);
    const revisions=await world.db.rows(`select scope,revision,summary from garmin.evaluation_revisions where connection_id='${account}' order by scope`);
    const links=await world.db.rows(`select ef.kind,ef.file_id,fr.metadata from garmin.evaluation_files ef join brain.file_requests fr on fr.id=ef.request_id where ef.connection_id='${account}'`);
    expect(links.some(link=>link.kind==='report')).toBe(true);
    expect(links.some(link=>link.kind==='graph')).toBe(true);
    const expectedGraphs=day === '2026-11-09' ? ['50-sleep-30d.png','57-workouts-all.png','58-strength-all.png'] : day === '2026-11-10' ? ['50-sleep-30d.png','54-sleep-all.png','57-workouts-all.png','58-strength-all.png'] : ['50-sleep-30d.png'];
    const artifacts=await world.db.rows(`select i.name,encode(i.content,'hex') content,fr.sha256,fr.size_bytes,fl.locator
      from garmin.report_publication_items i join brain.file_requests fr on fr.id=i.request_id
      join garmin.evaluation_files ef on ef.request_id=i.request_id and ef.scope=i.scope
      join brain.file_locations fl on fl.file_id=ef.file_id and fl.store_kind='local' and fl.ownership='brain'
      where i.user_id='${self}' and i.connection_id='${account}' and i.report_date='${day}' and i.scope='day' and i.kind='graph' order by i.name`);
    expect(artifacts.map(row=>row.name)).toEqual(expectedGraphs);
    const reports=await world.db.rows(`select i.scope,i.name,encode(i.content,'hex') content,fr.sha256,fr.size_bytes,fl.locator,e.report_md
      from garmin.report_publication_items i join brain.file_requests fr on fr.id=i.request_id
      join garmin.evaluation_files ef on ef.request_id=i.request_id and ef.scope=i.scope
      join garmin.evaluation_revisions e on (e.user_id,e.connection_id,e.report_date,e.scope,e.revision)=(i.user_id,i.connection_id,i.report_date,i.scope,i.revision)
      join brain.file_locations fl on fl.file_id=ef.file_id and fl.store_kind='local' and fl.ownership='brain'
      where i.user_id='${self}' and i.connection_id='${account}' and i.report_date='${day}' and i.kind='report' order by i.scope`);
    expect(reports.map(row=>[row.scope,row.name])).toEqual(['30d','7d','all','day'].map(scope=>[scope,'report.md']));
    const bundle=await world.db.rows(`select encode(b.content,'hex') content,fr.sha256,fr.size_bytes,fl.locator
      from garmin.report_bundle_files b join brain.file_requests fr on fr.id=b.request_id
      join garmin.evaluation_files ef on ef.request_id=b.request_id
      join brain.file_locations fl on fl.file_id=ef.file_id and fl.store_kind='local' and fl.ownership='brain'
      where b.user_id='${self}' and b.connection_id='${account}' and b.report_date='${day}'`);
    expect(bundle).toHaveLength(1);
    const bundleText=Buffer.from(String(bundle[0]!.content),'hex').toString('utf8');
    for (const report of reports) {
      const original=String(report.report_md).trimEnd();
      expect(original.length).toBeGreaterThan(0);
      expect(Buffer.from(String(report.content),'hex').toString('utf8')).toContain(original);
      expect(bundleText).toContain(original);
    }
    for (const name of expectedGraphs) expect(bundleText).toContain(`![${name}](${day}/${name})`);
    for (const item of [...artifacts,...reports,...bundle]) {
      const bytes=Buffer.from(String(item.content),'hex');
      expect(bytes.length).toBe(Number(item.size_bytes));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.sha256);
      expect(await readFile(join(home,'files',String(item.locator)))).toEqual(bytes);
    }
    for (const link of links) { expect(link.file_id).toBeTruthy(); expect(link.metadata).toMatchObject({kind:link.kind,report_date:day,scope:expect.any(String),original_path_hash:expect.stringMatching(/^[a-f0-9]{64}$/)}); }
    await expect.poll(()=>messages.includes('sendDocument'),{timeout:90000}).toBe(true);
    expect(await world.db.rows(`select scope,revision,summary from garmin.evaluation_revisions where connection_id='${account}' order by scope`)).toEqual(revisions);
    // The HTTP handler sees the request before the supervisor settles its failed attempt.
    // Wait for the retryable 500 to be recorded and released before moving only this work's clock.
    let channelWork = '', lastDiagnostic = '';
    await expect.poll(async()=> {
      const snapshot = await world.db.rows(`select r.id request_id,r.status,w.id work_id,w.current_attempt_token,w.completed_at,w.next_attempt_at,w.attempts,a.attempt_token,a.outcome,a.error_code,a.retryable,a.finished_at,wa.outcome work_outcome,wa.finished_at work_finished from brain.channel_requests r left join brain.work_items w on w.id=r.work_item_id left join brain.channel_attempt_results a on a.request_id=r.id left join brain.work_attempts wa on wa.token=a.attempt_token where r.producer='garmin' and r.purpose='event' order by a.sequence`);
      const diagnostic = JSON.stringify({interruption, clock:time, responses, snapshot});
      if (diagnostic !== lastDiagnostic) { process.stdout.write(`CHANNEL_DIAGNOSTIC ${diagnostic}\n`); lastDiagnostic=diagnostic; }
      const row=(await world.db.rows(`select w.id from brain.channel_requests r join brain.work_items w on w.id=r.work_item_id join brain.channel_attempt_results a on a.request_id=r.id and a.work_item_id=w.id where r.producer='garmin' and r.purpose='event' and a.outcome='definite_failed' and a.error_code='http_5xx' and a.retryable=true and a.finished_at is not null and w.current_attempt_token is null and w.completed_at is null`))[0];
      if (!row) return false; channelWork=String(row.id); return true;
    },{timeout:90000}).toBe(true);
    expect(responses.filter(response=>response.method==='sendDocument').map(response=>response.status)).toEqual([500]);
    await world.db.query(`update brain.work_items set next_attempt_at='${new Date(time-1000).toISOString()}' where id='${channelWork}' and completed_at is null and current_attempt_token is null`); time+=60000;
    await expect.poll(async()=> (await world.db.rows("select status from brain.channel_requests where producer='garmin' and purpose='event'"))[0]?.status,{timeout:90000}).toBe('sent');
    expect(responses.filter(response=>response.method==='sendDocument').map(response=>response.status)).toEqual([500,200]);
    expect(await world.db.rows(`select outcome,error_code,retryable from brain.channel_attempt_results where work_item_id='${channelWork}' order by sequence`)).toEqual([
      {outcome:'definite_failed',error_code:'http_5xx',retryable:true}, {outcome:'sent',error_code:null,retryable:null},
    ]);
    const photoMethod=expectedGraphs.length === 1 ? 'sendPhoto' : 'sendMediaGroup';
    expect(messages).toEqual(['sendMessage',photoMethod,'sendDocument','sendDocument']);
    const summary=JSON.parse(requests[0]!.bytes.toString('utf8'));
    expect(summary).toEqual({chat_id:'synthetic-chat',parse_mode:'HTML',text:
      `<b>🩺 Garmin 일일 리포트 · ${day.slice(5).replace('-', '/')} (${{'2026-11-09':'월','2026-11-10':'화','2026-11-11':'수'}[day]})</b>\n\n` +
      '<b>오늘 회복: synthetic day</b>\n• 수면 측정 없음 · 점수 측정 없음\n• HRV 측정 없음\n• 기상 Body Battery 측정 없음\n\n\n' +
      '<b>📈 추세</b>\n• 7일: synthetic 7d\n• 30일: synthetic 30d\n• 전체: synthetic all'});
    // Keep field names and values as well as file bytes to validate media references.

    const parts=(request: typeof requests[number]) => {
      const boundary=request.contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean);
      if (!boundary) throw Error('missing multipart boundary');
      const marker=Buffer.from(`--${boundary}`), separator=Buffer.from('\r\n\r\n');
      const result: {field:string; filename:string | undefined; bytes:Buffer}[]=[]; let cursor=0;
      while ((cursor=request.bytes.indexOf(marker,cursor)) !== -1) {
        const next=request.bytes.indexOf(marker,cursor+marker.length); if (next === -1) break;
        const section=request.bytes.subarray(cursor+marker.length,next);
        const split=section.indexOf(separator); if (split !== -1) {
          const header=section.subarray(0,split).toString();
          const field=header.match(/(?:^|;\s*)name="([^"]+)"/)?.[1];
          const filename=header.match(/filename="([^"]+)"/)?.[1];
          if (!field) throw Error('missing multipart field name');
          result.push({field,filename,bytes:section.subarray(split+separator.length,section.length-2)});
        }
        cursor=next;
      }
      return result;
    };
    const forms=requests.slice(1).map(parts);
    for (const form of forms) {
      const chat=form.filter(part=>part.field==='chat_id');
      expect(chat).toHaveLength(1);
      expect(chat[0]!.bytes.toString('utf8')).toBe('synthetic-chat');
    }
    const photoForm=forms[0]!;
    const photoParts=photoForm.filter(part=>part.filename !== undefined);
    expect(photoParts.map(part=>part.filename)).toEqual(expectedGraphs);
    if (photoMethod === 'sendMediaGroup') {
      const media=photoForm.filter(part=>part.field==='media');
      expect(media).toHaveLength(1);
      expect(responses.filter(response=>response.method==='sendMediaGroup').map(response=>response.mediaCount)).toEqual([expectedGraphs.length]);
      expect(photoParts.map(part=>part.field)).toEqual(expectedGraphs.map((_,index)=>`photo${index}`));
      expect(JSON.parse(media[0]!.bytes.toString('utf8'))).toEqual(photoParts.map(part=>({type:'photo',media:`attach://${part.field}`})));
    } else expect(photoParts.map(part=>part.field)).toEqual(['photo']);
    expect(photoParts.map(part=>part.bytes)).toEqual(artifacts.map(row=>Buffer.from(String(row.content),'hex')));
    for (const form of forms.slice(1)) {
      const documentParts=form.filter(part=>part.filename !== undefined);
      expect(documentParts.map(part=>part.field)).toEqual(['document']);
      expect(documentParts).toHaveLength(1);
      expect(documentParts[0]!.bytes).toEqual(Buffer.from(String(bundle[0]!.content),'hex'));
    }
    expect(await tickSchedules(deps)).toMatchObject({ok:true,enqueued:0});
    expect((await world.db.rows("select count(*)::int n from brain.channel_requests where producer='garmin' and purpose='event'"))[0]?.n).toBe(1);
    expect(messages).toEqual(['sendMessage',photoMethod,'sendDocument','sendDocument']);

    await world.db.query(`insert into garmin.day_summary(user_id,connection_id,date,steps) values ('${self}','${account}','2026-01-01',10),('${self}','${account}','2026-01-02',null),('${self}','${account}','2026-01-03',30);
      insert into garmin.workout(user_id,connection_id,activity_id,date,type,duration_s) values ('${self}','${account}',1,'2026-01-01','strength',60);
      insert into garmin.exercise_log(user_id,connection_id,activity_id,exercise,reps) values ('${self}','${account}',1,'squat',10);
      insert into garmin.evaluation_revisions(user_id,connection_id,report_date,scope,summary,judgments,evidence,next_checks,report_md,model,created_at,revision) values ('${self}','${account}','2026-01-03','day','password=hunter2x','[]','[]','[]','synthetic','fake',1,1)`);
    const input={connection_id:account,timezone:'Asia/Seoul',start_date:'2026-01-01',end_date:'2026-01-03',metric:'steps',aggregation:'sum'};
    const query=async(value:unknown)=>world.run(['ext','garmin','period-summary','--input',JSON.stringify(value),'--json']);
    expect((await query(input)).body.data).toMatchObject({value:40,observed_count:2,null_count:1});
    expect((await query({...input,aggregation:'mean'})).body.data.value).toBe(20);
    expect((await query({...input,activity_type:'strength',exercise:'squat'})).body.data.value).toBe(10);
    expect((await query({...input,activity_type:'missing'})).body.data).toMatchObject({value:null,observed_count:0,null_count:0});
    expect((await query({...input,start_date:'2026-01-02',end_date:'2026-01-02'})).body.data).toMatchObject({value:null,observed_count:0,null_count:1});
    expect((await query({...input,metric:'weight_kg',aggregation:'sum'})).body.ok).toBe(false);
    const recentInput={connection_id:account,timezone:'Asia/Seoul',scope:'day',limit:10};
    const recent=await world.run(['ext','garmin','recent-evaluations','--input',JSON.stringify(recentInput),'--json']);
    expect(JSON.stringify(recent.body.data)).not.toContain('hunter2x');
    expect(recent.body.data.evaluations.some((item:{file_id:string|null})=>item.file_id)).toBe(true);
    const child=spawn(process.execPath,[join(repo,'apps/cli/dist/bin.js'),'mcp','serve'],{env:world.env,stdio:['pipe','pipe','pipe']});
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    const request=async(id:number,method:string,params:unknown={})=>{child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return JSON.parse((await lines.next()).value!);};
    try {
      await request(1,'initialize');
      const mcp=await request(2,'tools/call',{name:'ext_garmin_period_summary',arguments:input});
      expect(JSON.parse(mcp.result.content[0].text).data).toEqual((await query(input)).body.data);
      const recentMcp=await request(3,'tools/call',{name:'ext_garmin_recent_evaluations',arguments:recentInput});
      expect(JSON.parse(recentMcp.result.content[0].text).data).toEqual(recent.body.data);
      expect(JSON.stringify(recentMcp)).not.toContain('hunter2x');
      const mcpMean=await request(4,'tools/call',{name:'ext_garmin_period_summary',arguments:{...input,aggregation:'mean'}});
      expect(JSON.parse(mcpMean.result.content[0].text).data.value).toBe(20);
      const mcpFiltered=await request(5,'tools/call',{name:'ext_garmin_period_summary',arguments:{...input,activity_type:'strength',exercise:'squat'}});
      expect(JSON.parse(mcpFiltered.result.content[0].text).data.value).toBe(10);
    }
    finally {child.stdin.end();await new Promise(resolve=>child.once('close',resolve));}
    // 실패한 재생성은 완료 이벤트·발송을 추가하지 않고 성공한 평가 행을 보존한다.
    const eventsBeforeFailure=await world.db.rows("select id from brain.result_events order by id");
    await writeFile(join(control,'status-failed-7d'),'yes');
    const failed=await world.run(['ext','run','garmin','report-regenerate','--target',account,'--json']);
    expect(failed.body.ok).toBe(true); const failedWork=String(failed.body.data.work_id);
    await world.db.query(`update brain.work_items set next_attempt_at='${new Date(time-1000).toISOString()}' where id='${failedWork}' and completed_at is null and current_attempt_token is null`);
    await expect.poll(async()=> (await world.db.rows(`select count(*)::int n from brain.work_attempts where work_item_id='${failedWork}' and outcome='failed'`))[0]?.n,{timeout:120000}).toBeGreaterThan(0);
    expect(await world.db.rows("select id from brain.result_events order by id")).toEqual(eventsBeforeFailure);
    expect(await world.db.rows("select id from brain.channel_requests where producer='garmin' and purpose='report_failed'")).toEqual([]);
    const afterFailure=await world.db.rows(`select scope,revision,summary from garmin.evaluation_revisions where connection_id='${account}' and report_date='${day}' order by scope,revision`);
    for (const row of revisions) expect(afterFailure).toContainEqual(row);
    await world.db.query(`update brain.work_items set next_attempt_at='${new Date(time+86400000).toISOString()}' where id='${failedWork}' and completed_at is null and current_attempt_token is null`);
    await unlink(join(control,'status-failed-7d'));
    const nativeBefore=await world.db.rows(`select date,steps,sleep_total_s from garmin.day_summary where connection_id='${account}' order by date`);
    const revisionsBefore=await world.db.rows(`select report_date,scope,revision,summary from garmin.evaluation_revisions where connection_id='${account}' order by report_date,scope,revision`);
    const before=await world.db.rows(`select request_id,file_id from garmin.evaluation_files where connection_id='${account}' order by request_id`);
    expect((await world.run(['ext','disable','garmin','--json'])).body.ok).toBe(true);
    await world.db.query(`update brain.schedules set next_run_at='${reportAt.toISOString()}' where extension='garmin' and removed_at is null`);
    expect((await query(input)).body.ok).toBe(false);
    const workBefore=(await world.db.rows("select count(*)::int n from brain.work_items where kind like 'garmin.%'"))[0]?.n;
    expect((await world.run(['ext','run','garmin','collect','--target',account,'--json'])).body.ok).toBe(false);
    expect((await world.db.rows("select count(*)::int n from brain.work_items where kind like 'garmin.%'"))[0]?.n).toBe(workBefore);
    expect(await tickSchedules(deps)).toMatchObject({ok:true,enqueued:0});
    expect(await world.db.rows(`select request_id,file_id from garmin.evaluation_files where connection_id='${account}' order by request_id`)).toEqual(before);
    expect(await world.db.rows(`select date,steps,sleep_total_s from garmin.day_summary where connection_id='${account}' order by date`)).toEqual(nativeBefore);
    expect(await world.db.rows(`select report_date,scope,revision,summary from garmin.evaluation_revisions where connection_id='${account}' order by report_date,scope,revision`)).toEqual(revisionsBefore);
    expect((await world.run(['ext','enable','garmin','--json'])).body.ok).toBe(true);
    expect((await query(input)).body.data.value).toBe(40);
    const schedules=await world.db.rows("select id,schedule_key from brain.schedules where extension='garmin' order by schedule_key");
    const reportSchedule=schedules.find(row=>row.schedule_key==='report')!;
    const collectSchedule=schedules.find(row=>row.schedule_key==='collect')!;
    expect((await world.run(['schedules','update',String(reportSchedule.id),'--cron','15 8 * * 5','--disable','--json'])).body.ok).toBe(true);
    expect((await world.run(['schedules','remove',String(collectSchedule.id),'--json'])).body.ok).toBe(true);
    await world.db.query(`update brain.schedules set next_run_at='${new Date(Date.now()+86400000).toISOString()}' where extension='garmin' and removed_at is null`);
    const scheduleRows=await world.db.rows("select id,schedule_key,cron_expr,enabled,removed_at from brain.schedules where extension='garmin' order by schedule_key");
    controller.abort(); expect(await daemon).toMatchObject({ok:true}); daemon=undefined;
    expect(await readDaemonLock(home)).toBeUndefined();
    expect(await readFile(join(home,'run','supervisor-ready.json'),'utf8').then(()=>true).catch(()=>false)).toBe(false);
    // The failed manual work was parked against the synthetic clock; park it against the real clock for this restart.
    await world.db.query(`update brain.work_items set next_attempt_at='${new Date(Date.now()+86400000).toISOString()}' where id='${failedWork}' and completed_at is null and current_attempt_token is null`);
    realController=new AbortController();
    realDaemon=runDaemon({home,env:{...world.env,HOME:home,PATH:`${bin}:${world.env.PATH ?? ''}`,BRAIN_TELEGRAM_BOT_TOKEN:'synthetic-token',BRAIN_TELEGRAM_CHAT_ID:'synthetic-chat'},clock:systemClock,idGen:ids,signal:realController.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,channelTestEndpoint:`http://127.0.0.1:${address.port}`}});
    await expect.poll(async()=> {const owner=await readDaemonLock(home); const live=await daemonLiveness({home,clock:systemClock}); const ready=await readFile(join(home,'run','supervisor-ready.json'),'utf8').then(value=>JSON.parse(value)).catch(()=>null); const age=ready ? Date.now()-Date.parse(ready.at) : -1; return !!owner && live.alive && owner.pid===ready?.pid && owner.startedAt.toISOString()===ready?.startedAt && age>=0 && age<=20000;},{timeout:30000}).toBe(true);
    await writeFile(join(ext,'src/collect_runtime.py'),originalCollectRuntime);
    await writeFile(datesPath,originalDates);
    await unlink(join(ext,'src/supervised_fake_network.py'));
    const reinstall=await world.runDirect(['ext','install','--package',pkg,'--json']);
    expect(reinstall.code,reinstall.stdout+reinstall.stderr).toBe(0);
    expect(await world.db.rows("select id,schedule_key,cron_expr,enabled,removed_at from brain.schedules where extension='garmin' order by schedule_key")).toEqual(scheduleRows);
    expect(await world.db.rows(`select request_id,file_id from garmin.evaluation_files where connection_id='${account}' order by request_id`)).toEqual(before);
  } finally {
    controller.abort(); if (daemon) await daemon; if(realController) realController.abort(); if(realDaemon) await realDaemon; await store.close();
    await new Promise<void>(resolve=>server.close(()=>resolve())); await world.cleanup();
  }
}, 360000);
