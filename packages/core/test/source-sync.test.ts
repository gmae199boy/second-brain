import { expect, it } from 'vitest';
import { sourceSyncHandler, type SourceRemote, type WorkItem } from '../src/index.js';
import { memorySourceStore, sequenceIdGen } from '../src/testing/index.js';
const now=new Date('2026-01-01T00:00:00Z'),clock={now:()=>now};
const item:WorkItem={id:'019a0000-0000-7000-8000-000000000001',kind:'source_sync',targetKind:'source',targetId:'019a0000-0000-7000-8000-000000000002',executionClass:'core',currentAttemptToken:null,serializationKey:null,holdGroup:null,createdAt:now,attempts:1,nextAttemptAt:now,claimedAt:now,claimExpiresAt:new Date(now.getTime()+600000),claimedBy:'worker',lastError:null,completedAt:null,outcome:null,cancelRequestedAt:null,scheduledOccurrences:null};
function fixture(){const requests:string[]=[], handoffs:string[]=[];let incomplete=false,version='1';const ids=sequenceIdGen({timestampMs:now.getTime(),start:20});
const store=memorySourceStore({claim:c=>c.claimedBy==='worker',renew:c=>c.claimedBy==='worker',file:(_h,_s,id)=>({id,redacted:false}),extraction:()=>true,workOpen:()=>true,isRedacted:()=>false,handoff:(_w,id)=>handoffs.push(id)});
const data=[{id:'text',name:'hello.txt',mimeType:'text/plain',version:'1',sizeBytes:3},{id:'photo',name:'photo.jpg',mimeType:'image/jpeg',version:'1',sizeBytes:4},{id:'big',name:'big.txt',mimeType:'text/plain',version:'1',sizeBytes:60_000_000},{id:'child',name:'nested',mimeType:'application/vnd.google-apps.folder',version:'1',sizeBytes:null},{id:'docs',name:'doc',mimeType:'application/vnd.google-apps.document',version:'1',sizeBytes:null}];
const remote:SourceRemote={async startToken(){requests.push('token');return {ok:true,token:'token'};},async list({parentId,pageToken}){requests.push(`list:${parentId}:${pageToken??'0'}`);if(parentId==='child')return {ok:true,items:[data[4]!],nextPageToken:null,incomplete};const p=Number(pageToken??0);return {ok:true,items:data.slice(p*2,p*2+2),nextPageToken:p<1?String(p+1):null,incomplete};},async metadata(id){requests.push(`meta:${id}`);return {ok:true,item:{...data.find(x=>x.id===id)!,version}};},async download({id}){requests.push(`download:${id}`);return {ok:true,bytes:new Uint8Array([97,98,99])};}};
return {store,remote,requests,handoffs,ids,setIncomplete:()=>{incomplete=true;},setVersion:()=>{version='2';}};}
it('obtains token before paged nested listing and skips downloads for photos and 60MB',async()=>{const f=fixture();await f.store.ensureSource({id:item.targetId,kind:'drive',account:'a',rootId:'root'});expect(await sourceSyncHandler({store:f.store,remote:f.remote,clock,idGen:f.ids})(item)).toEqual({ok:true});expect(f.requests[0]).toBe('token');expect(f.requests).toContain('list:child:0');expect(f.requests).not.toContain('download:photo');expect(f.requests).not.toContain('download:big');expect(f.requests).toContain('download:docs');const rows=await f.store.listSourceEntries(item.targetId);expect(rows.ok&&rows.entries.map(e=>[e.remoteId,e.indexStatus])).toEqual(expect.arrayContaining([['photo','photo'],['big','too_large']]));});
it('incomplete listing and changed download version never publish a successful fingerprint',async()=>{const f=fixture();await f.store.ensureSource({id:item.targetId,kind:'drive',account:'a',rootId:'root'});f.setIncomplete();expect(await sourceSyncHandler({store:f.store,remote:f.remote,clock,idGen:f.ids})(item)).toMatchObject({ok:false});const src=await f.store.readSource(item.targetId);expect(src.ok&&src.source?.cursor).toBeNull();const g=fixture();await g.store.ensureSource({id:item.targetId,kind:'drive',account:'a',rootId:'root'});g.setVersion();expect(await sourceSyncHandler({store:g.store,remote:g.remote,clock,idGen:g.ids})(item)).toMatchObject({ok:false,code:'SOURCE_CHANGED'});expect(g.handoffs).toHaveLength(0);});
it('complete empty listing marks only that source unreachable; a failed listing does not prune',async()=>{const f=fixture();await f.store.ensureSource({id:item.targetId,kind:'drive',account:'a',rootId:'root'});expect(await sourceSyncHandler({store:f.store,remote:f.remote,clock,idGen:f.ids})(item)).toEqual({ok:true});const failed:SourceRemote={...f.remote,async list(){return {ok:false,code:'TEMPORARY',message:'retry'};}};expect(await sourceSyncHandler({store:f.store,remote:failed,clock,idGen:f.ids})(item)).toMatchObject({ok:false,retryable:true});const before=await f.store.listSourceEntries(item.targetId);expect(before.ok&&before.entries.every(e=>!e.unreachable)).toBe(true);const empty:SourceRemote={...f.remote,async list(){return {ok:true,items:[],nextPageToken:null,incomplete:false};}};expect(await sourceSyncHandler({store:f.store,remote:empty,clock,idGen:f.ids})(item)).toEqual({ok:true});const after=await f.store.listSourceEntries(item.targetId);expect(after.ok&&after.entries.every(e=>e.unreachable&&e.unreachableAt?.getTime()===now.getTime())).toBe(true);});
it('redacted content cannot be handed off and confirmed inaccessible item is distinguished from retryable errors',async()=>{const f=fixture();const blocked=memorySourceStore({claim:()=>true,renew:()=>true,file:(_h,_s,id)=>({id,redacted:true}),extraction:()=>true,workOpen:()=>true,isRedacted:()=>true,handoff:()=>{throw Error('redacted handoff');}});await blocked.ensureSource({id:item.targetId,kind:'drive',account:'a',rootId:'root'});expect(await sourceSyncHandler({store:blocked,remote:f.remote,clock,idGen:f.ids})(item)).toEqual({ok:true});const hidden=await blocked.listSourceEntries(item.targetId);expect(hidden.ok&&hidden.entries.find(e=>e.remoteId==='text')?.fileId).toBeTruthy();const removed:SourceRemote={...f.remote,async download({id}){return id==='text'?{ok:false,code:'UNREACHABLE',message:'gone'}:{ok:true,bytes:new Uint8Array([97,98,99])};}};expect(await sourceSyncHandler({store:blocked,remote:removed,clock,idGen:f.ids})(item)).toEqual({ok:true});const rows=await blocked.listSourceEntries(item.targetId);expect(rows.ok&&rows.entries.find(e=>e.remoteId==='text')?.unreachable).toBe(true);});
it('renews during paged progress past 600 seconds and rejects expired or replaced claims',async()=>{
  let time=now.getTime(), expires=time+600_000, owner='worker';const localClock={now:()=>new Date(time)};
  const valid=(c:import('../src/ports/source-store.js').SourceClaim,kind:string,target:string)=>kind==='source_sync'&&target===item.targetId&&c.workId===item.id&&c.claimedBy===owner&&c.claimedAt.getTime()===now.getTime()&&c.attempts===item.attempts&&c.now.getTime()<expires;
  const store=memorySourceStore({claim:valid,renew:(c,target)=>{if(!valid(c,'source_sync',target))return false;expires=Math.max(expires,c.now.getTime()+600_000);return true;},file:(_h,_s,id)=>({id,redacted:false}),extraction:()=>true,workOpen:()=>true,isRedacted:()=>false,handoff:()=>{}});
  await store.ensureSource({id:item.targetId,kind:'drive',account:'lease',rootId:'root'});
  let page=0;const remote:SourceRemote={async startToken(){return {ok:true,token:'token'};},async list(){time+=300_000;page++;return {ok:true,items:[],nextPageToken:page<4?String(page):null,incomplete:false};},async metadata(){throw Error('unused');},async download(){throw Error('unused');}};
  const handler=sourceSyncHandler({store,remote,clock:localClock,idGen:sequenceIdGen({timestampMs:now.getTime(),start:400})});
  expect(await handler(item)).toEqual({ok:true});expect(time-now.getTime()).toBe(1_200_000);
  time=expires;expect(await handler(item)).toMatchObject({ok:false,code:'CLAIM_LOST'});
  time=now.getTime();expires=time+600_000;owner='replacement';expect(await handler(item)).toMatchObject({ok:false,code:'CLAIM_LOST'});
});
it('renews between files on one long page without holding a remote transaction',async()=>{
  let time=now.getTime(),expires=time+600_000;const localClock={now:()=>new Date(time)};
  const valid=(c:import('../src/ports/source-store.js').SourceClaim,kind:string,target:string)=>kind==='source_sync'&&target===item.targetId&&c.workId===item.id&&c.claimedBy===item.claimedBy&&c.claimedAt.getTime()===now.getTime()&&c.attempts===item.attempts&&c.now.getTime()<expires;
  const store=memorySourceStore({claim:valid,renew:(c,target)=>{if(!valid(c,'source_sync',target))return false;expires=Math.max(expires,c.now.getTime()+600_000);return true;},file:(_h,_s,id)=>({id,redacted:false}),extraction:()=>true,workOpen:()=>true,isRedacted:()=>false,handoff:()=>{}});
  await store.ensureSource({id:item.targetId,kind:'drive',account:'files-lease',rootId:'root'});
  const shortcuts=Array.from({length:4},(_,i)=>({id:`shortcut-${i}`,name:`photo-${i}`,mimeType:'application/vnd.google-apps.shortcut',version:'1',sizeBytes:null,shortcutTargetId:`photo-${i}`}));
  const remote:SourceRemote={async startToken(){return {ok:true,token:'token'};},async list(){return {ok:true,items:shortcuts,nextPageToken:null,incomplete:false};},async metadata(id){time+=300_000;return {ok:true,item:{id,name:id,mimeType:'image/jpeg',version:'1',sizeBytes:1}};},async download(){throw Error('photo must not download');}};
  expect(await sourceSyncHandler({store,remote,clock:localClock,idGen:sequenceIdGen({timestampMs:now.getTime(),start:500})})(item)).toEqual({ok:true});
  expect(time-now.getTime()).toBe(1_200_000);const rows=await store.listSourceEntries(item.targetId);expect(rows.ok&&rows.entries.map(e=>e.indexStatus)).toEqual(['photo','photo','photo','photo']);
});
it('fake source work scope tracks only current handoffs and their outcomes',async()=>{
 const sync={...item,completedAt:now,outcome:'succeeded' as const},fileId='019a0000-0000-7000-8000-000000000050',extractId='019a0000-0000-7000-8000-000000000051',otherId='019a0000-0000-7000-8000-000000000052';
 const extraction:WorkItem={...item,id:extractId,kind:'document_extract',targetKind:'file',targetId:fileId,completedAt:null,outcome:null,nextAttemptAt:new Date(now.getTime()+60_000)};
 const unrelated:WorkItem={...extraction,id:otherId,nextAttemptAt:now};const work=new Map<string,WorkItem>([[sync.id,sync],[extractId,extraction],[otherId,unrelated]]);
 const queue={async work(id:string){return work.get(id)??null;},async hasDue(ids:string[],at:Date){return {ok:true as const,due:ids.some(id=>{const w=work.get(id);return !!w&&!w.completedAt&&w.nextAttemptAt<=at;})};},async claim(ids:string[],at:Date,_by:string){const w=ids.map(id=>work.get(id)).find(w=>w&&!w.completedAt&&w.nextAttemptAt<=at);return {ok:true as const,item:w??null};}};
 const store=memorySourceStore({claim:()=>true,renew:()=>true,file:()=>({id:fileId,redacted:false}),extraction:()=>true,workOpen:id=>work.has(id),isRedacted:()=>false,handoff:()=>{},queue});
 await store.ensureSource({id:item.targetId,kind:'drive',account:'scope',rootId:'root'});const c={workId:item.id,claimedBy:'worker',claimedAt:now,attempts:1,now},scan='019a0000-0000-7000-8000-000000000053',sf='019a0000-0000-7000-8000-000000000054';
 await store.beginSourceScan({sourceId:item.targetId,generation:1,scanId:scan,startToken:'t',claim:c});await store.observeSourceEntry({sourceId:item.targetId,generation:1,scanId:scan,claim:c,entry:{id:sf,remoteId:'r',name:'n',path:'',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:1}});
 await store.handoffSourceFile({sourceId:item.targetId,generation:1,sourceFileId:sf,remoteVersion:'v1',fileId,contentHash:'hash',sizeBytes:1,workId:extractId,claim:c});
 const scope={sourceId:item.targetId,syncWorkId:item.id};expect(await store.hasDueSourceWork({...scope,now})).toEqual({ok:true,due:false});expect(await store.claimSourceWork({...scope,now,claimedBy:'w'})).toEqual({ok:true,item:null});expect(await store.readSourceWorkStatus(scope)).toEqual({ok:true,complete:false});
 extraction.nextAttemptAt=now;expect(await store.claimSourceWork({...scope,now,claimedBy:'w'})).toMatchObject({ok:true,item:{id:extractId}});
 extraction.completedAt=now;extraction.outcome='failed';expect(await store.readSourceWorkStatus(scope)).toEqual({ok:true,complete:false});
 await store.markSourceFileOutcome({sourceFileId:sf,fileId,remoteVersion:'v1',status:'unsupported',claim:{...c,workId:extractId}});extraction.outcome='succeeded';expect(await store.readSourceWorkStatus(scope)).toEqual({ok:true,complete:true});
 expect(await store.readSourceWorkStatus({sourceId:otherId,syncWorkId:item.id})).toEqual({ok:true,complete:false});
});
it('fake late shared handoff links only a current publication and obeys version and redaction fences',async()=>{
 let redacted=false,current=true;const fileId='019a0000-0000-7000-8000-000000000060',workId='019a0000-0000-7000-8000-000000000061',extractionId='019a0000-0000-7000-8000-000000000062',scan='019a0000-0000-7000-8000-000000000063';
 const store=memorySourceStore({claim:()=>true,renew:()=>true,file:()=>({id:fileId,redacted}),extraction:()=>true,workOpen:id=>id===workId,isRedacted:()=>redacted,publishedCurrent:()=>current,handoff:()=>{}});
 await store.ensureSource({id:item.targetId,kind:'drive',account:'late',rootId:'root'});const claim={workId:item.id,claimedBy:'worker',claimedAt:now,attempts:1,now};await store.beginSourceScan({sourceId:item.targetId,generation:1,scanId:scan,startToken:'t',claim});
 const entryIds=['019a0000-0000-7000-8000-000000000064','019a0000-0000-7000-8000-000000000065','019a0000-0000-7000-8000-000000000066','019a0000-0000-7000-8000-000000000067'];
 for(const id of entryIds)await store.observeSourceEntry({sourceId:item.targetId,generation:1,scanId:scan,claim,entry:{id,remoteId:id,name:id,path:'',mimeType:'text/plain',remoteVersion:'1',sizeBytes:3}});
 const base={sourceId:item.targetId,generation:1,sourceFileId:entryIds[0]!,remoteVersion:'1',fileId,contentHash:'hash',sizeBytes:3,workId,claim};expect(await store.handoffSourceFile(base)).toMatchObject({ok:true});
 const extractClaim={...claim,workId};expect(await store.bindSourceAttempt({sourceFileId:entryIds[0]!,fileId,remoteVersion:'1',tempKey:'owned',extractionId,claim:extractClaim})).toMatchObject({ok:true});
 expect(await store.publishSourceFile({sourceId:item.targetId,generation:1,sourceFileId:entryIds[0]!,fileId,remoteVersion:'1',contentHash:'hash',extractionId,outcome:{status:'ok',mediaType:'text/plain',indexConfigId:null},claim:extractClaim})).toMatchObject({ok:true});
 expect(await store.handoffSourceFile({...base,sourceFileId:entryIds[1]!})).toMatchObject({ok:true,workId});expect(await store.handoffSourceFile({...base,sourceFileId:entryIds[1]!})).toMatchObject({ok:true,workId});
 current=false;expect(await store.handoffSourceFile({...base,sourceFileId:entryIds[2]!})).toMatchObject({ok:false,code:'SOURCE_CHANGED'});
 expect(await store.handoffSourceFile({...base,sourceFileId:entryIds[3]!,remoteVersion:'wrong'})).toMatchObject({ok:false,code:'SOURCE_CHANGED'});
 redacted=true;expect(await store.handoffSourceFile({...base,sourceFileId:entryIds[3]!})).toMatchObject({ok:false,code:'FILE_REDACTED'});
 const result=await store.listSourceEntries(item.targetId);expect(result).toMatchObject({ok:true,entries:expect.arrayContaining([expect.objectContaining({id:entryIds[1],indexStatus:'indexed',completedHash:'hash'}),expect.objectContaining({id:entryIds[2],indexStatus:'pending',completedHash:null}),expect.objectContaining({id:entryIds[3],indexStatus:'failed',completedHash:null})])});
});
it('fake closes only the bound extraction claim and settles every shared handoff',async()=>{
 let closed=0,active=true;const f=fixture(),file='019a0000-0000-7000-8000-000000000080',work='019a0000-0000-7000-8000-000000000081',extraction='019a0000-0000-7000-8000-000000000082',scan='019a0000-0000-7000-8000-000000000083',ids=['019a0000-0000-7000-8000-000000000084','019a0000-0000-7000-8000-000000000085'];
 const store=memorySourceStore({claim:c=>c.claimedBy==='worker'&&c.attempts===1,renew:()=>true,file:()=>({id:file,redacted:false}),extraction:()=>true,workOpen:()=>active,isRedacted:()=>false,handoff:()=>{},finishExtraction:(_f,id)=>{if(id!==extraction)return false;closed++;return true;},recoverExtraction:(_f,id)=>id===extraction});
 await store.ensureSource({id:item.targetId,kind:'drive',account:'fake-close',rootId:'root'});const owner={workId:item.id,claimedBy:'worker',claimedAt:now,attempts:1,now};await store.beginSourceScan({sourceId:item.targetId,generation:1,scanId:scan,startToken:'t',claim:owner});for(const id of ids){await store.observeSourceEntry({sourceId:item.targetId,generation:1,scanId:scan,claim:owner,entry:{id,remoteId:id,name:id,path:'',mimeType:'text/plain',remoteVersion:'1',sizeBytes:3}});await store.handoffSourceFile({sourceId:item.targetId,generation:1,sourceFileId:id,remoteVersion:'1',fileId:file,contentHash:'hash',sizeBytes:3,workId:work,claim:owner});}
 const extractClaim={...owner,workId:work};await store.bindSourceAttempt({sourceFileId:ids[0]!,fileId:file,remoteVersion:'1',tempKey:'owned',extractionId:extraction,claim:extractClaim});
 expect(await store.finishSourceAttempt({fileId:file,extractionId:extraction,claim:{...extractClaim,attempts:2},outcome:{status:'unsupported',error:'x',mediaType:null}})).toMatchObject({ok:false,code:'CLAIM_LOST'});
 expect(await store.finishSourceAttempt({fileId:file,extractionId:extraction,claim:extractClaim,outcome:{status:'unsupported',error:'x',mediaType:null}})).toMatchObject({ok:true});expect(closed).toBe(1);const rows=await store.listSourceEntries(item.targetId);expect(rows.ok&&rows.entries.map(e=>e.indexStatus)).toEqual(['unsupported','unsupported']);expect(await store.recoverSourceAttempt('owned',now)).toMatchObject({ok:true,binding:{open:true}});active=false;expect(await store.recoverSourceAttempt('owned',now)).toMatchObject({ok:true,binding:{open:false}});void f;
});

