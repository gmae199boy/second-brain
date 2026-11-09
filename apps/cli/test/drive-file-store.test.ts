import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileStoreContract } from 'second_brain/testing';
import { contentHashOfBytes, driveBrainLocator } from 'second_brain';
import { driveFileStore } from '../src/runtime/drive-file-store.js';
import { fakeClock, fakeDrive, memoryDriveUploads, type FakeDrive } from './fixtures/fake-drive.js';

const servers: FakeDrive[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>s.close()));});
async function fixture() {
  const server=await fakeDrive(); servers.push(server);
  const uploads=memoryDriveUploads(), clock=fakeClock();
  const store=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock});
  return {server,uploads,clock,store};
}
describe('Drive FileStore',()=>{
  for (const c of fileStoreContract()) it(c.name,()=>c.run(async()=>(await fixture()).store));
  it('동시 put과 응답 유실을 한 ID로 검증해 복구한다',async()=>{
    const {server,store}=await fixture(); const bytes=Uint8Array.of(1,2,3);
    server.loseNextUploadResponse=true;
    const results=await Promise.all([store.put(bytes),store.put(bytes)]);
    const retry=await store.put(bytes); expect(retry).toMatchObject({ok:true});
    expect(results).toHaveLength(2); expect(server.files.size).toBe(1);
    expect(server.requests.some(r=>r.path.startsWith('/drive/v3/files?'))).toBe(false);
  });
  it('같은 이름의 다른 파일이 있어도 매핑된 ID만 이용한다', async () => {
    const {server,store,uploads} = await fixture();
    const bytes = Uint8Array.of(9,8), hash = contentHashOfBytes(bytes);
    const put = await store.put(bytes); if (!put.ok) throw new Error('put');
    const row = await uploads.read({rootFolderId:'brain-root',contentHash:hash});
    if (!row.ok || !row.upload) throw new Error('매핑 없음');
    server.files.set('unmapped', {id:'unmapped',name:put.location.locator,parents:['brain-root'],bytes:Buffer.from([0])});
    expect(await store.get(put.location)).toEqual({ok:true,bytes});
    expect((await store.delete(put.location))).toEqual({ok:true,deleted:true});
    expect(server.files.has('unmapped')).toBe(true);
    expect(server.requests.some(r=>r.path.includes('/unmapped'))).toBe(false);
    expect(server.requests.some(r=>r.path.startsWith('/drive/v3/files?'))).toBe(false);
  });
  it('주입한 시계가 예약 및 업로드 상태에 전달된다',async()=>{
    const {clock,uploads,store}=await fixture(); clock.set('2026-02-03T04:05:06.000Z');
    const bytes=Uint8Array.of(12), result=await store.put(bytes); expect(result.ok).toBe(true);
    expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(bytes)})).toMatchObject({ok:true,upload:{state:'uploaded',createdAt:new Date('2026-02-03T04:05:06.000Z')}});
  });
  it('checksum 실패는 성공으로 처리하지 않고 누락은 원문을 되읽는다',async()=>{
    const {server,store}=await fixture(); server.checksum='wrong';
    expect(await store.put(Uint8Array.of(4))).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'});
    server.checksum='none'; expect((await store.put(Uint8Array.of(4))).ok).toBe(true);
    expect(server.requests.some(r=>r.path.includes('alt=media'))).toBe(true);
    server.checksum='md5'; expect((await store.put(Uint8Array.of(5))).ok).toBe(true);
  });
  it('매핑된 파일이 루트 밖으로 이동하면 읽기와 삭제를 거부한다',async()=>{
    const {server,store}=await fixture(); const bytes=Uint8Array.of(7); const put=await store.put(bytes); if (!put.ok) throw new Error('put');
    const file=[...server.files.values()][0]!; file.parents=['outside'];
    for (const op of [store.get,store.exists,store.url,store.delete]) expect(await op(put.location)).toMatchObject({ok:false,code:'LOCATION_REFUSED'});
    expect(server.files.size).toBe(1); expect(put.location.locator).toBe(driveBrainLocator(contentHashOfBytes(bytes).slice(7),bytes));
  });
});

