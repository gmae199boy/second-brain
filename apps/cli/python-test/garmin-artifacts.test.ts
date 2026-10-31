import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';
import { postgresStore } from 'second_brain/postgres';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

it('명시 다종 파일과 기존 evaluation을 설치된 감독자가 발행하고 재실행한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture');
    await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const channel=ids.next(), conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(join(root,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const run=async()=>{
      const result=await fixture.run(['ext','run','garmin','import','--json']);
      expect(result.code,result.stdout+result.stderr).toBe(0);
      await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${result.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe('succeeded');
    };
    await run();
    const inventory=await fixture.db.rows("select artifact_key,category,exclusion_reason,request_id from garmin.artifact_inventory order by artifact_key");
    expect(inventory).toHaveLength(11);
    expect(await fixture.db.rows("select metadata->>'source' as source,metadata_raw is null as ordinary from garmin.artifact_inventory where artifact_key='report'")).toEqual([{source:'report.md',ordinary:true}]);
    expect(inventory.find(r=>r.artifact_key==='secret')?.exclusion_reason).toBe('secret');
    expect(inventory.find(r=>r.artifact_key==='config')?.exclusion_reason).toBe('config');
    expect(inventory.find(r=>r.artifact_key==='config_log')).toMatchObject({category:'config',exclusion_reason:'config',request_id:null});
    expect(inventory.find(r=>r.artifact_key==='unknown_log')).toMatchObject({category:'unknown',exclusion_reason:'unknown',request_id:null});
    for (const key of ['utf16le','utf16be']) expect(inventory.find(r=>r.artifact_key===key)).toMatchObject({exclusion_reason:'scan_failed',request_id:null});
    expect(inventory.find(r=>r.artifact_key==='safe')?.request_id).toBeTruthy();
    expect(await fixture.db.rows("select category,state from garmin.input_inventory where dataset='synthetic-D1' order by category")).toEqual([{category:'body',state:'present'},{category:'inbox',state:'absent'},{category:'profile',state:'empty'}]);
    expect(await fixture.db.rows("select reason from garmin.artifact_relations where analysis_key='input'")).toEqual([{reason:'analysis_unavailable'}]);
    const body=(await fixture.db.rows("select metadata from garmin.input_inventory where dataset='synthetic-D1' and category='body'"))[0]!.metadata as any;
    expect(body.fields).toEqual({measured_date:'2026-01-01',fields:{weight:{mtime:'2026-01-02T00:00:00Z'}}});
    expect(body.source_files).toEqual([{artifact_key:'input',request_id:inventory.find(r=>r.artifact_key==='input')!.request_id}]);
    const expectedFiles: Record<string, Buffer> = {
      report: Buffer.from('# synthetic report\n'), facts: Buffer.from('{"synthetic":true}\n'),
      plot: Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('synthetic')]),
      input: Buffer.from('{"day":"synthetic"}'), safe: Buffer.from('operation completed\n'),
    };
    await expect.poll(async()=> (await fixture.db.rows(`select count(*)::int as n from garmin.artifact_inventory i join brain.file_request_results r on r.request_id=i.request_id where i.exclusion_reason is null and r.file_id is not null`))[0]?.n,{timeout:20000}).toBe(Object.keys(expectedFiles).length);
    const storedFiles=await fixture.db.rows(`select i.artifact_key, q.sha256, q.size_bytes::int as request_size, r.file_id, f.content_hash, f.size_bytes as file_size, l.locator
      from garmin.artifact_inventory i join brain.file_requests q on q.id=i.request_id join brain.file_request_results r on r.request_id=q.id
      join brain.files f on f.id=r.file_id join brain.file_locations l on l.id=f.home_location_id where i.exclusion_reason is null order by i.artifact_key`);
    expect(storedFiles.map(r=>r.artifact_key).sort()).toEqual(Object.keys(expectedFiles).sort());
    for (const row of storedFiles) {
      const expected=expectedFiles[String(row.artifact_key)]!, hash=createHash('sha256').update(expected).digest('hex');
      expect(row).toMatchObject({sha256:hash,request_size:expected.length,content_hash:`sha256:${hash}`,file_size:expected.length});
      const actual=await readFile(join(fixture.home,'files',String(row.locator)));
      expect(actual).toEqual(expected);
      expect(createHash('sha256').update(actual).digest('hex')).toBe(hash);
    }
    await expect.poll(async()=> (await fixture.db.rows(`select count(*)::int as n from garmin.artifact_inventory i join brain.file_request_results r on r.request_id=i.request_id where i.artifact_key='report' and r.file_id is not null`))[0]?.n,{timeout:20000}).toBe(1);
    await expect.poll(async()=> (await fixture.db.rows(`select count(*)::int as n from garmin.artifact_inventory i join brain.file_request_results r on r.request_id=i.request_id join brain.document_extractions e on e.file_id=r.file_id join brain.document_chunks c on c.extraction_id=e.id where i.artifact_key='report' and e.status='ok' and c.body like '%synthetic report%'`))[0]?.n,{timeout:20000}).toBeGreaterThan(0);
    await expect.poll(async()=> (await fixture.db.rows(`select count(*)::int as n from garmin.artifact_inventory i join brain.file_request_results r on r.request_id=i.request_id join brain.document_extractions e on e.file_id=r.file_id where i.artifact_key='plot' and e.status='unsupported'`))[0]?.n,{timeout:20000}).toBeGreaterThan(0);
    const blob=(await fixture.db.rows(`select l.locator from garmin.artifact_inventory i join brain.file_request_results r on r.request_id=i.request_id join brain.files f on f.id=r.file_id join brain.file_locations l on l.id=f.home_location_id where i.artifact_key='report'`))[0]!.locator as string;
    expect(await readFile(join(fixture.home,'files',blob))).toEqual(Buffer.from('# synthetic report\n'));
    const analyses=await store.imports.readAnalyses(); expect(analyses.ok).toBe(true);
    if (!analyses.ok) throw Error('analysis read failed');
    expect(analyses.rows).toContainEqual(expect.objectContaining({original_key:'report',model:null,model_missing:true,created_at:null,created_at_missing:true,artifacts:expect.arrayContaining([expect.objectContaining({role:'image'}),expect.objectContaining({role:'input'})])}));
    expect(analyses.rows).toContainEqual(expect.objectContaining({original_key:'facts',created_at:'2026-01-01T18:04:05.000Z',created_at_missing:false}));
    expect(analyses.rows).toContainEqual(expect.objectContaining({original_table:'evaluation',report_date:'2026-01-01',scope:'day',summary:'합성\0기록',judgments:{type:'invalid-text',encoding:'utf-8',base64:'/w=='},evidence:'[]',next_checks:'[]',report_md:'본문',model:'model',created_at:'1970-01-01T00:00:00.001Z'}));
    const before=await fixture.db.rows('select id,source,dataset,original_table,original_key from brain.analyses order by id');
    await run();
    expect(await fixture.db.rows('select id,source,dataset,original_table,original_key from brain.analyses order by id')).toEqual(before);
    expect(await fixture.db.rows('select count(*)::int as n from brain.channel_requests')).toEqual([{n:0}]);
    expect((await readFile(join(root,'report.md'),'utf8'))).toBe('# synthetic report\n');
    await writeFile(join(root,'report.md'),'# synthetic reporz\n');
    const conflict=await fixture.run(['ext','run','garmin','import','--json']);
    expect(conflict.code,conflict.stdout+conflict.stderr).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${conflict.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe('failed');
    expect(await fixture.db.rows("select count(*)::int as n from garmin.import_conflicts where reason='artifact_mismatch'")).toEqual([{n:1}]);
    expect(await fixture.db.rows('select id,source,dataset,original_table,original_key from brain.analyses order by id')).toEqual(before);
  } finally { controller.abort(); if (daemon) await daemon; await store.close(); await fixture.cleanup(); }
}, 90000);