it('disconnect during a remote download refuses the late handoff',async()=>{
  const f=fixture();await f.store.ensureSource({id:item.targetId,kind:'drive',account:'download-fence',rootId:'root'});
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});const hold=new Promise<void>(r=>{release=r;});
  const remote:SourceRemote={...f.remote,async download(){entered();await hold;return {ok:true,bytes:new Uint8Array([97,98,99])};}};
  const sync=sourceSyncHandler({store:f.store,remote,clock,idGen:f.ids})(item);await started;
  expect(await f.store.disconnectSource({id:item.targetId,now})).toMatchObject({ok:true,source:{connected:false}});release();
  expect(await sync).toMatchObject({ok:false});expect(f.handoffs).toEqual([]);
});

it('clears recorded source authentication failures only after a successful scan',async()=>{
  const f=fixture();await f.store.ensureSource({id:item.targetId,kind:'drive',account:'resolved',rootId:'root'});const calls:string[]=[];
  const store={...f.store,async resolveFailures(input:{targetKind:string;targetId:string;stage:string;now:Date}){calls.push(`${input.targetKind}:${input.targetId}:${input.stage}`);return {ok:true as const,resolved:1};}};
  const failed={...f.remote,async startToken(){return {ok:false as const,code:'AUTH_REQUIRED' as const,message:'Drive 재동의가 필요합니다'};}};
  expect(await sourceSyncHandler({store,remote:failed,clock,idGen:f.ids})(item)).toMatchObject({ok:false,retryable:false});expect(calls).toEqual([]);
  expect(await sourceSyncHandler({store,remote:f.remote,clock,idGen:f.ids})(item)).toEqual({ok:true});expect(calls).toEqual([`source:${item.targetId}:source_sync`]);
});

