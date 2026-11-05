import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { postgresStore } from 'second_brain/postgres';
import { extHome } from '../test/ext-fixture.js';
import { extensionDatabaseUrl } from '../src/config/codec.js';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

const root=fileURLToPath(new URL('../../../extensions/garmin',import.meta.url));
const synthetic=join(root,'fixtures/native');
const self='01940000-0000-7000-8000-00000000000a';

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
    const run=async (kind:string) => {
      const request=await fixture.run(['ext','run','garmin',kind,'--json']);
      expect(request.code,request.stdout+request.stderr).toBe(0);
      const id=String(request.body.data.work_id);
      await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome,{timeout:90000,interval:100}).toBe('succeeded');
      return id;
    };
    const work=await run('import');
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
      if (name.endsWith('.json')) expect(JSON.parse(b.toString('utf8')),name).toEqual(JSON.parse(a.toString('utf8')));
      else expect(b,name).toEqual(a);
    }
    const counts=await fixture.db.rows(`select (select count(*)::int from garmin.native_import_mapping) mappings,(select count(*)::int from brain.file_requests where source='garmin') requests,(select count(*)::int from garmin.evaluation_revisions) revisions`);
    await run('import');
    expect(await fixture.db.rows(`select (select count(*)::int from garmin.native_import_mapping) mappings,(select count(*)::int from brain.file_requests where source='garmin') requests,(select count(*)::int from garmin.evaluation_revisions) revisions`)).toEqual(counts);
    await run('import-verify');
    const selectedMetric=await fixture.db.rows(`select user_id,connection_id,day_key,steps from garmin.daily_metric where user_id='${self}' and day_key='2026-01-01'`);
    expect(selectedMetric).toHaveLength(1);
    const metric=selectedMetric[0]!;
    const metricWhere=`user_id='${self}' and connection_id='${String(metric.connection_id)}' and day_key='2026-01-01'`;
    await fixture.db.query(`update garmin.daily_metric set steps=steps+1 where ${metricWhere}`);
    try {
      const tampered=await fixture.db.rows(`select user_id,connection_id,day_key,steps from garmin.daily_metric where ${metricWhere}`);
      expect(tampered).not.toEqual(selectedMetric);
      // Keep the production import-verify entry; do not reimport or repair here.
      const bad=await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(bad.code).not.toBe(0);
      expect(bad.body.error.code).toBe('EXTENSION_INVALID');
      expect(await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${String(bad.body.data.work_id)}' order by started_at desc limit 1`)).toEqual([{error_code:'EXTENSION_REPORT_NOT_READY'}]);
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

it('preserves the source but blocks native attribution when a capture has no profile evidence', async () => {
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
    const run=await fixture.run(['ext','run','garmin','import','--json']);
    expect(run.code,run.stdout+run.stderr).toBe(0);
    const work=String(run.body.data.work_id);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome,{timeout:60000}).toBe('failed');
    expect(await fixture.db.rows(`select account_confirmed from garmin.datasets where dataset='synthetic-D5'`)).toEqual([{account_confirmed:false}]);
    const storedKeys=(await fixture.db.rows(`select original_key from garmin.preserved_rows where dataset='synthetic-D5' and original_table='raw_response'`)).map(row=>String(row.original_key)).sort();
    expect(storedKeys).toEqual(sourceKeys.sort());
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
      const result=await fixture.run(['ext','run','garmin',kind,'--json']);
      expect(result.code,result.stdout+result.stderr).toBe(0);
      await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${String(result.body.data.work_id)}'`))[0]?.outcome,{timeout:90000,interval:100}).toBe(outcome);
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
