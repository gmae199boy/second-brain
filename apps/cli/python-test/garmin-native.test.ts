import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { postgresStore } from 'second_brain/postgres';
import { maskOutputValue } from 'second_brain';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';
import { dynamicExtensionCommands } from '../src/runtime/extension-commands.js';
import { extHome } from '../test/ext-fixture.js';
import { extensionDatabaseUrl } from '../src/config/codec.js';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

const root=fileURLToPath(new URL('../../../extensions/garmin',import.meta.url));
const synthetic=join(root,'fixtures/native');
const self='01940000-0000-7000-8000-00000000000a';

// Exercise the actual dispatcher and output codec while retaining the DB identity.
// The first 16 digits form a Luhn-valid synthetic card number across UUID groups.
let syntheticSequence=0;
async function requestNative(fixture: Awaited<ReturnType<typeof extHome>>, job: 'import' | 'import-verify', target='default') {
  const id=`41111111-1111-7118-8abc-${(++syntheticSequence).toString(16).padStart(12,'0')}`;
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const card='4111111111117118';
  const luhn=[...card].map(Number).reduce((sum,digit,index)=>{const doubled=index%2===0 ? digit*2 : digit; return sum+(doubled>9 ? doubled-9 : doubled);},0);
  expect(luhn%10).toBe(0);
  expect(maskOutputValue(id)).toBe(`[REDACTED:card_number]-8abc-${id.slice(-12)}`);
  const kind=job === 'import' ? 'garmin.import' : 'garmin.import_verify';
  const candidates=()=>fixture.db.rows(`select id from brain.work_items where kind='${kind}' and target_kind='extension' and target_id='${target}'`);
  const before=new Set((await candidates()).map(row=>String(row.id)));
  const dynamic=await dynamicExtensionCommands(fixture.env);
  expect(dynamic.ok).toBe(true);
  if (!dynamic.ok) throw Error('extension registry unavailable');
  let stdout='', stderr='';
  const code=await dispatch([...commands,...dynamic.commands],['ext','run','garmin',job,'--target',target,'--json'],{
    env:fixture.env,clock:systemClock,idGen:{next:()=>id},stdout:text=>{stdout+=text;},stderr:text=>{stderr+=text;},
  });
  const body=JSON.parse(stdout);
  const added=(await candidates()).map(row=>String(row.id)).filter(value=>!before.has(value));
  expect(added).toEqual([id]);
  expect(body.data.work_id).toBe(maskOutputValue(id));
  expect(body.data.work_id).not.toBe(id);
  return {code,stdout,stderr,body,id:added[0]!};
}