it('원격 version이 바이트 판정 중 바뀌면 marker와 handoff를 만들지 않는다',async()=>{
 const f=fixture(),id='binary',entry={id,name:'elsewhere.bin',mimeType:'application/octet-stream',version:'1',sizeBytes:5};await f.store.ensureSource({id:item.targetId,kind:'drive',account:'carry-version',rootId:'root'});let version='1';
 const remote:SourceRemote={async startToken(){return {ok:true,token:'t'};},async list(){return {ok:true,items:[entry],nextPageToken:null,incomplete:false};},async metadata(){return {ok:true,item:{...entry,version}};},async download(){return {ok:true,bytes:Uint8Array.of(37,80,68,70,45)};}};
 const probe:import('../src/files/extractors.js').DocumentExtractor={name:'synthetic',detect:()=>null,detectCarry:async()=>{version='2';return true;},extract:async()=>({ok:true,pieces:[]})};
 expect(await sourceSyncHandler({store:f.store,remote,clock,idGen:f.ids,extractors:[probe]})(item)).toMatchObject({ok:false,code:'SOURCE_CHANGED'});expect(f.handoffs).toHaveLength(0);const rows=await f.store.listSourceEntries(item.targetId);if(!rows.ok)throw Error('source rows');const checked=await f.store.readSourceCarryCheck({sourceFileId:rows.entries[0]!.id,remoteVersion:'1',extractorVersion:(await import('../src/files/extractors.js')).DOCUMENT_EXTRACTOR_VERSION});expect(checked).toMatchObject({ok:true,checked:false});
});

