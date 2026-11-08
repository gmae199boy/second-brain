import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, readFile, writeFile, unlink, copyFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';
import { postgresStore } from 'second_brain/postgres';
import { maskOutputText } from 'second_brain';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

// 공개 응답은 그대로 보존하고, 실제 보고서 경로에만 원본 ID를 사용한다.
function newVerifyWorkId(before: readonly string[], after: readonly string[], publicId: string): string {
  const previous=new Set(before), created=after.filter(id=>!previous.has(id));
  if(created.length!==1) throw new Error(`expected one new garmin.import_verify work item, got ${created.length}`);
  const rawId=created[0]!;
  if(publicId!==maskOutputText(rawId)) throw new Error('public work_id does not match the masked work item ID');
  return rawId;
}
async function runVerify(fixture: Awaited<ReturnType<typeof extHome>>) {
  const ids=async()=> (await fixture.db.rows<{id:string}>("select id::text as id from brain.work_items where kind='garmin.import_verify'")).map(row=>row.id);
  const before=await ids();
  const result=await fixture.run(['ext','run','garmin','import-verify','--json']);
  const rawId=newVerifyWorkId(before,await ids(),result.body.data.work_id);
  return {...result,rawId};
}

it('공개 가림 ID와 실제 보고서 ID를 구별하고 새 작업이 없거나 여럿이면 거부한다', () => {
  const existing='01940000-0000-7000-8000-000000000001';
  const rawId='01940000-4111-7111-8111-1113aaaaaaaa';
  const publicId=maskOutputText(rawId);
  expect(publicId).toContain('[REDACTED:card_number]');
  expect(publicId).not.toBe(rawId);
  expect(newVerifyWorkId([existing],[existing,rawId],publicId)).toBe(rawId);
  expect(join('reports',newVerifyWorkId([existing],[existing,rawId],publicId),'public.json')).toBe(join('reports',rawId,'public.json'));
  expect(()=>newVerifyWorkId([existing],[existing],publicId)).toThrow('got 0');
  expect(()=>newVerifyWorkId([existing],[existing,rawId,'01940000-0000-7000-8000-000000000002'],publicId)).toThrow('got 2');
  expect(()=>newVerifyWorkId([existing],[existing,rawId],rawId)).toThrow('public work_id');
});

const self='01940000-0000-7000-8000-00000000000a';
async function installPreservationAdapter(home:string,store:ReturnType<typeof postgresStore>) {
  const adapter=fileURLToPath(new URL('../../../extensions/garmin/tests/preservation_entry.py',import.meta.url));
  for(const entry of ['import.py','import_verify.py']) await copyFile(adapter,join(home,'extensions/garmin/src',entry));
  await store.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
}