// Advance only a settled synthetic retry after its prerequisite is complete.
// The production retry policy and the supervisor still own the next attempt.
async function resumeImport(fixture: Awaited<ReturnType<typeof extHome>>, id: string, crashed = false) {
  const rows = await fixture.db.rows(`select a.error_code, w.current_attempt_token, w.completed_at,
    (select count(*)::int from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where q.source='garmin' and r.file_id is null) pending,
    (select count(*)::int from brain.work_attempts where work_item_id=w.id) attempts
    from brain.work_items w join lateral (select error_code,finished_at from brain.work_attempts where work_item_id=w.id order by started_at desc limit 1) a on true
    where w.id='${id}' and a.finished_at is not null`);
  const row = rows[0];
  if (row && row.current_attempt_token === null && row.completed_at === null && (row.error_code === 'IMPORT_FILES_PENDING' && row.pending === 0 || crashed && row.attempts === 1 && row.error_code === 'ABI_EXIT_FAILED')) {
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${id}' and completed_at is null and current_attempt_token is null`);
  }
  return (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome;
}

async function files(dir: string): Promise<string[]> {
  const result:string[]=[];
  async function walk(current:string) {
    for (const entry of await readdir(current,{withFileTypes:true})) {
      const path=join(current,entry.name);
      if (entry.isDirectory()) await walk(path); else result.push(relative(dir,path));
    }
  }
  await walk(dir); return result.sort();
}

it('installed native import rejects unsupported schema 17 without changing source or preservation ledgers', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), capture=join(fixture.home,'unsupported-capture'); await mkdir(capture);
    execFileSync(python,['-c',`import sqlite3,sys;sys.path.insert(0,sys.argv[1]);from synthetic import make_capture;from pathlib import Path;root=Path(sys.argv[2]);make_capture(root);c=sqlite3.connect(root/'D2.db');c.execute('pragma user_version=17');c.commit();c.close()`,synthetic,capture],{env:fixture.env});
    const hashes=async()=>Promise.all((await files(capture)).map(async name=>({name,hash:createHash('sha256').update(await readFile(join(capture,name))).digest('hex')})));
    const beforeHashes=await hashes();
    await fixture.db.query("insert into garmin.datasets(dataset,account,account_confirmed) values ('synthetic-existing',null,false)");
    const tables=['garmin.datasets','garmin.import_batches','garmin.import_mapping','garmin.import_checkpoints','garmin.raw_payloads','garmin.import_conflicts','garmin.artifact_inventory','garmin.artifact_relations','garmin.input_inventory','garmin.unassigned_file_requests','garmin.native_import_mapping','garmin.native_import_checkpoints','brain.file_requests'];
    const ledger=async()=>Promise.all(tables.map(table=>fixture.db.rows(`select coalesce(json_agg(t order by t::text)::text,'[]') as contents from ${table} t`)));
    const before=await ledger();
    await store.setSetting({userId:self,key:'garmin.capture_manifest',value:await realpath(join(capture,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const request=await requestNative(fixture,'import'); expect(request.code,request.stdout+request.stderr).toBe(0);
    const id=request.id;
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome,{timeout:90000}).toBe('failed');
    const attempts=await fixture.db.rows(`select error_code,error_retryable,stderr from brain.work_attempts where work_item_id='${id}'`);
    expect(attempts,JSON.stringify(attempts)).toMatchObject([{error_code:'PREFLIGHT_SCHEMA_UNSUPPORTED',error_retryable:false}]);
    const queue=await fixture.run(['queue','list','--all','--kind','garmin.import','--json']); expect(queue.code,queue.stdout+queue.stderr).toBe(0);
    expect(queue.body.data.items).toContainEqual(expect.objectContaining({id:maskOutputValue(id),state:'failed',last_error:expect.stringContaining('PREFLIGHT_SCHEMA_UNSUPPORTED')}));
    expect(await hashes()).toEqual(beforeHashes); expect(await ledger()).toEqual(before);
    expect(await fixture.db.rows('select count(*)::int n from garmin.native_import_checkpoints where completed')).toEqual([{n:0}]);
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},120000);

it('copies schema 16 under supervision, resumes after a crash and matches the pinned SQLite oracle', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), capture=join(fixture.home,'synthetic-capture');
    await mkdir(capture);
    execFileSync(python,['-c','import sys;sys.path.insert(0,sys.argv[1]);from synthetic import make_capture;make_capture(sys.argv[2])',synthetic,capture],{env:fixture.env});
    const now=new Date(), sid=ids.next(), mid=ids.next(), fid=ids.next();
    await fixture.db.query(`insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('${sid}','synthetic','synthetic-native','${self}','fixture',now(),'import');
      insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ('${mid}','${sid}','message','user','synthetic memory',now());
      insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${fid}','sha256:${'a'.repeat(64)}',0,now())`);
    const memoryBefore=await fixture.db.rows(`select s.id,m.body from brain.sessions s join brain.messages m on m.session_id=s.id where s.id='${sid}'`);
    await store.setSetting({userId:self,key:'garmin.capture_manifest',value:await realpath(join(capture,'manifest.json')),updatedAt:now});
    await store.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:now});
    // Only the disposable installed worker is instrumented. A real process death
    // after an atomic row commit forces the supervisor to retry the same work item.
    await appendFile(join(fixture.home,'extensions/garmin/src/native_import.py'), `\n_original_copy_for_test = copy\ndef copy(conn,capture,entries,verified,settings,seam=None):\n    from pathlib import Path\n    marker=Path(os.environ['BRAIN_EXTENSION_HOME'])/'synthetic-crash-once'\n    def stop(stage,*args):\n        if stage=='after' and not marker.exists():\n            marker.write_text('crashed')\n            os._exit(23)\n    return _original_copy_for_test(conn,capture,entries,verified,settings,seam=stop)\n`);
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const run=async (kind:string, crashed=false) => {
      const request=await requestNative(fixture,kind as 'import' | 'import-verify');
      expect(request.code,request.stdout+request.stderr).toBe(0);
      const id=request.id;
      await expect.poll(()=>resumeImport(fixture,id,crashed),{timeout:90000,interval:100}).toBe('succeeded');
      return id;
    };
    const work=await run('import',true);
    expect(await readFile(join(fixture.home,'extensions/garmin/synthetic-crash-once'),'utf8')).toBe('crashed');
    expect((await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${work}' order by started_at limit 1`))[0]?.error_code).toBe('ABI_EXIT_FAILED');
    expect((await fixture.db.rows(`select count(*)::int n from brain.work_attempts where work_item_id='${work}'`))[0]!.n).toBeGreaterThan(1);
    expect(await fixture.db.rows(`select count(*)::int n from garmin.native_import_checkpoints where completed`)).toEqual([{n:5}]);
    expect(await fixture.db.rows(`select count(*)::int n from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where q.source='garmin' and r.file_id is null`)).toEqual([{n:0}]);
    const links=await fixture.db.rows(`select q.metadata,q.sha256,q.size_bytes::int size_bytes,r.file_id,f.content_hash,l.locator,e.file_id as linked
      from brain.file_requests q join brain.file_request_results r on r.request_id=q.id join brain.files f on f.id=r.file_id
      join brain.file_locations l on l.id=f.home_location_id join garmin.evaluation_files e on e.request_id=q.id where q.source='garmin'`);
    // Expectations come from the pinned SQLite input and the capture manifest,
    // independently of the PG importer and its request ledger.
    const source=JSON.parse(execFileSync(python,['-c',`import json,sqlite3,sys;from pathlib import Path;c=sqlite3.connect(sys.argv[1]);m=json.loads(Path(sys.argv[2]).read_text());print(json.dumps({'evaluations':c.execute('select report_date,scope,report_md from evaluation order by report_date,scope').fetchall(),'files':m['files']}))`,join(capture,'D2.db'),join(capture,'manifest.json')],{encoding:'utf8'})) as {evaluations:[string,string,string][],files:{source:string,snapshot:string,category:string,report_date?:string,scope?:string}[]};
    expect(source.evaluations.length).toBeGreaterThan(4);
    expect(links.length).toBe(source.evaluations.length+source.files.length);
    const pathHash=(text:string)=>createHash('sha256').update(text).digest('hex');
    const expectedLinks=source.evaluations.map(([date,scope,content])=>{
      const key=JSON.stringify([date,scope].map(value=>({base64:Buffer.from(value).toString('base64'),encoding:'utf-8',type:'text'})));
      return {date,scope,kind:'report',hash:pathHash(content),original:pathHash(JSON.stringify(['evaluation','synthetic-D2',key,'report_md']))};
    });
    const report=source.files.find(file=>file.category==='report');
    expect(report?.report_date).toBeDefined(); expect(report?.scope).toBeDefined();
    for (const file of source.files) {
      const bytes=await readFile(join(capture,file.snapshot));
      expectedLinks.push({date:report!.report_date!,scope:report!.scope!,kind:file.category==='image'?'graph':'report',hash:createHash('sha256').update(bytes).digest('hex'),original:pathHash(file.source)});
    }
    const observedLinks=links.map(row=>{
      const metadata=row.metadata as Record<string,unknown>;
      expect(metadata.original_path_hash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
      expect(row.linked).toEqual(row.file_id); expect(row.content_hash).toBe(`sha256:${row.sha256}`);
      return {date:metadata.report_date,scope:metadata.scope,kind:metadata.kind,hash:row.sha256,original:metadata.original_path_hash};
    });
    const sortLinks=(values:unknown[])=>values.map(value=>JSON.stringify(value)).sort();
    expect(sortLinks(observedLinks)).toEqual(sortLinks(expectedLinks));
    const requestHashes=(await fixture.db.rows(`select sha256 from brain.file_requests where source='garmin'`)).map(row=>row.sha256).sort();
    const allHashes=[...source.evaluations.flatMap(([, , content])=>Array(5).fill(createHash('sha256').update(content).digest('hex')) as string[]),...expectedLinks.slice(source.evaluations.length).map(item=>item.hash)].sort();
    expect(requestHashes).toEqual(allHashes);
    for (const row of links) {
      const content=await readFile(join(fixture.home,'files',String(row.locator)));
      expect(createHash('sha256').update(content).digest('hex')).toBe(row.sha256);
      expect(content.length).toBe(row.size_bytes);
    }
    const extDsn=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl);
    const env={...fixture.env,BRAIN_DATABASE_URL:extDsn,BRAIN_USER_ID:self,BRAIN_ACCOUNT:'12345',BRAIN_WORK_ID:ids.next(),BRAIN_ATTEMPT_TOKEN:ids.next(),PYTHONPATH:join(fixture.home,'extensions/garmin/src')};
    execFileSync(python,[join(synthetic,'compare_tables.py'),join(capture,'D2.db')],{env,encoding:'utf8'});
    for (const table of ['auth_event','run','fetch_error','delivery']) {
      const sequence=await fixture.db.rows(`select s.last_value,s.is_called,(select max(id) from garmin.${table}) as max_id from garmin.${table}_id_seq s`);
      expect(sequence[0]?.is_called).toBe(true);
      expect(BigInt(String(sequence[0]?.last_value))).toBeGreaterThanOrEqual(BigInt(String(sequence[0]?.max_id)));
    }
    const sqliteRoot=join(fixture.home,'oracle'), pgRoot=join(fixture.home,'pg-export');
    const script=join(synthetic,'export.py');
    execFileSync(python,[script,sqliteRoot,join(capture,'D2.db')],{env:{...env,PYTHONPATH:[join(root,'tests/oracle/src'),synthetic].join(delimiter)}});
    execFileSync(python,[script,pgRoot,join(capture,'D2.db')],{env});
    const sqliteFolder=join(sqliteRoot,'report-input/2026-01-02'), pgFolder=join(pgRoot,'report-input/2026-01-02');
    const expected=await files(sqliteFolder); expect(await files(pgFolder)).toEqual(expected);
    for (const required of ['manifest.json','days/2026-01-02/heart_rates.json','days/2026-01-02/stress_data.json','activities/42/activity.json','activities/45/activity.json','activities/46/activity.json','activities/49/activity.json','activities/50/activity.json','previous_evaluations/day.json','previous_evaluations/7d.json','period/7d/day_values.json','period/30d/evaluations.json','period/all/day_values.json']) expect(expected).toContain(required);
    expect(expected).not.toContain('activities/43/activity.json');
    expect(expected).not.toContain('activities/44/activity.json');
    expect(expected).not.toContain('activities/47/activity.json');
    expect(expected).not.toContain('activities/48/activity.json');
    const manifest=JSON.parse(await readFile(join(sqliteFolder,'manifest.json'),'utf8')) as {workouts:string[],months:string[],collect:{status:string}};
    expect(manifest.workouts).toEqual(['42']);
    expect(manifest.months).toEqual(['2025-11','2025-12','2026-01']);
    expect(manifest.collect.status).toBe('success');
    expect(JSON.parse(await readFile(join(sqliteFolder,'days/2026-01-02/heart_rates.json'),'utf8')).heartRateValues).toHaveLength(1);
    for (const scope of ['7d','30d','all']) {
      const evaluations=JSON.parse(await readFile(join(sqliteFolder,'period',scope,'evaluations.json'),'utf8')) as unknown[];
      expect(evaluations.length).toBeGreaterThan(1);
    }
    for (const name of expected) {
      const a=await readFile(join(sqliteFolder,name)),b=await readFile(join(pgFolder,name));
      if (name.endsWith('.json')) {
        const actualJson=JSON.parse(b.toString('utf8')),expectedJson=JSON.parse(a.toString('utf8'));
        if(name==='manifest.json') {
          // 새 수집 독립 계약은 직전 현지 날짜의 완료 시각 창이다.
          expect(actualJson.workouts).toEqual(['49']);
          expect(actualJson.workout_window).toEqual({from:'2026-01-01T00:00:00.000+09:00',to:'2026-01-02T00:00:00.000+09:00',basis:'completed_at'});
          for(const key of ['workouts','workout_window','notes']) { delete actualJson[key];delete expectedJson[key]; }
        }
        expect(actualJson,name).toEqual(expectedJson);
      }
      else expect(b,name).toEqual(a);
    }
    const counts=await fixture.db.rows(`select (select count(*)::int from garmin.native_import_mapping) mappings,(select count(*)::int from brain.file_requests where source='garmin') requests,(select count(*)::int from garmin.evaluation_revisions) revisions`);
    await run('import');
    expect(await fixture.db.rows(`select (select count(*)::int from garmin.native_import_mapping) mappings,(select count(*)::int from brain.file_requests where source='garmin') requests,(select count(*)::int from garmin.evaluation_revisions) revisions`)).toEqual(counts);
    const verifyWork=await run('import-verify');
    expect((await fixture.db.rows(`select last_progress_at from brain.work_attempts where work_item_id='${verifyWork}'`))[0]?.last_progress_at).toBeTruthy();
    const selectedMetric=await fixture.db.rows(`select user_id,connection_id,day_key,steps from garmin.daily_metric where user_id='${self}' and day_key='2026-01-01'`);
    expect(selectedMetric).toHaveLength(1);
    const metric=selectedMetric[0]!;
    const metricWhere=`user_id='${self}' and connection_id='${String(metric.connection_id)}' and day_key='2026-01-01'`;
    await fixture.db.query(`update garmin.daily_metric set steps=steps+1 where ${metricWhere}`);
    try {
      const tampered=await fixture.db.rows(`select user_id,connection_id,day_key,steps from garmin.daily_metric where ${metricWhere}`);
      expect(tampered).not.toEqual(selectedMetric);
      // Keep the production import-verify entry; do not reimport or repair here.
      const bad=await requestNative(fixture,'import-verify');
      expect(bad.code).not.toBe(0);
      expect(bad.body.error.code).toBe('EXTENSION_INVALID');
      expect(await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${bad.id}' order by started_at desc limit 1`)).toEqual([{error_code:'EXTENSION_REPORT_NOT_READY'}]);
      expect(bad.body.data.report.checks.checkpoints).toBe(false);
      expect(bad.body.data.report.counts.mismatches).toBeGreaterThan(0);
      expect(await fixture.db.rows(`select user_id,connection_id,day_key,steps from garmin.daily_metric where ${metricWhere}`)).toEqual(tampered);
    } finally {
      await fixture.db.query(`update garmin.daily_metric set steps=steps-1 where ${metricWhere}`);
    }
    expect(await fixture.db.rows(`select user_id,connection_id,day_key,steps from garmin.daily_metric where ${metricWhere}`)).toEqual(selectedMetric);
    await run('import-verify');
    expect(await fixture.db.rows(`select s.id,m.body from brain.sessions s join brain.messages m on m.session_id=s.id where s.id='${sid}'`)).toEqual(memoryBefore);
    expect(await fixture.db.rows(`select content_hash from brain.files where id='${fid}'`)).toEqual([{content_hash:`sha256:${'a'.repeat(64)}`}]);
    await fixture.db.query(`insert into garmin.evaluation_revisions(user_id,connection_id,report_date,scope,revision,summary,judgments,evidence,next_checks,report_md,model,created_at)
      select user_id,connection_id,report_date,scope,2,'second',judgments,evidence,next_checks,'second','fake',2 from garmin.evaluation_revisions where revision=1 and report_date='2026-01-01' and scope='day'`);
    expect(await fixture.db.rows(`select revision,summary from garmin.evaluation where report_date='2026-01-01' and scope='day'`)).toEqual([{revision:'2',summary:'second'}]);
    expect(await fixture.db.rows(`select count(*)::int n from garmin.evaluation_revisions`)).toEqual([{n:source.evaluations.length+1}]);
  } finally {controller.abort(); if (daemon) await daemon; await store.close(); await fixture.cleanup();}
},180000);

