import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Clock, DriveUpload, DriveUploadStore } from 'second_brain';

export function fakeClock(start = '2026-01-01T00:00:00.000Z'): Clock & { set(value: string): void } {
  let now = new Date(start);
  return {now: () => new Date(now), set: value => { now = new Date(value); }};
}
export function memoryDriveUploads(): DriveUploadStore {
  const rows = new Map<string, DriveUpload & {submissionId?:string}>();
  const key = (root: string, hash: string) => JSON.stringify([root, hash]);
  return {
    async read(input) { return {ok:true, upload:rows.get(key(input.rootFolderId,input.contentHash)) ?? null}; },
    async start(input) {
      const k=key(input.rootFolderId,input.contentHash), old=rows.get(k); if (!old || old.remoteId!==input.remoteId) return {ok:false,message:'missing'};
      const claimed=old.state==='reserved'; if (claimed) rows.set(k,{...old,state:'submitting',submissionId:input.submissionId});
      return {ok:true,claimed,upload:rows.get(k)!};
    },
    async cancelReserved(input) {
      const k=key(input.rootFolderId,input.contentHash), old=rows.get(k); if(old?.state==='reserved') rows.set(k,{...old,state:'cancelled'});
      return {ok:true,upload:rows.get(k) ?? null};
    },
    async save(input) {
      const k = key(input.rootFolderId,input.contentHash), old = rows.get(k);
      if (!old) rows.set(k, {rootFolderId:input.rootFolderId,contentHash:input.contentHash,remoteId:input.remoteId,state:input.state,createdAt:input.at});
      else if (old.remoteId === input.remoteId && old.state === 'submitting' && old.submissionId === input.submissionId && input.state === 'uploaded') rows.set(k, {...old,state:'uploaded'});
      return {ok:true,upload:rows.get(k)!};
    },
  };
}
export interface FakeDriveFile { id:string; name:string; parents:string[]; bytes:Buffer; mimeType?:string; version?:string; size?:number; shortcutDetails?:{targetId:string;targetMimeType:string} }
export interface FakeDrive {
  baseUrl:string; files:Map<string,FakeDriveFile>; requests:{method:string; path:string}[];
  checksum: 'sha256' | 'md5' | 'none' | 'wrong'; loseNextUploadResponse:boolean;
  checksums?: {sha256Checksum?:string; md5Checksum?:string};
  downloadBytes?: Buffer;
  holdNextUpload(): {entered:Promise<void>; release():void};
  holdNextDownload(): {entered:Promise<void>; release():void};
  close():Promise<void>;
}
export async function fakeDrive(): Promise<FakeDrive> {
  const files = new Map<string,FakeDriveFile>(), requests:{method:string;path:string}[] = [];
  let seq = 0;
  let barrier: {entered:()=>void; wait:Promise<void>} | undefined;
  let downloadBarrier: {entered:()=>void; wait:Promise<void>} | undefined;
  const state: FakeDrive = {baseUrl:'',files,requests,checksum:'sha256',loseNextUploadResponse:false,
    holdNextUpload() {
      if (barrier) throw Error('upload barrier already installed');
      let entered!:()=>void, release!:()=>void;
      const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
      const wait=new Promise<void>(resolve=>{release=resolve;});
      barrier={entered,wait}; return {entered:enteredPromise,release};
    },
    holdNextDownload() {
      if (downloadBarrier) throw Error('download barrier already installed');
      let entered!:()=>void, release!:()=>void;
      const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
      const wait=new Promise<void>(resolve=>{release=resolve;});
      downloadBarrier={entered,wait}; return {entered:enteredPromise,release};
    }, close:async () => new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()))};
  const server: Server = createServer(async (req,res) => {
    const url = new URL(req.url ?? '/', 'http://localhost'); const method = req.method ?? 'GET'; requests.push({method,path:url.pathname + url.search});
    const json = (status:number, value:unknown) => {res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if (method === 'GET' && url.pathname === '/drive/v3/changes/startPageToken') return json(200,{startPageToken:'synthetic-token'});
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const parent=/^'([^']+)' in parents/.exec(url.searchParams.get('q') ?? '')?.[1];const page=Number(url.searchParams.get('pageToken') ?? '0');
      const entries=[...files.values()].filter(f=>f.parents.includes(parent ?? ''));const selected=entries.slice(page*2,page*2+2);
      return json(200,{files:selected.map(f=>({id:f.id,name:f.name,mimeType:f.mimeType ?? 'text/plain',version:f.version ?? '1',size:String(f.size ?? f.bytes.length),...(f.shortcutDetails?{shortcutDetails:f.shortcutDetails}:{})})),...(entries.length>(page+1)*2?{nextPageToken:String(page+1)}:{})});
    }
    const exportMatch=/^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname);
    if(method==='GET'&&exportMatch){const file=files.get(decodeURIComponent(exportMatch[1]!));if(!file)return json(404,{});res.writeHead(200,{'content-type':'text/plain'});res.end(file.bytes);return;}
    if (method === 'GET' && url.pathname === '/drive/v3/files/generateIds') return json(200,{ids:[`fake-${++seq}`]});
    if (method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const chunks:Buffer[]=[]; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body=Buffer.concat(chunks), boundary=/boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1];
      if (!boundary) return json(400,{});
      const divider=Buffer.from('\r\n\r\n'), first=body.indexOf(divider), second=body.indexOf(Buffer.from(`\r\n--${boundary}\r\n`),first+4), dataStart=body.indexOf(divider,second+1)+4, dataEnd=body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      if (first<0 || second<0 || dataStart<4 || dataEnd<dataStart) return json(400,{});
      const meta=JSON.parse(body.subarray(first+4,second).toString()) as {id:string;name:string;parents:string[]};
      if (barrier) { const held=barrier; barrier=undefined; held.entered(); await held.wait; }
      if (files.has(meta.id)) return json(409,{});
      files.set(meta.id,{...meta,bytes:body.subarray(dataStart,dataEnd)});
      if (state.loseNextUploadResponse) {state.loseNextUploadResponse=false; req.socket.destroy(); return;}
      return json(200,{id:meta.id});
    }
    const match = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname); if (!match) return json(404,{});
    const id=decodeURIComponent(match[1]!), file=files.get(id); if (!file) return json(404,{});
    if (method === 'DELETE') {files.delete(id);res.writeHead(204);res.end();return;}
    if (method !== 'GET') return json(405,{});
    if (url.searchParams.get('alt') === 'media') {if (downloadBarrier) {const held=downloadBarrier; downloadBarrier=undefined; held.entered(); await held.wait;} res.writeHead(200,{'content-type':'application/octet-stream'});res.end(state.downloadBytes ?? file.bytes);return;}
    const checksum = state.checksum === 'none' ? {} : state.checksum === 'md5' ? {md5Checksum:createHash('md5').update(file.bytes).digest('hex')} : {sha256Checksum:state.checksum === 'wrong' ? '0'.repeat(64) : createHash('sha256').update(file.bytes).digest('hex')};
    return json(200,{id:file.id,name:file.name,parents:file.parents,mimeType:file.mimeType ?? 'text/plain',version:file.version ?? '1',size:String(file.size ?? file.bytes.length),...(file.shortcutDetails?{shortcutDetails:file.shortcutDetails}:{}),...(state.checksums ?? checksum)});
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(); if (!address || typeof address === 'string') throw new Error('fake Drive 주소 없음');
  state.baseUrl=`http://127.0.0.1:${address.port}`; return state;
}