it('checkpoint 뒤 같은 크기로 바뀐 SQLite에서 evaluation을 재독해하지 않는다', async () => {
  const { extensionDatabaseUrl }=await import('../src/config/codec.js');
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), ids=uuidV7IdGen();
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const source=join(root,'D1.db'), before=await readFile(source), beforeHash=createHash('sha256').update(before).digest('hex');
    const channel=ids.next(),conversation=ids.next(),work=ids.next(),token=ids.next(),now=new Date();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.addWork({id:work,kind:'garmin.import',targetKind:'import',targetId:'snapshot-barrier',createdAt:now,nextAttemptAt:now});
    expect(await store.claimSupervisedWork({now,claimedBy:'snapshot-barrier',kinds:['garmin.import'],attemptToken:token})).toMatchObject({ok:true});
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl), home=await realpath(join(fixture.home,'extensions/garmin'));
    // ingest가 보존 checkpoint를 커밋하고 검증된 객체를 반환한 직후 같은 크기의 값을 교체한다.
    const script=`import sys,sqlite3\nsys.path.insert(0,sys.argv[1])\nimport batch_import\noriginal=batch_import.ingest\ndef intercepted(conn,capture,entry,catalog,conversation):\n result=original(conn,capture,entry,catalog,conversation)\n if entry['dataset']=='synthetic-D1':\n  with sqlite3.connect(sys.argv[2]) as db: db.execute('update evaluation set summary=?',('가성\\0기록',))\n return result\nbatch_import.ingest=intercepted\nbatch_import.run()`;
    const result=execFileSync(python,['-c',script,join(home,'src'),source],{encoding:'utf8',env:{...process.env,BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:work,BRAIN_ATTEMPT_TOKEN:token,BRAIN_EXTENSION_HOME:home,BRAIN_SECRET_SCANNER_NODE:process.execPath,BRAIN_SECRET_SCANNER_SCRIPT:fileURLToPath(new URL('../dist/workers/secret-scan.js',import.meta.url)),BRAIN_SETTINGS_SNAPSHOT:JSON.stringify({version:1,extension:'garmin',values:{'garmin.capture_manifest':await realpath(join(root,'manifest.json')),'garmin.legacy_conversation_id':conversation}})}});
    expect(result).toContain('"type": "result"');
    const after=await readFile(source); expect(after.length).toBe(before.length); expect(createHash('sha256').update(after).digest('hex')).not.toBe(beforeHash);
    expect(await fixture.db.rows("select source_hash from garmin.import_checkpoints where dataset='synthetic-D1'")).toEqual([{source_hash:beforeHash}]);
    const preserved=await fixture.db.rows("select values_json->'summary' as summary from garmin.preserved_rows where dataset='synthetic-D1' and original_table='evaluation'");
    expect(preserved).toEqual([{summary:{type:'text',encoding:'utf-8',base64:Buffer.from('합성\0기록').toString('base64')}}]);
    const analyses=await store.imports.readAnalyses(); expect(analyses.ok && analyses.rows).toContainEqual(expect.objectContaining({dataset:'synthetic-D1',original_table:'evaluation',summary:'합성\0기록'}));
  } finally {await store.close(); await fixture.cleanup();}
},90000);

