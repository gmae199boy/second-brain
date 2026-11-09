import { expect,it } from 'vitest';
import { driveRequest,DriveRequestError,parseRetryAfter } from '../src/runtime/drive-http.js';
import { sourceDrive } from '../src/runtime/source-drive.js';
import { driveFileStore } from '../src/runtime/drive-file-store.js';
import { fakeClock,memoryDriveUploads } from './fixtures/fake-drive.js';
import { contentHashOfBytes,drainQueue,runDoctor,sourceSyncHandler } from 'second_brain';
import { memorySchemaStore,memorySourceStore,memorySpool,memoryStore,sampleWorkInput,sequenceIdGen } from 'second_brain/testing';

const start=new Date('2026-01-01T00:00:00Z');
it('retries 401 once with refreshed credentials and never leaks external error text',async()=>{
 let calls=0,refresh=0;const auth={async token(){return {ok:true as const,accessToken:'synthetic-old'};},async retryAfter401(){refresh++;return {ok:true as const,accessToken:'synthetic-new'};}};
 const fetcher:typeof fetch=async(_url,init)=>{calls++;const authHeader=new Headers(init?.headers).get('authorization');expect(authHeader).toBe(calls===1?'Bearer synthetic-old':'Bearer synthetic-new');return new Response('secret-error',{status:401});};
 const remote=sourceDrive({baseUrl:'http://local',auth,fetch:fetcher});const r=await remote.startToken();expect(r).toMatchObject({ok:false,code:'AUTH_LOGIN_REQUIRED'});expect(refresh).toBe(1);expect(calls).toBe(2);expect(JSON.stringify(r)).not.toContain('secret-error');expect(JSON.stringify(r)).not.toContain('synthetic-new');
});
it('classifies 403 and Retry-After for seconds and HTTP date using injected clock',async()=>{
 const clock=fakeClock(start.toISOString());expect(parseRetryAfter('120',clock.now())).toEqual(new Date(start.getTime()+120_000));expect(parseRetryAfter('Thu, 01 Jan 2026 00:03:00 GMT',clock.now())).toEqual(new Date(start.getTime()+180_000));
 const fetcher:typeof fetch=async input=>String(input).includes('limited')?new Response('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}',{status:403,headers:{'Retry-After':'120'}}):new Response('private remote body',{status:403});
 const remote=sourceDrive({baseUrl:'http://local',fetch:fetcher,clock});expect(await remote.metadata('limited')).toMatchObject({ok:false,code:'TEMPORARY',retryAfter:new Date(start.getTime()+120_000)});expect(await remote.metadata('denied')).toMatchObject({ok:false,code:'UNREACHABLE'});
});
it('uses one request policy for Brain-owned Drive storage and preserves retry time',async()=>{
 const clock=fakeClock(start.toISOString()), uploads=memoryDriveUploads(), bytes=new TextEncoder().encode('abc'),hash=contentHashOfBytes(bytes),locator=hash.slice(7);
 await uploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote',state:'reserved',at:start});
 const store=driveFileStore({baseUrl:'http://local',rootFolderId:'root',uploads,clock,fetch:async()=>new Response('secret-remote',{status:429,headers:{'Retry-After':'90'}})});
 const result=await store.get({storeKind:'drive',ownership:'brain',locator});expect(result).toMatchObject({ok:false,code:'FILES_UNAVAILABLE',driveCode:'TEMPORARY',retryAfter:new Date(start.getTime()+90_000)});expect(JSON.stringify(result)).not.toContain('secret-remote');
});
it('queue defers source work until Retry-After and then claims it',async()=>{
 const queue=memoryStore(),spool=memorySpool(),clock=fakeClock(start.toISOString());const id='019a0000-0000-7000-8000-000000000201',work='019a0000-0000-7000-8000-000000000202';let calls=0;
 const source=memorySourceStore({claim:()=>true,renew:()=>true,file:(_h,_s,i)=>({id:i,redacted:false}),extraction:()=>true,workOpen:()=>true,isRedacted:()=>false,handoff:()=>{}});await source.ensureSource({id,kind:'drive',account:'synthetic',rootId:'root'});
 const remote=sourceDrive({baseUrl:'http://local',clock,fetch:async()=>{calls++;return new Response('private',{status:429,headers:{'Retry-After':'120'}});}});
 await queue.addWork(sampleWorkInput({id:work,kind:'source_sync',targetKind:'source',targetId:id,createdAt:start,nextAttemptAt:start}));
 const run=()=>drainQueue({store:queue,spool,clock,idGen:sequenceIdGen({timestampMs:start.getTime(),start:100+calls*10})},{budgetMs:1000,handlers:{source_sync:sourceSyncHandler({store:source,remote,clock,idGen:sequenceIdGen({timestampMs:start.getTime(),start:500})})}});
 await run();expect(queue.snapshot().workItems[0]?.nextAttemptAt).toEqual(new Date(start.getTime()+120_000));expect(calls).toBe(1);await run();expect(calls).toBe(1);clock.set('2026-01-01T00:02:00Z');await run();expect(calls).toBe(2);
});
it('invalid_grant records a non-retryable queue failure and doctor reports reconsent',async()=>{
 const queue=memoryStore(),spool=memorySpool(),clock=fakeClock(start.toISOString()),id='019a0000-0000-7000-8000-000000000211',work='019a0000-0000-7000-8000-000000000212';
 const source=memorySourceStore({claim:()=>true,renew:()=>true,file:(_h,_s,i)=>({id:i,redacted:false}),extraction:()=>true,workOpen:()=>true,isRedacted:()=>false,handoff:()=>{}});await source.ensureSource({id,kind:'drive',account:'synthetic',rootId:'root'});
 const auth={async token(){return {ok:false as const,code:'AUTH_REQUIRED' as const,message:'private token'};},async retryAfter401(){return {ok:false as const,code:'AUTH_REQUIRED' as const,message:'private token'};}};
 const remote=sourceDrive({baseUrl:'http://local',auth,clock});await queue.addWork(sampleWorkInput({id:work,kind:'source_sync',targetKind:'source',targetId:id,createdAt:start,nextAttemptAt:start}));
 await drainQueue({store:queue,spool,clock,idGen:sequenceIdGen({timestampMs:start.getTime(),start:700})},{budgetMs:1000,handlers:{source_sync:sourceSyncHandler({store:source,remote,clock,idGen:sequenceIdGen({timestampMs:start.getTime(),start:800})})}});
 expect(queue.snapshot().workItems[0]).toMatchObject({outcome:'failed',attempts:1});const failures=await queue.listFailures({});expect(failures).toMatchObject({ok:true,failures:[{code:'AUTH_REQUIRED'}]});expect(JSON.stringify(failures)).not.toContain('private token');
 const schema=memorySchemaStore({version:1});const report=await runDoctor({...schema,async checkHealth(){return {ok:true as const,serverVersion:'test',source:{location:'synthetic',probes:[]}};}},{store:queue,clock,schemaVersions:{core:1}});expect(report.checks).toContainEqual(expect.objectContaining({id:'failures',status:'warn',detail:expect.stringContaining('Drive 재동의')}));expect(JSON.stringify(report)).not.toContain('private token');
});
it('network errors produce safe transient failures',async()=>{const error=await driveRequest({url:'http://local',fetch:async()=>{throw Error('synthetic-private');}}).catch(e=>e);expect(error).toBeInstanceOf(DriveRequestError);expect(error.code).toBe('TEMPORARY');expect(error.message).not.toContain('synthetic-private');});