it('blocks unconfirmed attribution before any preservation or native write', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), capture=join(fixture.home,'synthetic-unconfirmed');
    await mkdir(capture);
    execFileSync(python,['-c',`import sqlite3,sys;sys.path.insert(0,sys.argv[1]);from synthetic import make_capture;make_capture(sys.argv[2]);db=sqlite3.connect(sys.argv[2]+'/D5.db');db.execute("update raw_response set raw='{}'");db.commit();db.close()`,synthetic,capture],{env:fixture.env});
    const sourceKeys=JSON.parse(execFileSync(python,['-c',`import base64,json,sqlite3,sys;c=sqlite3.connect(sys.argv[1]);rows=c.execute('select scope,key,endpoint from raw_response').fetchall();print(json.dumps(sorted(json.dumps([{'type':'text','encoding':'utf-8','base64':base64.b64encode(v.encode('utf-8')).decode('ascii')} for v in row],sort_keys=True,separators=(',',':')) for row in rows)))`,join(capture,'D5.db')],{encoding:'utf8'})) as string[];
    expect(sourceKeys.length).toBeGreaterThan(0);
    await store.setSetting({userId:self,key:'garmin.capture_manifest',value:await realpath(join(capture,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:uuidV7IdGen(),signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const run=await requestNative(fixture,'import');
    expect(run.code,run.stdout+run.stderr).toBe(0);
    const work=run.id;
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome,{timeout:60000}).toBe('failed');
    expect(await fixture.db.rows('select count(*)::int n from garmin.datasets')).toEqual([{n:0}]);
    expect(await fixture.db.rows('select count(*)::int n from garmin.preserved_rows')).toEqual([{n:0}]);
    expect(await fixture.db.rows('select count(*)::int n from garmin.native_import_checkpoints')).toEqual([{n:0}]);
  } finally {controller.abort(); if (daemon) await daemon; await store.close(); await fixture.cleanup();}
},120000);