it('NUL metadata를 원형으로 재개하고 참조 없는 파일의 미연결 사유를 기록한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const manifestPath=join(root,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    const label='synthetic\0D1';
    manifest.datasets[0].dataset=label;
    for(const file of manifest.files) file.dataset=label;
    for(const item of manifest.inventory) item.dataset=label;
    const report=manifest.files.find((x:any)=>x.artifact_key==='report');
    const surrogateKey='report\ud800', excludedKey='secret\udfff', reservedKey='~garmin-key-v1~cmVwb3J07aCA';
    report.artifact_key=surrogateKey;
    manifest.files.find((x:any)=>x.artifact_key==='secret').artifact_key=excludedKey;
    manifest.files.find((x:any)=>x.artifact_key==='facts').artifact_key=reservedKey;
    for(const file of manifest.files) for(const relation of file.relations ?? []) if(relation.analysis_key==='report') relation.analysis_key=surrogateKey;
    manifest.inventory.find((x:any)=>x.category==='body').source_files.push(surrogateKey);
    Object.assign(report,{model:'모델\ud800\0원형',scope:'범위\udfff\0값',report_date:'날짜\ud800\0값'});
    const body=manifest.inventory.find((x:any)=>x.category==='body');
    body.metadata={'측정\0일':'날짜\0값',nested:{'필드\0키':{'수정\0시각':'시각\0값'},'\ud800':'\udfff'}};
    const lonePng=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x42]);
    const loneInput=Buffer.from('{"independent":true}');
    await writeFile(join(root,'orphan.png'),lonePng); await writeFile(join(root,'orphan.json'),loneInput);
    manifest.files.push({source:'orphan.png',snapshot:'orphan.png',bytes:lonePng.length,dataset:label,artifact_key:'orphan_png',category:'image'});
    manifest.files.push({source:'orphan.json',snapshot:'orphan.json',bytes:loneInput.length,dataset:label,artifact_key:'orphan_input',category:'input',relations:[]});
    await writeFile(manifestPath,JSON.stringify(manifest));
    const channel=ids.next(),conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(manifestPath),updatedAt:new Date()});
    await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const run=async()=>{
      const result=await fixture.run(['ext','run','garmin','import','--json']); expect(result.code,result.stdout+result.stderr).toBe(0);
      await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${result.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe('succeeded');
      return result.body.data.work_id as string;
    };
    const first=await run();
    const privateReport=JSON.parse(await readFile(join(fixture.home,'extensions/garmin/reports',first,'private.json'),'utf8'));
    const publicReport=JSON.parse(await readFile(join(fixture.home,'extensions/garmin/reports',first,'public.json'),'utf8'));
    expect(privateReport.artifacts.find((x:any)=>x.key===surrogateKey).metadata).toMatchObject({dataset:label,model:'모델\ud800\0원형',scope:'범위\udfff\0값',report_date:'날짜\ud800\0값'});
    const privateBody=privateReport.inventory.find((x:any)=>x.category==='body' && x.metadata);
    expect(privateBody.metadata.fields).toEqual(body.metadata);
    expect(privateBody.metadata.source_files).toEqual([{artifact_key:'input',request_id:privateReport.artifacts.find((x:any)=>x.key==='input').request_id},{artifact_key:surrogateKey,request_id:privateReport.artifacts.find((x:any)=>x.key===surrogateKey).request_id}]);
    expect(privateReport.artifacts.find((x:any)=>x.key===excludedKey).reason).toBe('secret');
    expect(privateReport.artifacts.find((x:any)=>x.key===reservedKey).request_id).toBeTruthy();
    expect(privateReport.relations).toContainEqual(expect.objectContaining({analysis_key:surrogateKey}));
    const analyses=await store.imports.readAnalyses();
    expect(analyses.ok && analyses.rows).toContainEqual(expect.objectContaining({original_key:expect.stringMatching(/^~garmin-key-v1~/),model:'모델\ud800\0원형',scope:'범위\udfff\0값',report_date:'날짜\ud800\0값'}));
    expect(await fixture.db.rows("select dataset_label from garmin.datasets where dataset_label is not null")).toEqual([{dataset_label:'synthetic�D1'}]);
    const normal=await fixture.db.rows("select metadata,metadata_raw is null as ordinary from garmin.input_inventory where category='profile' and state='empty'");
    expect(normal).toEqual([{metadata:{fields:{},source_files:[]},ordinary:true}]);
    expect((await fixture.db.rows("select metadata_raw is not null as preserved from garmin.artifact_inventory where metadata_raw is not null and category='report'"))).toEqual([{preserved:true}]);
    const unlinked=await fixture.db.rows("select artifact_key,request_id,unlinked_reason from garmin.artifact_inventory where artifact_key in ('orphan_input','orphan_png') order by artifact_key");
    expect(unlinked).toEqual([{artifact_key:'orphan_input',request_id:expect.any(String),unlinked_reason:'no_analysis_reference'},{artifact_key:'orphan_png',request_id:expect.any(String),unlinked_reason:'no_analysis_reference'}]);
    expect(await fixture.db.rows("select count(*)::int as n from garmin.artifact_relations where artifact_key in ('orphan_input','orphan_png')")).toEqual([{n:0}]);
    expect(publicReport.counts.unlinked).toBe(3); // 두 미참조 파일과 한 명시 미해결 참조
    await expect.poll(async()=> (await fixture.db.rows("select count(*)::int as n from garmin.artifact_inventory i join brain.file_request_results r on r.request_id=i.request_id where i.artifact_key in ('orphan_input','orphan_png') and r.file_id is not null"))[0]?.n,{timeout:20000}).toBe(2);
    const before=await fixture.db.rows("select artifact_key,request_id,analysis_id,unlinked_reason from garmin.artifact_inventory order by artifact_key");
    const second=await run();
    expect(await fixture.db.rows("select artifact_key,request_id,analysis_id,unlinked_reason from garmin.artifact_inventory order by artifact_key")).toEqual(before);
    const repeated=JSON.parse(await readFile(join(fixture.home,'extensions/garmin/reports',second,'public.json'),'utf8')); expect(repeated.counts.unlinked).toBe(3);
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},90000);

