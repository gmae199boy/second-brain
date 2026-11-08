import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { extHome } from '../test/ext-fixture.js';
import { postgresStore } from 'second_brain/postgres';
import { createAbiRun, decodeAbiLine, maskOutputText } from 'second_brain';
import pg from 'pg';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import {createLifecycle, maskedError, onceCleanup, settleCleanup} from './fixtures/artifacts-lifecycle.js';

// Child results settle immediately on both spawn errors and close, and retain
// the full masked streams rather than just the parsed final ABI message.
function observedChild(command:string, args:string[], env:NodeJS.ProcessEnv, mask:(s:string)=>string) {
  const child=spawn(command,args,{env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='', code:string|null=null, stdinCode:string|null=null, closed=false;
  let finalResult:{status:number|null;signal:NodeJS.Signals|null;code:string|null;stdinCode:string|null;stdout:string;stderr:string;output:[null,string,string]} | undefined;
  const recordStdin=(error:NodeJS.ErrnoException)=>{stdinCode=mask(error.code ?? 'ERROR'); if(finalResult) finalResult.stdinCode=stdinCode;};
  child.stdin!.on('error',recordStdin);
  const waiters=new Set<()=>void>();
  child.stdout!.setEncoding('utf8').on('data',chunk=>{stdout+=chunk; for(const wake of waiters) wake();});
  child.stderr!.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});
  child.on('error',error=>{code=(error as NodeJS.ErrnoException).code ?? 'ERROR';});
  const result=new Promise<{status:number|null;signal:NodeJS.Signals|null;code:string|null;stdinCode:string|null;stdout:string;stderr:string;output:[null,string,string]}>(resolve=>{
    child.on('close',(status,signal)=>{closed=true; for(const wake of waiters) wake(); const out=mask(stdout),err=mask(stderr); finalResult={status,signal,code:code===null?null:mask(code),stdinCode,stdout:out,stderr:err,output:[null,out,err]}; resolve(finalResult);});
  });
  async function barrier(marker:string) {
    while(!stdout.includes(marker) && !closed) await new Promise<void>(resolve=>{const wake=()=>{waiters.delete(wake); resolve();}; waiters.add(wake);});
    if(!stdout.includes(marker)) throw Error(JSON.stringify({phase:'barrier',...(await result)}));
  }
  const write=(data:string)=>new Promise<string|null>(resolve=>{try {child.stdin!.write(data,(error)=>{if(error) recordStdin(error); resolve(stdinCode);});} catch(error) {recordStdin(error as NodeJS.ErrnoException); resolve(stdinCode);}});
  return {child,result,barrier,write};
}
function maskChild(secrets:string[]) {
  const values=[...new Set(secrets.filter(Boolean).flatMap(value=>[value,JSON.stringify(value).slice(1,-1),encodeURIComponent(value)]))].sort((a,b)=>b.length-a.length);
  const apply=(text:string)=>maskOutputText(values.reduce((value,secret)=>value.split(secret).join('[REDACTED:fixture]'),text));
  // Only the adapter's fixed diagnostic shape and public phase may bypass
  // substring masking. Other stderr and all stdout follow normal masking.
  const phases=new Set(['settings','connect','initial_check','capture','checkpoint','ingest','publish','locator_acquire','locator_body','locator_unlock','reports','verify_connect','verify_database','verify_compare','verify_reports','unknown']);
  const fields=['kind','phase','sqlstate','body_sqlstate'];
  return (input:string)=>input.split(/(?<=\n)/).map(line=>{
    try {
      const value=JSON.parse(line); const phase=value?.phase;
      if(value?.kind==='preservation_diagnostic' && typeof phase==='string' && phases.has(phase) && Object.keys(value).length===fields.length && fields.every(key=>Object.hasOwn(value,key)) && [value.sqlstate,value.body_sqlstate].every(state=>state===null || typeof state==='string' && /^[A-Za-z0-9]{5}$/.test(state))) {
        const match=/"phase"\s*:\s*"([a-z_]+)"/.exec(line);
        if(match && match[1]===phase) {const start=match.index+match[0].lastIndexOf(phase); return apply(line.slice(0,start))+phase+apply(line.slice(start+phase.length));}
      }
    } catch { /* non-ABI output follows the normal masking path */ }
    return apply(line);
  }).join('');
}
function deferred() { let release!:()=>void; const promise=new Promise<void>(resolve=>{release=resolve;}); return {promise,release}; }

