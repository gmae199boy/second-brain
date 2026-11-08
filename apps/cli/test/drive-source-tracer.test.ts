import {mkdtemp,mkdir,readdir,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {createIsolatedTestDatabase} from '@second-brain/test-db';
import {createBrain,cleanupSourceTemps,type BrainDependencies} from 'second_brain';
import {sequenceIdGen} from 'second_brain/testing';
import {EXPECTED_SCHEMA_VERSIONS,postgresStore,type PostgresStore} from 'second_brain/postgres';
import {brainDependencies} from '../src/assembly.js';
import {readConfig} from '../src/config/codec.js';
import {commands} from '../src/commands/index.js';
import {dispatch,type DispatchRuntime} from '../src/dispatch.js';
import {sourceDrive} from '../src/runtime/source-drive.js';
import {sourceTemp} from '../src/runtime/source-temp.js';
import {fakeDrive,fakeClock} from './fixtures/fake-drive.js';
import {pgHome,pgRunner} from './pg-home.js';
const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'brain-source-tracer-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));const home=join(root,'home'),tempRoot=join(root,'source-temp');await mkdir(home,{recursive:true});
  const db=await pgHome(home,true,createIsolatedTestDatabase);cleanup.push(()=>db.drop());const server=await fakeDrive();cleanup.push(()=>server.close());
  const clock=fakeClock('2026-01-01T00:00:00Z'),ids=sequenceIdGen({timestampMs:clock.now().getTime(),start:2000});const store=postgresStore({databaseUrl:db.appUrl});cleanup.push(()=>store.close());
  const sourceId=ids.next();expect(await store.ensureSource({id:sourceId,kind:'drive',account:'synthetic',rootId:'root'})).toMatchObject({ok:true});
  const temp=sourceTemp(tempRoot),remote=sourceDrive({baseUrl:server.baseUrl});
  const sourceSyncFactory:NonNullable<DispatchRuntime['sourceSyncFactory']>=s=>({store:s as PostgresStore,remote,temp});
  const env={HOME:home,SECOND_BRAIN_HOME:home,BRAIN_DATABASE_URL:db.appUrl,CLAUDE_CONFIG_DIR:join(home,'claude-config'),PATH:process.env.PATH,TMPDIR:root};const config=await readConfig(home);
  const assemble=(inputEnv:NodeJS.ProcessEnv)=>brainDependencies({home,env:inputEnv,config,store,clock,idGen:ids,schemaVersions:EXPECTED_SCHEMA_VERSIONS,workHandlers:{},sourceSyncFactory});
  const dependencies=assemble(env);
  const brain=createBrain(dependencies);
  async function cli(args:string[]){let stdout='',stderr='';const code=await dispatch(commands,args,{env,clock,idGen:ids,runner:pgRunner,sourceSyncFactory,stdout:s=>{stdout+=s;},stderr:s=>{stderr+=s;}});return {code,stdout,stderr,body:stdout?JSON.parse(stdout):null};}
  return {root,home,tempRoot,db,server,clock,ids,store,sourceId,brain,cli,temp,dependencies,env,assemble};
}
function seed(server:Awaited<ReturnType<typeof fakeDrive>>){
  const add=(id:string,name:string,mimeType:string,body:string,parents=['root'],size?:number)=>server.files.set(id,{id,name,mimeType,version:'1',bytes:Buffer.from(body),parents,...(size===undefined?{}:{size})});
  add('text','합성문서.txt','text/plain','공통검색 텍스트');add('markdown','합성기록.md','text/markdown','공통검색 마크다운');add('docs','합성문서','application/vnd.google-apps.document','공통검색 문서');add('photo','합성사진.jpg','image/jpeg','image');add('large','합성대형.txt','text/plain','x',['root'],60_000_000);add('folder','하위','application/vnd.google-apps.folder','');add('nested','하위문서.txt','text/plain','공통검색 하위',['folder']);
}
it('fixture drain은 process HOME의 합성 transcript를 수집하지 않는다', async()=>{
  const ambient=await mkdtemp(join(tmpdir(),'brain-drive-ambient-'));
  cleanup.push(()=>rm(ambient,{recursive:true,force:true}));
  const projects=join(ambient,'.claude','projects','synthetic');
  await mkdir(projects,{recursive:true});
  const session='4f1e7a90-1c2b-4d3e-8f55-000000000000';
  await writeFile(join(projects,`${session}.jsonl`),JSON.stringify({type:'user',sessionId:session,uuid:'00000000-0000-4000-8000-000000000003',timestamp:'2026-01-02T03:04:05.000Z',message:{role:'user',content:'synthetic input'}})+'\n');
  const previousHome=process.env.HOME;
  const f=await fixture();
  expect(process.env.HOME).toBe(previousHome);
  process.env.HOME=ambient;
  try {
    expect(homedir()).toBe(ambient);
    const isolatedBrain=createBrain(f.assemble(f.env));
    const isolated=await isolatedBrain.queue.drain({budgetMs:60000});
    expect(isolated).toMatchObject({stopped:'empty',failed:0,spoolFailed:0,enqueued:0});
    expect(isolated.scanStopped).toBeUndefined();
    expect(await f.db.rows("select kind from brain.work_items where kind='session_ingest'")).toEqual([]);
    // Reassemble with the same environment except the fixture's config override.
    const {CLAUDE_CONFIG_DIR: _fixtureConfig,...fallbackEnv}=f.env;
    const control=createBrain(f.assemble(fallbackEnv));
    const scanned=await control.queue.drain({budgetMs:60000});
    expect(scanned).toMatchObject({stopped:'empty',failed:0,spoolFailed:0,enqueued:1});
    expect(scanned.scanStopped).toBeUndefined();
    expect(await f.db.rows("select kind from brain.work_items where kind='session_ingest'")).toEqual([{kind:'session_ingest'}]);
  } finally {
    if(previousHome===undefined) delete process.env.HOME; else process.env.HOME=previousHome;
  }
});

