import { describe, expect, it } from 'vitest';
import { DOCUMENT_CHUNK_BATCH_MAX } from '../src/domain/document.js';
import { writeExtractionChunks } from '../src/files/extraction-chunks.js';
import type {
  AppendExtractionChunksResult,
  ExtractionChunkInput,
  ExtractionStore,
} from '../src/ports/store.js';

/**
 * The Core side of the two-second rule: a whole document's pieces reach the
 * store as bounded batches, one write transaction each (AD-7, AD-24).
 *
 * The store here is a recorder rather than the memory fake, because what these
 * cases are about is the cut — how many batches, how big, and what happens to
 * the ones after a failure. The fake would answer all of that too, and it would
 * also need a file, a claim and an open generation to do it, none of which the
 * cut depends on.
 */

interface Recorder {
  store: Pick<ExtractionStore, 'appendExtractionChunks'>;
  /** The size of each batch, in the order it arrived. */
  sizes: number[];
}

/** A store that remembers its batches, and fails the `failAt`-th one. */
function recorder(failAt?: number): Recorder {
  const sizes: number[] = [];
  return {
    sizes,
    store: {
      async appendExtractionChunks({ chunks }): Promise<AppendExtractionChunksResult> {
        sizes.push(chunks.length);
        if (sizes.length === failAt) {
          return { ok: false, code: 'CHUNK_INVALID', message: `${String(sizes.length)}번째 배치` };
        }
        // Every real store refuses a batch with no pieces, and so does this one:
        // the helper must not be able to hide that answer (port contract).
        if (chunks.length === 0) {
          return { ok: false, code: 'CHUNK_BATCH_TOO_LARGE', message: '조각이 없습니다' };
        }
        return { ok: true, appended: chunks.length };
      },
    },
  };
}

function chunks(count: number): ExtractionChunkInput[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `chunk-${String(index)}`,
    ordinal: index,
    body: `조각 ${String(index)}`,
    chunkLocator: { type: 'text', start: index * 10, end: index * 10 + 5 },
    page: null,
  }));
}

describe('writeExtractionChunks', () => {
  it('상한 크기 배치로 나눠 차례로 쓰고 쓴 수를 센다', async () => {
    const { store, sizes } = recorder();
    const result = await writeExtractionChunks({ store, extractionId: 'e', chunks: chunks(450) });
    expect(sizes).toEqual([DOCUMENT_CHUNK_BATCH_MAX, DOCUMENT_CHUNK_BATCH_MAX, 50]);
    expect(result).toEqual({ ok: true, appended: 450 });
  });

  it('첫 실패에서 멈추고 그 결과를 그대로 돌려준다', async () => {
    const { store, sizes } = recorder(2);
    const result = await writeExtractionChunks({ store, extractionId: 'e', chunks: chunks(450) });
    // The third batch is never sent: the reading is about to be closed as
    // failed, and closing it is what removes the two batches already written.
    expect(sizes).toEqual([DOCUMENT_CHUNK_BATCH_MAX, DOCUMENT_CHUNK_BATCH_MAX]);
    expect(result).toEqual({ ok: false, code: 'CHUNK_INVALID', message: '2번째 배치' });
  });

  it('상한에 꼭 맞는 목록은 한 배치다', async () => {
    const { store, sizes } = recorder();
    const result = await writeExtractionChunks({
      store,
      extractionId: 'e',
      chunks: chunks(DOCUMENT_CHUNK_BATCH_MAX),
    });
    expect(sizes).toEqual([DOCUMENT_CHUNK_BATCH_MAX]);
    expect(result).toEqual({ ok: true, appended: DOCUMENT_CHUNK_BATCH_MAX });
  });

  it('빈 목록은 조용히 성공하지 않고 store의 거부를 그대로 전한다', async () => {
    const { store, sizes } = recorder();
    const result = await writeExtractionChunks({ store, extractionId: 'e', chunks: [] });
    expect(sizes).toEqual([0]);
    expect(result).toEqual({ ok: false, code: 'CHUNK_BATCH_TOO_LARGE', message: '조각이 없습니다' });
  });
});
