import { createHash, randomUUID } from 'node:crypto';
import { contentHashOfBytes, driveBrainLocator, isDriveBrainLocator, type Clock, type DriveUploadStore, type FileLocation, type FileStore } from 'second_brain';

export interface DriveMetadata { id: string; parents: string[]; name: string; trashed?: boolean; sha256Checksum?: string; md5Checksum?: string }
export interface DriveFileStore extends FileStore {
  /** Metadata is checked against the same mapping and root as every other operation. */
  metadata(location: FileLocation): Promise<{ok: true; metadata: DriveMetadata} | {ok: false; code: 'LOCATION_REFUSED'; message: string} | {ok: false; code: 'FILES_UNAVAILABLE'; message: string} | {ok: false; code: 'FILE_NOT_FOUND'; message: string}>;
}
export interface DriveFileStoreOptions {
  rootFolderId: string;
  baseUrl: string;
  uploads: DriveUploadStore;
  clock: Clock;
  /** Inject transport authentication without storing or logging credentials. */
  headers?: () => Promise<Record<string, string>>;
  fetch?: typeof fetch;
  /** Per-request deadline, including authentication headers and body consumption. */
  timeoutMs?: number;
  signal?: AbortSignal;
}
const validId = (value: string) => { const match = /^[A-Za-z0-9_-]+$/.exec(value); return match !== null && match[0] === value; };
const unavailable = () => ({ok:false as const, code:'FILES_UNAVAILABLE' as const, message:'Drive 저장소에 접근할 수 없습니다'});
const refused = () => ({ok:false as const, code:'LOCATION_REFUSED' as const, message:'허용되지 않는 파일 위치입니다'});
const missing = () => ({ok:false as const, code:'FILE_NOT_FOUND' as const, message:'파일이 없습니다'});