it('CLI/SDK sync to two-character docs and show across pages with zero photo and large downloads',async()=>{
 const f=await fixture();seed(f.server);const guide=await f.cli(['guide','schema','sources','sync','--json']);expect(guide.body).toMatchObject({ok:true,data:{commands:[{ns:'sources',verb:'sync',required:['sourceId']}]}});const sync=await f.cli(['sources','sync',f.sourceId,'--json']);expect(sync.code,sync.stderr).toBe(0);expect(sync.body).toMatchObject({ok:true,data:{source_id:f.sourceId}});
 const calls=f.server.requests.map(r=>r.path);expect(calls[0]).toContain('startPageToken');expect(calls.filter(x=>x.startsWith('/drive/v3/files?')).length).toBeGreaterThanOrEqual(4);expect(calls.some(x=>x.includes('/photo?alt=media')||x.includes('/large?alt=media'))).toBe(false);expect(calls.some(x=>x.includes('/docs/export'))).toBe(true);
 for(const path of ['/text?alt=media','/markdown?alt=media','/nested?alt=media','/docs/export'])expect(calls.filter(x=>x.includes(path))).toHaveLength(1);
 const found=await f.cli(['recall','docs','검색','--limit','30','--json']);expect(found.code).toBe(0);const rows=found.body.data as {source_file_id:string;file_id:string;chunk_locator:string;source_url:string}[];expect(rows).toHaveLength(4);expect(rows.every(row=>row.source_url.startsWith('https://drive.google.com/file/d/'))).toBe(true);
 for(const row of rows){const show=await f.cli(['files','show',row.file_id,'--source-file-id',row.source_file_id,'--chunk-locator',row.chunk_locator,'--json']);expect(show.body).toMatchObject({ok:true,meta:{source_file:{source_file_id:row.source_file_id}}});}
 for(const [query,status] of [['사진','photo'],['대형','too_large']] as const){const foundName=await f.cli(['recall','docs',query,'--json']);expect(foundName.body.data[0]).toMatchObject({file_id:null,chunk_locator:null,index_status:status});const shown=await f.cli(['files','show','--source-file-id',foundName.body.data[0].source_file_id,'--json']);expect(shown.body).toMatchObject({ok:true,meta:{source_file:{file_id:null,index_status:status}}});}
 const before=await f.db.rows('select (select count(*) from brain.source_files)::int as sources,(select count(*) from brain.files)::int as files,(select count(*) from brain.document_chunks)::int as chunks');const again=await f.brain.sources.sync({sourceId:f.sourceId});expect(again.ok).toBe(true);expect(await f.db.rows('select (select count(*) from brain.source_files)::int as sources,(select count(*) from brain.files)::int as files,(select count(*) from brain.document_chunks)::int as chunks')).toEqual(before);
 expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);expect(await readdir(join(f.home,'files')).catch(()=>[])).toEqual([]);
},120000);
it('remote deletion preserves chunks and another source, then redaction hides all provenance',async()=>{
 const f=await fixture();seed(f.server);f.server.files.set('copy',{id:'copy',name:'다른사본.txt',mimeType:'text/plain',version:'1',parents:['root'],bytes:Buffer.from('공통검색 텍스트')});expect((await f.cli(['sources','sync',f.sourceId,'--json'])).code).toBe(0);
 const before=await f.db.rows<{id:string;file_id:string}>("select id,file_id from brain.source_files where remote_id='text'");const target=before[0]!;const chunks=await f.db.rows(`select count(*)::int as n from brain.document_chunks where extraction_id=(select current_extraction_id from brain.files where id='${target.file_id}')`);
 f.server.files.delete('text');expect((await f.cli(['sources','sync',f.sourceId,'--json'])).code).toBe(0);expect(await f.db.rows(`select unreachable from brain.source_files where id='${target.id}'`)).toEqual([{unreachable:true}]);expect(await f.db.rows(`select source_unreachable_at from brain.files where id='${target.file_id}'`)).toEqual([{source_unreachable_at:null}]);expect(await f.db.rows(`select count(*)::int as n from brain.document_chunks where extraction_id=(select current_extraction_id from brain.files where id='${target.file_id}')`)).toEqual(chunks);
 const found=await f.cli(['recall','docs','검색','--limit','30','--json']);expect(found.body.data).toEqual(expect.arrayContaining([expect.objectContaining({source_file_id:target.id,source_unreachable:true,warning:'FILE_SOURCE_UNREACHABLE'}),expect.objectContaining({source_unreachable:false,file_id:target.file_id})]));
 expect((await f.cli(['files','redact',target.file_id,'--yes','--json'])).code).toBe(0);expect((await f.cli(['sources','sync',f.sourceId,'--json'])).code).toBe(0);const after=await f.cli(['recall','docs','사본','--json']);expect(JSON.stringify(after.body)).not.toContain('다른사본');const show=await f.cli(['files','show','--source-file-id',target.id,'--json']);expect(show.body.ok).toBe(false);expect(show.stdout).not.toContain('remote');expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);
},120000);
it('killed temporary writer preserves an open extraction and removes only owned closed bytes after restart',async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath,pathToFileURL}=await import('node:url');const f=await fixture();seed(f.server);expect((await f.cli(['sources','sync',f.sourceId,'--json'])).code).toBe(0);
 const target=(await f.db.rows<{id:string;file_id:string;remote_version:string}>("select id,file_id,remote_version from brain.source_files where remote_id='text'"))[0]!;const workId=f.ids.next(),key=f.ids.next(),generation=f.ids.next(),now=f.clock.now();
 expect(await f.store.addWork({id:workId,kind:'document_extract',targetKind:'file',targetId:target.file_id,createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});
 await f.db.query(`update brain.source_handoffs set work_id='${workId}' where source_file_id='${target.id}'`);
 const held=await f.store.claimWork({now,kinds:['document_extract'],claimedBy:'crash-fixture'});if(!held.ok||!held.item||!held.item.claimedAt||!held.item.claimedBy)throw Error('claim missing');const claim={workId:held.item.id,claimedBy:held.item.claimedBy,claimedAt:held.item.claimedAt,attempts:held.item.attempts,now};
 expect(await f.store.beginExtraction({id:generation,fileId:target.file_id,extractorVersion:'crash-fixture',startedAt:now,claim:{workItemId:workId,claimedBy:claim.claimedBy}})).toMatchObject({ok:true});expect(await f.store.bindSourceAttempt({sourceFileId:target.id,fileId:target.file_id,remoteVersion:target.remote_version,tempKey:key,extractionId:generation,claim})).toMatchObject({ok:true});
 await mkdir(f.tempRoot,{recursive:true,mode:0o700});await writeFile(join(f.tempRoot,'unrelated-owner'),'untouched');
 const moduleUrl=pathToFileURL(fileURLToPath(new URL('../dist/runtime/source-temp.js',import.meta.url))).href, script=`const {sourceTemp}=await import(process.argv[1]);const result=await sourceTemp(process.argv[2]).write(process.argv[3],new TextEncoder().encode('synthetic crash bytes'));if(!result.ok)process.exit(2);process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,moduleUrl,f.tempRoot,key],{stdio:['ignore','pipe','pipe']});
 try{const output=await new Promise<Buffer>((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('writer exited before ready')));});expect(String(output)).toContain('ready');const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;
  await cleanupSourceTemps(f.temp,f.store);expect(await f.temp.read(key,100)).toMatchObject({ok:true});expect(await readdir(f.tempRoot)).toContain('unrelated-owner');
  expect(await f.store.finishExtraction({extractionId:generation,finishedAt:now,outcome:{status:'failed',failedStage:'read',error:'synthetic crash',mediaType:null}})).toMatchObject({ok:true});expect(await f.store.completeWork({id:workId,claimedBy:claim.claimedBy,now})).toMatchObject({ok:true,outcome:'done'});await cleanupSourceTemps(f.temp,f.store);expect(await f.temp.read(key,100)).toMatchObject({ok:false});expect(await readdir(f.tempRoot)).toEqual(['unrelated-owner']);expect(await readdir(join(f.home,'files')).catch(()=>[])).toEqual([]);
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
},120000);
it('temporary remote failure leaves existing source records reachable and reports incomplete sync',async()=>{
 const f=await fixture();seed(f.server);expect((await f.cli(['sources','sync',f.sourceId,'--json'])).code).toBe(0);const before=await f.db.rows('select id,unreachable,completed_version,completed_hash from brain.source_files order by id');
 const config=await readConfig(f.home),env={HOME:f.home,SECOND_BRAIN_HOME:f.home,BRAIN_DATABASE_URL:f.db.appUrl,CLAUDE_CONFIG_DIR:join(f.home,'claude-config'),PATH:process.env.PATH,TMPDIR:f.root};const remote=sourceDrive({baseUrl:f.server.baseUrl});const failed={...remote,async list(){return {ok:false as const,code:'TEMPORARY' as const,message:'synthetic outage'};}};
 const brain=createBrain(brainDependencies({home:f.home,env,config,store:f.store,clock:f.clock,idGen:f.ids,schemaVersions:EXPECTED_SCHEMA_VERSIONS,workHandlers:{},sourceSyncFactory:s=>({store:s as PostgresStore,remote:failed,temp:f.temp})}));
 expect(await brain.sources.sync({sourceId:f.sourceId})).toMatchObject({ok:false,code:'SOURCE_SYNC_INCOMPLETE'});expect(await f.db.rows('select id,unreachable,completed_version,completed_hash from brain.source_files order by id')).toEqual(before);
});

it('source sync ignores unrelated failed work and due backlog',async()=>{
 const f=await fixture();const unrelatedSource=f.ids.next(),otherSync=f.ids.next(),attachment=f.ids.next(),failed=f.ids.next(),now=f.clock.now();
 await f.store.ensureSource({id:unrelatedSource,kind:'drive',account:'other',rootId:'other-root'});
 for(const [id,kind,targetKind,targetId] of [[otherSync,'source_sync','source',unrelatedSource],[attachment,'document_extract','file',f.ids.next()],[failed,'document_extract','file',f.ids.next()]] as const)expect(await f.store.addWork({id,kind,targetKind,targetId,createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});
 await f.db.query(`update brain.work_items set completed_at='2026-01-01Z',outcome='failed' where id='${failed}'`);
 expect(await f.brain.sources.sync({sourceId:f.sourceId})).toMatchObject({ok:true});
 expect(await f.db.rows(`select id::text,attempts,completed_at from brain.work_items where id in ('${otherSync}','${attachment}') order by id`)).toEqual(expect.arrayContaining([expect.objectContaining({id:otherSync,attempts:0,completed_at:null}),expect.objectContaining({id:attachment,attempts:0,completed_at:null})]));
});

it('future handoff backoff remains incomplete when a later sync has zero due extraction work',async()=>{
 const f=await fixture();f.server.files.set('one',{id:'one',name:'one.txt',mimeType:'text/plain',version:'1',bytes:Buffer.from('synthetic body'),parents:['root']});
 expect(await f.brain.sources.sync({sourceId:f.sourceId})).toMatchObject({ok:true});
 const row=(await f.db.rows<{id:string;work_id:string}>("select sf.id,h.work_id from brain.source_files sf join brain.source_handoffs h on h.source_file_id=sf.id where sf.remote_id='one'"))[0]!;
 await f.db.query(`update brain.source_files set index_status='pending',completed_version=null,completed_hash=null where id='${row.id}'; update brain.work_items set completed_at=null,outcome=null,next_attempt_at='2026-01-01T01:00:00Z' where id='${row.work_id}'`);
 const result=await f.brain.sources.sync({sourceId:f.sourceId});expect(result).toMatchObject({ok:false,code:'SOURCE_SYNC_INCOMPLETE'});
 expect(await f.db.rows(`select completed_at,next_attempt_at from brain.work_items where id='${row.work_id}'`)).toMatchObject([{completed_at:null}]);
 const sync=(await f.db.rows<{id:string}>(`select id from brain.work_items where kind='source_sync' and target_id='${f.sourceId}' order by created_at desc,id desc limit 1`))[0]!;
 expect(await f.store.readSourceWorkStatus({sourceId:f.sourceId,syncWorkId:sync.id})).toMatchObject({ok:true,complete:false});
 expect(await f.store.hasDueSourceWork({sourceId:f.sourceId,syncWorkId:sync.id,now:f.clock.now()})).toEqual({ok:true,due:false});
 expect(await f.store.claimSourceWork({sourceId:f.sourceId,syncWorkId:sync.id,now:f.clock.now(),claimedBy:'probe'})).toEqual({ok:true,item:null});
 await f.db.query(`update brain.work_items set claimed_by='other-worker',claimed_at='2026-01-01Z',claim_expires_at='2026-01-01T00:10:00Z' where id='${row.work_id}'`);
 expect(await f.store.readSourceWorkStatus({sourceId:f.sourceId,syncWorkId:sync.id})).toMatchObject({ok:true,complete:false});
 await f.db.query(`update brain.work_items set completed_at='2026-01-01Z',outcome='failed',claimed_by=null,claimed_at=null,claim_expires_at=null where id='${row.work_id}'`);
 expect(await f.store.readSourceWorkStatus({sourceId:f.sourceId,syncWorkId:sync.id})).toMatchObject({ok:true,complete:false});
});

it('indexes a nine million byte Docs export and rejects a streamed export over ten million bytes',async()=>{
 const f=await fixture();const body=Buffer.alloc(9_000_000,32),head=Buffer.from('시작표식 합성본문'),tail=Buffer.from('끝쪽표식 합성본문');head.copy(body,0);tail.copy(body,body.length-tail.length);expect(body.length).toBe(9_000_000);f.server.files.set('nine',{id:'nine',name:'nine',mimeType:'application/vnd.google-apps.document',version:'1',bytes:body,parents:['root']});f.server.files.set('over',{id:'over',name:'over',mimeType:'application/vnd.google-apps.document',version:'1',size:1,bytes:Buffer.alloc(10_000_001,32),parents:['root']});
 expect(await f.brain.sources.sync({sourceId:f.sourceId})).toMatchObject({ok:true});
 const rows=await f.db.rows<{remote_id:string;index_status:string;completed_version:string|null}>("select remote_id,index_status,completed_version from brain.source_files order by remote_id");expect(rows).toEqual([{remote_id:'nine',index_status:'indexed',completed_version:'1'},{remote_id:'over',index_status:'too_large',completed_version:null}]);
 const chunks=await f.db.rows<{body:string}>("select c.body from brain.source_files sf join brain.files f on f.id=sf.file_id join brain.document_chunks c on c.extraction_id=f.current_extraction_id where sf.remote_id='nine' order by c.ordinal");expect(chunks.some(c=>c.body.includes('시작표식'))).toBe(true);expect(chunks.some(c=>c.body.includes('끝쪽표식'))).toBe(true);
 for(const marker of ['시작표식','끝쪽표식']){const query=marker.slice(0,2),found=await f.cli(['recall','docs',query,'--json']);expect(found.code).toBe(0);const row=found.body.data.find((r:{body:string})=>r.body.includes(marker));expect(row).toMatchObject({body:expect.stringContaining(marker),source_url:'https://drive.google.com/file/d/nine/view'});const show=await f.cli(['files','show',row.file_id,'--source-file-id',row.source_file_id,'--chunk-locator',row.chunk_locator,'--json']);expect(show.body).toMatchObject({ok:true,data:expect.arrayContaining([expect.objectContaining({body:expect.stringContaining(marker)})])});}
 for(const path of ['/nine/export','/over/export'])expect(f.server.requests.filter(r=>r.path.includes(path))).toHaveLength(1);expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);expect(await readdir(join(f.home,'files')).catch(()=>[])).toEqual([]);
},120000);

for (const boundary of ['sync-write','extract-read'] as const) it(`SIGKILL at actual ${boundary} handler boundary preserves live ownership and permits recovery`,async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const f=await fixture();
 f.server.files.set('crash',{id:'crash',name:'crash.txt',mimeType:'text/plain',version:'1',bytes:Buffer.from('합성 중단 복구 본문'),parents:['root']});
 await mkdir(f.tempRoot,{recursive:true,mode:0o700});await writeFile(join(f.tempRoot,'unrelated-owner'),'untouched');
 const script=`
 const {createBrain}=await import('second_brain');const {postgresStore,EXPECTED_SCHEMA_VERSIONS}=await import('second_brain/postgres');
 const {v7}=await import('uuid');const {brainDependencies}=await import('./dist/assembly.js');const {readConfig}=await import('./dist/config/codec.js');
 const {sourceDrive}=await import('./dist/runtime/source-drive.js');const {sourceTemp}=await import('./dist/runtime/source-temp.js');
 const [home,url,base,root,sourceId,boundary]=process.argv.slice(1);const store=postgresStore({databaseUrl:url});const raw=sourceTemp(root);
 const barrier=async key=>{process.stdout.write('BARRIER '+key+'\\n');await new Promise(()=>{});};
 const temp={...raw,async write(key,bytes){const result=await raw.write(key,bytes);if(result.ok&&boundary==='sync-write')await barrier(key);return result;},async read(key,max){if(boundary==='extract-read')await barrier(key);return raw.read(key,max);}};
 const env={HOME:home,SECOND_BRAIN_HOME:home,BRAIN_DATABASE_URL:url,CLAUDE_CONFIG_DIR:home+'/claude-config',PATH:process.env.PATH};const clock={now:()=>new Date('2026-01-01T00:00:00Z')};
 const brain=createBrain(brainDependencies({home,env,config:await readConfig(home),store,clock,idGen:{next:()=>v7()},schemaVersions:EXPECTED_SCHEMA_VERSIONS,workHandlers:{},sourceSyncFactory:s=>({store:s,remote:sourceDrive({baseUrl:base}),temp})}));
 await brain.sources.sync({sourceId});process.exit(3);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,f.home,f.db.appUrl,f.server.baseUrl,f.tempRoot,f.sourceId,boundary],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',chunk=>{errors+=String(chunk);});
 try {const line=await new Promise<string>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('handler barrier timeout: '+errors)),30000);child.stdout.on('data',chunk=>{output+=String(chunk);const match=output.match(/BARRIER ([0-9a-f-]{36})/);if(match){clearTimeout(timer);resolve(match[1]!);}});child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('handler exited before barrier: '+errors));});});
  expect(await f.temp.read(line,1024)).toMatchObject({ok:true});const binding=await f.store.readSourceAttempt(line);expect(binding).toMatchObject({ok:true,binding:{open:true}});
  const exited=new Promise<NodeJS.Signals|null>(resolve=>child.once('exit',(_code,signal)=>resolve(signal)));child.kill('SIGKILL');expect(await exited).toBe('SIGKILL');
  await cleanupSourceTemps(f.temp,f.store,f.clock);if(boundary==='extract-read')expect(await f.temp.read(line,1024)).toMatchObject({ok:true});expect(await readdir(f.tempRoot)).toContain('unrelated-owner');
  f.clock.set('2026-01-01T00:11:00Z');await cleanupSourceTemps(f.temp,f.store,f.clock);if(boundary==='sync-write')expect(await f.temp.read(line,1024)).toMatchObject({ok:false});else expect(await f.temp.read(line,1024)).toMatchObject({ok:true});
  const resumed=await f.brain.sources.sync({sourceId:f.sourceId});expect(resumed).toMatchObject({ok:true});
  expect(await f.db.rows("select index_status,completed_version from brain.source_files where remote_id='crash'")).toEqual([{index_status:'indexed',completed_version:'1'}]);expect(await readdir(f.tempRoot)).toEqual(['unrelated-owner']);expect(await readdir(join(f.home,'files')).catch(()=>[])).toEqual([]);
 }finally{if(child.exitCode===null&&child.signalCode===null){const stopped=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await stopped;}}
},120000);