it('registers v1 capture files without inventing account provenance and records fingerprint conflicts', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    expect((await fixture.run(['ext','install','garmin','--json'])).code).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), capture=join(fixture.home,'synthetic-v1');
    await mkdir(capture);
    execFileSync(python,['-c',`import json,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from synthetic import make_capture;p=make_capture(sys.argv[2]);m=json.loads(p.read_text());m['version']=1;m.pop('inventory');m['files']=[{k:f[k] for k in ('source','snapshot','bytes')} for f in m['files']];p.write_text(json.dumps(m))`,synthetic,capture],{env:fixture.env});
    await store.setSetting({userId:self,key:'garmin.capture_manifest',value:await realpath(join(capture,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const run=async (kind:string, outcome:string) => {
      const result=await requestNative(fixture,kind as 'import' | 'import-verify');
      expect(result.code,result.stdout+result.stderr).toBe(0);
      await expect.poll(()=>resumeImport(fixture,result.id),{timeout:90000,interval:100}).toBe(outcome);
    };
    await run('import','succeeded');
    const rows=await fixture.db.rows(`select u.path_hash,u.request_id,u.request_batch,q.dataset,q.import_batch,q.sha256,q.metadata,r.file_id,f.content_hash from garmin.unassigned_file_requests u join brain.file_requests q on q.id=u.request_id join brain.file_request_results r on r.request_id=q.id join brain.files f on f.id=r.file_id order by u.path_hash`);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(String(row.dataset)).toMatch(/^capture-unassigned:/);
      expect(row.import_batch).toEqual(row.request_batch);
      expect(row.metadata).toMatchObject({report_date:null,scope:null,original_path_hash:row.path_hash});
      expect(['report','graph']).toContain((row.metadata as Record<string,unknown>).kind);
      expect(row.content_hash).toBe(`sha256:${row.sha256}`);
    }
    expect(await fixture.db.rows('select count(*)::int n from garmin.evaluation_files e join garmin.unassigned_file_requests u on u.request_id=e.request_id')).toEqual([{n:0}]);
    await run('import','succeeded');
    expect(await fixture.db.rows('select count(*)::int n from garmin.unassigned_file_requests')).toEqual([{n:3}]);
    await run('import-verify','succeeded');
    const target=rows[0]!;
    await fixture.db.query(`update garmin.unassigned_file_requests set content_hash='synthetic-conflict' where request_id='${String(target.request_id)}'`);
    await run('import','failed');
    expect(await fixture.db.rows(`select dataset,batch,original_key,reason from garmin.import_conflicts where original_key='${String(target.path_hash)}'`)).toEqual([{dataset:target.dataset,batch:target.request_batch,original_key:target.path_hash,reason:'native_file_conflict'}]);
    expect(await fixture.db.rows(`select r.file_id,f.content_hash from brain.file_request_results r join brain.files f on f.id=r.file_id where r.request_id='${String(target.request_id)}'`)).toEqual([{file_id:target.file_id,content_hash:target.content_hash}]);
  } finally {controller.abort(); if (daemon) await daemon; await store.close(); await fixture.cleanup();}
},180000);

