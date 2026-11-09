import { driveRequest, DriveRequestError, type DriveAuthProvider } from './drive-http.js';
import { createHash, randomUUID } from 'node:crypto';
import { contentHashOfBytes, driveBrainLocator, isDriveBrainLocator, type Clock, type DriveUploadStore, type FileLocation, type FileStore } from 'second_brain';

export interface DriveMetadata { id: string; parents: string[]; name: string; trashed?: boolean; sha256Checksum?: string; md5Checksum?: string }
export interface DriveFileStore extends FileStore {
  /** Metadata is checked against the same mapping and root as every other operation. */
  metadata(location: FileLocation): Promise<{ok: true; metadata: DriveMetadata} | import('second_brain').FileStoreFailure | {ok: false; code: 'FILE_NOT_FOUND'; message: string}>;
}
export interface DriveFileStoreOptions {
  rootFolderId: string;
  baseUrl: string;
  uploads: DriveUploadStore;
  clock: Clock;
  /** Inject transport authentication without storing or logging credentials. */
  headers?: () => Promise<Record<string, string>>;
  auth?: DriveAuthProvider;
  fetch?: typeof fetch;
  /** Per-request deadline, including authentication headers and body consumption. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Revalidate connection generation before each upload operation. */
  authorize?: () => Promise<boolean>;
  deleteSourceFence?:{sourceId:string;generation:number;account:string};
}
const validId = (value: string) => { const match = /^[A-Za-z0-9_-]+$/.exec(value); return match !== null && match[0] === value; };
const unavailable = (error?:unknown) => ({ok:false as const, code:'FILES_UNAVAILABLE' as const, message:error instanceof DriveRequestError?error.message:'Drive 저장소에 접근할 수 없습니다',...(error instanceof DriveRequestError && ['AUTH_REQUIRED','AUTH_LOGIN_REQUIRED','AUTH_SESSION_CHANGED','TEMPORARY'].includes(error.code)?{driveCode:error.code as 'AUTH_REQUIRED'|'AUTH_LOGIN_REQUIRED'|'AUTH_SESSION_CHANGED'|'TEMPORARY'}:{}),...(error instanceof DriveRequestError&&error.retryAfter?{retryAfter:error.retryAfter}:{})});
const refused = () => ({ok:false as const, code:'LOCATION_REFUSED' as const, message:'허용되지 않는 파일 위치입니다'});
const missing = () => ({ok:false as const, code:'FILE_NOT_FOUND' as const, message:'파일이 없습니다'});