it('SHA256 is authoritative over conflicting MD5, and bad fallback bytes fail after ACK',async()=>{
  const {server,store,uploads}=await fixture();
  const {createHash}=await import('node:crypto');
  const bytes=Uint8Array.of(21), sha=createHash('sha256').update(bytes).digest('hex'), md5=createHash('md5').update(bytes).digest('hex');
  server.checksums={sha256Checksum:sha,md5Checksum:'0'.repeat(32)};
  expect(await store.put(bytes)).toMatchObject({ok:true});
  const other=Uint8Array.of(22);
  server.checksums={sha256Checksum:'0'.repeat(64),md5Checksum:createHash('md5').update(other).digest('hex')};
  expect(await store.put(other)).toMatchObject({ok:false});
  expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(other)})).toMatchObject({ok:true,upload:{state:'submitting'}});
  const otherRow=await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(other)});
  const third=Uint8Array.of(23); server.checksums={}; server.downloadBytes=Buffer.from([99]);
  expect(await store.put(third)).toMatchObject({ok:false});
  expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(third)})).toMatchObject({ok:true,upload:{state:'submitting'}});
  const thirdRow=await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(third)});
  if(!otherRow.ok||!otherRow.upload||!thirdRow.ok||!thirdRow.upload)throw Error('missing reserved uploads');
  server.checksums=undefined;server.downloadBytes=undefined;
  expect(await store.put(other)).toMatchObject({ok:true});expect(await store.put(third)).toMatchObject({ok:true});
  expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(other)})).toMatchObject({ok:true,upload:{state:'uploaded',remoteId:otherRow.upload.remoteId}});
  expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(third)})).toMatchObject({ok:true,upload:{state:'uploaded',remoteId:thirdRow.upload.remoteId}});
  expect(server.files.size).toBe(3);expect(md5).toHaveLength(32);
});

it('timeouts and cancellation bound headers, fetch and body without resolving an uncertain submission',async()=>{
  const {server,uploads,clock}=await fixture();
  const base={rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,timeoutMs:20};
  const never=()=>new Promise<never>(()=>{});
  expect(await driveFileStore({...base,headers:never}).put(Uint8Array.of(31))).toMatchObject({ok:false});
  expect(await driveFileStore({...base,fetch:never as typeof fetch}).put(Uint8Array.of(32))).toMatchObject({ok:false});
  const abort=new AbortController(); abort.abort();
  expect(await driveFileStore({...base,signal:abort.signal}).put(Uint8Array.of(33))).toMatchObject({ok:false});
  const bodyStore=driveFileStore({...base,fetch:async()=>new Response(new ReadableStream({start(){}}),{status:200})});
  expect(await bodyStore.put(Uint8Array.of(34))).toMatchObject({ok:false});
  const barrier=server.holdNextUpload(), pending=driveFileStore(base).put(Uint8Array.of(35));
  try {
    await barrier.entered; expect(await pending).toMatchObject({ok:false});
    expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(Uint8Array.of(35))})).toMatchObject({ok:true,upload:{state:'submitting'}});
    barrier.release();
  } finally {barrier.release(); await pending;}
});

it('bounds a stalled media body after valid metadata',async()=>{
  const {server,uploads,clock,store}=await fixture();
  const put=await store.put(Uint8Array.of(44)); if(!put.ok) throw Error('put failed');
  let cancelled=false;
  const stalled=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,timeoutMs:20,
    fetch:async (input,init)=>String(input).includes('alt=media') ? new Response(new ReadableStream({start(){},cancel(){cancelled=true;}}),{status:200}) : fetch(input,init)});
  expect(await stalled.get(put.location)).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'});
  expect(cancelled).toBe(true);
});