it('자식 관측은 조기 종료와 spawn 오류를 정착하고 출력 문맥을 가린다', async()=>{
  const secret='fixture-secret-opaque'; const mask=maskChild([secret]);
  const text=`line  one ${secret}\n{"extra":"${secret}"}\nTraceback: ${secret}\n`;
  expect(mask(text)).toBe('line  one [REDACTED:fixture]\n{"extra":"[REDACTED:fixture]"}\nTraceback: [REDACTED:fixture]\n');
  const noisy=observedChild(process.execPath,['-e',`process.stdout.write(${JSON.stringify(text)}); process.stderr.write(${JSON.stringify('trace '+secret+'\n')})`],process.env,mask);
  expect(()=>JSON.parse('{\"abi\":1,\"type\":\"result\"} trailing')).toThrow(); expect(JSON.parse('{\"abi\":1,\"type\":\"result\",\"extra\":true}')).not.toEqual({abi:1,type:'result'});
  const noisyResult=await noisy.result; expect(noisyResult.stdout).toBe(mask(text)); expect(noisyResult.stderr).toBe('trace [REDACTED:fixture]\n'); expect(noisyResult.output).toEqual([null,noisyResult.stdout,noisyResult.stderr]);
  const empty=observedChild(process.execPath,['-e',''],process.env,mask);
  await expect(empty.barrier('missing')).rejects.toThrow('barrier'); expect((await empty.result).status).toBe(0);
  const missing=observedChild('/definitely-missing-19-12',[],process.env,mask);
  await expect(missing.barrier('missing')).rejects.toThrow('barrier'); expect((await missing.result).code).toBe('ENOENT');
  const closed=observedChild(process.execPath,['-e',"process.stdout.write('MARKER\\n')"],process.env,mask); await closed.barrier('MARKER\n'); const closedResult=await closed.result; expect(await closed.write('x')).toBeTruthy(); expect(closedResult.stdinCode).toBeTruthy();
  const order:string[]=[]; const primary=new Error('first');
  const combined=await settleCleanup([()=>{order.push('gate'); throw Error('cleanup');},()=>{order.push('child'); throw Error('second cleanup');},()=>{order.push('fixture');}],primary).catch(error=>error);
  expect(combined).toBeInstanceOf(AggregateError); expect(combined.message).toContain('first'); expect(combined.message).toContain('cleanup'); expect(combined.errors).toHaveLength(3);
  expect(order).toEqual(['gate','child','fixture']);
  const details=await settleCleanup([()=>{throw Error('cleanup fixture-secret-opaque');}],new Error('primary fixture-secret-opaque'),mask,()=>noisyResult).catch(error=>error);
  expect(details.message).not.toContain(secret); expect(details.message).toContain('primary'); expect(JSON.parse(details.message).child).toEqual(noisyResult);
  const nested=new AggregateError([new Error('role '+secret),new AggregateError([new Error('home '+secret)],'database '+secret)],'fixture '+secret,{cause:new Error('cause '+secret)});
  (nested.cause as Error & {cause?:unknown}).cause=nested; const preserved=maskedError(nested,mask); const serialized=JSON.stringify(preserved);
  expect(serialized).not.toContain(secret); expect(serialized).toContain('role '); expect(serialized).toContain('database '); expect(serialized).toContain('home '); expect(serialized).toContain('cause '); expect(serialized).toContain('[circular]');
  const nestedCleanup=await settleCleanup([()=>{throw nested;}],undefined,mask).catch(error=>error); const nestedReport=JSON.stringify({message:nestedCleanup.message,errors:nestedCleanup.errors});
  expect(nestedReport).not.toContain(secret); for(const fragment of ['role ','database ','home ','cause ','[circular]']) expect(nestedReport).toContain(fragment);
  expect(JSON.stringify(maskedError(new Error('outer',{cause:{reason:'detail '+secret}}),mask))).toContain('detail [REDACTED:fixture]');
  let calls=0; const simulatedTimeout=onceCleanup(async()=>{calls++;}); await Promise.all([simulatedTimeout(),simulatedTimeout()]); expect(calls).toBe(1);
  const cleanupError=new Error('gate failure'); const after:string[]=[];
  await expect(settleCleanup([()=>{throw cleanupError;},()=>{after.push('store');},()=>{after.push('fixture');}])).rejects.toThrow('gate failure'); expect(after).toEqual(['store','fixture']);
  const url='postgresql://fixture:opaque-pass@example.invalid/db', snapshot='{\"capture\":\"fixture-private\"}', home='/synthetic/home';
  const hide=maskChild([url,'opaque-pass',snapshot,'fixture-private',home]);
  const raw=`diagnostic  ${url}\n{\"snapshot\":${JSON.stringify(snapshot)}}\nTraceback ${home}/input fixture-private\n`;
  const phaseMask=maskChild(['report']); for(const phase of ['reports','verify_reports']) {const diagnostic=JSON.stringify({kind:'preservation_diagnostic',phase,sqlstate:'55P03',body_sqlstate:null}); expect(phaseMask(diagnostic)).toBe(diagnostic);}
  expect(phaseMask('raw report and {\"phase\":\"report-private\"}')).not.toContain('report-private');
  for(const malformed of [
    {kind:'other',phase:'reports',sqlstate:null,body_sqlstate:null},
    {kind:'preservation_diagnostic',phase:'reports',sqlstate:null,body_sqlstate:null,extra:'report'},
    {kind:'preservation_diagnostic',phase:'reports',sqlstate:'report',body_sqlstate:null},
    {abi:1,type:'error',phase:'reports'},
  ]) expect(phaseMask(JSON.stringify(malformed))).not.toContain('reports');
  const sanitized=hide(raw); expect(sanitized).toContain('diagnostic  '); expect(sanitized).toContain('Traceback '); for(const secret of [url,'opaque-pass',snapshot,'fixture-private',home]) expect(sanitized).not.toContain(secret);
});

it('격리 Vitest timeout이 같은 lifecycle 정리와 재개 fence를 실행한다',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'brain-lifecycle-timeout-'));
  let child:ReturnType<typeof observedChild>|undefined;
  try {
    const marker=join(dir,'result.json');
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('VITEST')));
    const cli=fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs',import.meta.url));
    const config=fileURLToPath(new URL('./fixtures/lifecycle-vitest.config.mjs',import.meta.url));
    child=observedChild(process.execPath,[cli,'run','--config',config],{...env,LIFECYCLE_MARKER:marker},maskChild([dir,process.env.HOME ?? '']));
    const result=await child.result;
    expect(result,JSON.stringify(result)).toMatchObject({status:1,signal:null,code:null});
    expect(result.stdout+result.stderr).toMatch(/timed out/i);
    const outcome=JSON.parse(await readFile(marker,'utf8'));
    expect(outcome).toMatchObject({spawned:1,lateSpawns:0,lateOverrides:0,resumed:true,bodySettled:true,childClosed:true,disposed:true,restored:true});
    expect(outcome.cleanupError).toContain('test finished before body settled');
  } finally {
    if(child && child.child.exitCode===null && child.child.signalCode===null){child.child.kill('SIGKILL'); await child.result;}
    await rm(dir,{recursive:true,force:true});
  }
},30000);

// Exercise the historical preservation and artifact primitives inside an isolated installation.
const self='01940000-0000-7000-8000-00000000000a';
async function installPreservationAdapter(home:string, store:ReturnType<typeof postgresStore>) {
  await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/preservation_entry.py',import.meta.url)),join(home,'extensions/garmin/src/import.py'));
  await store.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
}

