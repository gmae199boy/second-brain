import { chmod, mkdir, stat } from 'node:fs/promises';
import { describeError } from 'second_brain';

export async function storeFileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

export type FilesRootResult =
  | {
      ok: true;
      /** The folder, as it was asked for. */
      path: string;
      /** Whether this call is the one that made it. */
      created: boolean;
    }
  | { ok: false; code: 'FILES_UNAVAILABLE'; message: string };

/**
 * The file store's root, at mode 0700. An existing folder is tightened rather
 * than left as it was found: the blobs under it are the originals of everything
 * the brain ingested, so "somebody already made this one readable" is not a
 * reason to leave it that way (NFR-1). Nothing is written into it here — the
 * `FileStore` port and the blob writes are epic 2's.
 */
export async function prepareFilesRoot(path: string): Promise<FilesRootResult> {
  try {
    const made = await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    // `mkdir` with `recursive` answers with the first directory it created, and
    // with `undefined` when there was nothing to create.
    return { ok: true, path, created: made !== undefined };
  } catch (error) {
    return {
      ok: false,
      code: 'FILES_UNAVAILABLE',
      message: `파일 저장소 루트를 만들 수 없습니다: ${describeError(error)}`,
    };
  }
}
