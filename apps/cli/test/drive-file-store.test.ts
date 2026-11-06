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
  it('동시 put과 응답 유실은 하나의 ID와 미확정 상태를 보존한다',async()=>{
    const {server,store}=await fixture(); const bytes=Uint8Array.of(1,2,3);
    server.loseNextUploadResponse=true;
    const results=await Promise.all([store.put(bytes),store.put(bytes)]);
    const retry=await store.put(bytes); expect(retry).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'});
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
  expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(other)})).toMatchObject({ok:true,upload:{state:'uploaded'}});
  const third=Uint8Array.of(23); server.checksums={}; server.downloadBytes=Buffer.from([99]);
  expect(await store.put(third)).toMatchObject({ok:false});
  expect(await uploads.read({rootFolderId:'brain-root',contentHash:contentHashOfBytes(third)})).toMatchObject({ok:true,upload:{state:'uploaded'}});
  expect(md5).toHaveLength(32);
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
