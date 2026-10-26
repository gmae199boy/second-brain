import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { SourceFileReader } from 'second_brain';

export function fileSourceReader(): SourceFileReader {
  return {
    async read(path, maxBytes) {
      const failure = { ok: false as const, message: '원본 파일을 읽을 수 없습니다' };
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return failure;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        // Nonblocking open also lets us reject FIFOs without waiting for a writer.
        handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) return failure;
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const chunk = new Uint8Array(Math.min(64 * 1024, maxBytes + 1 - size));
          const { bytesRead } = await handle.read(chunk);
          if (bytesRead === 0) break;
          size += bytesRead;
          if (size > maxBytes) return failure;
          chunks.push(chunk.subarray(0, bytesRead));
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return { ok: true, bytes };
      } catch { return failure; }
      finally { await handle?.close().catch(() => undefined); }
    },
  };
}