it('같은 key와 bytes의 artifact 정리 뒤 evaluation은 별도 locator로 재개한다', async () => {
  const { extensionDatabaseUrl }=await import('../src/config/codec.js');
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), ids=uuidV7IdGen(), controller=new AbortController();
  let daemon: ReturnType<typeof runDaemon> | undefined, child: ChildProcess | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), home=await realpath(join(fixture.home,'extensions/garmin')), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const source=join(root,'D1.db');
    const key=execFileSync(python,['-c',"import sys; sys.path.insert(0,sys.argv[1]); from reader import read_snapshot; from batch_import import canonical,encoded; t=read_snapshot(sys.argv[2])['tables']['evaluation']; print(canonical([encoded(t['rows'][0][k]) for k in t['keys']]))",join(home,'src'),source],{encoding:'utf8'}).trim();
    const body=Buffer.from('본문'), manifestPath=join(root,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    await writeFile(join(root,'same.md'),body);
    manifest.files=[{source:'same.md',snapshot:'same.md',bytes:body.length,dataset:'synthetic-D1',artifact_key:key,category:'report'}]; manifest.inventory=[];
    await writeFile(manifestPath,JSON.stringify(manifest));
    const channel=ids.next(),conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl), settings=JSON.stringify({version:1,extension:'garmin',values:{'garmin.capture_manifest':await realpath(manifestPath),'garmin.legacy_conversation_id':conversation}});
    const claim=async(target:string)=>{
      const id=ids.next(),token=ids.next(),now=new Date();
      expect(await store.addWork({id,kind:'garmin.import',targetKind:'import',targetId:target,createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});
      expect(await store.claimSupervisedWork({now,claimedBy:target,kinds:['garmin.import'],attemptToken:token})).toMatchObject({ok:true,item:{id},attemptToken:token});
      return {id,token};
    };
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{disabled:true}});
    const first=await claim('locator-first');
    const env={...process.env,BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:first.id,BRAIN_ATTEMPT_TOKEN:first.token,BRAIN_EXTENSION_HOME:home,BRAIN_SETTINGS_SNAPSHOT:settings};
    const script=`import sys\nsys.path.insert(0,sys.argv[1])\nimport analyses,batch_import\noriginal=analyses.stage\ndef stage(home,dataset,table,key,data):\n if table=='evaluation':\n  print('EVALUATION_BARRIER',flush=True)\n  sys.stdin.read(1)\n return original(home,dataset,table,key,data)\nanalyses.stage=stage\nbatch_import.run()`;
    child=spawn(python,['-c',script,join(home,'src')],{env,stdio:['pipe','pipe','pipe']});
    expect(String((await once(child.stdout!,'data'))[0])).toContain('EVALUATION_BARRIER');
    const requestSql="select q.id,q.locator,r.file_id,c.cleaned_at from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id left join brain.file_import_cleanup c on c.request_id=q.id where q.request_key::jsonb->>1='artifact'";
    await expect.poll(async()=> (await fixture.db.rows(requestSql))[0]?.cleaned_at,{timeout:20000}).toBeTruthy();
    const prior=(await fixture.db.rows(requestSql))[0]!; expect(prior.file_id).toBeTruthy();
    await expect(readFile(join(home,'staging',String(prior.locator)))).rejects.toMatchObject({code:'ENOENT'});
    const closed=once(child,'close'); child.kill('SIGKILL'); const exit=await closed; expect(exit[1]).toBe('SIGKILL'); child=undefined;
    expect(await store.finishSupervisedWork({id:first.id,attemptToken:first.token,now:new Date(),outcome:'failed'})).toMatchObject({ok:true});
    const second=await claim('locator-second');
    const output=execFileSync(python,[join(home,'src/import.py')],{encoding:'utf8',env:{...env,BRAIN_WORK_ID:second.id,BRAIN_ATTEMPT_TOKEN:second.token}});
    expect(JSON.parse(output)).toMatchObject({type:'result'});
    expect(await store.finishSupervisedWork({id:second.id,attemptToken:second.token,now:new Date(),outcome:'succeeded'})).toMatchObject({ok:true});
    const sql="select q.id,q.locator,q.request_key::jsonb->>1 as original_table,r.file_id from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where q.dataset='synthetic-D1' order by original_table";
    await expect.poll(async()=> (await fixture.db.rows(sql)).filter(r=>r.file_id).length,{timeout:20000}).toBe(2);
    const rows=await fixture.db.rows(sql); expect(rows.map(r=>r.original_table)).toEqual(['artifact','evaluation']);
    expect(rows[0]!.locator).not.toBe(rows[1]!.locator); expect(rows[0]!.file_id).toBe(rows[1]!.file_id);
    expect(await fixture.db.rows(`select count(*)::int as n from brain.files where content_hash='sha256:${createHash('sha256').update(body).digest('hex')}'`)).toEqual([{n:1}]);
    const before=await fixture.db.rows('select id,original_table,original_key,file_request_id from brain.analyses order by id');
    const third=await claim('locator-third');
    const replay=execFileSync(python,[join(home,'src/import.py')],{encoding:'utf8',env:{...env,BRAIN_WORK_ID:third.id,BRAIN_ATTEMPT_TOKEN:third.token}});
    expect(JSON.parse(replay)).toMatchObject({type:'result'});
    expect(await fixture.db.rows('select id,original_table,original_key,file_request_id from brain.analyses order by id')).toEqual(before);
  } finally {
    if(child && child.exitCode===null && child.signalCode===null){const closed=once(child,'close'); child.kill('SIGKILL'); await closed;}
    controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();
  }
},90000);