it('명시 다종 파일과 기존 evaluation을 설치된 감독자가 발행하고 재실행한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await installPreservationAdapter(fixture.home,store);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture');
    await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const channel=ids.next(), conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,(select id from brain.users where is_self=1))`);
    await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.capture_manifest',value:await realpath(join(root,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
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
    const before=await fixture.db.rows('select dataset,original_table,original_key,target_kind,target_id,content_hash from garmin.import_mapping order by dataset,original_table,original_key,target_kind');
    // v12에서 온 장부를 합성한다. 기존 요청과 관계는 새 발행에서도 유지돼야 한다.
    const legacyAnalysis=ids.next();
    await fixture.db.query(`update garmin.artifact_inventory set analysis_id='${legacyAnalysis}' where artifact_key='input'; update garmin.artifact_relations set analysis_id='${legacyAnalysis}',reason='legacy-reason' where analysis_key='input'`);
    const oldInventory=await fixture.db.rows("select request_id,analysis_id,exclusion_reason,unlinked_reason from garmin.artifact_inventory where artifact_key='input'");
    const oldRelation=await fixture.db.rows("select request_id,analysis_id,reason from garmin.artifact_relations where analysis_key='input'");
    expect(oldInventory).toHaveLength(1); expect(oldInventory[0]).toMatchObject({analysis_id:legacyAnalysis}); expect(oldInventory[0]!.request_id).toBeTruthy();
    expect(oldRelation).toHaveLength(1); expect(oldRelation[0]).toMatchObject({analysis_id:legacyAnalysis,reason:'legacy-reason'});
    await run();
    expect(await fixture.db.rows("select request_id,analysis_id,exclusion_reason,unlinked_reason from garmin.artifact_inventory where artifact_key='input'")).toEqual(oldInventory);
    expect(await fixture.db.rows("select request_id,analysis_id,reason from garmin.artifact_relations where analysis_key='input'")).toEqual(oldRelation);
    expect(await fixture.db.rows('select dataset,original_table,original_key,target_kind,target_id,content_hash from garmin.import_mapping order by dataset,original_table,original_key,target_kind')).toEqual(before);
    expect(await fixture.db.rows('select count(*)::int as n from brain.channel_requests')).toEqual([{n:0}]);
    expect((await readFile(join(root,'report.md'),'utf8'))).toBe('# synthetic report\n');
    await writeFile(join(root,'report.md'),'# synthetic reporz\n');
    const conflict=await fixture.run(['ext','run','garmin','import','--json']);
    expect(conflict.code,conflict.stdout+conflict.stderr).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${conflict.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe('failed');
    expect(await fixture.db.rows("select count(*)::int as n from garmin.import_conflicts where reason='artifact_mismatch'")).toEqual([{n:1}]);
    expect(await fixture.db.rows('select dataset,original_table,original_key,target_kind,target_id,content_hash from garmin.import_mapping order by dataset,original_table,original_key,target_kind')).toEqual(before);
  } finally { controller.abort(); if (daemon) await daemon; await store.close(); await fixture.cleanup(); }
}, 90000);

it('checkpoint 뒤 같은 크기로 바뀐 SQLite에서 evaluation을 재독해하지 않는다', async () => {
  const { extensionDatabaseUrl }=await import('../src/config/codec.js');
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), ids=uuidV7IdGen();
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await installPreservationAdapter(fixture.home,store);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const source=join(root,'D1.db'), before=await readFile(source), beforeHash=createHash('sha256').update(before).digest('hex');
    const channel=ids.next(),conversation=ids.next(),work=ids.next(),token=ids.next(),now=new Date();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,(select id from brain.users where is_self=1))`);
    await store.addWork({id:work,kind:'garmin.import',targetKind:'import',targetId:'snapshot-barrier',createdAt:now,nextAttemptAt:now});
    expect(await store.claimSupervisedWork({now,claimedBy:'snapshot-barrier',kinds:['garmin.import'],attemptToken:token})).toMatchObject({ok:true});
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl), home=await realpath(join(fixture.home,'extensions/garmin'));
    // ingest가 보존 checkpoint를 커밋하고 검증된 객체를 반환한 직후 같은 크기의 값을 교체한다.
    const script=`import sys,sqlite3\nsys.path.insert(0,sys.argv[1])\nimport batch_import\noriginal=batch_import.ingest\ndef intercepted(conn,capture,entry,conversation,**kwargs):\n result=original(conn,capture,entry,conversation,**kwargs)\n if entry['dataset']=='synthetic-D1':\n  print('SNAPSHOT_BARRIER',flush=True)\n  with sqlite3.connect(sys.argv[2]) as db: db.execute('update evaluation set summary=?',('가성\\0기록',))\n return result\nbatch_import.ingest=intercepted\nimport runpy\nrunpy.run_path(sys.argv[1]+'/import.py',run_name='__main__')`;
    const result=execFileSync(python,['-c',script,join(home,'src'),source],{encoding:'utf8',env:{...process.env,BRAIN_DATABASE_URL:url,BRAIN_USER_ID:self,BRAIN_WORK_ID:work,BRAIN_ATTEMPT_TOKEN:token,BRAIN_EXTENSION_HOME:home,BRAIN_SECRET_SCANNER_NODE:process.execPath,BRAIN_SECRET_SCANNER_SCRIPT:fileURLToPath(new URL('../dist/workers/secret-scan.js',import.meta.url)),BRAIN_SETTINGS_SNAPSHOT:JSON.stringify({version:1,extension:'garmin',user_id:'01940000-0000-7000-8000-00000000000a',values:{'garmin.timezone':'Asia/Seoul','garmin.capture_manifest':await realpath(join(root,'manifest.json')),'garmin.legacy_conversation_id':conversation}})}});
    expect(result).toContain('SNAPSHOT_BARRIER'); expect(result).toContain('"type": "result"');
    const after=await readFile(source); expect(after.length).toBe(before.length); expect(createHash('sha256').update(after).digest('hex')).not.toBe(beforeHash);
    expect(await fixture.db.rows("select source_hash from garmin.import_checkpoints where dataset='synthetic-D1'")).toEqual([{source_hash:beforeHash}]);
    const preserved=await fixture.db.rows("select values_json->'summary' as summary from garmin.preserved_rows where dataset='synthetic-D1' and original_table='evaluation'");
    expect(preserved).toEqual([{summary:{type:'text',encoding:'utf-8',base64:Buffer.from('합성\0기록').toString('base64')}}]);
    expect(await fixture.db.rows("select count(*)::int as n from garmin.import_mapping where dataset='synthetic-D1' and original_table='evaluation' and target_kind='artifact_file'")).toEqual([{n:1}]);
  } finally {await store.close(); await fixture.cleanup();}
},90000);