it('fixed4 package import preserves full5 capture, excludes D3, resumes and rejects tampering and extra files', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    const pkg=fileURLToPath(new URL('../../../plugins/garmin/package',import.meta.url));
    const installed=await fixture.run(['ext','install','--package',pkg,'--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), capture=join(fixture.home,'fixed4');
    await mkdir(capture);
    execFileSync(python,['-c',`import json,sqlite3,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1]);from synthetic import make_capture
root=Path(sys.argv[2]);p=make_capture(root);m=json.loads(p.read_text())
with sqlite3.connect(root/'D3.db') as db:
 for (name,) in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'").fetchall():
  if name!='auth_event': db.execute('delete from "'+name+'"')
(root/'excluded.md').write_bytes(b'excluded original')
m['files'].append(dict(dataset='synthetic-D3',artifact_key='excluded',source='excluded.md',snapshot='excluded.md',bytes=17,category='report'))
m.update(version=3,selection=dict(version=1,include=['synthetic-D2','synthetic-D1','synthetic-D4','synthetic-D5'],exclude=[dict(dataset='synthetic-D3',reason='unconfirmed-account')]))
p.write_text(json.dumps(m))`,synthetic,capture],{env:fixture.env});
    const before=await Promise.all((await files(capture)).map(async name=>[name,createHash('sha256').update(await readFile(join(capture,name))).digest('hex')]));
    await store.setSetting({userId:self,key:'garmin.capture_manifest',value:await realpath(join(capture,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:uuidV7IdGen(),signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const preflight=await fixture.run(['ext','run','garmin','import-preflight','--json']);
    expect(preflight.code,preflight.stdout+preflight.stderr).toBe(0);
    expect(preflight.body.data.report.counts).toMatchObject({datasets:4,unconfirmed_accounts:0});
    const run=async(job:'import'|'import-verify',outcome:'succeeded'|'failed')=>{
      const requested=await requestNative(fixture,job);
      expect(requested.code,requested.stdout+requested.stderr).toBe(0);
      await expect.poll(()=>resumeImport(fixture,requested.id),{timeout:90000,interval:100}).toBe(outcome);
      return requested.id;
    };
    const verifyRejected=async(expected:{check:'checkpoints'|'files';mismatches:1|5})=>{
      const requested=await requestNative(fixture,'import-verify');
      // Public-report commands wait for a terminal report; a rejected report is
      // a completed CLI failure, unlike a queued import request's exit 0.
      expect(requested.code,requested.stdout+requested.stderr).toBe(2);
      expect(requested.body).toMatchObject({ok:false,error:{code:'EXTENSION_INVALID'},data:{status:'failed',report:{
        counts:{datasets:4,mismatches:expected.mismatches},
        checks:{source_unchanged:true,checkpoints:expected.check!=='checkpoints',schemas:true,preserved:true,
          mappings:true,raw:true,legacy:true,files:expected.check!=='files',inventory:true,conflicts:true},
      }}});
      expect(await fixture.db.rows(`select outcome,completed_at is not null as terminal,current_attempt_token is null as released from brain.work_items where id='${requested.id}'`))
        .toEqual([{outcome:'failed',terminal:true,released:true}]);
      return requested.id;
    };
    const work=await run('import','succeeded');
    await run('import-verify','succeeded');
    const detail=JSON.parse(await readFile(join(fixture.home,'extensions/garmin/reports',work,'private.json'),'utf8'));
    expect(detail.selection_receipt).toMatchObject({captured:5,selected:4,excluded:1,table_counts:{'synthetic-D3':{auth_event:1,raw_response:0}}});
    for(const table of ['datasets','import_batches','import_mapping','import_checkpoints','source_schemas','preserved_rows','raw_payloads','artifact_inventory','artifact_relations','input_inventory','native_import_mapping','native_import_checkpoints']) {
      expect(await fixture.db.rows(`select count(*)::int n from garmin.${table} where dataset='synthetic-D3'`),table).toEqual([{n:0}]);
    }
    expect(await fixture.db.rows("select count(*)::int n from brain.file_requests where dataset='synthetic-D3'")).toEqual([{n:0}]);
    expect(await fixture.db.rows('select count(*)::int n from garmin.account_connections')).toEqual([{n:1}]);
    const ledger=()=>fixture.db.rows("select (select count(*) from garmin.preserved_rows)::int preserved,(select count(*) from garmin.native_import_mapping)::int native,(select count(*) from brain.file_requests)::int files");
    const complete=await ledger();
    await run('import','succeeded'); expect(await ledger()).toEqual(complete);
    expect(await Promise.all((await files(capture)).map(async name=>[name,createHash('sha256').update(await readFile(join(capture,name))).digest('hex')]))).toEqual(before);
    // Excluded bytes still bind both checkpoint layers and cannot be hidden from verify.
    const excluded=join(capture,'excluded.md'), original=await readFile(excluded);
    const {writeFile}=await import('node:fs/promises');
    await writeFile(excluded,Buffer.from('changed original!'));
    await verifyRejected({check:'checkpoints',mismatches:5});
    await writeFile(excluded,original);
    await run('import-verify','succeeded');
    // Role anchors catch a completely renamed dataset partition before new content.
    const manifest=join(capture,'manifest.json'), originalManifest=await readFile(manifest);
    const renamed=JSON.parse(originalManifest.toString());
    for(const entry of renamed.datasets) entry.dataset='renamed-'+entry.dataset;
    for(const entry of renamed.files) entry.dataset='renamed-'+entry.dataset;
    renamed.selection.include=renamed.selection.include.map((id:string)=>'renamed-'+id);
    renamed.selection.exclude[0].dataset='renamed-'+renamed.selection.exclude[0].dataset;
    await writeFile(manifest,JSON.stringify(renamed));
    await run('import','failed'); expect(await ledger()).toEqual(complete);
    expect(await fixture.db.rows("select count(*)::int n from garmin.datasets where dataset like 'renamed-%'")).toEqual([{n:0}]);
    await writeFile(manifest,originalManifest);
    // Extra requests in a selected current batch are rejected by file verification.
    await fixture.db.query(`insert into garmin.import_mapping(dataset,original_table,original_key,target_kind,target_id,content_hash,batch)
      select dataset,'artifact','synthetic-extra','native_file_v1','01940000-0000-7000-8000-000000000099','synthetic',batch from garmin.import_checkpoints where dataset='synthetic-D2'`);
    await verifyRejected({check:'files',mismatches:1});
    await fixture.db.query("delete from garmin.import_mapping where original_key='synthetic-extra'");
    await fixture.db.query(`insert into garmin.native_import_mapping(dataset,original_table,original_key,user_id,connection_id,batch,native_key,content_hash)
      select dataset,'meta','synthetic-extra',user_id,connection_id,batch,'[]','synthetic' from garmin.native_import_checkpoints where dataset='synthetic-D2'`);
    await verifyRejected({check:'checkpoints',mismatches:1});
    await fixture.db.query("delete from garmin.native_import_mapping where original_key='synthetic-extra'");
    await run('import-verify','succeeded');
    // Import conflicts remain in the audit ledger; exercise destructive tampering last.
    await writeFile(excluded,Buffer.from('changed original!'));
    await run('import','failed'); expect(await ledger()).toEqual(complete);
    expect(await fixture.db.rows("select count(*)::int n from brain.work_items where kind in ('garmin.collect','garmin.report')")).toEqual([{n:0}]);
    expect(await fixture.db.rows("select count(*)::int n from brain.channel_requests where producer='garmin'")).toEqual([{n:0}]);
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},240000);

it('fixed4 rejects missing roles, altered selection and unconfirmed or multiple profiles before all content writes', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    expect((await fixture.run(['ext','install','garmin','--json'])).code).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), capture=join(fixture.home,'fixed4-rejections');
    await mkdir(capture);
    execFileSync(python,['-c',`import json,sys;sys.path.insert(0,sys.argv[1]);from synthetic import make_capture;p=make_capture(sys.argv[2]);m=json.loads(p.read_text());m.update(version=3,selection=dict(version=1,include=['synthetic-D2','synthetic-D1','synthetic-D4','synthetic-D5'],exclude=[dict(dataset='synthetic-D3',reason='unconfirmed-account')]));p.write_text(json.dumps(m))`,synthetic,capture],{env:fixture.env});
    await store.setSetting({userId:self,key:'garmin.capture_manifest',value:await realpath(join(capture,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:uuidV7IdGen(),signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const {writeFile}=await import('node:fs/promises');
    const manifest=join(capture,'manifest.json'), baseline=await readFile(manifest), db=join(capture,'D5.db'), originalDB=await readFile(db);
    const cases=['missing-role','single-role','include-D3','wrong-exclusion','unconfirmed','multiple-profile','different-profile'];
    for(const scenario of cases) {
      await writeFile(manifest,baseline); await writeFile(db,originalDB);
      execFileSync(python,['-c',`import json,sqlite3,sys;from pathlib import Path
root=Path(sys.argv[1]);case=sys.argv[2];p=root/'manifest.json';m=json.loads(p.read_text())
if case=='missing-role': m['datasets'].pop()
if case=='single-role': m['selection']['include']=['synthetic-D2']
if case=='include-D3': m['selection']['include'].append('synthetic-D3')
if case=='wrong-exclusion': m['selection']['exclude'][0]['dataset']='synthetic-D4'
if case in ('unconfirmed','multiple-profile','different-profile'):
 with sqlite3.connect(root/'D5.db') as db:
  value={} if case=='unconfirmed' else dict(userProfileId=99999)
  if case=='multiple-profile': value=dict(profiles=[dict(userProfileId=12345),dict(userProfileId=99999)])
  db.execute('update raw_response set raw=?',(json.dumps(value),))
p.write_text(json.dumps(m))`,capture,scenario],{env:fixture.env});
      const requested=await requestNative(fixture,'import'); expect(requested.code).toBe(0);
      await expect.poll(()=>resumeImport(fixture,requested.id),{timeout:60000}).toBe('failed');
      for(const table of ['garmin.datasets','garmin.import_batches','garmin.import_checkpoints','garmin.preserved_rows','garmin.raw_payloads','garmin.account_connections','garmin.native_import_checkpoints','garmin.native_import_mapping','brain.file_requests']) {
        expect(await fixture.db.rows(`select count(*)::int n from ${table}`),scenario+': '+table).toEqual([{n:0}]);
      }
    }
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},180000);

async function makeFixed4(fixture: Awaited<ReturnType<typeof extHome>>, name:string) {
  const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), capture=join(fixture.home,name);
  await mkdir(capture);
  execFileSync(python,['-c',`import json,sqlite3,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1]);from synthetic import make_capture
root=Path(sys.argv[2]);p=make_capture(root);m=json.loads(p.read_text())
with sqlite3.connect(root/'D3.db') as db:
 for (name,) in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'").fetchall():
  if name!='auth_event': db.execute('delete from "'+name+'"')
m.update(version=3,selection=dict(version=1,include=['synthetic-D2','synthetic-D1','synthetic-D4','synthetic-D5'],exclude=[dict(dataset='synthetic-D3',reason='unconfirmed-account')]))
p.write_text(json.dumps(m))`,synthetic,capture],{env:fixture.env});
  return {python,capture};
}

const fixed4TargetTables=['garmin.datasets','garmin.import_batches','garmin.import_checkpoints','garmin.source_schemas',
  'garmin.account_connections','garmin.preserved_rows','garmin.import_mapping','garmin.raw_payloads','garmin.import_conflicts',
  'garmin.native_import_mapping','garmin.native_import_checkpoints','garmin.evaluation_revisions','garmin.evaluation_files','brain.file_requests'];
async function fixed4TargetSnapshot(fixture: Awaited<ReturnType<typeof extHome>>) {
  return Promise.all(fixed4TargetTables.map(table=>fixture.db.rows(`select coalesce(json_agg(t order by t::text)::text,'[]') contents from ${table} t`)));
}

it.each(['account','confirmed','label','schema'])('fixed4 refuses a final D5 target %s conflict before all new durable writes', async conflict => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    expect((await fixture.run(['ext','install','garmin','--json'])).code).toBe(0);
    const {capture}=await makeFixed4(fixture,'fixed4-target-conflict');
    await store.setSetting({userId:self,key:'garmin.capture_manifest',value:await realpath(join(capture,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    await fixture.db.query(`insert into garmin.datasets(dataset,account,account_confirmed,dataset_label)
      values ('synthetic-D5','${conflict==='account'?'99999':'12345'}',${conflict!=='confirmed'},${conflict==='label'?"'wrong-label'":'null'})`);
    if(conflict==='schema') await fixture.db.query("insert into garmin.source_schemas values ('synthetic-D5','meta',16,'[]'::jsonb,'[]'::jsonb)");
    const before=await fixed4TargetSnapshot(fixture);
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:uuidV7IdGen(),signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const request=await requestNative(fixture,'import'); expect(request.code).toBe(0);
    await expect.poll(()=>resumeImport(fixture,request.id),{timeout:60000}).toBe('failed');
    expect(await fixture.db.rows(`select error_code,error_retryable from brain.work_attempts where work_item_id='${request.id}'`)).toEqual([{error_code:'IMPORT_CONFLICT',error_retryable:false}]);
    expect(await fixed4TargetSnapshot(fixture)).toEqual(before);
    for(const table of ['garmin.import_batches','garmin.import_checkpoints','garmin.account_connections','garmin.preserved_rows','brain.file_requests']) {
      expect(await fixture.db.rows(`select count(*)::int n from ${table}`),table).toEqual([{n:0}]);
    }
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},120000);

it.each(['before-anchor','during-anchor','after-anchor','after-account','after-preservation','partial-receipt'])('fixed4 %s crash keeps account writes behind durable anchors and permits only unchanged resume', async boundary => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    const pkg=fileURLToPath(new URL('../../../plugins/garmin/package',import.meta.url));
    expect((await fixture.run(['ext','install','--package',pkg,'--json'])).code).toBe(0);
    const {python,capture}=await makeFixed4(fixture,'fixed4-anchor-crash');
    await store.setSetting({userId:self,key:'garmin.capture_manifest',value:await realpath(join(capture,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    // Only the disposable installed modules are instrumented, never product code.
    // A process exit during the first checkpoint INSERT proves the whole receipt rolls back.
    const stop=`\ndef _crash_once_fixed4():\n    from pathlib import Path\n    marker=Path(os.environ['BRAIN_EXTENSION_HOME'])/'fixed4-boundary-crash'\n    if not marker.exists():\n        marker.write_text('crashed')\n        os._exit(23)\n`;
    if(boundary==='after-account') {
      await appendFile(join(fixture.home,'extensions/garmin/src/native_import.py'),stop+`\n_original_connect_fixed4=_connect_account\ndef _connect_account(*args,**kwargs):\n    result=_original_connect_fixed4(*args,**kwargs)\n    _crash_once_fixed4()\n    return result\n`);
    } else if(boundary==='after-preservation') {
      await appendFile(join(fixture.home,'extensions/garmin/src/batch_import.py'),stop+`\n_original_ingest_fixed4=ingest\ndef ingest(*args,**kwargs):\n    result=_original_ingest_fixed4(*args,**kwargs)\n    _crash_once_fixed4()\n    return result\n`);
    } else if(boundary==='during-anchor') {
      await appendFile(join(fixture.home,'extensions/garmin/src/batch_import.py'),stop+`\n_original_execute_fixed4=psycopg.Cursor.execute\ndef _execute_fixed4(self,query,*args,**kwargs):\n    result=_original_execute_fixed4(self,query,*args,**kwargs)\n    if isinstance(query,str) and query.startswith('insert into garmin.import_checkpoints'):\n        _crash_once_fixed4()\n    return result\npsycopg.Cursor.execute=_execute_fixed4\n`);
    } else {
      await appendFile(join(fixture.home,'extensions/garmin/src/batch_import.py'),stop+`\n_original_prepare_fixed4=prepare_fixed4\ndef prepare_fixed4(*args,**kwargs):\n    ${boundary==='before-anchor'?'_crash_once_fixed4()':'pass'}\n    result=_original_prepare_fixed4(*args,**kwargs)\n    ${['after-anchor','partial-receipt'].includes(boundary)?'_crash_once_fixed4()':'pass'}\n    return result\n`);
    }
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:uuidV7IdGen(),signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const first=await requestNative(fixture,'import'); expect(first.code).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${first.id}' and finished_at is not null order by started_at limit 1`))[0]?.error_code,{timeout:60000,interval:25}).toBe('ABI_EXIT_FAILED');
    // Freeze only this settled synthetic retry; no second attempt may obscure the crash snapshot.
    await fixture.db.query(`update brain.work_items set next_attempt_at='2099-01-01T00:00:00Z' where id='${first.id}' and current_attempt_token is null and completed_at is null`);
    expect(await fixture.db.rows(`select count(*)::int n from brain.work_attempts where work_item_id='${first.id}'`)).toEqual([{n:1}]);
    const anchored=!['before-anchor','during-anchor'].includes(boundary);
    expect(await fixture.db.rows('select count(*)::int n from garmin.import_checkpoints')).toEqual([{n:anchored?4:0}]);
    expect(await fixture.db.rows('select count(*)::int n from garmin.account_connections')).toEqual([{n:['after-account','after-preservation'].includes(boundary)?1:0}]);
    expect(await fixture.db.rows('select count(*)::int n from brain.file_requests')).toEqual([{n:0}]);
    if(boundary==='after-preservation') {
      expect(await fixture.db.rows('select count(*)::int n from garmin.import_checkpoints where original_table is not null')).toEqual([{n:1}]);
      expect((await fixture.db.rows('select count(*)::int n from garmin.preserved_rows'))[0]?.n).toBeGreaterThan(0);
    } else expect(await fixture.db.rows('select count(*)::int n from garmin.preserved_rows')).toEqual([{n:0}]);
    if(boundary==='partial-receipt') {
      // Seed the older v3 single-role receipt shape in this owned fixture only.
      // New first receipts are atomic; compatibility still must bind the full capture.
      await fixture.db.query("delete from garmin.import_checkpoints where source_role<>'production'");
      expect(await fixture.db.rows('select count(*)::int n from garmin.import_checkpoints')).toEqual([{n:1}]);
    }
    if(anchored) {
      const {writeFile}=await import('node:fs/promises');
      const manifest=join(capture,'manifest.json'), originalManifest=await readFile(manifest);
      const snapshots=await Promise.all(['D1','D2','D4','D5'].map(async role=>({path:join(capture,role+'.db'),bytes:await readFile(join(capture,role+'.db'))})));
      const baseline=await fixed4TargetSnapshot(fixture);
      for(const mutation of ['rename','profile']) {
        if(mutation==='rename') {
          const value=JSON.parse(originalManifest.toString());
          for(const entry of [...value.datasets,...value.files,...value.inventory]) entry.dataset='renamed-'+entry.dataset;
          value.selection.include=value.selection.include.map((id:string)=>'renamed-'+id);
          value.selection.exclude[0].dataset='renamed-'+value.selection.exclude[0].dataset;
          await writeFile(manifest,JSON.stringify(value));
        } else {
          execFileSync(python,['-c',`import sqlite3,sys;from pathlib import Path
for role in ('D1','D2','D4','D5'):
 with sqlite3.connect(Path(sys.argv[1])/(role+'.db')) as db: db.execute("update raw_response set raw=replace(raw,'12345','99999')")`,capture],{env:fixture.env});
        }
        const changed=await requestNative(fixture,'import','fixed4-change-'+mutation); expect(changed.code).toBe(0);
        await expect.poll(()=>resumeImport(fixture,changed.id),{timeout:60000}).toBe('failed');
        expect(await fixed4TargetSnapshot(fixture),boundary+': '+mutation).toEqual(baseline);
        await writeFile(manifest,originalManifest);
        for(const snapshot of snapshots) await writeFile(snapshot.path,snapshot.bytes);
      }
    }
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${first.id}' and current_attempt_token is null and completed_at is null`);
    await expect.poll(()=>resumeImport(fixture,first.id,true),{timeout:90000,interval:100}).toBe('succeeded');
    const verification=await requestNative(fixture,'import-verify'); expect(verification.code).toBe(0);
    await expect.poll(()=>resumeImport(fixture,verification.id),{timeout:60000}).toBe('succeeded');
    expect(await fixture.db.rows('select count(*)::int n from garmin.import_checkpoints')).toEqual([{n:4}]);
    expect(await fixture.db.rows('select count(*)::int n from garmin.account_connections')).toEqual([{n:1}]);
    expect(await fixture.db.rows("select count(*)::int n from garmin.datasets where dataset='synthetic-D3'")).toEqual([{n:0}]);
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},240000);

it('two supervised fixed4 attempts serialize the first durable receipt on the capture lock', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    expect((await fixture.run(['ext','install','garmin','--json'])).code).toBe(0);
    const {capture}=await makeFixed4(fixture,'fixed4-competing');
    await store.setSetting({userId:self,key:'garmin.capture_manifest',value:await realpath(join(capture,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    const extension=join(fixture.home,'extensions/garmin'), entered=join(extension,'fixed4-lock-entered'), release=join(extension,'fixed4-lock-release');
    // The barrier holds the actual capture lock, before the first durable anchor.
    await appendFile(join(extension,'src/batch_import.py'),`\n_original_prepare_lock_test=prepare_fixed4\ndef prepare_fixed4(*args,**kwargs):\n    from pathlib import Path\n    import time\n    root=Path(os.environ['BRAIN_EXTENSION_HOME'])\n    marker=root/'fixed4-lock-entered'\n    if not marker.exists():\n        marker.write_text(os.environ['BRAIN_WORK_ID'])\n        deadline=time.monotonic()+20\n        while not (root/'fixed4-lock-release').exists():\n            if time.monotonic()>deadline: raise RuntimeError('synthetic lock barrier timed out')\n            time.sleep(0.01)\n    return _original_prepare_lock_test(*args,**kwargs)\n`);
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:uuidV7IdGen(),signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const first=await requestNative(fixture,'import','fixed4-race-first'); expect(first.code).toBe(0);
    await expect.poll(()=>readFile(entered,'utf8').catch(()=>''),{timeout:60000}).toBe(first.id);
    // Different work targets create two attempts; they do not change dataset selection.
    const second=await requestNative(fixture,'import','fixed4-race-second'); expect(second.code).toBe(0);
    const waiting=()=>fixture.db.rows(`select count(*)::int n from pg_locks
      where locktype='advisory' and not granted
        and classid=((hashtextextended('garmin:fixed4:native-synthetic-v1',0)>>32)&4294967295)::oid
        and objid=(hashtextextended('garmin:fixed4:native-synthetic-v1',0)&4294967295)::oid`);
    await expect.poll(waiting,{timeout:15000,interval:25}).toEqual([{n:1}]);
    expect(await fixture.db.rows('select count(*)::int n from garmin.import_checkpoints')).toEqual([{n:0}]);
    expect(await fixture.db.rows('select count(*)::int n from garmin.account_connections')).toEqual([{n:0}]);
    const {writeFile}=await import('node:fs/promises'); await writeFile(release,'release');
    await expect.poll(()=>resumeImport(fixture,first.id),{timeout:90000,interval:100}).toBe('succeeded');
    await expect.poll(()=>resumeImport(fixture,second.id),{timeout:90000,interval:100}).toBe('succeeded');
    expect(await fixture.db.rows('select count(*)::int n from garmin.import_checkpoints')).toEqual([{n:4}]);
    expect(await fixture.db.rows('select count(*)::int n from garmin.account_connections')).toEqual([{n:1}]);
    expect(await fixture.db.rows("select count(*)::int n from garmin.datasets where dataset='synthetic-D3'")).toEqual([{n:0}]);
    const verification=await requestNative(fixture,'import-verify'); expect(verification.code).toBe(0);
    await expect.poll(()=>resumeImport(fixture,verification.id),{timeout:60000}).toBe('succeeded');
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},180000);