for (const [initial, changed] of [['password=synthetic\n','operation complete\n'], ['operation complete\n','password=synthetic\n']] as const) {
  it(`로그 수용 상태 변경은 발행 전체를 충돌로 거부한다: ${initial.startsWith('password')}`, async () => {
    const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
    let daemon: ReturnType<typeof runDaemon> | undefined;
    try {
      const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
      const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
      const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
      execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
      const path=join(root,'manifest.json'), manifest=JSON.parse(await readFile(path,'utf8'));
      expect(Buffer.byteLength(initial)).toBe(Buffer.byteLength(changed));
      await writeFile(join(root,'case.log'),initial);
      manifest.files=[{source:'case.log',snapshot:'case.log',bytes:Buffer.byteLength(initial),dataset:'synthetic-D1',artifact_key:'case',category:'log'}]; manifest.inventory=[];
      await writeFile(path,JSON.stringify(manifest));
      const channel=ids.next(),conversation=ids.next();
      await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
      await store.setSetting({key:'garmin.capture_manifest',value:await realpath(path),updatedAt:new Date()});
      await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
      daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
      const run=async(outcome:string)=>{const result=await fixture.run(['ext','run','garmin','import','--json']); expect(result.code,result.stdout+result.stderr).toBe(0); await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${result.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe(outcome);};
      await run('succeeded');
      const inventory=await fixture.db.rows("select * from garmin.artifact_inventory where artifact_key='case'");
      if (!initial.startsWith('password')) await expect.poll(async()=> (await fixture.db.rows("select count(*)::int as n from garmin.artifact_inventory i join brain.file_request_results r on r.request_id=i.request_id where i.artifact_key='case'"))[0]?.n,{timeout:20000}).toBe(1);
      await expect.poll(async()=> (await fixture.db.rows("select count(*)::int as n from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where r.request_id is null"))[0]?.n,{timeout:20000}).toBe(0);
      const snapshot=async()=>Promise.all([
        fixture.db.rows("select * from garmin.artifact_inventory where artifact_key='case'"),
        fixture.db.rows("select * from garmin.import_mapping where original_table='artifact' and original_key='case' order by target_kind"),
        fixture.db.rows("select id from brain.file_requests where request_key::jsonb->>2='case'"),
        fixture.db.rows("select id from brain.analyses where original_table='artifact' and original_key='case'"),
        fixture.db.rows('select id from brain.analysis_artifacts order by id'), fixture.db.rows('select id from brain.files order by id')]);
      const before=await snapshot(); expect(inventory[0]?.exclusion_reason).toBe(initial.startsWith('password')?'secret':null);
      await writeFile(join(root,'case.log'),changed); await run('failed');
      expect(await snapshot()).toEqual(before);
      expect(await fixture.db.rows("select count(*)::int as n from garmin.import_conflicts where original_table='artifact' and original_key='case'")).toEqual([{n:1}]);
    } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
  },90000);
}

it('inventory 확정 직전 장애는 요청과 mapping을 되돌리고 재개한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const path=join(root,'manifest.json'), manifest=JSON.parse(await readFile(path,'utf8'));
    manifest.files=manifest.files.filter((x:any)=>x.artifact_key==='report'); manifest.inventory=[]; await writeFile(path,JSON.stringify(manifest));
    const channel=ids.next(),conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(path),updatedAt:new Date()});
    await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    await fixture.db.query("create function garmin.test_inventory_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic barrier'; end $$; create trigger test_inventory_failure before insert on garmin.artifact_inventory for each row execute function garmin.test_inventory_failure()");
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const run=async(outcome:string)=>{const result=await fixture.run(['ext','run','garmin','import','--json']); expect(result.code,result.stdout+result.stderr).toBe(0); await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${result.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe(outcome);};
    await run('failed');
    expect(await fixture.db.rows("select count(*)::int as n from garmin.artifact_inventory where artifact_key='report'")).toEqual([{n:0}]);
    expect(await fixture.db.rows("select count(*)::int as n from garmin.import_mapping where original_table='artifact' and original_key='report'")).toEqual([{n:0}]);
    expect(await fixture.db.rows("select count(*)::int as n from brain.file_requests where request_key::jsonb->>2='report'")).toEqual([{n:0}]);
    expect(await fixture.db.rows("select count(*)::int as n from brain.analyses where original_table='artifact' and original_key='report'")).toEqual([{n:0}]);
    await fixture.db.query('drop trigger test_inventory_failure on garmin.artifact_inventory; drop function garmin.test_inventory_failure()');
    await run('succeeded');
    expect(await fixture.db.rows("select count(*)::int as n from garmin.artifact_inventory i join brain.file_requests q on q.id=i.request_id join brain.analyses a on a.id=i.analysis_id where i.artifact_key='report'")).toEqual([{n:1}]);
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},90000);

