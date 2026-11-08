import {mkdtemp,mkdir,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
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
  const env={HOME:home,SECOND_BRAIN_HOME:home,BRAIN_DATABASE_URL:db.appUrl,PATH:process.env.PATH,TMPDIR:root};const config=await readConfig(home);
  const brain=createBrain(brainDependencies({home,env,config,store,clock,idGen:ids,schemaVersions:EXPECTED_SCHEMA_VERSIONS,workHandlers:{},sourceSyncFactory}));
  async function cli(args:string[]){let stdout='',stderr='';const code=await dispatch(commands,args,{env,clock,idGen:ids,runner:pgRunner,sourceSyncFactory,stdout:s=>{stdout+=s;},stderr:s=>{stderr+=s;}});return {code,stdout,stderr,body:stdout?JSON.parse(stdout):null};}
  return {root,home,tempRoot,db,server,clock,ids,store,sourceId,brain,cli,temp};
}
function seed(server:Awaited<ReturnType<typeof fakeDrive>>){
  const add=(id:string,name:string,mimeType:string,body:string,parents=['root'],size?:number)=>server.files.set(id,{id,name,mimeType,version:'1',bytes:Buffer.from(body),parents,...(size===undefined?{}:{size})});
  add('text','합성문서.txt','text/plain','공통검색 텍스트');add('markdown','합성기록.md','text/markdown','공통검색 마크다운');add('docs','합성문서','application/vnd.google-apps.document','공통검색 문서');add('photo','합성사진.jpg','image/jpeg','image');add('large','합성대형.txt','text/plain','x',['root'],60_000_000);add('folder','하위','application/vnd.google-apps.folder','');add('nested','하위문서.txt','text/plain','공통검색 하위',['folder']);
}
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
 const config=await readConfig(f.home),env={HOME:f.home,SECOND_BRAIN_HOME:f.home,BRAIN_DATABASE_URL:f.db.appUrl,PATH:process.env.PATH,TMPDIR:f.root};const remote=sourceDrive({baseUrl:f.server.baseUrl});const failed={...remote,async list(){return {ok:false as const,code:'TEMPORARY' as const,message:'synthetic outage'};}};
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
 const env={HOME:home,SECOND_BRAIN_HOME:home,BRAIN_DATABASE_URL:url,PATH:process.env.PATH};const clock={now:()=>new Date('2026-01-01T00:00:00Z')};
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