it('disconnect가 바이트 판정 중 발생하면 source generation fence가 marker와 handoff를 거부한다',async()=>{
 const f=fixture(),entry={id:'binary',name:'one.bin',mimeType:'application/octet-stream',version:'1',sizeBytes:5};await f.store.ensureSource({id:item.targetId,kind:'drive',account:'carry-disconnect',rootId:'root'});
 const remote:SourceRemote={async startToken(){return {ok:true,token:'t'};},async list(){return {ok:true,items:[entry],nextPageToken:null,incomplete:false};},async metadata(){return {ok:true,item:entry};},async download(){return {ok:true,bytes:Uint8Array.of(37,80,68,70,45)};}};
 const probe:import('../src/files/extractors.js').DocumentExtractor={name:'synthetic',detect:()=>null,detectCarry:async()=>{await f.store.disconnectSource({id:item.targetId,now});return true;},extract:async()=>({ok:true,pieces:[]})};
 expect(await sourceSyncHandler({store:f.store,remote,clock,idGen:f.ids,extractors:[probe]})(item)).toMatchObject({ok:false});expect(f.handoffs).toHaveLength(0);const rows=await f.store.listSourceEntries(item.targetId);if(!rows.ok)throw Error('source rows');expect(await f.store.readSourceCarryCheck({sourceFileId:rows.entries[0]!.id,remoteVersion:'1',extractorVersion:(await import('../src/files/extractors.js')).DOCUMENT_EXTRACTOR_VERSION})).toMatchObject({ok:true,checked:false});
});

it('fake source Carry는 이미 시작된 scan 완료 뒤 새 work를 예약한다',async()=>{
 let completed:((workId:string,at:Date)=>void)|undefined;let active=item.id;const queued:string[]=[];
 const store=memorySourceStore({claim:()=>true,renew:()=>true,file:(_h,_s,id)=>({id,redacted:false}),extraction:()=>true,workOpen:()=>false,isRedacted:()=>false,handoff:()=>{},carryEnqueue:(_source,requested)=>{const id=active||requested;queued.push(id);return {workId:id};},onCarryCompletion:fn=>{completed=fn;}});
 await store.ensureSource({id:item.targetId,kind:'drive',account:'carry-fake-queue',rootId:'root'});const claim={workId:item.id,claimedBy:'worker',claimedAt:now,attempts:1,now},scan='019a0000-0000-7000-8000-000000000081',sf='019a0000-0000-7000-8000-000000000082';await store.beginSourceScan({sourceId:item.targetId,generation:1,scanId:scan,startToken:'t',claim});await store.observeSourceEntry({sourceId:item.targetId,generation:1,scanId:scan,claim,entry:{id:sf,remoteId:'binary',name:'x',path:'',mimeType:'application/octet-stream',remoteVersion:'1',sizeBytes:3}});await store.markSourceEntry({sourceId:item.targetId,generation:1,sourceFileId:sf,remoteVersion:'1',status:'unsupported',claim});expect(await store.reserveSourceCarry({sourceId:item.targetId,generation:1,extractorVersion:'new',workId:'019a0000-0000-7000-8000-000000000083',now})).toMatchObject({ok:true,reserved:true});await store.finishSourceScan({sourceId:item.targetId,generation:1,scanId:scan,claim});active='';completed?.(item.id,now);expect(queued).toHaveLength(2);expect(queued[1]).not.toBe(item.id);
});

it('형식 판정의 too_large는 상태를 보존하고 재다운로드하지 않는다',async()=>{
 const f=fixture(),entry={id:'zip',name:'z.bin',mimeType:'application/octet-stream',version:'1',sizeBytes:4};await f.store.ensureSource({id:item.targetId,kind:'drive',account:'carry-limit',rootId:'root'});let downloads=0;
 const remote:SourceRemote={async startToken(){return {ok:true,token:'t'};},async list(){return {ok:true,items:[entry],nextPageToken:null,incomplete:false};},async metadata(){return {ok:true,item:entry};},async download(){downloads++;return {ok:true,bytes:Uint8Array.of(80,75,3,4)};}};
 const probe:import('../src/files/extractors.js').DocumentExtractor={name:'synthetic',detect:()=>null,detectCarry:async()=> 'too_large',extract:async()=>({ok:true,pieces:[]})};const sync=sourceSyncHandler({store:f.store,remote,clock,idGen:f.ids,extractors:[probe]});expect(await sync(item)).toEqual({ok:true});expect(await sync(item)).toEqual({ok:true});expect(downloads).toBe(1);const rows=await f.store.listSourceEntries(item.targetId);expect(rows.ok&&rows.entries[0]?.indexStatus).toBe('too_large');expect(f.handoffs).toHaveLength(0);
});


it('크기를 모르는 원격 전송 초과는 버전 재검증 후 marker를 남긴다',async()=>{
 const f=fixture(),entry={id:'oversize',name:'large.bin',mimeType:'application/octet-stream',version:'1',sizeBytes:null};await f.store.ensureSource({id:item.targetId,kind:'drive',account:'carry-transfer-limit',rootId:'root'});let downloads=0,version='1';
 const remote:SourceRemote={async startToken(){return {ok:true,token:'t'};},async list(){return {ok:true,items:[entry],nextPageToken:null,incomplete:false};},async metadata(){return {ok:true,item:{...entry,version}};},async download(){downloads++;return {ok:false,code:'TOO_LARGE',message:'limit'};}};
 const probe:import('../src/files/extractors.js').DocumentExtractor={name:'probe',detect:()=>null,detectCarry:async()=>true,extract:async()=>({ok:true,pieces:[]})};const sync=sourceSyncHandler({store:f.store,remote,clock,idGen:f.ids,extractors:[probe]});
 expect(await sync(item)).toEqual({ok:true});expect(await sync(item)).toEqual({ok:true});expect(downloads).toBe(1);
 version='2';const changed={...remote,async list(){return {ok:true as const,items:[{...entry,version:'2'}],nextPageToken:null,incomplete:false};}};expect(await sourceSyncHandler({store:f.store,remote:changed,clock,idGen:f.ids,extractors:[probe]})(item)).toEqual({ok:true});expect(downloads).toBe(2);
});

it('fake Carry는 terminal 실패 뒤 새 work로 이어지고 foreground 범위에 포함한다',async()=>{
 const old='019a0000-0000-7000-8000-000000000091',next='019a0000-0000-7000-8000-000000000092',root='019a0000-0000-7000-8000-000000000093',scan='019a0000-0000-7000-8000-000000000094',sf='019a0000-0000-7000-8000-000000000095';
 const work=new Map<string,WorkItem>([[old,{...item,id:old}],[root,{...item,id:root,completedAt:now,outcome:'succeeded'}]]);let selected:string[]=[];
 const queue={async work(id:string){return work.get(id)??null;},async hasDue(ids:string[]){selected=ids;return {ok:true as const,due:ids.includes(next)};},async claim(ids:string[]){selected=ids;return {ok:true as const,item:work.get(next)??null};}};
 const store=memorySourceStore({claim:()=>true,renew:()=>true,file:(_h,_s,id)=>({id,redacted:false}),extraction:()=>true,workOpen:()=>false,isRedacted:()=>false,handoff:()=>{},queue,carryEnqueue:(_source,id)=>({workId:id})});
 await store.ensureSource({id:item.targetId,kind:'drive',account:'fake-carry-failure',rootId:'root'});const sourceClaim={workId:old,claimedBy:'worker',claimedAt:now,attempts:1,now};
 await store.beginSourceScan({sourceId:item.targetId,generation:1,scanId:scan,startToken:'t',claim:sourceClaim});await store.observeSourceEntry({sourceId:item.targetId,generation:1,scanId:scan,claim:sourceClaim,entry:{id:sf,remoteId:'x',name:'x',path:'',mimeType:'application/octet-stream',remoteVersion:'1',sizeBytes:3}});await store.markSourceEntry({sourceId:item.targetId,generation:1,sourceFileId:sf,remoteVersion:'1',status:'unsupported',claim:sourceClaim});
 expect(await store.reserveSourceCarry({sourceId:item.targetId,generation:1,extractorVersion:'A',workId:old,now})).toMatchObject({ok:true,reserved:true});work.set(old,{...item,id:old,completedAt:now,outcome:'failed'});work.set(next,{...item,id:next});
 expect(await store.reserveSourceCarry({sourceId:item.targetId,generation:1,extractorVersion:'B',workId:next,now})).toMatchObject({ok:true,reserved:true});expect(await store.hasDueSourceWork({sourceId:item.targetId,syncWorkId:root,now})).toMatchObject({ok:true,due:true});expect(selected).toContain(next);
 const nextClaim={...sourceClaim,workId:next};await store.beginSourceScan({sourceId:item.targetId,generation:1,scanId:scan,startToken:'t2',claim:nextClaim});await store.finishSourceScan({sourceId:item.targetId,generation:1,scanId:scan,claim:nextClaim});expect(await store.readSourceWorkStatus({sourceId:item.targetId,syncWorkId:root})).toMatchObject({ok:true,complete:true});
});