it('상한 초과 파일의 동일 크기 변경을 원문 해시로 충돌 처리한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const path=join(root,'manifest.json'), manifest=JSON.parse(await readFile(path,'utf8')), bytes=Buffer.alloc(32*1024*1024+1,0x61);
    await writeFile(join(root,'large.md'),bytes);
    manifest.files=[{source:'large.md',snapshot:'large.md',bytes:bytes.length,dataset:'synthetic-D1',artifact_key:'large',category:'report'}]; manifest.inventory=[]; await writeFile(path,JSON.stringify(manifest));
    const channel=ids.next(),conversation=ids.next(); await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(path),updatedAt:new Date()}); await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const run=async(outcome:string)=>{const result=await fixture.run(['ext','run','garmin','import','--json']); expect(result.code,result.stdout+result.stderr).toBe(0); await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${result.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe(outcome);};
    await run('succeeded');
    const before=await fixture.db.rows("select * from garmin.artifact_inventory where artifact_key='large'");
    expect(before[0]).toMatchObject({exclusion_reason:'too_large',content_hash:createHash('sha256').update(bytes).digest('hex'),request_id:null,analysis_id:null});
    expect(await fixture.db.rows("select count(*)::int as n from brain.file_requests where request_key::jsonb->>2='large'")).toEqual([{n:0}]);
    bytes[0]=0x62; await writeFile(join(root,'large.md'),bytes); await run('failed');
    expect(await fixture.db.rows("select * from garmin.artifact_inventory where artifact_key='large'")).toEqual(before);
    expect(await fixture.db.rows("select count(*)::int as n from garmin.import_conflicts where original_key='large'")).toEqual([{n:1}]);
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},90000);