it('preserved body identifies its completed version after newer metadata fails',async()=>{
 const f=await fixture();f.server.files.set('versioned',{id:'versioned',name:'기존.txt',mimeType:'text/plain',version:'1',bytes:Buffer.from('이전 본문 검색'),parents:['root']});
 expect(await f.brain.sources.sync({sourceId:f.sourceId})).toMatchObject({ok:true});
 await f.db.query("update brain.source_files set remote_version='2',name='새이름.txt',index_status='failed' where remote_id='versioned'");
 const found=await f.cli(['recall','docs','검색','--json']);const row=found.body.data[0];expect(row).toMatchObject({display_name:'새이름.txt',current_version:'2',completed_version:'1',stale:true,body:expect.stringContaining('이전 본문')});
 const show=await f.cli(['files','show',row.file_id,'--source-file-id',row.source_file_id,'--chunk-locator',row.chunk_locator,'--json']);expect(show.body).toMatchObject({ok:true,meta:{source_file:{current_version:'2',completed_version:'1',stale:true}},data:[{body:expect.stringContaining('이전 본문')}]});
 const name=await f.cli(['recall','docs','새이름','--json']);expect(name.body.data[0]).toMatchObject({current_version:'2',completed_version:'1',stale:true});
});

it('disconnect during an actual HTTP download cancels the claim and refuses the late handoff',async()=>{
 const f=await fixture();f.server.files.set('held',{id:'held',name:'대기문서.txt',mimeType:'text/plain',version:'1',parents:['root'],bytes:Buffer.from('합성 대기 본문')});
 const gate=f.server.holdNextDownload(),pending=f.brain.sources.sync({sourceId:f.sourceId});
 try {
  await gate.entered;const claimed=(await f.db.rows<{id:string;claimed_by:string}>(`select id::text,claimed_by from brain.work_items where kind='source_sync' and target_id='${f.sourceId}' and completed_at is null`))[0]!;expect(claimed.claimed_by).toBeTruthy();
  expect(await f.store.disconnectSource({id:f.sourceId,now:f.clock.now()})).toMatchObject({ok:true,source:{connected:false}});gate.release();expect(await pending).toMatchObject({ok:false});
  expect(await f.db.rows('select * from brain.source_handoffs')).toEqual([]);expect(await f.store.retryWork({id:claimed.id,claimedBy:claimed.claimed_by,nextAttemptAt:f.clock.now(),lastError:'synthetic'})).toMatchObject({ok:true,outcome:'lost'});
  expect(await f.db.rows(`select outcome,completed_at from brain.work_items where id='${claimed.id}'`)).toMatchObject([{outcome:'cancelled',completed_at:expect.anything()}]);expect(f.server.requests.some(r=>r.method==='DELETE')).toBe(false);
 } finally {gate.release();await pending;}
},120000);