it('NUL metadata를 원형으로 재개하고 참조 없는 파일의 미연결 사유를 기록한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await installPreservationAdapter(fixture.home,store);
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
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,(select id from brain.users where is_self=1))`);
    await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.capture_manifest',value:await realpath(manifestPath),updatedAt:new Date()});
    await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
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
    expect(await fixture.db.rows("select dataset_label from garmin.datasets where dataset_label is not null")).toEqual([{dataset_label:'synthetic�D1'}]);
    const normal=await fixture.db.rows("select metadata,metadata_raw is null as ordinary from garmin.input_inventory where category='profile' and state='empty'");
    expect(normal).toEqual([{metadata:{fields:{},source_files:[]},ordinary:true}]);
    expect((await fixture.db.rows("select metadata_raw is not null as preserved from garmin.artifact_inventory where metadata_raw is not null and category='report'"))).toEqual([{preserved:true}]);
    const unlinked=await fixture.db.rows("select artifact_key,request_id,unlinked_reason from garmin.artifact_inventory where artifact_key in ('orphan_input','orphan_png') order by artifact_key");
    expect(unlinked).toEqual([{artifact_key:'orphan_input',request_id:expect.any(String),unlinked_reason:'no_analysis_reference'},{artifact_key:'orphan_png',request_id:expect.any(String),unlinked_reason:'no_analysis_reference'}]);
    expect(await fixture.db.rows("select count(*)::int as n from garmin.artifact_relations where artifact_key in ('orphan_input','orphan_png')")).toEqual([{n:0}]);
    expect(publicReport.counts.unlinked).toBe(4); // 분석 미이관으로 명시 참조도 미해결로 보존한다.
    await expect.poll(async()=> (await fixture.db.rows("select count(*)::int as n from garmin.artifact_inventory i join brain.file_request_results r on r.request_id=i.request_id where i.artifact_key in ('orphan_input','orphan_png') and r.file_id is not null"))[0]?.n,{timeout:20000}).toBe(2);
    const before=await fixture.db.rows("select artifact_key,request_id,analysis_id,unlinked_reason from garmin.artifact_inventory order by artifact_key");
    const second=await run();
    expect(await fixture.db.rows("select artifact_key,request_id,analysis_id,unlinked_reason from garmin.artifact_inventory order by artifact_key")).toEqual(before);
    const repeated=JSON.parse(await readFile(join(fixture.home,'extensions/garmin/reports',second,'public.json'),'utf8')); expect(repeated.counts.unlinked).toBe(4);
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},90000);

it('같은 key와 bytes의 artifact 정리 뒤 evaluation은 별도 locator로 재개한다', async () => {
  const { extensionDatabaseUrl }=await import('../src/config/codec.js');
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), ids=uuidV7IdGen(), controller=new AbortController();
  let daemon: ReturnType<typeof runDaemon> | undefined, child: ChildProcess | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await installPreservationAdapter(fixture.home,store);
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
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,(select id from brain.users where is_self=1))`);
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl), settings=JSON.stringify({version:1,extension:'garmin',user_id:'01940000-0000-7000-8000-00000000000a',values:{'garmin.timezone':'Asia/Seoul','garmin.capture_manifest':await realpath(manifestPath),'garmin.legacy_conversation_id':conversation}});
    const claim=async(target:string)=>{
      const id=ids.next(),token=ids.next(),now=new Date();
      expect(await store.addWork({id,kind:'garmin.import',targetKind:'import',targetId:target,createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});
      expect(await store.claimSupervisedWork({now,claimedBy:target,kinds:['garmin.import'],attemptToken:token})).toMatchObject({ok:true,item:{id},attemptToken:token});
      return {id,token};
    };
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{disabled:true}});
    const first=await claim('locator-first');
    const env={...process.env,BRAIN_DATABASE_URL:url,BRAIN_USER_ID:self,BRAIN_WORK_ID:first.id,BRAIN_ATTEMPT_TOKEN:first.token,BRAIN_EXTENSION_HOME:home,BRAIN_SETTINGS_SNAPSHOT:settings};
    const script=`import sys\nsys.path.insert(0,sys.argv[1])\nimport artifact_publish,batch_import\noriginal=artifact_publish.stage\ndef stage(home,dataset,table,key,data):\n if table=='evaluation':\n  print('EVALUATION_BARRIER',flush=True)\n  sys.stdin.read(1)\n return original(home,dataset,table,key,data)\nartifact_publish.stage=stage\nimport runpy\nrunpy.run_path(sys.argv[1]+'/import.py',run_name='__main__')`;
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
    const before=await fixture.db.rows("select dataset,original_table,original_key,target_id from garmin.import_mapping where target_kind='artifact_file' order by dataset,original_table,original_key");
    const third=await claim('locator-third');
    const replay=execFileSync(python,[join(home,'src/import.py')],{encoding:'utf8',env:{...env,BRAIN_WORK_ID:third.id,BRAIN_ATTEMPT_TOKEN:third.token}});
    expect(JSON.parse(replay)).toMatchObject({type:'result'});
    expect(await fixture.db.rows("select dataset,original_table,original_key,target_id from garmin.import_mapping where target_kind='artifact_file' order by dataset,original_table,original_key")).toEqual(before);
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
    await installPreservationAdapter(fixture.home,store);
      const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
      const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
      execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
      const path=join(root,'manifest.json'), manifest=JSON.parse(await readFile(path,'utf8'));
      expect(Buffer.byteLength(initial)).toBe(Buffer.byteLength(changed));
      await writeFile(join(root,'case.log'),initial);
      manifest.files=[{source:'case.log',snapshot:'case.log',bytes:Buffer.byteLength(initial),dataset:'synthetic-D1',artifact_key:'case',category:'log'}]; manifest.inventory=[];
      await writeFile(path,JSON.stringify(manifest));
      const channel=ids.next(),conversation=ids.next();
      await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,(select id from brain.users where is_self=1))`);
      await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.capture_manifest',value:await realpath(path),updatedAt:new Date()});
      await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
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
        fixture.db.rows('select id from brain.files order by id')]);
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
    await installPreservationAdapter(fixture.home,store);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const path=join(root,'manifest.json'), manifest=JSON.parse(await readFile(path,'utf8'));
    manifest.files=manifest.files.filter((x:any)=>x.artifact_key==='report'); manifest.inventory=[]; await writeFile(path,JSON.stringify(manifest));
    const channel=ids.next(),conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,(select id from brain.users where is_self=1))`);
    await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.capture_manifest',value:await realpath(path),updatedAt:new Date()});
    await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    await fixture.db.query("create function garmin.test_inventory_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic barrier'; end $$; create trigger test_inventory_failure before insert on garmin.artifact_inventory for each row execute function garmin.test_inventory_failure()");
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const run=async(outcome:string)=>{const result=await fixture.run(['ext','run','garmin','import','--json']); expect(result.code,result.stdout+result.stderr).toBe(0); await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${result.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe(outcome);};
    await run('failed');
    expect(await fixture.db.rows("select count(*)::int as n from garmin.artifact_inventory where artifact_key='report'")).toEqual([{n:0}]);
    expect(await fixture.db.rows("select count(*)::int as n from garmin.import_mapping where original_table='artifact' and original_key='report'")).toEqual([{n:0}]);
    expect(await fixture.db.rows("select count(*)::int as n from brain.file_requests where request_key::jsonb->>2='report'")).toEqual([{n:0}]);
    await fixture.db.query('drop trigger test_inventory_failure on garmin.artifact_inventory; drop function garmin.test_inventory_failure()');
    await run('succeeded');
    expect(await fixture.db.rows("select count(*)::int as n from garmin.artifact_inventory i join brain.file_requests q on q.id=i.request_id where i.artifact_key='report'")).toEqual([{n:1}]);
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},90000);