it('cancels unused POST, DELETE and error bodies including late responses',async()=>{
  const {server,uploads,clock}=await fixture();
  const cancelled:string[]=[];
  const stream=(label:string)=>new ReadableStream<Uint8Array>({cancel(){cancelled.push(label);}});
  let mode:'normal'|'error'|'late'='normal';
  let deliver!: (response:Response)=>void;
  const delayed=new Promise<Response>(resolve=>{deliver=resolve;});
  const transport:typeof fetch=async (input,init)=>{
    const url=String(input), method=init?.method ?? 'GET';
    if (mode==='late') return delayed;
    if (mode==='error') return new Response(stream('error'),{status:503});
    const response=await fetch(input,init);
    if (method==='POST' || method==='DELETE') { await response.body?.cancel(); return new Response(stream(method),{status:method==='DELETE' ? 200 : response.status}); }
    return response;
  };
  const store=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,fetch:transport,timeoutMs:25});
  const put=await store.put(Uint8Array.of(81)); expect(put.ok).toBe(true); if(!put.ok) throw Error('put');
  expect(cancelled).toContain('POST');
  expect(await store.delete(put.location)).toMatchObject({ok:true}); expect(cancelled).toContain('DELETE');
  mode='error'; expect(await store.put(Uint8Array.of(82))).toMatchObject({ok:false}); expect(cancelled).toContain('error');
  mode='late'; const pending=store.put(Uint8Array.of(83)); expect(await pending).toMatchObject({ok:false});
  deliver(new Response(stream('late'),{status:200}));
  await vi.waitFor(()=>expect(cancelled).toContain('late'));
});

it('getBounded는 누적 정확 경계를 허용하고 초과 스트림을 취소한다',async()=>{
  const {server,uploads,clock,store}=await fixture(),put=await store.put(Uint8Array.of(1,2,3,4));if(!put.ok)throw Error('put');
  let cancelled=0;const bounded=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,fetch:async(input,init)=>{
    if(!String(input).includes('alt=media'))return fetch(input,init);
    let index=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(index++===0)controller.enqueue(Uint8Array.of(1,2));else if(index===2)controller.enqueue(Uint8Array.of(3,4));else if(index===3)controller.close();},cancel(){cancelled++;}},{highWaterMark:0}),{status:200});
  }});
  expect(await bounded.getBounded(put.location,4)).toEqual({ok:true,bytes:Uint8Array.of(1,2,3,4)});expect(cancelled).toBe(0);
  expect(await bounded.getBounded(put.location,3)).toMatchObject({ok:false,code:'TOO_LARGE'});expect(cancelled).toBe(1);
  let closedCancels=0;const closed=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,fetch:async(input,init)=>{
    if(!String(input).includes('alt=media'))return fetch(input,init);
    return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(Uint8Array.of(1,2,3,4));controller.close();},cancel(){closedCancels++;}}),{status:200});
  }});
  expect(await closed.getBounded(put.location,3)).toMatchObject({ok:false,code:'TOO_LARGE'});expect(closedCancels).toBe(0);
});

it('resumable_half_restart_and_lost_completion recovers server offset and reserved ID',async()=>{
  const {server,store,uploads,clock}=await fixture(),bytes=new Uint8Array(20*1024*1024);bytes.fill(37);
  server.interruptAfterOffset=10*1024*1024;expect(await store.put(bytes)).toMatchObject({ok:false});
  const hash=contentHashOfBytes(bytes),before=await uploads.read({rootFolderId:'brain-root',contentHash:hash});
  expect(before).toMatchObject({ok:true,upload:{state:'submitting',confirmedOffset:5*1024*1024}});
  const resumed=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock});server.loseNextUploadResponse=true;
  expect(await resumed.put(bytes)).toMatchObject({ok:false});expect(server.files.size).toBe(1);
  expect(await resumed.put(bytes)).toMatchObject({ok:true,contentHash:hash});
  const after=await uploads.read({rootFolderId:'brain-root',contentHash:hash});if(!before.ok||!before.upload||!after.ok||!after.upload)throw Error('mapping missing');
  expect(after.upload.remoteId).toBe(before.upload.remoteId);expect(after.upload.state).toBe('uploaded');
  expect(server.chunkRanges).toEqual(['bytes 0-5242879/20971520','bytes 5242880-10485759/20971520','bytes 10485760-15728639/20971520','bytes 15728640-20971519/20971520']);
  expect(server.requests.some(r=>r.method==='PUT'&&r.path.includes('upload_id='))).toBe(true);
});