it('disconnect warns only its source while a shared source and search survive, then redaction hides both',async()=>{
 const f=await fixture();f.server.files.set('shared',{id:'shared',name:'공유합성.txt',mimeType:'text/plain',version:'1',parents:['root'],bytes:Buffer.from('공유본문검색 합성자료')});
 const second=f.ids.next();await f.store.ensureSource({id:second,kind:'drive',account:'other-synthetic',rootId:'root'});
 expect(await f.brain.sources.sync({sourceId:f.sourceId})).toMatchObject({ok:true});expect(await f.brain.sources.sync({sourceId:second})).toMatchObject({ok:true});
 const entries=await f.db.rows<{id:string;source_id:string;file_id:string}>(`select id::text,source_id::text,file_id::text from brain.source_files where remote_id='shared' order by source_id`);expect(entries).toHaveLength(2);expect(entries[0]!.file_id).toBe(entries[1]!.file_id);
 const gone=entries.find(e=>e.source_id===f.sourceId)!,live=entries.find(e=>e.source_id===second)!,file=gone.file_id;const before=await f.db.rows(`select current_extraction_id from brain.files where id='${file}'`);const chunks=await f.db.rows(`select id,body from brain.document_chunks where extraction_id=(select current_extraction_id from brain.files where id='${file}') order by ordinal`);
 expect(await f.store.disconnectSource({id:f.sourceId,now:f.clock.now()})).toMatchObject({ok:true});expect(await f.db.rows(`select source_unreachable_at,current_extraction_id from brain.files where id='${file}'`)).toMatchObject([{source_unreachable_at:null,current_extraction_id:before[0]!.current_extraction_id}]);expect(await f.db.rows(`select id,body from brain.document_chunks where extraction_id=(select current_extraction_id from brain.files where id='${file}') order by ordinal`)).toEqual(chunks);
 const recall=await f.cli(['recall','docs','본문검색','--limit','30','--json']);expect(recall.body.data).toEqual(expect.arrayContaining([expect.objectContaining({source_file_id:gone.id,source_unreachable:true,warning:'FILE_SOURCE_UNREACHABLE'}),expect.objectContaining({source_file_id:live.id,source_unreachable:false})]));
 const goneShow=await f.cli(['files','show','--source-file-id',gone.id,'--json']);const liveShow=await f.cli(['files','show','--source-file-id',live.id,'--json']);expect(goneShow.body.meta.source_file).toMatchObject({source_unreachable:true,warning:'FILE_SOURCE_UNREACHABLE'});expect(liveShow.body.meta.source_file).toMatchObject({source_unreachable:false});
 expect((await f.cli(['files','redact',file,'--yes','--json'])).code).toBe(0);expect(JSON.stringify((await f.cli(['recall','docs','공유합성','--json'])).body)).not.toContain('공유합성');expect((await f.cli(['files','show','--source-file-id',live.id,'--json'])).body.ok).toBe(false);expect(f.server.requests.some(r=>r.method==='DELETE')).toBe(false);
},120000);