it('rejects Retry-After values outside the representable Date range',()=>{expect(parseRetryAfter('8640000000001',start)).toBeUndefined();expect(parseRetryAfter('1',new Date(NaN))).toBeUndefined();});

it('rate-limit body Retry after fallback uses buffer and hides private body',async()=>{
 const clock=fakeClock(start.toISOString()),target='2026-01-01T00:04:00Z';const fetcher:typeof fetch=async()=>new Response(`private synthetic rateLimitExceeded Retry after ${target}`,{status:403});
 const remote=sourceDrive({baseUrl:'http://local',fetch:fetcher,clock});const result=await remote.metadata('limited');expect(result).toMatchObject({ok:false,code:'TEMPORARY',retryAfter:new Date('2026-01-01T00:04:03Z')});expect(JSON.stringify(result)).not.toContain('private synthetic');
});

it('changes metadata preserves creation time needed to prove new out-of-scope structure',async()=>{
 let requested='';const remote=sourceDrive({baseUrl:'http://local',fetch:async input=>{requested=String(input);return new Response(JSON.stringify({changes:[{fileId:'folder',file:{id:'folder',name:'outside',mimeType:'application/vnd.google-apps.folder',version:'1',parents:['other'],createdTime:'2026-01-01T00:00:01Z'}}],newStartPageToken:'next'}),{status:200});}});
 expect(await remote.changes!({pageToken:'cursor'})).toMatchObject({ok:true,changes:[{remoteId:'folder',item:{createdTime:'2026-01-01T00:00:01Z'}}]});expect(new URL(requested).searchParams.get('fields')).toContain('createdTime');
});