it('lost resumable initiation and expired URI retry only the reserved remote ID',async()=>{
  const {server,store,uploads}=await fixture(),bytes=new Uint8Array(6*1024*1024);bytes.fill(19);const hash=contentHashOfBytes(bytes);
  server.loseNextSessionResponse=true;expect(await store.put(bytes)).toMatchObject({ok:false});
  const initial=await uploads.read({rootFolderId:'brain-root',contentHash:hash});if(!initial.ok||!initial.upload)throw Error('mapping missing');
  expect(initial.upload).toMatchObject({state:'submitting',sessionUri:null});
  server.interruptAfterOffset=5*1024*1024;expect(await store.put(bytes)).toMatchObject({ok:false});server.expireSessions();
  expect(await store.put(bytes)).toMatchObject({ok:true});const done=await uploads.read({rootFolderId:'brain-root',contentHash:hash});
  expect(done).toMatchObject({ok:true,upload:{remoteId:initial.upload.remoteId,state:'uploaded'}});expect(server.files.size).toBe(1);
});

it('upload cancellation stops before another chunk and restart queries server progress',async()=>{
  const {server,store}=await fixture(),bytes=new Uint8Array(11*1024*1024);bytes.fill(8);
  expect(await store.put(bytes,{continueUpload:async()=>server.chunkRanges.length===0})).toMatchObject({ok:false});
  expect(server.chunkRanges).toHaveLength(1);expect(await store.put(bytes)).toMatchObject({ok:true});expect(server.files.size).toBe(1);
});

it('untrusted persisted resumable URI never receives credentials',async()=>{
  const {server,uploads,clock}=await fixture(),bytes=new Uint8Array(6*1024*1024),hash=contentHashOfBytes(bytes),at=clock.now();
  await uploads.save({rootFolderId:'brain-root',contentHash:hash,remoteId:'safe-id',state:'reserved',at});await uploads.start({rootFolderId:'brain-root',contentHash:hash,remoteId:'safe-id',submissionId:'synthetic'});
  await uploads.checkpoint({rootFolderId:'brain-root',contentHash:hash,remoteId:'safe-id',submissionId:'synthetic',expectedSessionUri:null,expectedOffset:0,sessionUri:'https://attacker.invalid/upload/drive/v3/files?secret=synthetic',confirmedOffset:0});
  const calls:string[]=[];const store=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,fetch:async(input,init)=>{calls.push(String(input));return fetch(input,init);},headers:async()=>({authorization:'Bearer synthetic-secret'})});
  expect(await store.put(bytes)).toMatchObject({ok:false});expect(calls.every(url=>new URL(url).origin===server.baseUrl)).toBe(true);expect(JSON.stringify(server.requests)).not.toContain('synthetic-secret');
});

it('one remote 404 does not acknowledge deletion without a durable successful delete',async()=>{
  const {server,store,uploads}=await fixture(),bytes=Uint8Array.of(71,72),result=await store.put(bytes);if(!result.ok)throw Error('synthetic put');
  const hash=contentHashOfBytes(bytes),mapping=await uploads.read({rootFolderId:'brain-root',contentHash:hash});if(!mapping.ok||!mapping.upload)throw Error('mapping missing');
  const remote=server.files.get(mapping.upload.remoteId)!;server.files.delete(mapping.upload.remoteId);
  expect(await store.delete(result.location)).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'});
  server.files.set(remote.id,remote);expect(await store.delete(result.location)).toEqual({ok:true,deleted:true});expect(await store.delete(result.location)).toEqual({ok:true,deleted:false});
  expect(await uploads.read({rootFolderId:'brain-root',contentHash:hash})).toMatchObject({ok:true,upload:{state:'uploaded',deletedAt:expect.any(Date)}});
});