it.each(['file','parent'] as const)('원본 SQLite의 첫 읽기 직전 %s symlink 교체를 거부한다', async boundary => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await installPreservationAdapter(fixture.home,store);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c',"import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import five_candidates,capture_manifest; p=pathlib.Path(sys.argv[2]); capture_manifest(p,five_candidates(p))",fixtures,root]);
    const path=join(root,'manifest.json'), target=await realpath(join(root,'D1.db')), external=join(fixture.home,'external.db'), marker=join(fixture.home,'external-opened'); await copyFile(target,external);
    const captureDir=await realpath(root), externalDir=join(fixture.home,'external-capture'); await cp(root,externalDir,{recursive:true});
    const swapped=boundary==='file'?target:captureDir, swapDestination=boundary==='file'?external:externalDir;
    await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.capture_manifest',value:await realpath(path),updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const imported=await fixture.run(['ext','run','garmin','import','--json']); expect(imported.code,imported.stdout+imported.stderr).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${imported.body.data.work_id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    const script=join(fixture.home,'extensions/garmin/src/import_verify.py');
    let source=await readFile(script,'utf8');
    const instrumentation=`
# 격리 시험 전용: 원본 첫 열기 직전에만 경로를 교체한다.
import pathlib, inspect
_target=${JSON.stringify(swapped)}
_external=${JSON.stringify(swapDestination)}
_boundary=${JSON.stringify(boundary)}
_source=${JSON.stringify(target)}
_marker=${JSON.stringify(marker)}
_done=False
_old_path_open=pathlib.Path.open
_old_os_open=os.open
def _swap(call):
    global _done
    _done=True
    with _old_path_open(pathlib.Path(_marker+'-attempt'),'w') as f: f.write('attempted')
    os.rename(_target,_target+'.held')
    os.symlink(_external,_target)
    try:
        result=call()
        with _old_path_open(pathlib.Path(_marker),'w') as f: f.write('opened')
        return result
    finally:
        os.unlink(_target)
        os.rename(_target+'.held',_target)
def _path_open(self,*a,**kw):
    if not _done and str(self)==_source and any(f.function=='digest_file' for f in inspect.stack()): return _swap(lambda:_old_path_open(self,*a,**kw))
    return _old_path_open(self,*a,**kw)
def _os_open(path,flags,*a,**kw):
    if not _done and str(path)==('D1.db' if _boundary=='file' else 'capture') and any(f.function=='read_source' for f in inspect.stack()) and any(f.function=='compare' for f in inspect.stack()): return _swap(lambda:_old_os_open(path,flags,*a,**kw))
    return _old_os_open(path,flags,*a,**kw)
pathlib.Path.open=_path_open
os.open=_os_open
`;
    const seam='\ntry:\n    main()'; expect(source.split(seam)).toHaveLength(2);
    source=source.replace(seam,instrumentation+seam); expect(source).toContain(instrumentation); await writeFile(script,source);
    const result=await runVerify(fixture);
    expect(result.code,result.stdout+result.stderr).not.toBe(0); expect(result.body.data,result.stdout+result.stderr+JSON.stringify(await fixture.db.rows('select error_code,stderr from brain.work_attempts order by started_at desc limit 1'))).toBeDefined(); expect(result.body.data.report.checks.source_unchanged).toBe(false);
    expect(await readFile(marker+'-attempt','utf8')).toBe('attempted');
    await expect(readFile(marker,'utf8')).rejects.toMatchObject({code:'ENOENT'});
    const publicReport=await readFile(join(fixture.home,'extensions/garmin/reports',result.rawId,'public.json'),'utf8');
    for (const secret of [target,external,'synthetic-D1','2026-01-01','12345']) expect(result.stdout+result.stderr+publicReport).not.toContain(secret);
    expect(JSON.parse(publicReport)).toEqual(result.body.data.report);
    const sourceBytes=await readFile(target); expect(await readFile(external)).toEqual(sourceBytes);
    await writeFile(script,source.replace(instrumentation,''));
    try {
      await writeFile(target,Buffer.alloc(sourceBytes.length));
      const corrupt=await runVerify(fixture);
      expect(corrupt.code).not.toBe(0); expect(corrupt.body.data.report.checks.source_unchanged).toBe(false);
      const report=await readFile(join(fixture.home,'extensions/garmin/reports',corrupt.rawId,'public.json'),'utf8');
      for (const secret of [target,external,'synthetic-D1']) expect(corrupt.stdout+corrupt.stderr+report).not.toContain(secret);
    } finally {await writeFile(target,sourceBytes);}
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},120000);