it('재발행 staging과 core 정리는 같은 locator 잠금으로 직렬화된다', async () => {
  const { extensionDatabaseUrl }=await import('../src/config/codec.js');
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), ids=uuidV7IdGen(), controller=new AbortController();
  let daemon: ReturnType<typeof runDaemon> | undefined, child: ChildProcess | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), home=await realpath(join(fixture.home,'extensions/garmin')), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const path=join(root,'manifest.json'), manifest=JSON.parse(await readFile(path,'utf8')); manifest.files=manifest.files.filter((x:any)=>x.artifact_key==='report'); manifest.inventory=[]; await writeFile(path,JSON.stringify(manifest));
    const channel=ids.next(),conversation=ids.next(); await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl), settings=JSON.stringify({version:1,extension:'garmin',values:{'garmin.capture_manifest':await realpath(path),'garmin.legacy_conversation_id':conversation}});
    const claim=async(target:string)=>{const id=ids.next(),token=ids.next(),now=new Date(); expect(await store.addWork({id,kind:'garmin.import',targetKind:'import',targetId:target,createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true}); expect(await store.claimSupervisedWork({now,claimedBy:target,kinds:['garmin.import'],attemptToken:token})).toMatchObject({ok:true,item:{id},attemptToken:token}); return {id,token};};
    const first=await claim('lock-first'), base={...process.env,BRAIN_DATABASE_URL:url,BRAIN_EXTENSION_HOME:home,BRAIN_SETTINGS_SNAPSHOT:settings};
    const env=(attempt:{id:string;token:string})=>({...base,BRAIN_WORK_ID:attempt.id,BRAIN_ATTEMPT_TOKEN:attempt.token});
    expect(JSON.parse(execFileSync(python,[join(home,'src/import.py')],{encoding:'utf8',env:env(first)}))).toMatchObject({type:'result'});
    expect(await store.finishSupervisedWork({id:first.id,attemptToken:first.token,now:new Date(),outcome:'succeeded'})).toMatchObject({ok:true});
    const request=(await fixture.db.rows("select id,locator from brain.file_requests where request_key::jsonb->>2='report'"))[0]!;
    const second=await claim('lock-second');
    const script=`import sys\nsys.path.insert(0,sys.argv[1])\nimport analyses,batch_import\noriginal=analyses.stage\ndef stage(*args):\n if args[2]=='artifact':\n  print('STAGING_BARRIER',flush=True)\n  sys.stdin.read(1)\n return original(*args)\nanalyses.stage=stage\nbatch_import.run()`;
    child=spawn(python,['-c',script,join(home,'src')],{env:env(second),stdio:['pipe','pipe','pipe']});
    expect(String((await once(child.stdout!,'data'))[0])).toContain('STAGING_BARRIER');
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{disabled:true}});
    await expect.poll(async()=> (await fixture.db.rows(`select count(*)::int as n from brain.file_import_cleanup where request_id='${request.id}' and cleaned_at is null`))[0]?.n,{timeout:20000}).toBe(1);
    await expect.poll(async()=> (await fixture.db.rows("select count(*)::int as n from pg_locks where locktype='advisory' and not granted"))[0]?.n,{timeout:20000}).toBeGreaterThan(0);
    child.stdin!.write('x'); const closed=await once(child,'close'); expect(closed[0]).toBe(0); child=undefined;
    expect(await store.finishSupervisedWork({id:second.id,attemptToken:second.token,now:new Date(),outcome:'succeeded'})).toMatchObject({ok:true});
    await expect.poll(async()=> (await fixture.db.rows(`select cleaned_at from brain.file_import_cleanup where request_id='${request.id}'`))[0]?.cleaned_at,{timeout:20000}).toBeTruthy();
    await expect(readFile(join(home,'staging',String(request.locator)))).rejects.toMatchObject({code:'ENOENT'});
    const third=await claim('lock-third'); expect(JSON.parse(execFileSync(python,[join(home,'src/import.py')],{encoding:'utf8',env:env(third)}))).toMatchObject({type:'result'});
    await expect(readFile(join(home,'staging',String(request.locator)))).rejects.toMatchObject({code:'ENOENT'});
  } finally {if(child && child.exitCode===null && child.signalCode===null){const closed=once(child,'close'); child.kill('SIGKILL'); await closed;} controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},90000);