it('submitting recovery refuses a wrong reserved identity',async()=>{
  const {server,store,uploads,clock}=await fixture(),bytes=Uint8Array.of(81),hash=contentHashOfBytes(bytes),at=clock.now();
  await uploads.save({rootFolderId:'brain-root',contentHash:hash,remoteId:'remote-id',state:'reserved',at});await uploads.start({rootFolderId:'brain-root',contentHash:hash,remoteId:'remote-id',submissionId:'synthetic'});
  server.files.set('remote-id',{id:'remote-id',name:'wrong',parents:['brain-root'],bytes:Buffer.from(bytes)});
  expect(await store.put(bytes)).toMatchObject({ok:false});expect(await uploads.read({rootFolderId:'brain-root',contentHash:hash})).toMatchObject({ok:true,upload:{state:'submitting'}});
});

it('invalid 308 range is rejected and a later status query recovers confirmed bytes',async()=>{
  const {server,uploads,clock}=await fixture(),bytes=new Uint8Array(6*1024*1024);bytes.fill(4);let poisoned=false;
  const store=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,fetch:async(input,init)=>{
    const response=await fetch(input,init);if(response.status===308&&!poisoned){poisoned=true;await response.body?.cancel();return new Response(null,{status:308,headers:{range:'bytes=1-5242879'}});}return response;
  }});
  expect(await store.put(bytes)).toMatchObject({ok:false});expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(bytes)})).toMatchObject({ok:true,upload:{state:'submitting',confirmedOffset:0}});
  expect(await store.put(bytes)).toMatchObject({ok:true});expect(server.files.size).toBe(1);
});

it('initiation Location on another host is rejected before any authenticated request to it',async()=>{
  const {server,uploads,clock}=await fixture(),bytes=new Uint8Array(6*1024*1024),calls:string[]=[];
  const store=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,headers:async()=>({authorization:'Bearer synthetic-token'}),fetch:async(input,init)=>{
    calls.push(String(input));const response=await fetch(input,init);if(String(input).includes('uploadType=resumable')){await response.body?.cancel();return new Response(null,{status:200,headers:{location:'https://attacker.invalid/upload/drive/v3/files?token=synthetic'}});}return response;
  }});
  expect(await store.put(bytes)).toMatchObject({ok:false});expect(calls.every(url=>new URL(url).origin===server.baseUrl)).toBe(true);
  expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(bytes)})).toMatchObject({ok:true,upload:{state:'submitting',sessionUri:null}});
});

it('submitting before POST and after ACK before DB save recover the same reservation',async()=>{
  const {server,uploads,clock}=await fixture(),bytes=Uint8Array.of(99),hash=contentHashOfBytes(bytes);let failBefore=true,failSave=true;
  const store=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,clock,uploads:{...uploads,async save(i){if(i.state==='uploaded'&&failSave){failSave=false;return {ok:false,message:'synthetic'};}return uploads.save(i);}},fetch:async(input,init)=>{
    if(String(input).includes('uploadType=multipart')&&failBefore){failBefore=false;throw Error('synthetic before POST');}return fetch(input,init);
  }});
  expect(await store.put(bytes)).toMatchObject({ok:false});const reserved=await uploads.read({rootFolderId:'brain-root',contentHash:hash});if(!reserved.ok||!reserved.upload)throw Error('missing');
  expect(reserved.upload.state).toBe('submitting');expect(server.files.size).toBe(0);
  expect(await store.put(bytes)).toMatchObject({ok:false});expect(server.files.size).toBe(1);
  expect(await store.put(bytes)).toMatchObject({ok:true});
  expect(await uploads.read({rootFolderId:'brain-root',contentHash:hash})).toMatchObject({ok:true,upload:{state:'uploaded',remoteId:reserved.upload.remoteId}});
});