it.each(['DB_UNAVAILABLE','DB_LOCKED'] as const)('returns an extraction attempt on guarded %s and preserves the current extraction',async code=>{
 const f=await fixture();f.server.files.set('guarded',{id:'guarded',name:'guarded.txt',mimeType:'text/plain',version:'1',bytes:Buffer.from('기존 합성 본문'),parents:['root']});
 expect(await f.brain.sources.sync({sourceId:f.sourceId})).toMatchObject({ok:true});
 const rows=await f.db.rows<{id:string;file_id:string;current_extraction_id:string}>("select sf.id, sf.file_id, f.current_extraction_id from brain.source_files sf join brain.files f on f.id=sf.file_id where sf.remote_id='guarded'");const target=rows[0]!;expect(target.current_extraction_id).toBeTruthy();
 await f.db.query("insert into brain.settings(user_id,key,value,updated_at) select id,'drive.account_id','synthetic','2026-01-01Z' from brain.users where is_self=1");
 const {createDriveRuntime}=await import('../src/runtime/drive-runtime.js');let fail=false,calls=0,guardFailures=0;const original=f.store.listSources.bind(f.store);const wrapped=new Proxy(f.store,{get(target,key,receiver){if(key==='listSources')return async()=>fail?{ok:false as const,code,message:'synthetic database failure'}:original();return Reflect.get(target,key,receiver);}});
 const runtime=await createDriveRuntime({home:f.home,store:wrapped,clock:f.clock,idGen:f.ids,schemaVersions:EXPECTED_SCHEMA_VERSIONS,network:{fetch:async()=>{calls++;return new Response('{}');}}});if(!runtime)throw Error('runtime missing');expect(await runtime.sourceSync.validateSource!(f.sourceId)).toEqual({ok:true});const metadata=runtime.sourceSync.remote.metadata.bind(runtime.sourceSync.remote);runtime.sourceSync.remote.metadata=async id=>{const result=await metadata(id);if(!result.ok&&result.code===code)guardFailures++;return result;};
 const work=f.ids.next(),now=f.clock.now();expect(await f.store.addWork({id:work,kind:'document_extract',targetKind:'file',targetId:target.file_id,createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});
 await f.db.query(`update brain.source_handoffs set work_id='${work}' where source_file_id='${target.id}'`);const handoffs=await f.store.listSourceHandoffs(target.file_id);expect(handoffs).toMatchObject({ok:true,handoffs:expect.arrayContaining([expect.objectContaining({sourceFileId:target.id,remoteId:'guarded',workId:work})])});
 const config=await readConfig(f.home),env={HOME:f.home,SECOND_BRAIN_HOME:f.home,BRAIN_DATABASE_URL:f.db.appUrl,CLAUDE_CONFIG_DIR:join(f.home,'claude-config')};const brain=createBrain(brainDependencies({home:f.home,env,config,store:wrapped,clock:f.clock,idGen:f.ids,schemaVersions:EXPECTED_SCHEMA_VERSIONS,workHandlers:{},sourceSyncFactory:()=>runtime.sourceSync}));fail=true;
 expect(await brain.queue.drain({budgetMs:1000})).toMatchObject({stopped:'unwritable',code,released:1});expect(guardFailures).toBe(1);expect(calls).toBe(0);expect(await f.db.rows(`select attempts,completed_at from brain.work_items where id='${work}'`)).toEqual([{attempts:0,completed_at:null}]);expect(await f.db.rows(`select current_extraction_id from brain.files where id='${target.file_id}'`)).toEqual([{current_extraction_id:target.current_extraction_id}]);
});

/** Synthetic bytes, made solely for the source-to-extractor integration path. */
function carryPdf():Buffer {
 const stream='BT /F1 12 Tf 30 100 Td (Drivecarry) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
 let out='%PDF-1.4\n';const offsets=[0];objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${object}\nendobj\n`;});const xref=Buffer.byteLength(out);out+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(out);
}
async function carryDocx():Promise<Buffer>{const {default:JSZip}=await import('jszip');const z=new JSZip();z.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');z.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');z.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Docxcarry</w:t></w:r></w:p></w:body></w:document>');return z.generateAsync({type:'nodebuffer'});}

it('source unsupported PDF와 octet-stream 다른 이름 DOCX를 CLI에서 재색인하고 비대상은 재다운로드하지 않는다',async()=>{
 const f=await fixture();const docx=await carryDocx();for(const [id,name,bytes] of [['pdf','renamed.bin',carryPdf()],['docx','unknown.bin',docx],['other','other.bin',Buffer.from([0,1,2])]] as const){f.server.files.set(id,{id,name,mimeType:'application/octet-stream',version:'1',parents:['root'],bytes});const sf=f.ids.next();await f.db.query(`insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,size_bytes,index_status,unreachable) values ('${sf}','${f.sourceId}','${id}','${name}','','application/octet-stream','1',${bytes.length},'unsupported',false)`);}
 const result=await f.cli(['sources','sync',f.sourceId,'--json']);expect(result.body).toMatchObject({ok:true});const rows=await f.db.rows<{remote_id:string;index_status:string;file_id:string|null}>("select remote_id,index_status,file_id from brain.source_files order by remote_id");expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({remote_id:'pdf',index_status:'indexed'}),expect.objectContaining({remote_id:'docx',index_status:'indexed'}),expect.objectContaining({remote_id:'other',index_status:'unsupported',file_id:null})]));
 const chunks=await f.db.rows<{body:string;page:number|null;chunk_locator:unknown}>("select c.body,c.page,c.chunk_locator from brain.document_chunks c join brain.files f on f.current_extraction_id=c.extraction_id order by c.body");expect(chunks).toEqual(expect.arrayContaining([expect.objectContaining({body:expect.stringContaining('Drivecarry'),page:1}),expect.objectContaining({body:expect.stringContaining('Docxcarry'),page:null})]));
 for(const chunk of chunks){const locator=typeof chunk.chunk_locator==='string'?JSON.parse(chunk.chunk_locator):chunk.chunk_locator;expect(locator).toMatchObject(chunk.page===1?{type:'pdf',page:1}:{type:'docx',block:1});}
 expect(await f.db.rows('select count(*)::int as n from brain.source_carry_checks')).toEqual([{n:3}]);expect(await f.db.rows("select count(*)::int as n from brain.work_items where kind='document_extract'")).toEqual([{n:2}]);expect(await f.db.rows('select count(*)::int as n from brain.document_extractions')).toEqual([{n:2}]);expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);
 const counts=await f.db.rows("select (select count(*) from brain.document_extractions where status='ok')::int as generations,(select count(*) from brain.work_items where kind='document_extract')::int as work");const before=f.server.requests.filter(r=>r.path.includes('/other?alt=media')).length;expect((await f.brain.sources.sync({sourceId:f.sourceId})).ok).toBe(true);expect((await f.brain.sources.sync({sourceId:f.sourceId})).ok).toBe(true);expect(await f.db.rows("select (select count(*) from brain.document_extractions where status='ok')::int as generations,(select count(*) from brain.work_items where kind='document_extract')::int as work")).toEqual(counts);expect(f.server.requests.filter(r=>r.path.includes('/other?alt=media'))).toHaveLength(before);expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);
},120000);

it('source-only 구 unsupported 파일은 새 work handoff로 현재 세대를 만들고 temp를 정리한다',async()=>{
 const {createHash}=await import('node:crypto');const f=await fixture(),bytes=carryPdf(),hash='sha256:'+createHash('sha256').update(bytes).digest('hex'),sf=f.ids.next(),file=f.ids.next(),old=f.ids.next();f.server.files.set('legacy',{id:'legacy',name:'legacy.bin',mimeType:'application/octet-stream',version:'1',parents:['root'],bytes});
 await f.db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','${hash}',${bytes.length},'2026-01-01Z');insert into brain.document_extractions(id,file_id,extractor_version,attempt,started_at,finished_at,status) values ('${old}','${file}','doc/old',1,'2026-01-01Z','2026-01-01Z','unsupported');insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,size_bytes,file_id,index_status,unreachable) values ('${sf}','${f.sourceId}','legacy','legacy.bin','','application/octet-stream','1',${bytes.length},'${file}','unsupported',false)`);
 expect((await f.cli(['sources','sync',f.sourceId,'--json'])).body).toMatchObject({ok:true});expect(await f.db.rows(`select sf.file_id::text,sf.index_status,f.current_extraction_id::text from brain.source_files sf join brain.files f on f.id=sf.file_id where sf.id='${sf}'`)).toEqual([expect.objectContaining({file_id:file,index_status:'indexed',current_extraction_id:expect.any(String)})]);expect(await f.db.rows(`select count(*)::int as n from brain.source_handoffs h join brain.work_items w on w.id=h.work_id where h.source_file_id='${sf}' and w.kind='document_extract' and w.outcome='succeeded'`)).toEqual([{n:1}]);// The sentinel binding and staged-byte binding are distinct keys for the same owned extraction.
 const bindings=await f.db.rows<{temp_key:string;work_id:string;extraction_id:string}>(`select temp_key,work_id::text,extraction_id::text from brain.source_attempts where file_id='${file}' order by temp_key`);
 expect(bindings).toHaveLength(2);expect(new Set(bindings.map(b=>b.temp_key)).size).toBe(2);expect(new Set(bindings.map(b=>b.work_id)).size).toBe(1);expect(new Set(bindings.map(b=>b.extraction_id)).size).toBe(1);
 expect(await f.db.rows(`select status,attempt from brain.document_extractions where file_id='${file}' order by attempt`)).toEqual([{status:'ok',attempt:2}]);
 expect(await f.db.rows(`select count(*)::int as n from brain.work_items where kind='document_extract' and target_id='${file}'`)).toEqual([{n:1}]);
 expect(await f.db.rows(`select count(*)::int as n from brain.source_work_publications where file_id='${file}' and extraction_id='${bindings[0]!.extraction_id}' and work_id='${bindings[0]!.work_id}'`)).toEqual([{n:1}]);
 expect(await f.db.rows(`select c.body from brain.files f join brain.document_chunks c on c.extraction_id=f.current_extraction_id where f.id='${file}'`)).toEqual([expect.objectContaining({body:expect.stringContaining('Drivecarry')})]);
 expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);expect((await f.brain.sources.sync({sourceId:f.sourceId})).ok).toBe(true);
 expect(await f.db.rows(`select count(*)::int as n from brain.document_extractions where file_id='${file}'`)).toEqual([{n:1}]);expect(await f.db.rows(`select count(*)::int as n from brain.work_items where kind='document_extract' and target_id='${file}'`)).toEqual([{n:1}]);expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);
},120000);