export function driveFileStore(options: DriveFileStoreOptions): DriveFileStore {
  const base = options.baseUrl.replace(/\/$/, '');
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid Drive timeout');
  // Keep the deadline alive through body consumption, including non-cooperative
  // injected transports and header providers. Abort also closes native fetch I/O.
  const request = async <T>(path: string, init: RequestInit, consume: (response: Response, readBody: () => Promise<Uint8Array>) => Promise<T>): Promise<T> => {
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
        const headers = await options.headers?.();
        if (controller.signal.aborted) throw new Error('Drive request cancelled');
        const response = await fetcher(base + path, {...init, signal:controller.signal, headers:{...headers,...init.headers}});
        const readBody = async (): Promise<Uint8Array> => {
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
    } catch { return unavailable(); }
  }
  const api: DriveFileStore = {
    metadata,
    async put(bytes) {
      try {
        if (!validId(options.rootFolderId)) return unavailable();
        const contentHash = contentHashOfBytes(bytes);
        const location = {storeKind:'drive' as const, ownership:'brain' as const, locator:driveBrainLocator(contentHash.slice(7),bytes)};
        let row = await options.uploads.read({rootFolderId:options.rootFolderId, contentHash});
        if (!row.ok) return unavailable();
        if (!row.upload) {
          const {generated, data} = await request('/drive/v3/files/generateIds?count=1&space=drive&type=files', {}, async (generated, readBody) => ({generated, data: generated.ok ? JSON.parse(new TextDecoder().decode(await readBody())) as {ids?: unknown} : undefined}));
          if (!generated.ok) return unavailable();
          if (!data) return unavailable();
          if (!Array.isArray(data.ids) || typeof data.ids[0] !== 'string' || !validId(data.ids[0])) return unavailable();
          row = await options.uploads.save({rootFolderId:options.rootFolderId, contentHash, remoteId:data.ids[0], state:'reserved', at:options.clock.now()});
        }
        if (!row.ok || !row.upload || row.upload.rootFolderId !== options.rootFolderId || row.upload.contentHash !== contentHash || !validId(row.upload.remoteId)) return unavailable();
        const id = row.upload.remoteId;
        if (row.upload.state === 'cancelled' || row.upload.state === 'submitting') return unavailable();
        // Recheck the content fence even when this key was already reserved.
        const authorized = await options.uploads.save({rootFolderId:options.rootFolderId, contentHash, remoteId:id, state:'reserved', at:options.clock.now()});
        if (!authorized.ok || authorized.upload?.remoteId !== id) return unavailable();
        let submitted = false;
        let submissionId:string | undefined;
        let m = await metadata(location);
        if (!m.ok && m.code === 'FILE_NOT_FOUND') {
          // A single durable transition authorizes exactly one create request.
          // A submitted ID is never recreated after 404: outcome is uncertain.
          submissionId=randomUUID();
          const start=await options.uploads.start({rootFolderId:options.rootFolderId,contentHash,remoteId:id,submissionId});
          if (!start.ok || !start.claimed) return unavailable();
          submitted = true;
          const boundary = `brain_${randomUUID()}`;
          const pre = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({id,name:location.locator,parents:[options.rootFolderId],mimeType:'application/octet-stream'})}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
          const body = Buffer.concat([pre, Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]);
          const response = await request('/upload/drive/v3/files?uploadType=multipart', {method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body}, async response => response);
          if (!response.ok && response.status !== 409) return unavailable();
          // Acknowledgement proves this sole create request has completed even
          // when the later checksum fails; verification is a separate state.
          const saved=await options.uploads.save({rootFolderId:options.rootFolderId,contentHash,remoteId:id,state:'uploaded',at:options.clock.now(),submissionId});
          if (!saved.ok || saved.upload?.remoteId !== id || saved.upload.state !== 'uploaded') return unavailable();
          m = await metadata(location);
        }
        if (!m.ok) return unavailable();
        const sha = createHash('sha256').update(bytes).digest('hex');
        const md5 = createHash('md5').update(bytes).digest('hex');
        if (m.metadata.sha256Checksum !== undefined ? m.metadata.sha256Checksum !== sha : m.metadata.md5Checksum !== undefined ? m.metadata.md5Checksum !== md5 : false) return unavailable();
        if (m.metadata.sha256Checksum === undefined && m.metadata.md5Checksum === undefined) {
          const got = await api.get(location);
          if (!got.ok || contentHashOfBytes(got.bytes) !== contentHash) return unavailable();
        }
        if (!submitted && authorized.upload.state !== 'uploaded') return unavailable();
        return {ok:true, contentHash, sizeBytes:bytes.length, location};
      } catch { return unavailable(); }
    },
    async get(l) {
      const m = await metadata(l); if (!m.ok) return m;
      try { return await request(`/drive/v3/files/${encodeURIComponent(m.metadata.id)}?alt=media`, {}, async (response, readBody) => { if (response.status === 404) return missing(); if (!response.ok) return unavailable(); return {ok:true as const,bytes:await readBody()}; }); } catch { return unavailable(); }
    },
    async exists(l) { const m = await metadata(l); return m.ok ? {ok:true,exists:true} : m.code === 'FILE_NOT_FOUND' ? {ok:true,exists:false} : m; },
    async url(l) { const m = await metadata(l); return m.ok ? {ok:true,url:`https://drive.google.com/file/d/${encodeURIComponent(m.metadata.id)}/view`} : m.code === 'FILE_NOT_FOUND' ? unavailable() : m; },
    async delete(l) {
      const mapping = await lookup(l);
      if (!mapping.ok) return mapping.code === 'FILE_NOT_FOUND' ? {ok:true,deleted:false} : mapping;
      // An uncertain create may still finish; recovery promotes it only after it
      // has observed the remote file, so absence never marks this place deleted.
      if (mapping.upload.state === 'reserved') {
        const cancelled=await options.uploads.cancelReserved({rootFolderId:options.rootFolderId,contentHash:mapping.upload.contentHash});
        if (!cancelled.ok || cancelled.upload?.state !== 'cancelled') return unavailable();
        return {ok:true,deleted:false};
      }
      if (mapping.upload.state === 'cancelled') return {ok:true,deleted:false};
      if (mapping.upload.state === 'submitting') return unavailable();
      const m = await metadata(l); if (!m.ok) return m.code === 'FILE_NOT_FOUND' ? {ok:true,deleted:false} : m;
      try { const response = await request(`/drive/v3/files/${encodeURIComponent(m.metadata.id)}`,{method:'DELETE'}, async response => response); return response.ok ? {ok:true,deleted:true} : response.status === 404 ? {ok:true,deleted:false} : unavailable(); } catch { return unavailable(); }
    },
  };
  return api;
}