it('같은 inventory 키의 artifact와 대형 evaluation을 원본 표별로 보존하고 재개한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c',"import sys,pathlib,sqlite3; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; p=pathlib.Path(sys.argv[2]); artifact_capture(p); c=sqlite3.connect(p/'D1.db'); c.execute('update evaluation set report_md=?',('x'*(32*1024*1024+1),)); c.commit(); c.close()",fixtures,root]);
    const path=join(root,'manifest.json'), manifest=JSON.parse(await readFile(path,'utf8'));
    // SQLite 원문 키는 반입기가 사용하는 정렬된 바이트 표현이다.
    const key='evaluation:'+JSON.stringify(['2026-01-01','day'].map(x=>({base64:Buffer.from(x).toString('base64'),encoding:'utf-8',type:'text'})));
    manifest.files=[{source:'report.md',snapshot:'report.md',bytes:Buffer.byteLength('# synthetic report\n'),dataset:'synthetic-D1',artifact_key:key,category:'report'}]; manifest.inventory=[]; await writeFile(path,JSON.stringify(manifest));
    const channel=ids.next(),conversation=ids.next(); await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(path),updatedAt:new Date()}); await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const run=async()=>{const result=await fixture.run(['ext','run','garmin','import','--json']); expect(result.code,result.stdout+result.stderr).toBe(0); await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${result.body.data.work_id}'`))[0]?.outcome,{timeout:60000}).toBe('succeeded');};
    await run();
    await expect.poll(async()=> (await fixture.db.rows('select count(*)::int as n from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where r.file_id is null'))[0]?.n,{timeout:20000}).toBe(0);
    const verified = await fixture.run(['ext','run','garmin','import-verify','--json']);
    expect(verified.code,verified.stdout+verified.stderr).toBe(0);
    expect(verified.body.data.report.counts).toMatchObject({artifacts:2,excluded_too_large:1,analysis_rows:1});
    const rows=await fixture.db.rows('select original_table,artifact_key,batch,request_id,analysis_id,exclusion_reason from garmin.artifact_inventory order by original_table');
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({original_table:'artifact',artifact_key:key,exclusion_reason:null}); expect(rows[0]!.request_id).toBeTruthy(); expect(rows[1]).toMatchObject({original_table:'evaluation',artifact_key:key,exclusion_reason:'too_large',request_id:null});
    await run(); expect(await fixture.db.rows('select original_table,artifact_key,batch,request_id,analysis_id,exclusion_reason from garmin.artifact_inventory order by original_table')).toEqual(rows);
    // 0005 이전의 evaluation 제외 행을 재현하고 실제 전환 뒤 같은 capture를 재실행한다.
    await fixture.db.query("insert into garmin.artifact_inventory(dataset,artifact_key,batch,category,content_hash,size_bytes,metadata) select dataset,'legacy-artifact',batch,category,content_hash,size_bytes,metadata from garmin.artifact_inventory where original_table='artifact'; delete from garmin.artifact_inventory where original_table='artifact' and artifact_key <> 'legacy-artifact'; alter table garmin.artifact_inventory drop constraint artifact_inventory_pkey; alter table garmin.artifact_inventory drop constraint artifact_inventory_original_table_check; alter table garmin.artifact_inventory drop column original_table; alter table garmin.artifact_inventory add primary key(dataset,artifact_key)");
    await fixture.db.query(await readFile(new URL('../../../extensions/garmin/migrations/0005_inventory_namespace.sql',import.meta.url),'utf8'));
    expect(await fixture.db.rows("select original_table,artifact_key,batch,request_id,analysis_id,exclusion_reason from garmin.artifact_inventory where original_table='evaluation'")).toEqual([rows[1]]);
    expect(await fixture.db.rows("select original_table,artifact_key,batch from garmin.artifact_inventory where artifact_key='legacy-artifact'")).toEqual([{original_table:'artifact',artifact_key:'legacy-artifact',batch:rows[0]!.batch}]);
    await fixture.db.query("delete from garmin.artifact_inventory where artifact_key='legacy-artifact'");
    await run(); expect(await fixture.db.rows('select original_table,artifact_key,batch,request_id,analysis_id,exclusion_reason from garmin.artifact_inventory order by original_table')).toEqual(rows);
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},120000);