it.each(['checksum','bytes','metadata'] as const)('2xx with mismatched %s remains submitting until independent verification succeeds',async fault=>{
 const {server,store,uploads}=await fixture(),bytes=Uint8Array.of(8,3,1),hash=contentHashOfBytes(bytes);
 if(fault==='checksum')server.checksum='wrong';if(fault==='bytes'){server.checksum='none';server.downloadBytes=Buffer.from([9,9,9]);}
 const altered=fault==='metadata'?driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock:fakeClock(),fetch:async(input,init)=>{const response=await fetch(input,init);if(String(input).includes('/drive/v3/files/fake-')&&!String(input).includes('alt=media')&&response.ok){const value=await response.json() as Record<string,unknown>;return new Response(JSON.stringify({...value,parents:['wrong-root']}),{status:200});}return response;}}):store;
 expect(await altered.put(bytes)).toMatchObject({ok:false});const pending=await uploads.read({rootFolderId:'brain-root',contentHash:hash});expect(pending).toMatchObject({ok:true,upload:{state:'submitting'}});expect(server.files.size).toBe(1);
 server.checksum='sha256';server.downloadBytes=undefined;expect(await store.put(bytes)).toMatchObject({ok:true,contentHash:hash});const complete=await uploads.read({rootFolderId:'brain-root',contentHash:hash});expect(complete).toMatchObject({ok:true,upload:{state:'uploaded',remoteId:pending.ok?pending.upload?.remoteId:undefined}});expect(server.files.size).toBe(1);
});

it.each(['response-lost','mark-failed'] as const)('submitted delete stays uncertain after %s with a fresh adapter',async failure=>{
 const {server,uploads,clock,store}=await fixture(),bytes=Uint8Array.of(34,35),put=await store.put(bytes);if(!put.ok)throw Error('put');
 let lose=failure==='response-lost',failMark=failure==='mark-failed';
 const wrapped={...uploads,async markDeleted(i:Parameters<typeof uploads.markDeleted>[0]){if(failMark){failMark=false;return {ok:false as const,message:'synthetic failure'};}return uploads.markDeleted(i);}};
 const first=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,clock,uploads:wrapped,fetch:async(input,init)=>{const response=await fetch(input,init);if(init?.method==='DELETE'&&lose){lose=false;throw Error('lost response');}return response;}});
 expect(await first.delete(put.location)).toMatchObject({ok:false});
 const row=await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(bytes)});expect(row).toMatchObject({ok:true,upload:{deleteIntentAt:expect.any(Date),deleteSubmittedAt:expect.any(Date),deletedAt:null}});
 const restarted=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,clock,uploads});
 expect(await restarted.delete(put.location)).toMatchObject({ok:false});expect(await restarted.delete(put.location)).toMatchObject({ok:false});expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(bytes)})).toMatchObject({ok:true,upload:{deletedAt:null}});
});

it('delete refuses a same-name remote object with different content',async()=>{
 const {server,store}=await fixture(),put=await store.put(Uint8Array.of(51));if(!put.ok)throw Error('put');const file=[...server.files.values()][0]!;file.bytes=Buffer.from([52]);
 expect(await store.delete(put.location)).toMatchObject({ok:false});expect(server.files.has(file.id)).toBe(true);
});

it('fake redacted confirmation rechecks claim at the final write boundary',async()=>{
 let checks=0;const uploads=memoryDriveUploads({isRedactedIntent:()=>true,isCurrentClaim:c=>c.now.getTime()<1000});const at=new Date(0),identity={rootFolderId:'root',contentHash:'sha256:'+'a'.repeat(64),remoteId:'remote'};
 await uploads.save({...identity,state:'reserved',at});await uploads.start({...identity,submissionId:'synthetic'});
 const result=await uploads.confirmRedacted({...identity,fileId:'file',submissionId:'synthetic',at,claim:{workId:'work',claimedBy:'worker',claimedAt:at,attempts:1,now:at,nowAtLock:()=>new Date(++checks===1?0:2000)}});
 expect(result).toEqual({ok:true,upload:null});expect(await uploads.read(identity)).toMatchObject({ok:true,upload:{state:'submitting'}});
});

it('an intent without a submitted DELETE cannot turn missing metadata into success',async()=>{
 const {server,store,uploads,clock}=await fixture(),bytes=Uint8Array.of(68),put=await store.put(bytes);if(!put.ok)throw Error('put');const hash=contentHashOfBytes(bytes),mapping=await uploads.read({rootFolderId:'brain-root',contentHash:hash});if(!mapping.ok||!mapping.upload)throw Error('mapping');
 expect(await uploads.beginDelete({rootFolderId:'brain-root',contentHash:hash,remoteId:mapping.upload.remoteId,at:clock.now()})).toMatchObject({ok:true});server.files.delete(mapping.upload.remoteId);
 expect(await store.delete(put.location)).toMatchObject({ok:false});expect(await uploads.read({rootFolderId:'brain-root',contentHash:hash})).toMatchObject({ok:true,upload:{deleteSubmittedAt:null,deletedAt:null}});
});