export function driveFileStore(options: DriveFileStoreOptions): DriveFileStore {
  const base = options.baseUrl.replace(/\/$/, '');
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid Drive timeout');
  // Keep the deadline alive through body consumption, including non-cooperative
  // injected transports and header providers. Abort also closes native fetch I/O.
  const request = async <T>(path: string, init: RequestInit, consume: (response: Response, readBody: (maxBytes?: number) => Promise<Uint8Array>) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const parent = options.signal;
    const abort = () => controller.abort();
    parent?.addEventListener('abort', abort, {once:true});
    if (parent?.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('Drive request cancelled'));
        controller.signal.addEventListener('abort', onAbort, {once:true});
        if (controller.signal.aborted) onAbort();
        timer = setTimeout(() => controller.abort(), timeoutMs);
      });
      return await Promise.race([cancelled, (async () => {
        const response = await driveRequest({url:path.startsWith('https://')||path.startsWith('http://')?path:base+path,init:{...init,redirect:'manual',signal:controller.signal},fetch:fetcher,headers:options.headers,auth:options.auth,clock:options.clock});
        const readBody = async (maxBytes = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> => {
          if (!response.body) return new Uint8Array();
          const reader = response.body.getReader();
          const stop = () => { void reader.cancel().catch(() => undefined); };
          controller.signal.addEventListener('abort', stop, {once:true});
          if (controller.signal.aborted) stop();
          try {
            const chunks:Uint8Array[] = []; let size = 0;
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              if (part.value.length > maxBytes - size) { await reader.cancel(); throw new RangeError('TOO_LARGE'); }
              chunks.push(part.value); size += part.value.length;
            }
            const bytes = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
            return bytes;
          } finally {
            controller.signal.removeEventListener('abort', stop);
            reader.releaseLock();
          }
        };
        // The response is owned even if the caller needs only its status.  This
        // finally also runs for a response arriving after the deadline race.
        try {
          if (controller.signal.aborted) throw new Error('Drive request cancelled');
          return await consume(response, readBody);
        } finally {
          if (response.body && !response.bodyUsed) {
            await response.body.cancel().catch(() => undefined);
          }
        }
      })()]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      parent?.removeEventListener('abort', abort);
    }
  };
  const key = (l: FileLocation) => l.storeKind === 'drive' && l.ownership === 'brain' && isDriveBrainLocator(l.locator) ? `sha256:${l.locator.slice(0,64)}` : null;
  async function lookup(l: FileLocation) {
    const hash = key(l); if (!hash || !validId(options.rootFolderId)) return refused();
    const result = await options.uploads.read({rootFolderId:options.rootFolderId, contentHash:hash});
    if (!result.ok) return unavailable();
    const u = result.upload;
    if (!u) return missing();
    if (u.rootFolderId !== options.rootFolderId || u.contentHash !== hash || !validId(u.remoteId)) return unavailable();
    return {ok:true as const, upload:u};
  }
  async function metadata(l: FileLocation): ReturnType<DriveFileStore['metadata']> {
    try {
      const found = await lookup(l); if (!found.ok) return found;
      const {response, m} = await request(`/drive/v3/files/${encodeURIComponent(found.upload.remoteId)}?fields=id,name,parents,trashed,sha256Checksum,md5Checksum`, {}, async (response, readBody) => ({response, m: response.ok ? JSON.parse(new TextDecoder().decode(await readBody())) as DriveMetadata : undefined}));
      if (response.status === 404) return missing();
      if (!response.ok) return unavailable();
      if (!m) return unavailable();
      if (m.id !== found.upload.remoteId || !Array.isArray(m.parents) || m.parents.length !== 1 || m.parents[0] !== options.rootFolderId || m.name !== l.locator || m.trashed === true) return refused();
      return {ok:true, metadata:m};
    } catch (error) { return unavailable(error); }
  }
  const api: DriveFileStore = {
    metadata,
    async put(bytes, control) {
      try {
        if (!validId(options.rootFolderId)) return unavailable();
        const allowed=async()=>!options.signal?.aborted && (!options.authorize || await options.authorize()) && (!control || await control.continueUpload());
        const contentHash=contentHashOfBytes(bytes), rootFolderId=options.rootFolderId;
        const location={storeKind:'drive' as const,ownership:'brain' as const,locator:driveBrainLocator(contentHash.slice(7),bytes)};
        const safeSession=(raw:string):boolean=>{try{const u=new URL(raw),b=new URL(base);return u.origin===b.origin && !u.username && !u.password && !u.hash && u.pathname==='/upload/drive/v3/files' && (u.protocol==='https:'||((b.hostname==='127.0.0.1'||b.hostname==='localhost'||b.hostname==='[::1]')&&u.protocol==='http:'));}catch{return false;}};
        const readJSON=async(response:Response,readBody:(maxBytes?:number)=>Promise<Uint8Array>)=>response.ok?JSON.parse(new TextDecoder().decode(await readBody(1024*1024))) as {ids?:unknown}:undefined;
        let row=await options.uploads.read({rootFolderId,contentHash});if(!row.ok)return unavailable();
        if(!row.upload){if(!await allowed())return unavailable();const generated=await request('/drive/v3/files/generateIds?count=1&space=drive&type=files',{},async(r,body)=>({response:r,data:await readJSON(r,body)}));if(!generated.response.ok||!Array.isArray(generated.data?.ids)||typeof generated.data.ids[0]!=='string'||!validId(generated.data.ids[0]))return unavailable();row=await options.uploads.save({rootFolderId,contentHash,remoteId:generated.data.ids[0],state:'reserved',at:options.clock.now()});}
        if(!row.ok||!row.upload||row.upload.rootFolderId!==rootFolderId||row.upload.contentHash!==contentHash||!validId(row.upload.remoteId)||row.upload.state==='cancelled')return unavailable();
        const id=row.upload.remoteId;
        const verified=async()=>{const m=await metadata(location);if(!m.ok)return m;const sha=createHash('sha256').update(bytes).digest('hex'),md5=createHash('md5').update(bytes).digest('hex');if(m.metadata.sha256Checksum!==undefined?m.metadata.sha256Checksum!==sha:m.metadata.md5Checksum!==undefined?m.metadata.md5Checksum!==md5:false)return unavailable();if(m.metadata.sha256Checksum===undefined&&m.metadata.md5Checksum===undefined){const got=await api.getBounded(location,bytes.length);if(!got.ok||got.bytes.length!==bytes.length||contentHashOfBytes(got.bytes)!==contentHash)return unavailable();}return {ok:true as const};};
        const promote=async(submissionId:string)=>{if(!await allowed())return false;const valid=await verified();if(!valid.ok||!await allowed())return false;const saved=await options.uploads.save({rootFolderId,contentHash,remoteId:id,state:'uploaded',at:options.clock.now(),submissionId});return !!(saved.ok&&saved.upload?.state==='uploaded'&&saved.upload.remoteId===id);};
        const acknowledge=promote;
        if(!await allowed())return unavailable();
        if(row.upload.state==='uploaded'){if(row.upload.deletedAt||row.upload.deleteIntentAt)return unavailable();const good=await verified();return good.ok?{ok:true,contentHash,sizeBytes:bytes.length,location}:unavailable();}
        if(!await allowed())return unavailable();
        const authorized=await options.uploads.save({rootFolderId,contentHash,remoteId:id,state:'reserved',at:options.clock.now()});if(!authorized.ok||!authorized.upload||authorized.upload.remoteId!==id||authorized.upload.state==='cancelled')return unavailable();
        let upload=authorized.upload;
        if(upload.state==='reserved'){
          const m=await metadata(location);if(m.ok)return unavailable();if(m.code!=='FILE_NOT_FOUND')return unavailable();
          const started=await options.uploads.start({rootFolderId,contentHash,remoteId:id,submissionId:randomUUID()});if(!started.ok||!started.claimed)return unavailable();upload=started.upload;
        }
        if(upload.state!=='submitting'||!upload.submissionId)return unavailable();
        const submissionId=upload.submissionId;
        // A completed create is recovered only after identity and bytes verify.
        const existing=await metadata(location);if(existing.ok){if(!await promote(submissionId))return unavailable();return {ok:true,contentHash,sizeBytes:bytes.length,location};}if(existing.code!=='FILE_NOT_FOUND')return unavailable();
        if(bytes.length<=5*1024*1024){
          if(!await allowed())return unavailable();const boundary=`brain_${randomUUID()}`;
          const pre=Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({id,name:location.locator,parents:[rootFolderId],mimeType:'application/octet-stream'})}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
          const body=Buffer.concat([pre,Buffer.from(bytes),Buffer.from(`\r\n--${boundary}--\r\n`)]);
          const response=await request('/upload/drive/v3/files?uploadType=multipart',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body},async r=>r);
          if(!response.ok&&response.status!==409)return unavailable();if(!(response.ok?await acknowledge(submissionId):await promote(submissionId)))return unavailable();await control?.onChunk?.(bytes.length);return {ok:true,contentHash,sizeBytes:bytes.length,location};
        }
        const checkpoint=async(expectedSessionUri:string|null,expectedOffset:number,sessionUri:string|null,confirmedOffset:number)=>{
          if(!await allowed())return null;const saved=await options.uploads.checkpoint({rootFolderId,contentHash,remoteId:id,submissionId,expectedSessionUri,expectedOffset,sessionUri,confirmedOffset});return saved.ok?saved.upload:null;
        };
        // Server Range is authoritative; never accept a decreasing, malformed or oversized offset.
        const offsetOf=(response:Response)=>{const value=response.headers.get('range');if(value===null)return 0;const m=/^bytes=0-(0|[1-9][0-9]*)$/.exec(value);if(!m)return null;const end=Number(m[1]);return Number.isSafeInteger(end)&&end<bytes.length?end+1:null;};
        let session=upload.sessionUri,offset=upload.confirmedOffset;
        if(session&&!safeSession(session))return unavailable();
        if(session){
          if(!await allowed())return unavailable();const status=await request(session,{method:'PUT',headers:{'Content-Length':'0','Content-Range':`bytes */${bytes.length}`}},async r=>r);
          if(status.status===200||status.status===201){if(!await acknowledge(submissionId))return unavailable();return {ok:true,contentHash,sizeBytes:bytes.length,location};}
          if(status.status===404||status.status===410){const observed=await metadata(location);if(observed.ok){if(!await promote(submissionId))return unavailable();return {ok:true,contentHash,sizeBytes:bytes.length,location};}if(observed.code!=='FILE_NOT_FOUND')return unavailable();const reset=await checkpoint(session,offset,null,0);if(!reset)return unavailable();session=null;offset=0;}
          else if(status.status===308){const serverOffset=offsetOf(status);if(serverOffset===null||serverOffset<offset)return unavailable();if(serverOffset!==offset){const saved=await checkpoint(session,offset,session,serverOffset);if(!saved)return unavailable();offset=serverOffset;}}
          else return unavailable();
        }
        if(!session){
          if(!await allowed())return unavailable();const started=await request('/upload/drive/v3/files?uploadType=resumable',{method:'POST',headers:{'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':'application/octet-stream','X-Upload-Content-Length':String(bytes.length)},body:JSON.stringify({id,name:location.locator,parents:[rootFolderId],mimeType:'application/octet-stream'})},async r=>({status:r.status,uri:r.headers.get('location')}));
          if(started.status<200||started.status>=300||!started.uri||!safeSession(started.uri))return unavailable();const saved=await checkpoint(null,0,started.uri,0);if(!saved)return unavailable();session=started.uri;offset=0;
        }
        const chunkSize=5*1024*1024;
        while(offset<bytes.length){
          if(!await allowed())return unavailable();const end=Math.min(offset+chunkSize,bytes.length),body=Buffer.from(bytes.subarray(offset,end));
          const response=await request(session,{method:'PUT',headers:{'Content-Type':'application/octet-stream','Content-Length':String(body.length),'Content-Range':`bytes ${offset}-${end-1}/${bytes.length}`},body},async r=>r);
          if(response.status===200||response.status===201){if(end!==bytes.length||!await acknowledge(submissionId))return unavailable();await control?.onChunk?.(end);return {ok:true,contentHash,sizeBytes:bytes.length,location};}
          if(response.status!==308)return unavailable();const next=offsetOf(response);if(next===null||next<=offset||next>end)return unavailable();const saved=await checkpoint(session,offset,session,next);if(!saved)return unavailable();offset=next;await control?.onChunk?.(next);
        }
        return unavailable();
      }catch(error){return unavailable(error);}
    },
    async get(l) {
      const m = await metadata(l); if (!m.ok) return m;
      try { return await request(`/drive/v3/files/${encodeURIComponent(m.metadata.id)}?alt=media`, {}, async (response, readBody) => { if (response.status === 404) return missing(); if (!response.ok) return unavailable(); return {ok:true as const,bytes:await readBody()}; }); } catch (error) { return unavailable(error); }
    },
    async getBounded(l,maxBytes) {
      const m = await metadata(l); if (!m.ok) return m;
      try { return await request(`/drive/v3/files/${encodeURIComponent(m.metadata.id)}?alt=media`, {}, async (response, readBody) => {
        if (response.status === 404) return missing(); if (!response.ok) return unavailable();
        return {ok:true as const,bytes:await readBody(maxBytes)};
      }); } catch (error) { return error instanceof RangeError && error.message === 'TOO_LARGE' ? {ok:false,code:'TOO_LARGE',message:'파일 크기 상한 초과'} : unavailable(error); }
    },
    async exists(l) { const m = await metadata(l); return m.ok ? {ok:true,exists:true} : m.code === 'FILE_NOT_FOUND' ? {ok:true,exists:false} : m; },
    async url(l) { const m = await metadata(l); return m.ok ? {ok:true,url:`https://drive.google.com/file/d/${encodeURIComponent(m.metadata.id)}/view`} : m.code === 'FILE_NOT_FOUND' ? unavailable() : m; },
    async delete(l,control) {
      const mapping = await lookup(l);
      if (!mapping.ok) return mapping.code === 'FILE_NOT_FOUND' ? unavailable() : mapping;
      if(options.deleteSourceFence&&!control)return unavailable();
      const fence=options.deleteSourceFence&&control?{...options.deleteSourceFence,...control,now:options.clock.now(),nowAtLock:()=>options.clock.now()}:undefined;
      const identity={rootFolderId:options.rootFolderId,contentHash:mapping.upload.contentHash,remoteId:mapping.upload.remoteId,...(fence?{fence}:{})};
      const allowed=await options.uploads.checkDelete(identity);if(!allowed.ok||!allowed.allowed)return unavailable();
      // An uncertain create may still finish; recovery promotes it only after it
      // has observed the remote file, so absence never marks this place deleted.
      if (mapping.upload.state === 'reserved') {
        const cancelled=await options.uploads.cancelReserved({rootFolderId:options.rootFolderId,contentHash:mapping.upload.contentHash});
        if (!cancelled.ok || cancelled.upload?.state !== 'cancelled') return unavailable();
        return {ok:true,deleted:false};
      }
      if (mapping.upload.state === 'cancelled') return {ok:true,deleted:false};
      if (mapping.upload.state === 'submitting') return unavailable();
      // A durable tombstone is written only after an observed successful DELETE.
      if(mapping.upload.deletedAt){const saved=await options.uploads.markDeleted({...identity,at:options.clock.now()});return saved.ok&&saved.upload?.deletedAt?{ok:true,deleted:false}:unavailable();}
      const m=await metadata(l);if(!m.ok)return m.code==='FILE_NOT_FOUND'?unavailable():m;
      if(m.metadata.sha256Checksum!==undefined){if(typeof m.metadata.sha256Checksum!=='string'||m.metadata.sha256Checksum.toLowerCase()!==identity.contentHash.slice(7))return unavailable();}
      else {const bytes=await api.get(l);if(!bytes.ok||contentHashOfBytes(bytes.bytes)!==identity.contentHash)return unavailable();}
      const intent=await options.uploads.beginDelete({...identity,at:options.clock.now()});if(!intent.ok||!intent.upload?.deleteIntentAt)return unavailable();
      const submitted=await options.uploads.submitDelete({...identity,at:options.clock.now()});if(!submitted.ok||!submitted.upload?.deleteSubmittedAt)return unavailable();
      try {const response=await request(`/drive/v3/files/${encodeURIComponent(identity.remoteId)}`,{method:'DELETE'},async response=>response);if(!response.ok)return unavailable();const saved=await options.uploads.markDeleted({...identity,at:options.clock.now()});return saved.ok&&saved.upload?.deletedAt?{ok:true,deleted:true}:unavailable();}catch(error){return unavailable(error);}
    },
  };
  return api;
}