it('pending page work is drained into a handoff before full sync resumes',async()=>{
  const f=fixture(), sourceId=item.targetId, claim={workId:item.id,claimedBy:'worker',claimedAt:now,attempts:1,now};
  await f.store.ensureSource({id:sourceId,kind:'drive',account:'pending-page',rootId:'root'});
  const scan='019a0000-0000-7000-8000-000000000011',sf='019a0000-0000-7000-8000-000000000012';
  await f.store.beginSourceScan({sourceId,generation:1,scanId:scan,startToken:'old',claim});await f.store.finishSourceScan({sourceId,generation:1,scanId:scan,claim});
  await f.store.applySourceChanges({sourceId,generation:1,expectedCursor:'old',nextCursor:'next',claim,changes:[{kind:'upsert',entry:{id:sf,remoteId:'text',name:'text',path:'',mimeType:'text/plain',remoteVersion:'1',sizeBytes:3}}]});
  expect(f.store.canCompleteSourceSync(sourceId)).toBe(false);
  expect(await sourceSyncHandler({store:f.store,remote:f.remote,clock,idGen:f.ids})(item)).toMatchObject({ok:true});
  expect(f.handoffs.length).toBeGreaterThan(0);
  expect(f.store.canCompleteSourceSync(sourceId)).toBe(true);
});

function changesHarness(){
  type RemoteItem=import('../src/index.js').RemoteSourceItem;
  const entries=new Map<string,RemoteItem>(),pages=new Map<string,import('../src/index.js').RemoteResult<{changes:{remoteId:string;removed:boolean;item?:RemoteItem}[];nextPageToken:string|null;newStartPageToken:string|null}>>();
  const calls:string[]=[],contents=new Map<string,Uint8Array>(),hashes=new Map<string,string>();let rejectList=false,failMetadata=false;
  const store=memorySourceStore({claim:()=>true,renew:()=>true,file:(hash,_size,id)=>{if(!hashes.has(hash))hashes.set(hash,id);return {id:hashes.get(hash)!,redacted:false};},extraction:()=>true,workOpen:()=>true,isRedacted:()=>false,handoff:()=>{}});
  const remote:SourceRemote={async startToken(){calls.push('start');return {ok:true,token:'token'};},async changes({pageToken}){calls.push(`changes:${pageToken}`);return pages.get(pageToken)??{ok:true,changes:[],nextPageToken:null,newStartPageToken:pageToken};},async list({parentId}){calls.push(`list:${parentId}`);return {ok:true,items:[...entries.values()].filter(x=>x.parents?.includes(parentId)),nextPageToken:null,incomplete:rejectList};},async metadata(id){calls.push(`meta:${id}`);if(failMetadata){failMetadata=false;return {ok:false,code:'TEMPORARY',message:'synthetic'};}const found=entries.get(id);return found?{ok:true,item:found}:{ok:false,code:'UNREACHABLE',message:'synthetic'};},async download({id}){calls.push(`download:${id}`);return {ok:true,bytes:contents.get(id)??new Uint8Array([1,2,3])};}};
  const run=sourceSyncHandler({store,remote,clock,idGen:sequenceIdGen({timestampMs:now.getTime(),start:1000})});
  const claim={workId:item.id,claimedBy:'worker',claimedAt:now,attempts:1,now};
  const init=async()=>{await store.ensureSource({id:item.targetId,kind:'drive',account:'changes',rootId:'root'});expect(await run(item)).toEqual({ok:true});};
  return {entries,pages,calls,contents,store,remote,run,init,claim,failNextMetadata:()=>{failMetadata=true;},setIncomplete:(value:boolean)=>{rejectList=value;}};
}

it('changes_page_checkpoint_restart drains committed handoff before requesting the next page',async()=>{
  const h=changesHarness(),v1={id:'photo',name:'photo',mimeType:'image/jpeg',version:'v1',sizeBytes:3,parents:['root']};h.entries.set('photo',v1);await h.init();h.calls.length=0;
  const v2={...v1,version:'v2'};h.entries.set('photo',v2);h.pages.set('token',{ok:true,changes:[{remoteId:'photo',removed:false,item:v2}],nextPageToken:'page2',newStartPageToken:null});h.pages.set('page2',{ok:true,changes:[],nextPageToken:null,newStartPageToken:'next-start'});h.failNextMetadata();
  expect(await h.run(item)).toMatchObject({ok:false});expect(await h.store.readSource(item.targetId)).toMatchObject({ok:true,source:{cursor:'page2'}});
  expect(await h.store.listSourceChangeTasks({sourceId:item.targetId,generation:1,claim:h.claim})).toMatchObject({ok:true,tasks:[{remoteVersion:'v2'}]});
  h.calls.length=0;expect(await h.run(item)).toEqual({ok:true});expect(h.calls.indexOf('meta:photo')).toBeLessThan(h.calls.indexOf('changes:page2'));
  expect(await h.store.readSource(item.targetId)).toMatchObject({ok:true,source:{cursor:'next-start'}});expect(await h.store.listSourceChangeTasks({sourceId:item.targetId,generation:1,claim:h.claim})).toEqual({ok:true,tasks:[]});
});

it('cursor_rejected_full_scan_atomic_prune waits for a complete scan',async()=>{
  const h=changesHarness(),v={id:'old',name:'old',mimeType:'image/jpeg',version:'v1',sizeBytes:3,parents:['root']};h.entries.set('old',v);await h.init();h.entries.delete('old');h.pages.set('token',{ok:false,code:'CHANGED',message:'synthetic'});h.setIncomplete(true);
  expect(await h.run(item)).toMatchObject({ok:false,code:'SOURCE_INCOMPLETE'});let rows=await h.store.listSourceEntries(item.targetId);expect(rows).toMatchObject({ok:true,entries:[{remoteId:'old',unreachable:false}]});
  h.setIncomplete(false);expect(await h.run(item)).toEqual({ok:true});rows=await h.store.listSourceEntries(item.targetId);expect(rows).toMatchObject({ok:true,entries:[{remoteId:'old',unreachable:true}]});
});