it('memory upload store follows the deletion journal contract',async()=>{
 const {driveDeleteContract}=await import('second_brain/testing');const uploads=memoryDriveUploads(),at=new Date(0),input={rootFolderId:'root',contentHash:'sha256:'+'b'.repeat(64),remoteId:'remote',at};
 await uploads.save({...input,state:'reserved'});await uploads.start({...input,submissionId:'synthetic'});await uploads.save({...input,state:'uploaded',submissionId:'synthetic'});await driveDeleteContract(uploads,input);
});

it.each([200,403,503,404])('a first metadata 404 never infers delete from a following %s',async second=>{
 const {server,uploads,clock,store}=await fixture(),bytes=Uint8Array.of(75),put=await store.put(bytes);if(!put.ok)throw Error('put');const hash=contentHashOfBytes(bytes),row=await uploads.read({rootFolderId:'brain-root',contentHash:hash});if(!row.ok||!row.upload)throw Error('mapping');const identity={rootFolderId:'brain-root',contentHash:hash,remoteId:row.upload.remoteId,at:clock.now()};await uploads.beginDelete(identity);await uploads.submitDelete(identity);let reads=0;
 const guarded=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,fetch:async(input,init)=>{if(init?.method!=='DELETE'&&String(input).includes(`/files/${identity.remoteId}?fields=`)){reads++;if(reads===1)return new Response('',{status:404});if(second!==200)return new Response('',{status:second});}return fetch(input,init);}});
 expect(await guarded.delete(put.location)).toMatchObject({ok:false});expect(reads).toBe(1);expect(server.files.has(identity.remoteId)).toBe(true);expect(await uploads.read(identity)).toMatchObject({ok:true,upload:{deletedAt:null}});expect(server.requests.filter(r=>r.method==='DELETE')).toHaveLength(0);
});

it('an actual durable DELETE acknowledgement survives loss of the store response',async()=>{
 const {server,uploads,clock,store}=await fixture(),bytes=Uint8Array.of(76),put=await store.put(bytes);if(!put.ok)throw Error('put');let lost=true;
 const wrapper={...uploads,async markDeleted(i:Parameters<typeof uploads.markDeleted>[0]){const result=await uploads.markDeleted(i);if(lost){lost=false;return {ok:false as const,message:'synthetic lost DB response'};}return result;}};
 const first=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads:wrapper,clock});expect(await first.delete(put.location)).toMatchObject({ok:false});expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(bytes)})).toMatchObject({ok:true,upload:{deletedAt:expect.any(Date)}});
 const restarted=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock});expect(await restarted.delete(put.location)).toEqual({ok:true,deleted:false});expect(server.requests.filter(r=>r.method==='DELETE')).toHaveLength(1);
});

it('a changed account, source generation or cancelled claim prevents DELETE acknowledgement',async()=>{
 const server=await fakeDrive();servers.push(server);const clock=fakeClock(),at=clock.now();let valid=true;const uploads=memoryDriveUploads({isDeleteFenceValid:()=>valid});const store=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,deleteSourceFence:{sourceId:'source',generation:1,account:'account'}}),plain=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock});const put=await plain.put(Uint8Array.of(77));if(!put.ok)throw Error('put');const control={workId:'work',locationId:'location',claimedBy:'worker',claimedAt:at,attempts:1};
 const fenced=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,deleteSourceFence:{sourceId:'source',generation:1,account:'account'},fetch:async(input,init)=>{const response=await fetch(input,init);if(init?.method==='DELETE')valid=false;return response;}});expect(await fenced.delete(put.location,control)).toMatchObject({ok:false});expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(Uint8Array.of(77))})).toMatchObject({ok:true,upload:{deletedAt:null}});expect(await store.delete(put.location,control)).toMatchObject({ok:false});
});