it('열린 scan 뒤 요청된 Carry는 완료 트랜잭션에서 후속 sync로 이어지고 재시작한다',async()=>{
 const f=await fixture(),sf=f.ids.next(),work=f.ids.next(),scan=f.ids.next(),now=f.clock.now();f.server.files.set('pending',{id:'pending',name:'pending.bin',mimeType:'application/octet-stream',version:'1',parents:['root'],bytes:carryPdf()});await f.db.query(`insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,index_status,unreachable) values ('${sf}','${f.sourceId}','pending','pending.bin','','application/octet-stream','1','unsupported',false)`);
 expect(await f.store.addWork({id:work,kind:'source_sync',targetKind:'source',targetId:f.sourceId,createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});const picked=await f.store.claimWork({now,kinds:['source_sync'],claimedBy:'synthetic'});if(!picked.ok||!picked.item?.claimedBy||!picked.item.claimedAt)throw Error('claim');const claim={workId:work,claimedBy:picked.item.claimedBy,claimedAt:picked.item.claimedAt,attempts:picked.item.attempts,now};
 expect(await f.store.beginSourceScan({sourceId:f.sourceId,generation:1,scanId:scan,startToken:'t',claim})).toMatchObject({ok:true});expect(await f.store.reserveSourceCarry({sourceId:f.sourceId,generation:1,extractorVersion:'doc/synthetic',workId:f.ids.next(),now})).toMatchObject({ok:true,reserved:true});expect(await f.store.finishSourceScan({sourceId:f.sourceId,generation:1,scanId:scan,claim})).toMatchObject({ok:true});
 expect(await f.store.completeWork({id:work,claimedBy:claim.claimedBy,now})).toMatchObject({ok:true,outcome:'done'});const run=(await f.db.rows<{work_id:string;started:boolean;completed:boolean}>("select work_id::text,started,completed from brain.source_carry_runs where extractor_version='doc/synthetic'"))[0]!;expect(run).toMatchObject({started:false,completed:false});expect(run.work_id).not.toBe(work);expect(await f.db.rows(`select count(*)::int as n from brain.work_items where kind='source_sync' and target_id='${f.sourceId}' and completed_at is null`)).toEqual([{n:1}]);
 const drained=await f.brain.queue.drain({budgetMs:60000});expect(drained.failed).toBe(0);expect(await f.db.rows("select started,completed from brain.source_carry_runs where extractor_version='doc/synthetic'")).toEqual([{started:true,completed:true}]);expect(await f.db.rows(`select index_status from brain.source_files where id='${sf}'`)).toEqual([{index_status:'indexed'}]);expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);

},120000);

it('이전 버전이 가려져도 바뀐 원격 바이트는 해시 확인 뒤 새 파일로 색인한다',async()=>{
 const f=await fixture(),sf=f.ids.next(),old=f.ids.next(),bytes=carryPdf();f.server.files.set('changed',{id:'changed',name:'changed.bin',mimeType:'application/octet-stream',version:'2',parents:['root'],bytes});await f.db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at,redacted_at) values ('${old}','sha256:${'e'.repeat(64)}',3,'2026-01-01Z','2026-01-01Z');insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,size_bytes,file_id,index_status,unreachable) values ('${sf}','${f.sourceId}','changed','changed.bin','','application/octet-stream','1',3,'${old}','unsupported',false)`);
 const result=await f.cli(['sources','sync',f.sourceId,'--json']);expect(result.body).toMatchObject({ok:true});const rows=await f.db.rows<{file_id:string;index_status:string;remote_version:string}>(`select file_id::text,index_status,remote_version from brain.source_files where id='${sf}'`);expect(rows).toEqual([expect.objectContaining({file_id:expect.any(String),index_status:'indexed',remote_version:'2'})]);expect(rows[0]!.file_id).not.toBe(old);expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);
},120000);

it('일반 조립의 로컬 첨부와 Drive 원본이 같은 extractor를 통해 색인된다',async()=>{
 const f=await fixture(),bytes=carryPdf();f.server.files.set('drive-doc',{id:'drive-doc',name:'remote.bin',mimeType:'application/octet-stream',version:'1',parents:['root'],bytes});expect((await f.cli(['sources','sync',f.sourceId,'--json'])).body).toMatchObject({ok:true});
 const config=await readConfig(f.home),{localFileStore}=await import('../src/runtime/file-store.js'),files=localFileStore({root:config.ok?config.config.filesPath:join(f.home,'files')}),docx=await carryDocx(),put=await files.put(docx);if(!put.ok)throw Error(put.message);const file=f.ids.next(),location=f.ids.next();
 await f.db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','${put.contentHash}',${put.sizeBytes},'2026-01-01Z');insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${location}','${file}','local','${put.location.locator}','brain','2026-01-01Z');update brain.files set home_location_id='${location}' where id='${file}'`);
 expect(await f.brain.queue.drain({budgetMs:60000})).toMatchObject({failed:0});const rows=await f.db.rows<{body:string;page:number|null;chunk_locator:string}>(`select c.body,c.page,c.chunk_locator from brain.files f join brain.document_chunks c on c.extraction_id=f.current_extraction_id where f.id='${file}'`);expect(rows).toEqual([expect.objectContaining({body:expect.stringContaining('Docxcarry'),page:null})]);expect(JSON.parse(rows[0]!.chunk_locator)).toMatchObject({type:'docx',block:1});expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);
},120000);