it('changes_paths_versions_recovery keeps completed generation on rename, move and new bytes',async()=>{
  const h=changesHarness(),v1={id:'text',name:'one.txt',mimeType:'text/plain',version:'v1',sizeBytes:3,parents:['root']};h.entries.set('text',v1);h.contents.set('text',new Uint8Array([1,2,3]));await h.init();
  const listed=await h.store.listSourceEntries(item.targetId);if(!listed.ok||!listed.entries[0])throw Error('source missing');const first=listed.entries[0];
  // Locate the synthetic work through the fake's stable hash mapping by staging a known identity.
  const file='019a0000-0000-7000-8000-000000000910',work='019a0000-0000-7000-8000-000000000911',extract='019a0000-0000-7000-8000-000000000912';
  const hash=(await import('../src/index.js')).contentHashOfBytes(new Uint8Array([1,2,3]));const prepared=await h.store.handoffSourceFile({sourceId:item.targetId,generation:1,sourceFileId:first.id,remoteVersion:'v1',fileId:file,contentHash:hash,sizeBytes:3,workId:work,claim:h.claim});if(!prepared.ok)throw Error('handoff');
  const extractionClaim={...h.claim,workId:prepared.workId};await h.store.bindSourceAttempt({sourceFileId:first.id,fileId:prepared.fileId,remoteVersion:'v1',tempKey:'synthetic',extractionId:extract,claim:extractionClaim});
  expect(await h.store.publishSourceFile({sourceId:item.targetId,generation:1,sourceFileId:first.id,fileId:prepared.fileId,remoteVersion:'v1',contentHash:hash,extractionId:extract,outcome:{status:'ok',mediaType:'text/plain',indexConfigId:null},claim:extractionClaim})).toMatchObject({ok:true});
  const renamed={...v1,name:'two.txt'};h.entries.set('text',renamed);h.pages.set('token',{ok:true,changes:[{remoteId:'text',removed:false,item:renamed}],nextPageToken:null,newStartPageToken:'t2'});h.calls.length=0;
  expect(await h.run(item)).toEqual({ok:true});expect(h.calls).not.toContain('download:text');
  const cursor=async()=>{const result=await h.store.readSource(item.targetId);if(!result.ok||!result.source?.cursor)throw Error('missing cursor');return result.source.cursor;};
  const outside={...renamed,parents:['outside']};h.entries.set('outside',{id:'outside',name:'outside',mimeType:'application/vnd.google-apps.folder',version:'1',sizeBytes:null,parents:[]});h.entries.set('text',outside);
  let current=await cursor();h.pages.set(current,{ok:true,changes:[{remoteId:'text',removed:false,item:outside}],nextPageToken:null,newStartPageToken:'t3'});h.calls.length=0;expect(await h.run(item)).toEqual({ok:true});expect(h.calls).toContain(`changes:${current}`);expect(h.calls).not.toContain('download:text');
  expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[{remoteId:'text',unreachable:true,completedHash:hash}]});
  h.entries.set('text',renamed);current=await cursor();h.pages.set(current,{ok:true,changes:[{remoteId:'text',removed:false,item:renamed}],nextPageToken:null,newStartPageToken:'t4'});h.calls.length=0;expect(await h.run(item)).toEqual({ok:true});expect(h.calls).toContain(`changes:${current}`);expect(h.calls).not.toContain('download:text');
  expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[{remoteId:'text',unreachable:false,completedVersion:'v1',completedHash:hash}]});
  const v2={...renamed,version:'v2'};h.entries.set('text',v2);h.contents.set('text',new Uint8Array([4,5,6]));current=await cursor();h.pages.set(current,{ok:true,changes:[{remoteId:'text',removed:false,item:v2}],nextPageToken:null,newStartPageToken:'t5'});h.calls.length=0;expect(await h.run(item)).toEqual({ok:true});expect(h.calls).toContain(`changes:${current}`);expect(h.calls).toContain('download:text');
  expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[{remoteId:'text',unreachable:false,remoteVersion:'v2',completedVersion:'v1',completedHash:hash}]});
});

it('folder rename triggers complete reconciliation and recomputes descendant paths',async()=>{
  const h=changesHarness(),folder={id:'folder',name:'before',mimeType:'application/vnd.google-apps.folder',version:'1',sizeBytes:null,parents:['root']},photo={id:'photo',name:'photo',mimeType:'image/jpeg',version:'1',sizeBytes:3,parents:['folder']};
  h.entries.set('folder',folder);h.entries.set('photo',photo);await h.init();expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[{path:'before'}]});
  const renamed={...folder,name:'after',version:'2'};h.entries.set('folder',renamed);h.pages.set('token',{ok:true,changes:[{remoteId:'folder',removed:false,item:renamed}],nextPageToken:null,newStartPageToken:'unused'});h.calls.length=0;
  expect(await h.run(item)).toEqual({ok:true});expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[{path:'after',unreachable:false}]});expect(h.calls).toContain('list:folder');
});

it('weekly reconciliation runs only after the durable complete-scan interval',async()=>{
  const h=changesHarness();await h.init();h.calls.length=0;expect(await h.run(item)).toEqual({ok:true});expect(h.calls).not.toContain('list:root');
  const future={now:()=>new Date(now.getTime()+8*86400000)},run=sourceSyncHandler({store:h.store,remote:h.remote,clock:future,idGen:sequenceIdGen({timestampMs:now.getTime(),start:2000})});h.calls.length=0;
  expect(await run(item)).toEqual({ok:true});expect(h.calls).toContain('list:root');
});

it('incomplete full scan defers unreachable evidence until scan completion',async()=>{
  const h=changesHarness(),v={id:'old',name:'old.txt',mimeType:'text/plain',version:'v1',sizeBytes:3,parents:['root']};h.entries.set('old',v);await h.init();
  const scan='019a0000-0000-7000-8000-000000000970';expect(await h.store.beginSourceScan({sourceId:item.targetId,generation:1,scanId:scan,startToken:'new',claim:h.claim})).toMatchObject({ok:true});
  const prior=await h.store.listSourceEntries(item.targetId);if(!prior.ok||!prior.entries[0])throw Error('source missing');const row=prior.entries[0];
  expect(await h.store.observeSourceEntry({sourceId:item.targetId,generation:1,scanId:scan,claim:h.claim,entry:{id:row.id,remoteId:row.remoteId,name:row.name,path:row.path,mimeType:row.mimeType,remoteVersion:row.remoteVersion,sizeBytes:row.sizeBytes}})).toMatchObject({ok:true});
  expect(await h.store.deferSourceScanUnreachable({sourceId:item.targetId,generation:1,scanId:scan,sourceFileId:row.id,remoteVersion:row.remoteVersion,claim:h.claim})).toMatchObject({ok:true});
  expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[{remoteId:'old',unreachable:false}]});
  expect(await h.store.finishSourceScan({sourceId:item.targetId,generation:1,scanId:scan,claim:h.claim})).toMatchObject({ok:true});expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[{remoteId:'old',unreachable:true}]});
});

it('removed untracked folder forces full reconciliation before descendant pruning',async()=>{
  const h=changesHarness();h.entries.set('folder',{id:'folder',name:'folder',mimeType:'application/vnd.google-apps.folder',version:'1',sizeBytes:null,parents:['root']});h.entries.set('photo',{id:'photo',name:'photo',mimeType:'image/jpeg',version:'1',sizeBytes:3,parents:['folder']});await h.init();
  h.entries.delete('folder');h.entries.delete('photo');h.pages.set('token',{ok:true,changes:[{remoteId:'folder',removed:true}],nextPageToken:null,newStartPageToken:'after'});h.setIncomplete(true);
  expect(await h.run(item)).toMatchObject({ok:false,code:'SOURCE_INCOMPLETE'});expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[{remoteId:'photo',unreachable:false}]});
  h.setIncomplete(false);expect(await h.run(item)).toEqual({ok:true});expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[{remoteId:'photo',unreachable:true}]});
});

it('shortcut target outside a watched root remains reachable after its change',async()=>{
  const h=changesHarness(),target={id:'target',name:'target',mimeType:'image/jpeg',version:'1',sizeBytes:3,parents:['outside']},alias={id:'alias',name:'alias',mimeType:'application/vnd.google-apps.shortcut',version:'1',sizeBytes:null,parents:['root'],shortcutTargetId:'target'};
  h.entries.set('target',target);h.entries.set('alias',alias);h.entries.set('outside',{id:'outside',name:'outside',mimeType:'application/vnd.google-apps.folder',version:'1',sizeBytes:null,parents:[]});await h.init();
  expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[{remoteId:'target',name:'alias',unreachable:false}]});
  const changed={...target,version:'2'};h.entries.set('target',changed);h.pages.set('token',{ok:true,changes:[{remoteId:'target',removed:false,item:changed}],nextPageToken:null,newStartPageToken:'next'});
  expect(await h.run(item)).toEqual({ok:true});expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[{remoteId:'target',name:'alias',unreachable:false}]});
});