it('원본·보존 행·mapping·raw·checkpoint·파일 결과 변조를 읽기 전용으로 검출한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await installPreservationAdapter(fixture.home,store);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'),root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c',"import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))",fixtures,root]);
    const channel=ids.next(),conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,(select id from brain.users where is_self=1))`);
    await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.capture_manifest',value:await realpath(join(root,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const unfinished=await runVerify(fixture);
    expect(unfinished.code).not.toBe(0); expect(unfinished.body.data,unfinished.stdout+unfinished.stderr+JSON.stringify(await fixture.db.rows('select error_code,stderr from brain.work_attempts order by started_at desc limit 1'))).toBeDefined(); expect(unfinished.body.data.report.checks.files).toBe(false);
    const imported=await fixture.run(['ext','run','garmin','import','--json']); expect(imported.code,imported.stdout+imported.stderr).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${imported.body.data.work_id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    await expect.poll(async()=> (await fixture.db.rows('select count(*)::int as n from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where r.file_id is null'))[0]?.n,{timeout:20000}).toBe(0);
    const verify=()=>runVerify(fixture);
    const good=await verify(); expect(good.code,good.stdout+good.stderr).toBe(0); expect(Object.values(good.body.data.report.checks).every(Boolean)).toBe(true);
    await fixture.db.query(`create table public.test_preserved as select * from garmin.preserved_rows limit 1;
      create table public.test_mapping as select * from garmin.import_mapping where target_kind='preserved' limit 1;
      create table public.test_extra_mapping as select * from garmin.import_mapping where target_kind='preserved' and original_table='meta' limit 1;
      create table public.test_artifact_mapping as select * from garmin.import_mapping where target_kind='artifact_file' limit 1;
      create table public.test_second_artifact_mapping as select * from garmin.import_mapping where target_kind='artifact_file' and (dataset,original_table,original_key)<>(select dataset,original_table,original_key from public.test_artifact_mapping) limit 1;
      create table public.test_legacy_mapping as select * from garmin.import_mapping where target_kind='legacy' limit 1;
      create table public.test_second_legacy_mapping as select * from garmin.import_mapping where target_kind='legacy' and (dataset,original_table,original_key)<>(select dataset,original_table,original_key from public.test_legacy_mapping) and batch=(select batch from public.test_legacy_mapping) limit 1;
      create table public.test_parentless as select * from garmin.preserved_rows where run_id is null limit 1;
      create table public.test_schema as select * from garmin.source_schemas limit 1;
      create table public.test_legacy_conversation as select * from garmin.legacy_conversations limit 1;
      create table public.test_inventory as select * from garmin.artifact_inventory where original_table='artifact' and artifact_key='report';
      create table public.test_input_inventory as select * from garmin.input_inventory where category='body' and state='present' limit 1;
      create table public.test_relation as select * from garmin.artifact_relations limit 1;
      create table public.test_raw as select * from garmin.raw_payloads limit 1;
      create table public.test_checkpoint as select * from garmin.import_checkpoints limit 1;
      create table public.test_result as select * from brain.file_request_results where file_id is not null limit 1`);
    const raw=(await fixture.db.rows('select endpoint from public.test_raw'))[0]!;
    const endpointUtf16=Buffer.from(String(raw.endpoint),'utf16le').toString('hex');
    const cases=[
      ['preserved',"update garmin.preserved_rows set run_id=(select id from garmin.preserved_rows where original_table='run' limit 1) where id=(select id from public.test_parentless)","update garmin.preserved_rows set run_id=null where id=(select id from public.test_parentless)"],
      ['preserved',"update garmin.preserved_rows set values_json='{}' where id=(select id from public.test_preserved)","update garmin.preserved_rows p set values_json=b.values_json from public.test_preserved b where p.id=b.id"],
      ['mappings',"delete from garmin.import_mapping where (dataset,original_table,original_key,target_kind)=(select dataset,original_table,original_key,target_kind from public.test_mapping)","insert into garmin.import_mapping select * from public.test_mapping"],
      ['files',"insert into garmin.import_mapping select (jsonb_populate_record(null::garmin.import_mapping,to_jsonb(m)||jsonb_build_object('original_key','unexpected-file'))).* from public.test_artifact_mapping m","delete from garmin.import_mapping where target_kind='artifact_file' and original_key='unexpected-file'"],
      ['files',"delete from garmin.import_mapping where (dataset,original_table,original_key,target_kind)=(select dataset,original_table,original_key,target_kind from public.test_artifact_mapping)","insert into garmin.import_mapping select * from public.test_artifact_mapping"],
      ['files',"update garmin.import_mapping set content_hash='tampered' where (dataset,original_table,original_key,target_kind)=(select dataset,original_table,original_key,target_kind from public.test_artifact_mapping)","update garmin.import_mapping m set content_hash=b.content_hash from public.test_artifact_mapping b where (m.dataset,m.original_table,m.original_key,m.target_kind)=(b.dataset,b.original_table,b.original_key,b.target_kind)"],
      ['files',"update garmin.import_mapping set target_id=(select target_id from public.test_artifact_mapping) where (dataset,original_table,original_key,target_kind)=(select dataset,original_table,original_key,target_kind from public.test_second_artifact_mapping)","update garmin.import_mapping m set target_id=b.target_id from public.test_second_artifact_mapping b where (m.dataset,m.original_table,m.original_key,m.target_kind)=(b.dataset,b.original_table,b.original_key,b.target_kind)"],
      ['legacy',"update garmin.import_mapping set target_id=(select target_id from public.test_legacy_mapping) where (dataset,original_table,original_key,target_kind)=(select dataset,original_table,original_key,target_kind from public.test_second_legacy_mapping)","update garmin.import_mapping m set target_id=b.target_id from public.test_second_legacy_mapping b where (m.dataset,m.original_table,m.original_key,m.target_kind)=(b.dataset,b.original_table,b.original_key,b.target_kind)"],
      ['legacy',"insert into garmin.import_mapping select (jsonb_populate_record(null::garmin.import_mapping,to_jsonb(m)||jsonb_build_object('target_kind','legacy','target_id','00000000-0000-4000-8000-000000000098'))).* from public.test_extra_mapping m","delete from garmin.import_mapping where target_kind='legacy' and target_id='00000000-0000-4000-8000-000000000098'"],
      ['legacy',"delete from garmin.import_mapping where (dataset,original_table,original_key,target_kind)=(select dataset,original_table,original_key,target_kind from public.test_legacy_mapping)","insert into garmin.import_mapping select * from public.test_legacy_mapping"],
      ['legacy',"update garmin.legacy_conversations set conversation_id='00000000-0000-4000-8000-000000000099' where (dataset,original_table,original_key)=(select dataset,original_table,original_key from public.test_legacy_conversation)","update garmin.legacy_conversations c set conversation_id=b.conversation_id from public.test_legacy_conversation b where (c.dataset,c.original_table,c.original_key)=(b.dataset,b.original_table,b.original_key)"],
      ['inventory',"update garmin.artifact_inventory set unlinked_reason='changed' where (dataset,original_table,artifact_key)=(select dataset,original_table,artifact_key from public.test_inventory)","update garmin.artifact_inventory i set unlinked_reason=b.unlinked_reason from public.test_inventory b where (i.dataset,i.original_table,i.artifact_key)=(b.dataset,b.original_table,b.artifact_key)"],
      ['inventory',"update garmin.artifact_inventory set metadata='{}'::jsonb where (dataset,original_table,artifact_key)=(select dataset,original_table,artifact_key from public.test_inventory)","update garmin.artifact_inventory i set metadata=b.metadata from public.test_inventory b where (i.dataset,i.original_table,i.artifact_key)=(b.dataset,b.original_table,b.artifact_key)"],
      ['inventory',"update garmin.input_inventory set metadata_raw=decode('00','hex') where (dataset,category)=(select dataset,category from public.test_input_inventory)","update garmin.input_inventory i set metadata_raw=b.metadata_raw from public.test_input_inventory b where (i.dataset,i.category)=(b.dataset,b.category)"],
      ['inventory',"update garmin.artifact_relations set reason='changed' where (dataset,artifact_key,analysis_key,role)=(select dataset,artifact_key,analysis_key,role from public.test_relation)","update garmin.artifact_relations r set reason=b.reason from public.test_relation b where (r.dataset,r.artifact_key,r.analysis_key,r.role)=(b.dataset,b.artifact_key,b.analysis_key,b.role)"],
      ['schemas',"insert into garmin.source_schemas select (jsonb_populate_record(null::garmin.source_schemas,to_jsonb(s)||jsonb_build_object('original_table','unexpected_table'))).* from public.test_schema s","delete from garmin.source_schemas where original_table='unexpected_table'"],
      ['schemas',"update garmin.source_schemas set columns_json='[]'::jsonb where (dataset,original_table)=(select dataset,original_table from public.test_schema)","update garmin.source_schemas s set columns_json=b.columns_json from public.test_schema b where (s.dataset,s.original_table)=(b.dataset,b.original_table)"],
      ['schemas',"update garmin.source_schemas set keys_json='[]'::jsonb where (dataset,original_table)=(select dataset,original_table from public.test_schema)","update garmin.source_schemas s set keys_json=b.keys_json from public.test_schema b where (s.dataset,s.original_table)=(b.dataset,b.original_table)"],
      ['raw',`update garmin.raw_payloads set endpoint_raw=decode('${endpointUtf16}','hex'),endpoint_encoding='utf-16le' where (dataset,raw_identity)=(select dataset,raw_identity from public.test_raw)`,"update garmin.raw_payloads r set endpoint_raw=b.endpoint_raw,endpoint_encoding=b.endpoint_encoding from public.test_raw b where (r.dataset,r.raw_identity)=(b.dataset,b.raw_identity)"],
      ['raw',"update garmin.raw_payloads set body='changed' where (dataset,raw_identity)=(select dataset,raw_identity from public.test_raw)","update garmin.raw_payloads r set body=b.body from public.test_raw b where (r.dataset,r.raw_identity)=(b.dataset,b.raw_identity)"],
      ['checkpoints',"update garmin.import_checkpoints set importer_version=999 where (dataset,batch)=(select dataset,batch from public.test_checkpoint)","update garmin.import_checkpoints c set importer_version=b.importer_version from public.test_checkpoint b where (c.dataset,c.batch)=(b.dataset,b.batch)"],
      ['files',"update brain.file_request_results set file_id=null,error_code='SYNTHETIC' where request_id=(select request_id from public.test_result)","update brain.file_request_results r set file_id=b.file_id,error_code=b.error_code from public.test_result b where r.request_id=b.request_id"],
    ] as const;
    for(const [check,change,restore] of cases) {
      await fixture.db.query(change);
      try {
        const result=await verify(); expect(result.code,check).not.toBe(0); expect(result.body.data.report.checks[check],check).toBe(false);
        const publicText=await readFile(join(fixture.home,'extensions/garmin/reports',result.rawId,'public.json'),'utf8');
        expect(JSON.parse(publicText)).toEqual(result.body.data.report);
        for(const secret of ['synthetic-D1','2026-01-01','12345',fixture.home]) expect(result.stdout+result.stderr+publicText).not.toContain(secret);
      } finally {await fixture.db.query(restore);}
    }
    const artifact=join(root,'report.md'), artifactBytes=await readFile(artifact), altered=Buffer.from(artifactBytes); altered[0]=altered[0]!^1; await writeFile(artifact,altered);
    try {const changed=await verify(); expect(changed.code).not.toBe(0); expect(changed.body.data.report.checks.source_unchanged).toBe(false);} finally {await writeFile(artifact,artifactBytes);}
    const source=join(root,'D1.db'), before=await readFile(source);
    execFileSync(python,['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"update meta set value='changed' where key='timezone'\"); c.commit(); c.close()",source]);
    try {const changed=await verify(); expect(changed.code).not.toBe(0); expect(changed.body.data.report.checks.source_unchanged).toBe(false);} finally {await writeFile(source,before);}
    await writeFile(source,Buffer.alloc(before.length));
    try {const changed=await verify(); expect(changed.code).not.toBe(0); expect(changed.body.data.report.checks.source_unchanged).toBe(false);} finally {await writeFile(source,before);}
    expect((await verify()).code).toBe(0);
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},120000);
