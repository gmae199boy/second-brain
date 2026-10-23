import { brainLocator, contentHashOfBytes, isBrainLocator, type FileLocation } from '../../domain/file.js';
import type { FileStore } from '../../ports/file-store.js';
export function memoryFileStore(): FileStore {
  const blobs = new Map<string, Uint8Array>();
  const refused = { ok: false as const, code: 'LOCATION_REFUSED' as const, message: '허용되지 않는 파일 위치입니다' };
  const accepts = (l: FileLocation) => l.storeKind === 'local' && l.ownership === 'brain' && isBrainLocator(l.locator);
  return {
    async put(bytes) {
      const contentHash = contentHashOfBytes(bytes);
      const locator = brainLocator(contentHash.slice(7), bytes);
      blobs.set(locator, bytes.slice());
      return { ok: true, contentHash, sizeBytes: bytes.length, location: { storeKind: 'local', ownership: 'brain', locator } };
    },
    async get(l) {
      if (!accepts(l)) return refused;
      const bytes = blobs.get(l.locator);
      return bytes === undefined ? { ok: false, code: 'FILE_NOT_FOUND', message: '파일이 없습니다' } : { ok: true, bytes: bytes.slice() };
    },
    async exists(l) { return accepts(l) ? { ok: true, exists: blobs.has(l.locator) } : refused; },
    async url(l) { return accepts(l) ? { ok: true, url: `memory:///${l.locator}` } : refused; },
    async delete(l) { return accepts(l) ? { ok: true, deleted: blobs.delete(l.locator) } : refused; },
  };
}