it('unknown outside structure is reconciled without trusting server creation time',async()=>{
 const h=changesHarness();h.entries.set('outside',{id:'outside',name:'outside',mimeType:'application/vnd.google-apps.folder',version:'2',sizeBytes:null,parents:[]});await h.init();h.calls.length=0;
 const external={id:'new-folder',name:'new-folder',mimeType:'application/vnd.google-apps.folder',version:'1',sizeBytes:null,parents:['outside'],createdTime:'2026-01-01T00:00:01Z'};
 h.pages.set('token',{ok:true,changes:[{remoteId:external.id,removed:false,item:external}],nextPageToken:null,newStartPageToken:'next'});expect(await h.run(item)).toEqual({ok:true});expect(h.calls).toContain('list:root');
});

it('changes retain the first shortcut alias when its target is also inside the watched root',async()=>{
 const h=changesHarness();const target={id:'target',name:'original.txt',mimeType:'text/plain',version:'1',sizeBytes:3,parents:['root']};const alias={id:'alias',name:'first-alias.txt',mimeType:'application/vnd.google-apps.shortcut',version:'1',sizeBytes:null,parents:['root'],shortcutTargetId:'target'};
 h.entries.set(alias.id,alias);h.entries.set(target.id,target);await h.init();let entries=await h.store.listSourceEntries(item.targetId);expect(entries.ok&&entries.entries.find(e=>e.remoteId==='target')?.name).toBe('first-alias.txt');
 const updated={...target,version:'2'};h.entries.set(target.id,updated);h.pages.set('token',{ok:true,changes:[{remoteId:'target',removed:false,item:updated}],nextPageToken:null,newStartPageToken:'next'});expect(await h.run(item)).toEqual({ok:true});
 entries=await h.store.listSourceEntries(item.targetId);expect(entries.ok&&entries.entries.find(e=>e.remoteId==='target')).toMatchObject({name:'first-alias.txt',path:'',remoteVersion:'2'});
});

it('many durable tasks read the source entry batch a bounded number of times',async()=>{
 const h=changesHarness();await h.init();const changes=Array.from({length:30},(_,i)=>{const remoteId=`photo${i}`,entry={id:remoteId,name:remoteId,mimeType:'image/jpeg',version:'1',sizeBytes:1,parents:['root']};h.entries.set(remoteId,entry);return {kind:'upsert' as const,entry:{id:remoteId,remoteId,name:remoteId,path:'',mimeType:entry.mimeType,remoteVersion:'1',sizeBytes:1}};});
 expect(await h.store.applySourceChanges({sourceId:item.targetId,generation:1,expectedCursor:'token',nextCursor:'next',changes,claim:h.claim})).toMatchObject({ok:true});let reads=0;const wrapped={...h.store,async listSourceEntries(id:string){reads++;return h.store.listSourceEntries(id);}};
 const sync=sourceSyncHandler({store:wrapped,remote:h.remote,clock,idGen:sequenceIdGen({timestampMs:now.getTime(),start:2000})});expect(await sync(item)).toEqual({ok:true});expect(reads).toBeLessThanOrEqual(2);expect(await h.store.listSourceChangeTasks({sourceId:item.targetId,generation:1,claim:h.claim})).toEqual({ok:true,tasks:[]});
});

it('structural changes with unknown old ancestry conservatively reconcile before advancing',async()=>{
 const h=changesHarness();h.entries.set('outside',{id:'outside',name:'outside',mimeType:'application/vnd.google-apps.folder',version:'2',sizeBytes:null,parents:[]});await h.init();h.calls.length=0;
 const moved={id:'moved',name:'moved',mimeType:'application/vnd.google-apps.folder',version:'7',sizeBytes:null,parents:['outside']};h.pages.set('token',{ok:true,changes:[{remoteId:'moved',removed:false,item:moved}],nextPageToken:null,newStartPageToken:'unused'});
 expect(await h.run(item)).toEqual({ok:true});expect(h.calls).toContain('list:root');
});

it.each(['pending','reject'] as const)('a %s progress observer cannot block page cancellation',async mode=>{
 const h=changesHarness();await h.init();h.pages.set('token',{ok:true,changes:[],nextPageToken:'page2',newStartPageToken:null});let active=true;const delivered:string[]=[];
 const store={...h.store,async renewSourceClaim(){return active?{ok:true as const}:{ok:false as const,code:'CLAIM_LOST' as const,message:'cancelled'};}};
 const run=sourceSyncHandler({store,remote:h.remote,clock,idGen:sequenceIdGen({timestampMs:now.getTime(),start:8000}),onProgress:event=>{delivered.push(event.message??'');active=false;return mode==='pending'?new Promise<void>(()=>{}):Promise.reject(Error('observer'));}});
 expect(await run(item)).toMatchObject({ok:false});expect(delivered).toEqual(['source_page 1']);expect(h.calls).not.toContain('changes:page2');
});

it('현재 작업의 Carry 예약만 최근 cursor에서 전체 스캔을 요구한다',async()=>{
 const f=fixture(),queued=item.id;
 const store=memorySourceStore({claim:()=>true,renew:()=>true,file:(_h,_s,id)=>({id,redacted:false}),extraction:()=>true,workOpen:()=>true,isRedacted:()=>false,handoff:()=>{},carryEnqueue:()=>({workId:queued})});
 await store.ensureSource({id:item.targetId,kind:'drive',account:'carry-empty',rootId:'root'});
 const claim={workId:item.id,claimedBy:'worker',claimedAt:now,attempts:1,now},scan='019a0000-0000-7000-8000-000000000091',sf='019a0000-0000-7000-8000-000000000092';
 const entry={id:sf,remoteId:'bin',name:'bin',path:'',mimeType:'application/octet-stream',remoteVersion:'1',sizeBytes:3};
 await store.beginSourceScan({sourceId:item.targetId,generation:1,scanId:scan,startToken:'cursor',claim});await store.observeSourceEntry({sourceId:item.targetId,generation:1,scanId:scan,entry,claim});await store.markSourceEntry({sourceId:item.targetId,generation:1,sourceFileId:sf,remoteVersion:'1',status:'unsupported',claim});await store.finishSourceScan({sourceId:item.targetId,generation:1,scanId:scan,claim});
 expect(await store.reserveSourceCarry({sourceId:item.targetId,generation:1,extractorVersion:'new',workId:item.id,now})).toMatchObject({ok:true,reserved:true});
 let scans=0,changes=0,downloads=0;const remote:SourceRemote={async startToken(){scans++;return {ok:true,token:'cursor'};},async list(){return {ok:true,items:[{id:'bin',name:'bin',mimeType:entry.mimeType,version:'1',sizeBytes:3}],nextPageToken:null,incomplete:false};},async metadata(){return {ok:true,item:{id:'bin',name:'bin',mimeType:entry.mimeType,version:'1',sizeBytes:3}};},async download(){downloads++;return {ok:true,bytes:new Uint8Array([0,1,2])};},async changes(){changes++;return {ok:true,changes:[],nextPageToken:null,newStartPageToken:'cursor'};}};
 const probe:import('../src/files/extractors.js').DocumentExtractor={name:'probe',detect:()=>null,detectCarry:async()=>false,extract:async()=>({ok:true,pieces:[]})};const handler=sourceSyncHandler({store,remote,clock,idGen:f.ids,extractors:[probe]});
 expect(await handler(item)).toEqual({ok:true});expect(scans).toBe(1);expect(downloads).toBe(1);expect(await store.hasSourceCarryRun({sourceId:item.targetId,generation:1,workId:item.id})).toEqual({ok:true,pending:false});
 expect(await handler(item)).toEqual({ok:true});expect(scans).toBe(1);expect(changes).toBe(1);
});