it('foreground sync는 scan 시작 뒤 예약된 Carry 후속 work까지 직접 청구한다',async()=>{
 const f=await fixture(),sf=f.ids.next();f.server.files.set('late-carry',{id:'late-carry',name:'late.bin',mimeType:'application/octet-stream',version:'1',parents:['root'],bytes:carryPdf()});
 let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});let held=false;
 const remote=sourceDrive({baseUrl:f.server.baseUrl}),wrapped={...remote,async list(input:Parameters<typeof remote.list>[0]){if(!held){held=true;entered();await gate;}return remote.list(input);}};
 const config=await readConfig(f.home),env={HOME:f.home,SECOND_BRAIN_HOME:f.home,BRAIN_DATABASE_URL:f.db.appUrl,CLAUDE_CONFIG_DIR:join(f.home,'claude-config'),PATH:process.env.PATH,TMPDIR:f.root};
 const brain=createBrain(brainDependencies({home:f.home,env,config,store:f.store,clock:f.clock,idGen:f.ids,schemaVersions:EXPECTED_SCHEMA_VERSIONS,workHandlers:{},sourceSyncFactory:s=>({store:s as PostgresStore,remote:wrapped,temp:f.temp})}));
 const pending=brain.sources.sync({sourceId:f.sourceId});await waiting;
 await f.db.query(`insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,index_status,unreachable) values ('${sf}','${f.sourceId}','late-carry','late.bin','','application/octet-stream','1','unsupported',false)`);
 expect(await f.store.reserveSourceCarry({sourceId:f.sourceId,generation:1,extractorVersion:'doc/foreground-test',workId:f.ids.next(),now:f.clock.now()})).toMatchObject({ok:true,reserved:true});release();
 expect(await pending).toMatchObject({ok:true});expect(await f.db.rows("select started,completed from brain.source_carry_runs where extractor_version='doc/foreground-test'")).toEqual([{started:true,completed:true}]);
 expect(await f.db.rows(`select index_status from brain.source_files where id='${sf}'`)).toEqual([{index_status:'indexed'}]);expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);
},120000);


it('실제 OOXML 폭탄은 source handler too_large, 일반 ZIP은 새 세대 없이 제외',async()=>{
 const {default:JSZip}=await import('jszip');const f=await fixture(),doc=await JSZip.loadAsync(await carryDocx());doc.file('padding.bin',Buffer.alloc(200*1024*1024+1,65));const bomb=await doc.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),ordinary=new JSZip();ordinary.file('large.bin',Buffer.alloc(200*1024*1024+1,66));const zip=await ordinary.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
 for(const [id,bytes] of [['bomb',bomb],['ordinary',zip]] as const){const sf=f.ids.next();f.server.files.set(id,{id,name:id+'.bin',mimeType:'application/octet-stream',version:'1',parents:['root'],bytes});await f.db.query(`insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,size_bytes,index_status,unreachable) values ('${sf}','${f.sourceId}','${id}','${id}.bin','','application/octet-stream','1',${bytes.length},'unsupported',false)`);}
 expect(await f.brain.sources.sync({sourceId:f.sourceId})).toMatchObject({ok:true});expect(await f.db.rows("select remote_id,index_status,file_id is null as missing from brain.source_files order by remote_id")).toEqual([{remote_id:'bomb',index_status:'too_large',missing:true},{remote_id:'ordinary',index_status:'unsupported',missing:true}]);
 expect(await f.db.rows(`select sf.index_status,h.file_id is not null as handed_off,f.current_extraction_id is null as no_current,e.status,e.finished_at is not null as finished,w.outcome from brain.source_files sf join brain.source_handoffs h on h.source_file_id=sf.id join brain.files f on f.id=h.file_id join brain.document_extractions e on e.file_id=f.id join brain.work_items w on w.id=h.work_id where sf.remote_id='bomb'`)).toEqual([{index_status:'too_large',handed_off:true,no_current:true,status:'too_large',finished:true,outcome:'succeeded'}]);
 expect(await f.db.rows('select count(*)::int as n from brain.source_work_publications')).toEqual([{n:0}]);
 expect(await f.db.rows("select status from brain.document_extractions order by status")).toEqual([{status:'too_large'}]);expect(await f.db.rows("select count(*)::int as n from brain.failures where resolved_at is null")).toEqual([{n:0}]);expect(await f.db.rows("select count(*)::int as n from brain.work_items where kind='document_extract'")).toEqual([{n:1}]);expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);
},180000);