it.each([403,429,503])('status %s without retry hint defers queue 63 seconds',async status=>{
 const queue=memoryStore(),spool=memorySpool(),clock=fakeClock(start.toISOString()),id='019a0000-0000-7000-8000-000000000241',work='019a0000-0000-7000-8000-000000000242';let calls=0;
 const source=memorySourceStore({claim:()=>true,renew:()=>true,file:(_h,_s,i)=>({id:i,redacted:false}),extraction:()=>true,workOpen:()=>true,isRedacted:()=>false,handoff:()=>{}});await source.ensureSource({id,kind:'drive',account:'retry-default',rootId:'root'});
 const remote=sourceDrive({baseUrl:'http://local',clock,fetch:async()=>{calls++;return new Response(status===403?'rateLimitExceeded':'temporary',{status});}});
 await queue.addWork(sampleWorkInput({id:work,kind:'source_sync',targetKind:'source',targetId:id,createdAt:start,nextAttemptAt:start}));
 const run=()=>drainQueue({store:queue,spool,clock,idGen:sequenceIdGen({timestampMs:start.getTime(),start:1000+calls*10})},{budgetMs:1000,handlers:{source_sync:sourceSyncHandler({store:source,remote,clock,idGen:sequenceIdGen({timestampMs:start.getTime(),start:1100})})}});
 await run();expect(calls).toBe(1);expect(queue.snapshot().workItems[0]?.nextAttemptAt).toEqual(new Date(start.getTime()+63_000));clock.set('2026-01-01T00:01:02Z');await run();expect(calls).toBe(1);clock.set('2026-01-01T00:01:03Z');await run();expect(calls).toBe(2);
});

it('aborts a stalled error body, releases its reader and hides remote text',async()=>{
 const controller=new AbortController();let cancelled=false;let response!:Response;let entered!:()=>void;
 const reading=new Promise<void>(resolve=>{entered=resolve;});
 const pending=driveRequest({url:'http://local',init:{signal:controller.signal},fetch:async()=>{
  response=new Response(new ReadableStream<Uint8Array>({start(stream){stream.enqueue(new TextEncoder().encode('private synthetic'));},pull(){entered();},cancel(){cancelled=true;}}),{status:503});return response;
 }}).catch(error=>error);
 await reading;controller.abort();const error=await pending;
 expect(cancelled).toBe(true);expect(response.body?.locked).toBe(false);expect(error).toBeInstanceOf(DriveRequestError);expect(error.code).toBe('TEMPORARY');expect(JSON.stringify(error)).not.toContain('private synthetic');
});