it('bounded verification cancels a remote stream once the expected size is exceeded',async()=>{
 const {server,uploads,clock,store}=await fixture(),bytes=Uint8Array.of(78),put=await store.put(bytes);if(!put.ok)throw Error('put');let cancelled=false;
 const oversized=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,fetch:async(input,init)=>{if(String(input).includes('alt=media'))return new Response(new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array([1,2,3]));},cancel(){cancelled=true;}}));return fetch(input,init);}});
 expect(await oversized.getBounded(put.location,bytes.length)).toMatchObject({ok:false,code:'TOO_LARGE'});expect(cancelled).toBe(true);
});

it('submitted intent followed by two transient 404s leaves the existing remote and blob location unfinished',async()=>{
 const {server,store,uploads,clock}=await fixture(),bytes=Uint8Array.of(79),put=await store.put(bytes);if(!put.ok)throw Error('put');const hash=contentHashOfBytes(bytes),mapping=await uploads.read({rootFolderId:'brain-root',contentHash:hash});if(!mapping.ok||!mapping.upload)throw Error('mapping');const identity={rootFolderId:'brain-root',contentHash:hash,remoteId:mapping.upload.remoteId,at:clock.now()};await uploads.beginDelete(identity);await uploads.submitDelete(identity);let reads=0;
 const adapter=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,fetch:async(input,init)=>{if(String(input).includes(`/files/${identity.remoteId}?fields=`)){reads++;return new Response('',{status:404});}return fetch(input,init);}});
 const {blobDeleteHandler}=await import('second_brain');let marked=false;const handler=blobDeleteHandler({clock,files:store,driveFiles:adapter,driveRoot:{store:{async readDriveLocationRoot(){return {ok:true,rootFolderId:'brain-root'};}},rootFolderId:'brain-root'},store:{async readFileLocation(){return {ok:true,location:{id:'place',fileId:'file',storeKind:'drive',locator:put.location.locator,ownership:'brain',deletedAt:null}};},async markFileLocationDeleted(){marked=true;return {ok:true,deletedAt:clock.now(),marked:true};},async resolveFailures(){return {ok:true,resolved:0};}}});
 const item={id:'work',targetId:'place',claimedBy:'worker',claimedAt:clock.now(),attempts:1} as import('second_brain').WorkItem;expect(await handler(item)).toMatchObject({ok:false});expect(await handler(item)).toMatchObject({ok:false});expect(reads).toBe(2);expect(marked).toBe(false);expect(server.files.has(identity.remoteId)).toBe(true);expect(await uploads.read(identity)).toMatchObject({ok:true,upload:{deletedAt:null}});
});

it.each(['ack','recovery','uploaded'] as const)('put %s verification bounds checksum-free remote bytes and cancels excess',async mode=>{
 const {server,uploads,clock}=await fixture(),bytes=Uint8Array.of(61,62),hash=contentHashOfBytes(bytes),location=driveBrainLocator(hash.slice(7),bytes),at=clock.now();server.checksum='none';let cancelled=false;
 if(mode!=='ack'){await uploads.save({rootFolderId:'brain-root',contentHash:hash,remoteId:'existing',state:'reserved',at});await uploads.start({rootFolderId:'brain-root',contentHash:hash,remoteId:'existing',submissionId:'submission'});server.files.set('existing',{id:'existing',name:location,parents:['brain-root'],bytes:Buffer.from(bytes)});if(mode==='uploaded')await uploads.save({rootFolderId:'brain-root',contentHash:hash,remoteId:'existing',state:'uploaded',submissionId:'submission',at});}
 const drive=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads,clock,fetch:async(input,init)=>{if(String(input).includes('alt=media'))return new Response(new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(bytes.length+1));},cancel(){cancelled=true;}}));return fetch(input,init);}});
 expect(await drive.put(bytes)).toMatchObject({ok:false});expect(cancelled).toBe(true);expect(await uploads.read({rootFolderId:'brain-root',contentHash:hash})).toMatchObject({ok:true,upload:{state:mode==='uploaded'?'uploaded':'submitting'}});expect(server.files.size).toBe(1);
});
