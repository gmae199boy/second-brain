import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, stat, readFile, unlink, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brainLocator, isBrainLocator, type FileLocation, type FileStore } from 'second_brain';

/** No I/O until a method is called. Content is published with one atomic rename. */
export function localFileStore({ root }: { root: string }): FileStore {
  const base = resolve(root);
  const refused = { ok: false as const, code: 'LOCATION_REFUSED' as const, message: '허용되지 않는 파일 위치입니다' };
  const unavailable = () => ({ ok: false as const, code: 'FILES_UNAVAILABLE' as const, message: '파일 저장소에 접근할 수 없습니다' });
  const inside = (path: string) => path.startsWith(base + sep);
  async function pathOf(l: FileLocation): Promise<string | null> {
    if (l.storeKind !== 'local' || l.ownership !== 'brain' || !isBrainLocator(l.locator)) return null;
    const path = resolve(base, l.locator);
    if (!inside(path)) return null;
    // Existing symbolic links may not redirect a blob outside the configured root.
    const actualBase = await realpath(base).catch(() => base);
    let ancestor = path;
    for (;;) {
      try {
        const actual = await realpath(ancestor);
        if (actual !== actualBase && !actual.startsWith(actualBase + sep)) return null;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor || ancestor === base) break;
        ancestor = parent;
      }
    }
    return path;
  }
  return {
    async put(bytes) {
      let temporary: string | undefined;
      try {
        const hex = createHash('sha256').update(bytes).digest('hex');
        const location = { storeKind: 'local' as const, ownership: 'brain' as const, locator: brainLocator(hex, bytes) };
        const path = await pathOf(location);
        if (path === null) return unavailable();
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const existing = await stat(path).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (existing !== null && !existing.isFile()) return unavailable();
        if (existing?.size !== bytes.length) {
          temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
          await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
          await rename(temporary, path);
          temporary = undefined;
        }
        return { ok: true, contentHash: `sha256:${hex}`, sizeBytes: bytes.length, location };
      } catch { return unavailable(); }
      finally { if (temporary !== undefined) await unlink(temporary).catch(() => undefined); }
    },
    async get(l) {
      try {
        const path = await pathOf(l);
        if (path === null) return refused;
        return { ok: true, bytes: new Uint8Array(await readFile(path)) };
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: false, code: 'FILE_NOT_FOUND', message: '파일이 없습니다' } : unavailable();
      }
    },
    async exists(l) {
      try {
        const path = await pathOf(l);
        if (path === null) return refused;
        try { await stat(path); return { ok: true, exists: true }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, exists: false }; throw error; }
      } catch { return unavailable(); }
    },
    async url(l) {
      try { const path = await pathOf(l); return path === null ? refused : { ok: true, url: pathToFileURL(path).href }; }
      catch { return unavailable(); }
    },
    async delete(l) {
      try {
        const path = await pathOf(l);
        if (path === null) return refused;
        try { await unlink(path); return { ok: true, deleted: true }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, deleted: false }; throw error; }
      } catch { return unavailable(); }
    },
  };
}