it('상한 초과 파일의 동일 크기 변경을 원문 해시로 충돌 처리한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await installPreservationAdapter(fixture.home,store);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const path=join(root,'manifest.json'), manifest=JSON.parse(await readFile(path,'utf8')), bytes=Buffer.alloc(32*1024*1024+1,0x61);
    await writeFile(join(root,'large.md'),bytes);
    manifest.files=[{source:'large.md',snapshot:'large.md',bytes:bytes.length,dataset:'synthetic-D1',artifact_key:'large',category:'report'}]; manifest.inventory=[]; await writeFile(path,JSON.stringify(manifest));
    const channel=ids.next(),conversation=ids.next(); await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,(select id from brain.users where is_self=1))`);
    await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.capture_manifest',value:await realpath(path),updatedAt:new Date()}); await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
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
  let daemon: ReturnType<typeof runDaemon> | undefined, active: ReturnType<typeof observedChild> | undefined;
  const allowUnlock=deferred(), unlockCalled=deferred(), unlockFinished=deferred();
  const originalQuery=pg.Client.prototype.query;
  let called=false, sent=false, completed=false, unlocked=false, unlockError:string|null=null;
  let maskFailure=(value:string)=>maskOutputText(value), lastChild:unknown;
  const lifecycle=createLifecycle({
    interrupt:[()=>allowUnlock.release(), async()=>{if(active){if(active.child.exitCode===null && active.child.signalCode===null) active.child.kill('SIGKILL'); lastChild=await active.result;}}, ()=>controller.abort()],
    dispose:[async()=>{if(daemon) await daemon;},()=>{pg.Client.prototype.query=originalQuery;},()=>store.close(),()=>fixture.cleanup()],
    mask:value=>maskFailure(value), diagnostic:()=>lastChild,
  });
  onTestFinished(lifecycle.finish);
  const guarded=<T extends object>(target:T):T=>new Proxy(target,{get(object,key,receiver){const value=Reflect.get(object,key,receiver); return typeof value==='function' ? (...args:unknown[])=>{lifecycle.check(); return value.apply(object,args);} : value;}});
  const db=guarded(fixture.db), checkedStore=guarded(store);
  await lifecycle.run(async()=>{
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    lifecycle.check(); await installPreservationAdapter(fixture.home,checkedStore);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), home=await realpath(join(fixture.home,'extensions/garmin')), root=join(fixture.home,'capture'); lifecycle.check(); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    lifecycle.check(); execFileSync(python,['-c','import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))',fixtures,root]);
    const path=join(root,'manifest.json'), manifest=JSON.parse(await readFile(path,'utf8')); manifest.files=manifest.files.filter((x:any)=>x.artifact_key==='report'); manifest.inventory=[]; lifecycle.check(); await writeFile(path,JSON.stringify(manifest));
    const channel=ids.next(),conversation=ids.next(); await db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,(select id from brain.users where is_self=1))`);
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl), settings=JSON.stringify({version:1,extension:'garmin',user_id:self,values:{'garmin.timezone':'Asia/Seoul','garmin.capture_manifest':await realpath(path),'garmin.legacy_conversation_id':conversation}});
    const privateStrings=(value:unknown):string[]=>typeof value==='string' ? (value.length>=4?[value]:[]) : Array.isArray(value) ? value.flatMap(privateStrings) : value && typeof value==='object' ? Object.values(value).flatMap(privateStrings) : [];
    const mask=maskChild([url,fixture.db.appUrl,fixture.db.url,decodeURIComponent(new URL(url).password),settings,JSON.stringify(manifest),...privateStrings(manifest),...privateStrings(JSON.parse(settings)),fixture.home,home,root,'# synthetic report\n',process.env.HOME ?? '']);
    maskFailure=mask;
    const claim=async(target:string)=>{const id=ids.next(),token=ids.next(),now=new Date(); expect(await checkedStore.addWork({id,kind:'garmin.import',targetKind:'import',targetId:target,createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true}); expect(await checkedStore.claimSupervisedWork({now,claimedBy:target,kinds:['garmin.import'],attemptToken:token})).toMatchObject({ok:true,item:{id},attemptToken:token}); return {id,token};};
    const base={...process.env,BRAIN_DATABASE_URL:url,BRAIN_USER_ID:self,BRAIN_EXTENSION_HOME:home,BRAIN_SETTINGS_SNAPSHOT:settings};
    const env=(attempt:{id:string;token:string}, name='')=>{const u=new URL(url); if(name) u.searchParams.set('application_name',name); return {...base,BRAIN_DATABASE_URL:u.toString(),BRAIN_WORK_ID:attempt.id,BRAIN_ATTEMPT_TOKEN:attempt.token};};
    const run=async(attempt:{id:string;token:string},script?:string)=>{lifecycle.check(); const proc=observedChild(python,script?['-c',script,join(home,'src')]:[join(home,'src/import.py')],env(attempt),mask); active=proc; const result=await proc.result; active=undefined; return result;};
    const assertAdapterError=(result:Awaited<ReturnType<typeof observedChild>['result']>,code:string,retryable:boolean,phase:string,sqlstate:string|null,bodySqlstate:string|null=null)=>{
      expect(result,JSON.stringify(result)).toMatchObject({status:1,signal:null,code:null,stdinCode:null});
      expect(result.output).toEqual([null,result.stdout,result.stderr]);
      expect(result.stdout.split('\n')).toHaveLength(2); expect(result.stderr.split('\n')).toHaveLength(2);
      const event={abi:1,type:'error',code,retryable};
      expect(JSON.parse(result.stdout)).toEqual(event);
      expect(decodeAbiLine(result.stdout.trimEnd())).toEqual({ok:true,event});
      const consumer=createAbiRun(); consumer.feed(result.stdout); consumer.end();
      expect(consumer.violation).toBeUndefined(); expect(consumer.workerError).toBe(true);
      expect(consumer.verdict({code:result.status,signal:result.signal})).toEqual({outcome:'failed',code,retryable,usage:null});
      expect(JSON.parse(result.stderr)).toEqual({kind:'preservation_diagnostic',phase,sqlstate,body_sqlstate:bodySqlstate});
    };
    const first=await claim('lock-first'), firstResult=await run(first); expect(firstResult,JSON.stringify(firstResult)).toMatchObject({status:0,signal:null,code:null}); expect(JSON.parse(firstResult.stdout)).toEqual({abi:1,type:'result'});
    expect(await checkedStore.finishSupervisedWork({id:first.id,attemptToken:first.token,now:new Date(),outcome:'succeeded'})).toMatchObject({ok:true});
    const request=(await db.rows("select id,locator from brain.file_requests where request_key::jsonb->>2='report'"))[0]!;
    const second=await claim('lock-second');
    const secondScript=`import sys\nsys.path.insert(0,sys.argv[1])\nimport artifact_publish\noriginal=artifact_publish.stage\ndef stage(*args):\n if args[2]=='artifact':\n  print('STAGING_BARRIER',flush=True)\n  if sys.stdin.read(1) != 'x': raise RuntimeError('barrier not released')\n return original(*args)\nartifact_publish.stage=stage\nimport runpy\nrunpy.run_path(sys.argv[1]+'/import.py',run_name='__main__')`;
    lifecycle.check(); const secondChild=observedChild(python,['-c',secondScript,join(home,'src')],env(second,'artifact-second'),mask); active=secondChild; await secondChild.barrier('STAGING_BARRIER\n');
    const dbName=new URL(fixture.db.appUrl).pathname.slice(1);
    // Restrict interception to the fixture database, dedicated application name,
    // and this exact unlock query. The original query has not been called yet.
    lifecycle.check(); (pg.Client.prototype as any).query=function(this:any,...args:any[]) {
      if(this.connectionParameters.database===dbName && this.connectionParameters.application_name==='artifact-cleanup' && typeof args[0]==='string' && args[0].includes('pg_advisory_unlock(hashtextextended') && Array.isArray(args[1]) && args[1].includes(request.locator) && args[1].includes('garmin')) {
        called=true; unlockCalled.release();
        return allowUnlock.promise.then(()=>{sent=true; return (originalQuery as any).apply(this,args);}).then((result:any)=>{completed=true; unlocked=result.rows?.[0]?.pg_advisory_unlock===true; unlockFinished.release(); return result;},(error:unknown)=>{const code=(error as NodeJS.ErrnoException)?.code; unlockError=typeof code==='string' && /^[A-Z0-9]{5}$/.test(code)?code:'UNKNOWN'; unlockFinished.release(); throw error;});
      }
      return (originalQuery as any).apply(this,args);
    };
    lifecycle.check(); daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{disabled:true},createStore:options=>{lifecycle.check(); return postgresStore({...options,applicationName:'artifact-cleanup'});}});
    await expect.poll(async()=> (await db.rows(`select count(*)::int as n from brain.file_import_cleanup where request_id='${request.id}' and cleaned_at is null`))[0]?.n,{timeout:20000}).toBe(1);
    await expect.poll(async()=> (await db.rows(`select count(*)::int as n from pg_stat_activity a join pg_stat_activity b on b.pid=any(pg_blocking_pids(a.pid)) where a.application_name='artifact-cleanup' and b.application_name='artifact-second'`))[0]?.n,{timeout:20000}).toBe(1);
    expect(await readFile(join(home,'staging',String(request.locator)))).toEqual(Buffer.from('# synthetic report\n'));
    lifecycle.check(); const stdinError=await secondChild.write('x'); if(stdinError) throw Error(JSON.stringify({phase:'stdin',...(await secondChild.result)}));
    const secondResult=await secondChild.result; active=undefined; expect(secondResult,JSON.stringify(secondResult)).toMatchObject({status:0,signal:null,code:null,stdinCode:null}); expect(JSON.parse(secondResult.stdout.replace(/^STAGING_BARRIER\r?\n/,''))).toEqual({abi:1,type:'result'});
    expect(await checkedStore.finishSupervisedWork({id:second.id,attemptToken:second.token,now:new Date(),outcome:'succeeded'})).toMatchObject({ok:true});
    await expect.poll(()=>called,{timeout:20000}).toBe(true); await unlockCalled.promise;
    expect({sent,completed}).toEqual({sent:false,completed:false});
    expect((await db.rows(`select cleaned_at from brain.file_import_cleanup where request_id='${request.id}'`))[0]?.cleaned_at).toBeTruthy();
    const lockSql=`with target as (select hashtextextended(jsonb_build_array(source::text,locator::text)::text,10) as k from brain.file_requests where id='${request.id}') select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid=l.pid cross join target t where a.application_name='artifact-cleanup' and l.locktype='advisory' and l.granted and l.classid=((t.k >> 32) & 4294967295)::oid and l.objid=(t.k & 4294967295)::oid and l.objsubid=1`;
    expect(await db.rows(lockSql)).toEqual([{n:1}]);
    await expect(readFile(join(home,'staging',String(request.locator)))).rejects.toMatchObject({code:'ENOENT'});
    const fingerprint=(rows:unknown)=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const requests=async()=>fingerprint(await db.rows("select * from brain.file_requests where request_key::jsonb->>2='report'"));
    const mappings=async()=>fingerprint(await db.rows('select * from garmin.import_mapping order by dataset,original_table,original_key,target_kind'));
    const beforeRequests=await requests(), beforeMappings=await mappings();
    const third=await claim('lock-third');
    expect({sent,completed}).toEqual({sent:false,completed:false}); expect(await db.rows(lockSql)).toEqual([{n:1}]);
    // The real entry starts while unlock is queued in this event loop. A sync
    // child blocks the microtask and hits the existing PostgreSQL lock timeout.
    lifecycle.check(); queueMicrotask(allowUnlock.release);
    lifecycle.check(); const thirdChild=observedChild(python,[join(home,'src/import.py')],env(third,'artifact-third'),mask); active=thirdChild;
    const thirdResult=await thirdChild.result; active=undefined;
    await unlockFinished.promise; expect({sent,completed,unlocked,unlockError}).toEqual({sent:true,completed:true,unlocked:true,unlockError:null}); expect(await db.rows(lockSql)).toEqual([{n:0}]);
    expect(thirdResult,JSON.stringify(thirdResult)).toMatchObject({status:0,signal:null,code:null,stdinCode:null}); expect(JSON.parse(thirdResult.stdout)).toEqual({abi:1,type:'result'});
    expect(await checkedStore.finishSupervisedWork({id:third.id,attemptToken:third.token,now:new Date(),outcome:'succeeded'})).toMatchObject({ok:true});
    const stale=await run(third); expect(stale.status,JSON.stringify(stale)).not.toBe(0); expect(stale.stdout).toContain('"type": "error"');
    expect(await requests()).toBe(beforeRequests);
    expect(await mappings()).toBe(beforeMappings);
    await expect(readFile(join(home,'staging',String(request.locator)))).rejects.toMatchObject({code:'ENOENT'});
    // Inject only at the test adapter's locator boundary; the real work claim,
    // importer and existing locator context still run.
    for(const mode of ['acquire','body','unlock','both'] as const) {
      const attempt=await claim(`fault-${mode}`);
      const faultScript=`import sys,runpy,psycopg\nfrom contextlib import contextmanager\nsys.path.insert(0,sys.argv[1])\nimport artifact_publish,batch_import\nmode=${JSON.stringify(mode)}\noriginal=artifact_publish.locator_lock\ncheck=batch_import.check\ninside=False\ndef checked(cur):\n if inside and mode in ('body','both'): raise psycopg.errors.LockNotAvailable('secret fixture body')\n return check(cur)\nbatch_import.check=checked\n@contextmanager\ndef faulty(conn,locator):\n global inside\n if mode=='acquire': raise psycopg.errors.LockNotAvailable('secret fixture acquire')\n with original(conn,locator):\n  inside=True\n  try: yield\n  finally:\n   inside=False\n   if mode in ('unlock','both'): raise psycopg.errors.QueryCanceled('secret fixture unlock')\nartifact_publish.locator_lock=faulty\nrunpy.run_path(sys.argv[1]+'/import.py',run_name='__main__')`;
      const fault=await run(attempt,faultScript); expect(fault.status,JSON.stringify(fault)).toBe(1);
      assertAdapterError(fault,'IMPORT_INVALID',true,mode==='acquire'?'locator_acquire':mode==='body'?'locator_body':'locator_unlock',mode==='unlock'||mode==='both'?'57014':'55P03',mode==='both'?'55P03':null);
      expect(fault.stdout+fault.stderr).not.toContain('secret fixture');
      expect(await checkedStore.finishSupervisedWork({id:attempt.id,attemptToken:attempt.token,now:new Date(),outcome:'failed'})).toMatchObject({ok:true});
    }
    lifecycle.check(); const verifyFile=join(home,'src/import_verify.py'); await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/preservation_entry.py',import.meta.url)),verifyFile);
    for(const mode of ['connect','database','compare','reports'] as const) {
      const attempt=await claim(`verify-${mode}`);
      const verifyScript=`import sys,runpy,psycopg\nsys.path.insert(0,sys.argv[1])\nimport batch_import,verify_compare,reports\nmode=${JSON.stringify(mode)}\ndef fail(*args,**kwargs): raise psycopg.errors.LockNotAvailable('private verify')\nif mode=='connect': psycopg.connect=fail\nif mode=='database': batch_import.check=fail\nif mode=='compare': verify_compare.compare=fail\nif mode=='reports': reports.write_reports=fail\nrunpy.run_path(sys.argv[1]+'/import_verify.py',run_name='__main__')`;
      const verify=await run(attempt,verifyScript); expect(verify.status,JSON.stringify(verify)).toBe(1);
      assertAdapterError(verify,'IMPORT_INVALID',true,`verify_${mode}`,'55P03'); expect(verify.stdout+verify.stderr).not.toContain('private verify');
      expect(await checkedStore.finishSupervisedWork({id:attempt.id,attemptToken:attempt.token,now:new Date(),outcome:'failed'})).toMatchObject({ok:true});
    }
    const reportAttempt=await claim('import-reports');
    const reportScript=`import sys,runpy,psycopg\nsys.path.insert(0,sys.argv[1])\nimport reports\ndef fail(*args,**kwargs): raise psycopg.errors.LockNotAvailable('private report')\nreports.write_reports=fail\nrunpy.run_path(sys.argv[1]+'/import.py',run_name='__main__')`;
    const reportFailure=await run(reportAttempt,reportScript); expect(reportFailure.status,JSON.stringify(reportFailure)).toBe(1);
    assertAdapterError(reportFailure,'IMPORT_INVALID',true,'reports','55P03'); expect(reportFailure.stdout+reportFailure.stderr).not.toContain('private report');
    expect(await checkedStore.finishSupervisedWork({id:reportAttempt.id,attemptToken:reportAttempt.token,now:new Date(),outcome:'failed'})).toMatchObject({ok:true});
    const conflictAttempt=await claim('import-conflict-abi');
    const conflictScript=`import sys,runpy\nsys.path.insert(0,sys.argv[1])\nimport reports\ndef fail(*args,**kwargs): raise ValueError('IMPORT_CONFLICT')\nreports.write_reports=fail\nrunpy.run_path(sys.argv[1]+'/import.py',run_name='__main__')`;
    const conflict=await run(conflictAttempt,conflictScript);
    assertAdapterError(conflict,'IMPORT_CONFLICT',false,'reports',null);
    expect(await checkedStore.finishSupervisedWork({id:conflictAttempt.id,attemptToken:conflictAttempt.token,now:new Date(),outcome:'failed'})).toMatchObject({ok:true});
    // A real verifier run writes its report and raises the report-not-ready
    // error; the process ABI consumer must retain that specific verdict.
    const notReadyAttempt=await claim('verify-report-not-ready');
    const notReadyScript=`import sys,runpy\nsys.path.insert(0,sys.argv[1])\nimport verify_compare\noriginal=verify_compare.public_projection\ndef projection(details):\n public=original(details)\n public['checks']['preserved']=False\n return public\nverify_compare.public_projection=projection\nrunpy.run_path(sys.argv[1]+'/import_verify.py',run_name='__main__')`;
    const notReady=await run(notReadyAttempt,notReadyScript);
    assertAdapterError(notReady,'EXTENSION_REPORT_NOT_READY',false,'verify_reports',null);
    expect(JSON.parse(await readFile(join(home,'reports',notReadyAttempt.id,'public.json'),'utf8')).checks.preserved).toBe(false);
    expect(await checkedStore.finishSupervisedWork({id:notReadyAttempt.id,attemptToken:notReadyAttempt.token,now:new Date(),outcome:'failed'})).toMatchObject({ok:true});
  });
  await lifecycle.finish();
},90000);

