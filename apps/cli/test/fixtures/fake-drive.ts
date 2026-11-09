import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Clock, DriveUpload, DriveUploadStore } from 'second_brain';

export function fakeClock(start = '2026-01-01T00:00:00.000Z'): Clock & { set(value: string): void } {
  let now = new Date(start);
  return {now: () => new Date(now), set: value => { now = new Date(value); }};
}
export function memoryDriveUploads(options:{isRedactedIntent?:(input:{fileId:string;rootFolderId:string;contentHash:string})=>boolean;isCurrentClaim?:(claim:NonNullable<Parameters<DriveUploadStore['confirmRedacted']>[0]['claim']>)=>boolean;isConnectedGeneration?:(fence:NonNullable<Parameters<DriveUploadStore['confirmRedacted']>[0]['sourceFence']>)=>boolean;isDeleteFenceValid?:(fence:NonNullable<Parameters<DriveUploadStore['checkDelete']>[0]['fence']>)=>boolean}={}): DriveUploadStore {
  const rows = new Map<string, DriveUpload>();
  const deleteFences=new Map<string,string>();
  const fenceKey=(f:NonNullable<Parameters<DriveUploadStore['checkDelete']>[0]['fence']>|undefined)=>f?JSON.stringify([f.sourceId,f.generation,f.account]):'';
  const validDelete=(f:NonNullable<Parameters<DriveUploadStore['checkDelete']>[0]['fence']>|undefined)=>!f||!!options.isDeleteFenceValid?.({...f,now:f.nowAtLock?.()??f.now});
  const key = (root: string, hash: string) => JSON.stringify([root, hash]);
  return {
    async read(input) { return {ok:true, upload:rows.get(key(input.rootFolderId,input.contentHash)) ?? null}; },
    async start(input) {
      const k=key(input.rootFolderId,input.contentHash), old=rows.get(k); if (!old || old.remoteId!==input.remoteId) return {ok:false,message:'missing'};
      const claimed=old.state==='reserved'; if (claimed) rows.set(k,{...old,state:'submitting',submissionId:input.submissionId});
      return {ok:true,claimed,upload:rows.get(k)!};
    },
    async checkpoint(input) {
      const k=key(input.rootFolderId,input.contentHash), old=rows.get(k);
      if(!old || old.remoteId!==input.remoteId || old.state!=='submitting' || old.submissionId!==input.submissionId || old.sessionUri!==input.expectedSessionUri || old.confirmedOffset!==input.expectedOffset)return {ok:true,upload:null};
      if(input.confirmedOffset<0 || (input.sessionUri===null && input.confirmedOffset!==0) || (input.sessionUri===old.sessionUri && input.confirmedOffset<old.confirmedOffset) || (input.sessionUri!==old.sessionUri && input.confirmedOffset!==0))return {ok:false,message:'invalid checkpoint'};
      const next={...old,sessionUri:input.sessionUri,confirmedOffset:input.confirmedOffset};rows.set(k,next);return {ok:true,upload:next};
    },
    async checkDelete(input){return {ok:true,allowed:validDelete(input.fence)};},
    async beginDelete(input) {const k=key(input.rootFolderId,input.contentHash),old=rows.get(k);if(!old||old.remoteId!==input.remoteId||old.state!=='uploaded'||old.deletedAt||!validDelete(input.fence)||(old.deleteIntentAt&&deleteFences.get(k)!==fenceKey(input.fence)))return {ok:true,upload:null};if(!old.deleteIntentAt)deleteFences.set(k,fenceKey(input.fence));const next={...old,deleteIntentAt:old.deleteIntentAt??input.at};rows.set(k,next);return {ok:true,upload:next};},
    async submitDelete(input) {const k=key(input.rootFolderId,input.contentHash),old=rows.get(k);if(!old||old.remoteId!==input.remoteId||old.state!=='uploaded'||!old.deleteIntentAt||old.deletedAt||!validDelete(input.fence)||deleteFences.get(k)!==fenceKey(input.fence))return {ok:true,upload:null};const next={...old,deleteSubmittedAt:old.deleteSubmittedAt??input.at};rows.set(k,next);return {ok:true,upload:next};},
    async markDeleted(input) {const k=key(input.rootFolderId,input.contentHash),old=rows.get(k);if(!old||old.remoteId!==input.remoteId||old.state!=='uploaded'||!old.deleteSubmittedAt||!validDelete(input.fence)||deleteFences.get(k)!==fenceKey(input.fence)||!validDelete(input.fence))return {ok:true,upload:null};const next={...old,deletedAt:old.deletedAt??input.at};rows.set(k,next);return {ok:true,upload:next};},
    async confirmRedacted(input) {
      if(!options.isRedactedIntent?.(input))return {ok:false,message:'redacted intent required'};
      if(input.claim&&!options.isCurrentClaim?.({...input.claim,now:input.claim.nowAtLock?.()??input.claim.now})||input.sourceFence&&!options.isConnectedGeneration?.(input.sourceFence))return {ok:true,upload:null};
      const k=key(input.rootFolderId,input.contentHash),old=rows.get(k);if(!old||old.remoteId!==input.remoteId||old.submissionId!==input.submissionId||!['submitting','uploaded'].includes(old.state))return {ok:true,upload:null};
      if(input.claim&&!options.isCurrentClaim?.({...input.claim,now:input.claim.nowAtLock?.()??input.claim.now}))return {ok:true,upload:null};
      const next={...old,state:'uploaded' as const};rows.set(k,next);return {ok:true,upload:next};
    },
    async cancelReserved(input) {
      const k=key(input.rootFolderId,input.contentHash), old=rows.get(k); if(old?.state==='reserved') rows.set(k,{...old,state:'cancelled'});
      return {ok:true,upload:rows.get(k) ?? null};
    },
    async save(input) {
      const k = key(input.rootFolderId,input.contentHash), old = rows.get(k);
      if (!old) rows.set(k, {rootFolderId:input.rootFolderId,contentHash:input.contentHash,remoteId:input.remoteId,state:input.state,createdAt:input.at,submissionId:null,sessionUri:null,confirmedOffset:0,deletedAt:null,deleteIntentAt:null,deleteSubmittedAt:null});
      else if (old.remoteId === input.remoteId && old.state === 'submitting' && old.submissionId === input.submissionId && input.state === 'uploaded') rows.set(k, {...old,state:'uploaded'});
      return {ok:true,upload:rows.get(k)!};
    },
  };
}
export interface FakeDriveFile { id:string; name:string; parents:string[]; bytes:Buffer; mimeType?:string; version?:string; modifiedTime?:string; size?:number; trashed?:boolean; shortcutDetails?:{targetId:string;targetMimeType:string} }
export interface FakeDrive {
  baseUrl:string; files:Map<string,FakeDriveFile>; requests:{method:string; path:string}[];
  sessionIdPrefix?:string; statusQueries:number;
  checksum: 'sha256' | 'md5' | 'none' | 'wrong'; loseNextUploadResponse:boolean; loseNextSessionResponse:boolean; interruptAfterOffset:number|null; expireSessions():void; chunkRanges:string[];
  checksums?: {sha256Checksum?:string; md5Checksum?:string};
  changePages:Map<string,{changes:{fileId:string;removed?:boolean}[];nextPageToken?:string;newStartPageToken?:string}>; rejectedTokens:Set<string>; invalidListTokens:Set<string>;
  downloadBytes?: Buffer;
  fileForbidden:Map<string,'permission'|'rateLimitExceeded'>;
  holdNextUpload(): {entered:Promise<void>; release():void};
  holdNextDownload(): {entered:Promise<void>; release():void};
  close():Promise<void>;
}
export async function fakeDrive(): Promise<FakeDrive> {
  const files = new Map<string,FakeDriveFile>(), requests:{method:string;path:string}[] = [];
  let seq = 0, changeSeq=0;
  const snapshots=new Map<string,Map<string,string>>();
  const snapshot=()=>new Map([...files].map(([id,f])=>[id,JSON.stringify({name:f.name,parents:f.parents,mimeType:f.mimeType,version:f.version,size:f.size,trashed:f.trashed,bytes:createHash('sha256').update(f.bytes).digest('hex')})]));
  const sessions=new Map<string,{meta:{id:string;name:string;parents:string[]};length:number;bytes:Buffer}>();
  let barrier: {entered:()=>void; wait:Promise<void>} | undefined;
  let downloadBarrier: {entered:()=>void; wait:Promise<void>} | undefined;
  const state: FakeDrive = {baseUrl:'',files,requests,statusQueries:0,checksum:'sha256',changePages:new Map(),rejectedTokens:new Set(),invalidListTokens:new Set(),fileForbidden:new Map(),loseNextUploadResponse:false,loseNextSessionResponse:false,interruptAfterOffset:null,chunkRanges:[],expireSessions(){sessions.clear();},
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
    if (method === 'GET' && url.pathname === '/drive/v3/changes/startPageToken'){const token=`synthetic-token-${++changeSeq}`;snapshots.set(token,snapshot());return json(200,{startPageToken:token});}
    const asSource=(f:FakeDriveFile)=>({id:f.id,name:f.name,parents:f.parents,mimeType:f.mimeType??'text/plain',version:f.version??'1',modifiedTime:f.modifiedTime??f.version??'1',trashed:f.trashed??false,size:String(f.size??f.bytes.length),...(!f.mimeType?.startsWith('application/vnd.google-apps.')?{sha256Checksum:createHash('sha256').update(f.bytes).digest('hex')}:{}),...(f.shortcutDetails?{shortcutDetails:f.shortcutDetails}:{})});
    if(method==='GET'&&url.pathname==='/drive/v3/changes'){
      const token=url.searchParams.get('pageToken')??'';if(state.rejectedTokens.has(token))return json(410,{});const page=state.changePages.get(token);if(!page){const previous=snapshots.get(token);if(!previous)return json(200,{changes:[],newStartPageToken:token});const current=snapshot(),ids=new Set([...previous.keys(),...current.keys()]);const changes=[...ids].filter(id=>previous.get(id)!==current.get(id)).map(id=>{const file=files.get(id);return {fileId:id,removed:!file,...(file?{file:asSource(file)}:{})};});const next=`synthetic-token-${++changeSeq}`;snapshots.set(next,current);return json(200,{changes,newStartPageToken:next});}
      return json(200,{changes:page.changes.map(change=>{const f=files.get(change.fileId);return {fileId:change.fileId,removed:change.removed??!f,...(!change.removed&&f?{file:asSource(f)}:{})};}),...(page.nextPageToken?{nextPageToken:page.nextPageToken}:{newStartPageToken:page.newStartPageToken??token})});
    }

    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const parent=/^'([^']+)' in parents/.exec(url.searchParams.get('q') ?? '')?.[1];const pageToken=url.searchParams.get('pageToken');if(pageToken&&state.invalidListTokens.has(pageToken))return json(400,{});const page=Number(pageToken ?? '0');
      const entries=[...files.values()].filter(f=>!f.trashed&&f.parents.includes(parent ?? ''));const selected=entries.slice(page*2,page*2+2);
      return json(200,{files:selected.map(asSource),...(entries.length>(page+1)*2?{nextPageToken:String(page+1)}:{})});
    }
    const exportMatch=/^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname);
    if(method==='GET'&&exportMatch){const file=files.get(decodeURIComponent(exportMatch[1]!));if(!file)return json(404,{});res.writeHead(200,{'content-type':'text/plain'});res.end(file.bytes);return;}
    if (method === 'GET' && url.pathname === '/drive/v3/files/generateIds') return json(200,{ids:[`fake-${++seq}`]});
    if (method === 'POST' && url.pathname === '/upload/drive/v3/files' && url.searchParams.get('uploadType')==='resumable') {
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const meta=JSON.parse(Buffer.concat(chunks).toString()) as {id:string;name:string;parents:string[]};const length=Number(req.headers['x-upload-content-length']);
      if(!Number.isSafeInteger(length)||length<0)return json(400,{});if(files.has(meta.id))return json(409,{});
      const sessionId=`${state.sessionIdPrefix??'session'}-${++seq}`;sessions.set(sessionId,{meta,length,bytes:Buffer.alloc(0)});
      if(state.loseNextSessionResponse){state.loseNextSessionResponse=false;req.socket.destroy();return;}
      res.writeHead(200,{location:`${state.baseUrl}/upload/drive/v3/files?upload_id=${sessionId}`});res.end();return;
    }
    if (method === 'PUT' && url.pathname === '/upload/drive/v3/files' && url.searchParams.has('upload_id')) {
      const session=sessions.get(url.searchParams.get('upload_id')!);if(!session)return json(404,{});
      const range=req.headers['content-range']??'';if(range===`bytes */${session.length}`){state.statusQueries++;
        if(files.has(session.meta.id))return json(200,{id:session.meta.id});
        res.writeHead(308,session.bytes.length?{range:`bytes=0-${session.bytes.length-1}`}:{ });res.end();return;
      }
      state.chunkRanges.push(range);const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);if(!match)return json(400,{});
      const begin=Number(match[1]),end=Number(match[2]),total=Number(match[3]);const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const data=Buffer.concat(chunks);
      if(begin!==session.bytes.length||total!==session.length||end+1-begin!==data.length||end>=total)return json(400,{});
      session.bytes=Buffer.concat([session.bytes,data]);
      if(session.bytes.length===session.length){if(files.has(session.meta.id))return json(409,{});files.set(session.meta.id,{...session.meta,bytes:session.bytes});if(state.loseNextUploadResponse){state.loseNextUploadResponse=false;req.socket.destroy();return;}return json(200,{id:session.meta.id});}
      if(state.interruptAfterOffset!==null&&session.bytes.length>=state.interruptAfterOffset){state.interruptAfterOffset=null;req.socket.destroy();return;}
      res.writeHead(308,{range:`bytes=0-${session.bytes.length-1}`});res.end();return;
    }
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
    const forbidden=state.fileForbidden.get(id);if(method==='GET'&&forbidden)return json(403,{error:{errors:[{reason:forbidden}]}});
    if (method === 'DELETE') {files.delete(id);res.writeHead(204);res.end();return;}
    if (method !== 'GET') return json(405,{});
    if (url.searchParams.get('alt') === 'media') {if (downloadBarrier) {const held=downloadBarrier; downloadBarrier=undefined; held.entered(); await held.wait;} res.writeHead(200,{'content-type':'application/octet-stream'});res.end(state.downloadBytes ?? file.bytes);return;}
    const checksum = file.mimeType?.startsWith('application/vnd.google-apps.') || state.checksum === 'none' ? {} : state.checksum === 'md5' ? {md5Checksum:createHash('md5').update(file.bytes).digest('hex')} : {sha256Checksum:state.checksum === 'wrong' ? '0'.repeat(64) : createHash('sha256').update(file.bytes).digest('hex')};
    return json(200,{...asSource(file),sha256Checksum:undefined,...(state.checksums ?? checksum)});
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(); if (!address || typeof address === 'string') throw new Error('fake Drive 주소 없음');
  state.baseUrl=`http://127.0.0.1:${address.port}`; return state;
}
