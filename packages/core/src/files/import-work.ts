import type { ImportStore, ImportStaging } from '../ports/import-store.js';
import type { FileStore } from '../ports/file-store.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import { brainLocator, contentHashOfBytes } from '../domain/file.js';
import type { AttachmentStore, WorkStore } from '../ports/store.js';
import type { WorkHandler } from '../queue/drain.js';
export const FILE_IMPORT_KIND = 'file_import';
export async function handoffImportRequests(store: ImportStore, clock: Clock, idGen: IdGen) {
  const pending = await store.listUnhandedImports(); if (!pending.ok) return pending;
  for (const requestId of pending.ids) { const result = await store.handoffImport({ requestId, workId: idGen.next(), now: clock.now() }); if (!result.ok) return result; }
  return { ok: true as const };
}
export function importFileHandler(store: ImportStore, staging: ImportStaging, files: FileStore, clock: Clock, idGen: IdGen, redactions: Pick<AttachmentStore, 'listRedactedContentHashes'>, failures?: Pick<WorkStore, 'resolveFailures'>): WorkHandler {
  return async item => {
    const read = await store.readImport(item.targetId); if (!read.ok) return read;
    if (!read.request) return { ok: true };
    if (read.completed) {
      if (failures) { const resolved = await failures.resolveFailures({ targetKind: 'file_request', targetId: item.targetId, stage: FILE_IMPORT_KIND, now: clock.now() }); if (!resolved.ok) return resolved; }
      await staging.remove(read.request.source, read.request.locator).catch(() => {});
      return { ok: true };
    }
    if (!item.claimedBy) return { ok: false, code: 'CLAIM_LOST', message: '청구가 없습니다' };
    const request = read.request;
    const bytes = await staging.read(request.source, request.locator, 32 * 1024 * 1024);
    const valid = bytes.ok && bytes.bytes.length === request.sizeBytes && contentHashOfBytes(bytes.bytes) === `sha256:${request.sha256}`;
    if (!valid || !bytes.ok) {
      const failure = await store.failImport({ requestId: request.id, workId: item.id, claimedBy: item.claimedBy, code: 'IMPORT_FILE_INVALID', now: clock.now() });
      return failure.ok ? { ok: false, code: 'IMPORT_FILE_INVALID', message: '파일 요청을 확인할 수 없습니다', retryable: false } : failure;
    }
    const hash = `sha256:${request.sha256}`;
    const redacted = await redactions.listRedactedContentHashes([hash]);
    if (!redacted.ok) return redacted;
    const location = { storeKind: 'local' as const, ownership: 'brain' as const, locator: brainLocator(request.sha256, bytes.bytes) };
    if (!redacted.hashes.includes(hash)) {
      const put = await files.put(bytes.bytes); if (!put.ok) return put;
    }
    const input = { requestId: request.id, workId: item.id, claimedBy: item.claimedBy, fileId: idGen.next(), locationId: idGen.next(), hash, size: bytes.bytes.length, location, now: clock.now() };
    let finished = await store.finishImport({ ...input, cleanupDone: false });
    if (!finished.ok) return finished;
    if (finished.redacted) {
      const removed = await files.delete(location);
      if (!removed.ok) return { ...removed, retryable: true };
      finished = await store.finishImport({ ...input, cleanupDone: true });
      if (!finished.ok) return finished;
    }
    if (failures) { const resolved = await failures.resolveFailures({ targetKind: 'file_request', targetId: item.targetId, stage: FILE_IMPORT_KIND, now: clock.now() }); if (!resolved.ok) return resolved; }
    await staging.remove(request.source, request.locator).catch(() => {});
    return { ok: true };
  };
}