it('같은 inventory 키의 artifact와 대형 evaluation을 원본 표별로 보존하고 재개한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await installPreservationAdapter(fixture.home,store);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c',"import sys,pathlib,sqlite3; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; p=pathlib.Path(sys.argv[2]); artifact_capture(p); c=sqlite3.connect(p/'D1.db'); c.execute('update evaluation set report_md=?',('x'*(32*1024*1024+1),)); c.commit(); c.close()",fixtures,root]);
    const path=join(root,'manifest.json'), manifest=JSON.parse(await readFile(path,'utf8'));
    // SQLite 원문 키는 반입기가 사용하는 정렬된 바이트 표현이다.
    const key='evaluation:'+JSON.stringify(['2026-01-01','day'].map(x=>({base64:Buffer.from(x).toString('base64'),encoding:'utf-8',type:'text'})));
    manifest.files=[{source:'report.md',snapshot:'report.md',bytes:Buffer.byteLength('# synthetic report\n'),dataset:'synthetic-D1',artifact_key:key,category:'report'}]; manifest.inventory=[]; await writeFile(path,JSON.stringify(manifest));
    const channel=ids.next(),conversation=ids.next(); await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,(select id from brain.users where is_self=1))`);
    await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.capture_manifest',value:await realpath(path),updatedAt:new Date()}); await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const run=async()=>{const result=await fixture.run(['ext','run','garmin','import','--json']); expect(result.code,result.stdout+result.stderr).toBe(0); await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${result.body.data.work_id}'`))[0]?.outcome,{timeout:60000}).toBe('succeeded');};
    await run();
    await expect.poll(async()=> (await fixture.db.rows('select count(*)::int as n from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where r.file_id is null'))[0]?.n,{timeout:20000}).toBe(0);
    // Run the preservation verifier under a distinct, claimed extension work kind.
    // The production import-verify entry remains native and is not replaced.
    const {extensionDatabaseUrl}=await import('../src/config/codec.js');
    const {spawnSync}=await import('node:child_process');
    const home=await realpath(join(fixture.home,'extensions/garmin'));
    const verifyDir=join(home,'src/test-preservation'); await mkdir(verifyDir);
    const verifyEntry=join(verifyDir,'import_verify.py');
    await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/preservation_entry.py',import.meta.url)),verifyEntry);
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl);
    await fixture.db.query("insert into brain.extension_work_kinds(extension_name,kind) values ('garmin','garmin.test_preservation_verify')");
    const verify=async()=>{
      const id=ids.next(),token=ids.next(),now=new Date();
      expect(await store.addWork({id,kind:'garmin.test_preservation_verify',targetKind:'import',targetId:id,createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});
      expect(await store.claimSupervisedWork({now,claimedBy:'preservation-verify',kinds:['garmin.test_preservation_verify'],attemptToken:token})).toMatchObject({ok:true,item:{id},attemptToken:token});
      const result=spawnSync(python,[verifyEntry],{encoding:'utf8',env:{...process.env,PYTHONPATH:join(home,'src'),BRAIN_USER_ID:self,BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:id,BRAIN_ATTEMPT_TOKEN:token,BRAIN_EXTENSION_HOME:home,BRAIN_SETTINGS_SNAPSHOT:JSON.stringify({version:1,extension:'garmin',user_id:self,values:{'garmin.timezone':'Asia/Seoul','garmin.capture_manifest':await realpath(path),'garmin.legacy_conversation_id':conversation}})}});
      const report=JSON.parse(await readFile(join(home,'reports',id,'public.json'),'utf8'));
      expect(await store.finishSupervisedWork({id,attemptToken:token,now:new Date(),outcome:result.status===0?'succeeded':'failed'})).toMatchObject({ok:true});
      return {code:result.status,stdout:result.stdout,stderr:result.stderr,body:{data:{work_id:id,report}}};
    };
    const verified = await verify();
    expect(verified.code,verified.stdout+verified.stderr).toBe(0);
    expect(verified.body.data.report.checks.files).toBe(true);
    const rows=await fixture.db.rows('select original_table,artifact_key,batch,request_id,analysis_id,exclusion_reason from garmin.artifact_inventory order by original_table');
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({original_table:'artifact',artifact_key:key,exclusion_reason:null}); expect(rows[0]!.request_id).toBeTruthy(); expect(rows[1]).toMatchObject({original_table:'evaluation',artifact_key:key,exclusion_reason:'too_large',request_id:null});
    for (const [field, value] of [['metadata_raw', "convert_to('evaluation-secret-raw','UTF8')"], ['unlinked_reason', "'evaluation-secret-reason'"]] as const) {
      await fixture.db.query(`update garmin.artifact_inventory set ${field}=${value} where original_table='evaluation'`);
      try {
        const before=await fixture.db.rows("select encode(metadata_raw,'hex') as raw,unlinked_reason from garmin.artifact_inventory where original_table='evaluation'"); expect(before).toHaveLength(1);
        const result=await verify();
        expect(result.code,field).not.toBe(0); expect(result.body.data.report.checks.inventory,field).toBe(false);
        expect(await fixture.db.rows("select encode(metadata_raw,'hex') as raw,unlinked_reason from garmin.artifact_inventory where original_table='evaluation'")).toEqual(before);
        const publicReport=await readFile(join(fixture.home,'extensions/garmin/reports',result.body.data.work_id,'public.json'),'utf8');
        for (const secret of ['synthetic-D1','2026-01-01','evaluation-secret']) expect(result.stdout+result.stderr+publicReport).not.toContain(secret);
        expect(JSON.parse(publicReport)).toEqual(result.body.data.report);
      } finally {await fixture.db.query(`update garmin.artifact_inventory set ${field}=null where original_table='evaluation'`);}
    }
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