it('새 parser child 비정상 종료는 PG의 이전 current와 chunks를 보존한다',async()=>{
 const ambient=await mkdtemp(join(tmpdir(),'brain-parser-ambient-'));cleanup.push(()=>rm(ambient,{recursive:true,force:true}));
 const projects=join(ambient,'.claude','projects','synthetic');await mkdir(projects,{recursive:true});
 const session='4f1e7a90-1c2b-4d3e-8f55-000000000000';await writeFile(join(projects,`${session}.jsonl`),JSON.stringify({type:'user',sessionId:session,uuid:'00000000-0000-4000-8000-000000000003',timestamp:'2026-01-02T03:04:05.000Z',message:{role:'user',content:'synthetic input'}})+'\n');
 const previousHome=process.env.HOME;const f=await fixture();expect(process.env.HOME).toBe(previousHome);process.env.HOME=ambient;
 try {expect(homedir()).toBe(ambient);
 const initialBrain=createBrain(f.assemble(f.env));const config=await readConfig(f.home),{localFileStore}=await import('../src/runtime/file-store.js'),{createDocumentExtractor,runDocumentParser}=await import('../src/runtime/document-extractors.js'),files=localFileStore({root:config.ok?config.config.filesPath:join(f.home,'files')}),bytes=carryPdf(),put=await files.put(bytes);if(!put.ok)throw Error('put');const file=f.ids.next(),location=f.ids.next();
 await f.db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','${put.contentHash}',${put.sizeBytes},'2026-01-01Z');insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${location}','${file}','local','${put.location.locator}','brain','2026-01-01Z');update brain.files set home_location_id='${location}' where id='${file}'`);
 expect(await initialBrain.queue.drain({budgetMs:60000})).toMatchObject({failed:0});const before=await f.db.rows(`select current_extraction_id::text from brain.files where id='${file}'`),chunks=await f.db.rows(`select id::text,body from brain.document_chunks where extraction_id=(select current_extraction_id from brain.files where id='${file}') order by ordinal`);expect(chunks).toHaveLength(1);
 const work=f.ids.next(),now=f.clock.now();expect(await f.store.addWork({id:work,kind:'document_extract',targetKind:'file',targetId:file,createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});
 let observed:Awaited<ReturnType<typeof runDocumentParser>>|undefined;const crashing=createDocumentExtractor(async(input,mode)=>{const result=await runDocumentParser(input,mode,60000,child=>child.once('spawn',()=>child.kill('SIGKILL')));observed=result;return result;});
 const extracted=await crashing.extract(bytes,'application/pdf',{targetChars:1200,overlapChars:120});expect(observed).toMatchObject({kind:'failed',message:'문서 추출 프로세스가 종료되었습니다'});expect(extracted).toMatchObject({ok:false,message:'문서 추출 프로세스가 종료되었습니다'});observed=undefined;
 const env={HOME:f.home,SECOND_BRAIN_HOME:f.home,BRAIN_DATABASE_URL:f.db.appUrl,CLAUDE_CONFIG_DIR:join(f.home,'claude-config'),PATH:process.env.PATH,TMPDIR:f.root},base=brainDependencies({home:f.home,env,config,store:f.store,clock:f.clock,idGen:f.ids,schemaVersions:EXPECTED_SCHEMA_VERSIONS,workHandlers:{}}),brain=createBrain({...base,documentExtractors:[crashing]});
 const result=await brain.queue.drain({budgetMs:60000});expect(result).toMatchObject({failed:1,enqueued:0,stopped:'empty',spoolFailed:0});expect(result.scanStopped).toBeUndefined();expect(await f.db.rows("select kind from brain.work_items where kind='session_ingest'")).toEqual([]);expect(observed).toMatchObject({kind:'failed',message:'문서 추출 프로세스가 종료되었습니다'});expect(await f.db.rows(`select current_extraction_id::text from brain.files where id='${file}'`)).toEqual(before);expect(await f.db.rows(`select id::text,body from brain.document_chunks where extraction_id=(select current_extraction_id from brain.files where id='${file}') order by ordinal`)).toEqual(chunks);expect(await f.db.rows(`select status,failed_stage from brain.document_extractions where file_id='${file}' order by attempt`)).toEqual([{status:'ok',failed_stage:null},{status:'failed',failed_stage:'extract'}]);expect(await f.db.rows(`select code from brain.failures where target_id='${file}' and resolved_at is null`)).toEqual([{code:'EXTRACTION_FAILED'}]);
 } finally {if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;}
},120000);

it('Google Sheets만 남은 source는 반복 drain에서 전체 scan을 예약하지 않는다',async()=>{
 const f=await fixture(),sf=f.ids.next();f.server.files.set('sheet',{id:'sheet',name:'sheet',mimeType:'application/vnd.google-apps.spreadsheet',version:'1',parents:['root'],bytes:Buffer.from('synthetic')});await f.db.query(`insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,index_status,unreachable) values ('${sf}','${f.sourceId}','sheet','sheet','','application/vnd.google-apps.spreadsheet','1','unsupported',false)`);
 expect(await f.brain.sources.sync({sourceId:f.sourceId})).toMatchObject({ok:true});const workBefore=await f.db.rows(`select count(*)::int as n from brain.work_items where kind='source_sync' and target_id='${f.sourceId}'`),lists=f.server.requests.filter(r=>r.path.startsWith('/drive/v3/files?')).length;expect(lists).toBeGreaterThan(0);for(let i=0;i<2;i++)expect(await f.brain.queue.drain({budgetMs:60000})).toMatchObject({failed:0});expect(await f.db.rows(`select count(*)::int as n from brain.work_items where kind='source_sync' and target_id='${f.sourceId}'`)).toEqual(workBefore);expect(f.server.requests.filter(r=>r.path.startsWith('/drive/v3/files?'))).toHaveLength(lists);expect(f.server.requests.filter(r=>r.path.includes('/sheet?alt=media'))).toHaveLength(0);
},120000);

it('A terminal source Carry는 B foreground scan으로 승계되어 모두 완료된다',async()=>{
 const f=await fixture(),sf=f.ids.next(),old=f.ids.next(),bytes=carryPdf();f.server.files.set('legacy-a',{id:'legacy-a',name:'a.bin',mimeType:'application/octet-stream',version:'1',parents:['root'],bytes});await f.db.query(`insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,index_status,unreachable) values ('${sf}','${f.sourceId}','legacy-a','a.bin','','application/octet-stream','1','unsupported',false);insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,attempts,next_attempt_at,completed_at,outcome) values ('${old}','source_sync','core','source','${f.sourceId}','2026-01-01Z',1,'2026-01-01Z','2026-01-01Z','failed');insert into brain.source_carry_runs(source_id,generation,extractor_version,work_id,started,completed) values ('${f.sourceId}',1,'doc/previous','${old}',true,false)`);
 expect(await f.store.beginSourceScan({sourceId:f.sourceId,generation:1,scanId:f.ids.next(),startToken:'stale',claim:{workId:old,claimedBy:'old-owner',claimedAt:f.clock.now(),attempts:1,now:f.clock.now()}})).toMatchObject({ok:false,code:'CLAIM_LOST'});
 expect(await f.brain.sources.sync({sourceId:f.sourceId})).toMatchObject({ok:true});const runs=await f.db.rows<{extractor_version:string;work_id:string;started:boolean;completed:boolean}>(`select extractor_version,work_id::text,started,completed from brain.source_carry_runs where source_id='${f.sourceId}' order by extractor_version`);expect(runs).toHaveLength(2);expect(runs.every(r=>r.started&&r.completed&&r.work_id!==old)).toBe(true);expect(new Set(runs.map(r=>r.work_id)).size).toBe(1);expect(await f.db.rows(`select index_status from brain.source_files where id='${sf}'`)).toEqual([{index_status:'indexed'}]);expect(await readdir(f.tempRoot).catch(()=>[])).toEqual([]);
},120000);

it('A Carry 예약 뒤 새 store와 B drain이 같은 work를 승계해 실제 PDF를 게시한다',async()=>{
 const f=await fixture(),config=await readConfig(f.home),{localFileStore}=await import('../src/runtime/file-store.js'),files=localFileStore({root:config.ok?config.config.filesPath:join(f.home,'files')}),bytes=carryPdf(),put=await files.put(bytes);if(!put.ok)throw Error('put');const file=f.ids.next(),loc=f.ids.next(),old=f.ids.next(),work=f.ids.next();
 await f.db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','${put.contentHash}',${put.sizeBytes},'2026-01-01Z');insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${loc}','${file}','local','${put.location.locator}','brain','2026-01-01Z');update brain.files set home_location_id='${loc}' where id='${file}';insert into brain.document_extractions(id,file_id,extractor_version,attempt,started_at,finished_at,status) values ('${old}','${file}','doc/old',1,'2026-01-01Z','2026-01-01Z','unsupported')`);
 expect(await f.store.commitUnsupportedCarry({fileId:file,extractorVersion:'doc/A',contentHash:put.contentHash,home:put.location,supported:true,workId:work,now:f.clock.now()})).toMatchObject({ok:true,created:true});
 const restarted=postgresStore({databaseUrl:f.db.appUrl});cleanup.push(()=>restarted.close());const env={HOME:f.home,SECOND_BRAIN_HOME:f.home,BRAIN_DATABASE_URL:f.db.appUrl,CLAUDE_CONFIG_DIR:join(f.home,'claude-config'),PATH:process.env.PATH,TMPDIR:f.root},brain=createBrain(brainDependencies({home:f.home,env,config,store:restarted,clock:f.clock,idGen:f.ids,schemaVersions:EXPECTED_SCHEMA_VERSIONS,workHandlers:{}}));
 expect(await brain.queue.drain({budgetMs:60000})).toMatchObject({failed:0});expect(await f.db.rows(`select w.id::text,w.outcome,v.extractor_version from brain.work_items w join brain.document_carry_work_versions v on v.work_id=w.id where w.id='${work}'`)).toMatchObject([{id:work,outcome:'succeeded',extractor_version:expect.not.stringMatching(/^doc\/A$/)}]);expect(await f.db.rows(`select status from brain.document_extractions where file_id='${file}'`)).toEqual([{status:'ok'}]);expect(await f.db.rows(`select c.body from brain.files f join brain.document_chunks c on c.extraction_id=f.current_extraction_id where f.id='${file}'`)).toEqual([expect.objectContaining({body:expect.stringContaining('Drivecarry')})]);expect(await f.db.rows(`select extractor_version from brain.document_carry_checks where file_id='${file}'`)).toEqual([{extractor_version:'doc/A'}]);
},120000);

it('B 판정 marker가 이미 있어도 이전 A 미완료 run을 B foreground에서 회수한다',async()=>{
 const {DOCUMENT_EXTRACTOR_VERSION}=await import('second_brain');const f=await fixture(),sf=f.ids.next(),old=f.ids.next();f.server.files.set('checked',{id:'checked',name:'checked.bin',mimeType:'application/octet-stream',version:'1',parents:['root'],bytes:Buffer.from([0,1,2])});await f.db.query(`insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,index_status,unreachable) values ('${sf}','${f.sourceId}','checked','checked.bin','','application/octet-stream','1','unsupported',false);insert into brain.source_carry_checks(source_file_id,remote_version,extractor_version,requires_handoff) values ('${sf}','1','${DOCUMENT_EXTRACTOR_VERSION}',false);insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,attempts,next_attempt_at,completed_at,outcome) values ('${old}','source_sync','core','source','${f.sourceId}','2026-01-01Z',1,'2026-01-01Z','2026-01-01Z','failed');insert into brain.source_carry_runs(source_id,generation,extractor_version,work_id,started,completed) values ('${f.sourceId}',1,'doc/previous','${old}',true,false)`);
 expect(await f.brain.sources.sync({sourceId:f.sourceId})).toMatchObject({ok:true});expect(await f.db.rows(`select completed from brain.source_carry_runs where source_id='${f.sourceId}' order by extractor_version`)).toEqual([{completed:true},{completed:true}]);expect(f.server.requests.filter(r=>r.path.includes('/checked?alt=media'))).toHaveLength(0);expect(await f.db.rows(`select extractor_version,requires_handoff from brain.source_carry_checks where source_file_id='${sf}'`)).toEqual([{extractor_version:DOCUMENT_EXTRACTOR_VERSION,requires_handoff:false}]);
},120000);