it('MIME 변경으로 pending이 된 파일은 동일 버전 Carry marker를 우회해 재판정한다',async()=>{
 const f=fixture(),entry={id:'bin',name:'bin',mimeType:'application/octet-stream',version:'1',sizeBytes:3};await f.store.ensureSource({id:item.targetId,kind:'drive',account:'mime-marker',rootId:'root'});
 let probes=0,downloads=0;const remote:SourceRemote={async startToken(){return {ok:true,token:'t'};},async list(){return {ok:true,items:[entry],nextPageToken:null,incomplete:false};},async metadata(){return {ok:true,item:entry};},async download(){downloads++;return {ok:true,bytes:new Uint8Array([0,1,2])};}};
 const probe:import('../src/files/extractors.js').DocumentExtractor={name:'probe',detect:()=>null,detectCarry:async()=>{probes++;return false;},extract:async()=>({ok:true,pieces:[]})};const handler=sourceSyncHandler({store:f.store,remote,clock,idGen:f.ids,extractors:[probe]});
 expect(await handler(item)).toEqual({ok:true});expect(probes).toBe(1);
 entry.mimeType='image/jpeg';expect(await handler(item)).toEqual({ok:true});const photo=await f.store.listSourceEntries(item.targetId);expect(photo.ok&&photo.entries[0]?.indexStatus).toBe('photo');
 entry.mimeType='application/octet-stream';expect(await handler(item)).toEqual({ok:true});expect(probes).toBe(2);expect(downloads).toBe(2);
});

it('same source observer recovers for the next work after a timeout',async()=>{
 const f=fixture();await f.store.ensureSource({id:item.targetId,kind:'drive',account:'progress-recovery',rootId:'root'});let first=true;const events:string[]=[];
 const run=sourceSyncHandler({store:f.store,remote:f.remote,clock,idGen:f.ids,onProgress:event=>{events.push(event.message??'');if(first){first=false;return new Promise<void>(()=>{});}}});
 expect(await run(item)).toEqual({ok:true});expect(events).toEqual(['source_page 1']);expect(await run({...item,id:'next'})).toEqual({ok:true});expect(events).toContain('source_page 2');expect(events.filter(e=>e==='source_page 1')).toHaveLength(2);
});

it.each(['download','carry'] as const)('MIME-only change during %s refuses staging, marker and handoff',async stage=>{
 const f=fixture(),entry={id:'mime',name:'file.bin',mimeType:'application/octet-stream',version:'1',sizeBytes:3};await f.store.ensureSource({id:item.targetId,kind:'drive',account:`mime-${stage}`,rootId:'root'});let mime=entry.mimeType,writes=0;
 const remote:SourceRemote={async startToken(){return {ok:true,token:'t'};},async list(){return {ok:true,items:[entry],nextPageToken:null,incomplete:false};},async metadata(){return {ok:true,item:{...entry,mimeType:mime}};},async download(){if(stage==='download')mime='image/jpeg';return {ok:true,bytes:Uint8Array.of(1,2,3)};}};
 const probe:import('../src/files/extractors.js').DocumentExtractor={name:'probe',detect:()=>null,detectCarry:async()=>{if(stage==='carry')mime='image/jpeg';return true;},extract:async()=>({ok:true,pieces:[]})};
 const temp={async write(){writes++;return {ok:true as const};},async read(){return {ok:false as const,message:'missing'};},async remove(){},async cleanup(){}};
 expect(await sourceSyncHandler({store:f.store,remote,clock,idGen:f.ids,extractors:[probe],temp})(item)).toMatchObject({ok:false,code:'SOURCE_CHANGED'});expect(writes).toBe(0);expect(f.handoffs).toEqual([]);const rows=await f.store.listSourceEntries(item.targetId);if(!rows.ok||!rows.entries[0])throw Error('entry');expect(await f.store.readSourceCarryCheck({sourceFileId:rows.entries[0].id,remoteVersion:'1',extractorVersion:(await import('../src/files/extractors.js')).DOCUMENT_EXTRACTOR_VERSION})).toMatchObject({ok:true,checked:false});
});

it('invalid second list page keeps progress count across scan restart',async()=>{
 const f=fixture();await f.store.ensureSource({id:item.targetId,kind:'drive',account:'restart-progress',rootId:'root'});let calls=0;const events:string[]=[];
 const remote:SourceRemote={...f.remote,async startToken(){return {ok:true,token:'token'};},async list({pageToken}){calls++;if(calls===2)return {ok:false,code:'CHANGED',message:'expired'};return {ok:true,items:[],nextPageToken:pageToken?null:'next',incomplete:false};}};
 expect(await sourceSyncHandler({store:f.store,remote,clock,idGen:f.ids,onProgress:e=>{events.push(e.message??'');}})(item)).toEqual({ok:true});expect(events).toEqual(['source_page 1','source_page 2','source_page 3']);
});

it('server clock ahead cannot hide a moved folder and its previously indexed child',async()=>{
 const h=changesHarness(),folder={id:'folder',name:'folder',mimeType:'application/vnd.google-apps.folder',version:'1',sizeBytes:null,parents:['root'],createdTime:'2026-01-01T00:05:00Z'},child={id:'child',name:'child',mimeType:'image/jpeg',version:'1',sizeBytes:3,parents:['folder']};h.entries.set('folder',folder);h.entries.set('child',child);h.entries.set('outside',{id:'outside',name:'outside',mimeType:'application/vnd.google-apps.folder',version:'1',sizeBytes:null,parents:[]});await h.init();
 const moved={...folder,parents:['outside'],version:'2'};h.entries.set('folder',moved);h.pages.set('token',{ok:true,changes:[{remoteId:'folder',removed:false,item:moved}],nextPageToken:null,newStartPageToken:'next'});expect(await h.run(item)).toEqual({ok:true});expect(await h.store.listSourceEntries(item.targetId)).toMatchObject({ok:true,entries:[expect.objectContaining({remoteId:'child',unreachable:true})]});
});

it.each(['DB_UNAVAILABLE','DB_LOCKED'] as const)('parent metadata renewal %s returns its attempt to the queue',async code=>{
 const {drainQueue}=await import('../src/index.js'),{memoryStore,memorySpool,sampleWorkInput}=await import('../src/testing/index.js');const h=changesHarness();h.entries.set('parent',{id:'parent',name:'parent',mimeType:'application/vnd.google-apps.folder',version:'1',sizeBytes:null,parents:['root']});await h.init();
 const row={id:'new',name:'new',mimeType:'image/jpeg',version:'1',sizeBytes:1,parents:['parent']};h.pages.set('token',{ok:true,changes:[{remoteId:row.id,removed:false,item:row}],nextPageToken:null,newStartPageToken:'next'});
 let renewals=0;const store={...h.store,async renewSourceClaim(){renewals++;return renewals===4?{ok:false as const,code,message:'synthetic secret'}:{ok:true as const};}};
 const queue=memoryStore(),ids=sequenceIdGen({timestampMs:now.getTime(),start:9000});await queue.addWork(sampleWorkInput({id:item.id,kind:'source_sync',targetKind:'source',targetId:item.targetId,createdAt:now,nextAttemptAt:now}));const handler=sourceSyncHandler({store,remote:h.remote,clock,idGen:ids});
 const report=await drainQueue({store:queue,spool:memorySpool(),clock,idGen:ids},{budgetMs:1000,handlers:{source_sync:handler}});expect(report).toMatchObject({released:1,failed:0,stopped:'unwritable',code});expect(queue.snapshot().workItems[0]).toMatchObject({attempts:0,claimedBy:null});expect(queue.snapshot().failures).toHaveLength(0);expect(h.calls).not.toContain('meta:parent');
});
