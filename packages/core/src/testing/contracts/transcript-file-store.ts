import type { TranscriptFileStore } from '../../ports/store.js';
import { assertEqual, assertOk, assertTrue } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
import {
  otherTranscriptFileId,
  sampleTranscriptFileId,
  sampleTranscriptFileInput,
} from '../fixtures.js';

/**
 * The transcript-history capability: how far each file has been read, so a
 * folder scan opens only what changed (AD-7, Table Contract).
 *
 * A smaller size is taken only from a reset or from a read that began strictly
 * later than the stored one. Two reads of a growing transcript can finish out of
 * order — a hook and a drain, or two hooks of overlapping turns — and the older
 * one must not wind the history back. A later read that finds the file smaller
 * is the truth, though: refusing it would queue that file on every scan (P19).
 *
 * Every id and every instant arrives in the input: the store mints nothing and
 * reads no clock (AD-8, AD-13).
 */
export function transcriptFileStoreContract(): ContractCase<TranscriptFileStore>[] {
  const SCANNED = new Date('2026-02-03T04:05:06.000Z');
  const LATER = new Date('2026-02-03T05:05:06.000Z');

  return [
    contractCase<TranscriptFileStore>(
      'listTranscriptFiles answers an empty history as a value',
      async (make) => {
        await withSubject(make, async (store) => {
          const read = await store.listTranscriptFiles({ harness: 'demo' });
          assertOk(read, 'listTranscriptFiles must answer with a value, even with no rows');
          assertEqual(read.files.length, 0, 'a brain that has scanned nothing has no rows');
        });
      },
    ),

    contractCase<TranscriptFileStore>(
      'recordTranscriptFile creates the row and reads back what it was given',
      async (make) => {
        await withSubject(make, async (store) => {
          const input = sampleTranscriptFileInput();
          const written = await store.recordTranscriptFile(input);
          assertOk(written, 'recordTranscriptFile failed');
          assertEqual(written.file.id, input.id, 'the created row kept another id');
          assertEqual(written.file.sizeBytes, input.sizeBytes, 'the row kept another size');
          assertEqual(
            written.file.fingerprint,
            input.fingerprint,
            'the row kept another fingerprint',
          );
          assertEqual(written.file.cursor, input.cursor, 'the row kept another cursor');
          assertEqual(
            written.file.scannedAt.getTime(),
            input.scannedAt.getTime(),
            'the row must keep the instant it was given, not one the store read (AD-13)',
          );

          const read = await store.listTranscriptFiles({ harness: input.harness });
          assertOk(read, 'listTranscriptFiles failed after a record');
          assertEqual(read.files.length, 1, 'the recorded row must be readable back');
          assertEqual(read.files[0]?.path, input.path, 'the wrong row came back');

          // Another harness's history is another harness's: the scan asks per
          // folder, and a row leaking between them would make it open a file
          // it has no business reading.
          const elsewhere = await store.listTranscriptFiles({ harness: 'other' });
          assertOk(elsewhere, 'listTranscriptFiles for another harness failed');
          assertEqual(elsewhere.files.length, 0, 'the history is keyed by harness and path');
        });
      },
    ),

    contractCase<TranscriptFileStore>(
      'a second record of the same file keeps the first row and moves it forward',
      async (make) => {
        await withSubject(make, async (store) => {
          const first = sampleTranscriptFileInput();
          assertOk(await store.recordTranscriptFile(first), 'the first record failed');

          const grown = await store.recordTranscriptFile(
            sampleTranscriptFileInput({
              id: otherTranscriptFileId,
              sizeBytes: 2048,
              fingerprint: `sha256:${'c'.repeat(64)}`,
              cursor: { lastHarnessMessageId: 'm4', fingerprint: `sha256:${'d'.repeat(64)}` },
              scannedAt: LATER,
            }),
          );
          assertOk(grown, 'the second record failed');
          assertEqual(
            grown.file.id,
            sampleTranscriptFileId,
            'the row must keep the id it has, not take the proposed one (AD-8)',
          );
          assertEqual(grown.file.sizeBytes, 2048, 'a larger size must be taken');
          assertEqual(
            grown.file.cursor?.lastHarnessMessageId,
            'm4',
            'the cursor moves with the size: they are one fact about one read',
          );
          assertEqual(
            grown.file.scannedAt.getTime(),
            LATER.getTime(),
            'a record that moved the row forward must carry its own instant',
          );
        });
      },
    ),

    contractCase<TranscriptFileStore>('작은 크기는 더 늦게 시작했거나 reset인 읽기만 받는다', async (make) => {
      await withSubject(make, async (store) => {
        assertOk(
          await store.recordTranscriptFile(sampleTranscriptFileInput({ sizeBytes: 2048 })),
          'the first record failed',
        );

        for (const scannedAt of [new Date(SCANNED.getTime() - 1), SCANNED]) {
          const backwards = await store.recordTranscriptFile(sampleTranscriptFileInput({
            sizeBytes: 1024, fingerprint: `sha256:${'e'.repeat(64)}`, cursor: null, scannedAt,
          }));
          assertOk(backwards, '작은 읽기 기록 실패');
          assertEqual(backwards.file.sizeBytes, 2048, '더 이르거나 같은 시작 시각은 버려야 한다');
          assertTrue(backwards.file.cursor !== null, '버린 읽기는 커서를 바꾸면 안 된다');
          assertEqual(backwards.file.scannedAt.getTime(), SCANNED.getTime(), '버린 읽기는 시각도 그대로');
        }
        const later = await store.recordTranscriptFile(sampleTranscriptFileInput({
          sizeBytes: 1024, cursor: null, scannedAt: LATER,
        }));
        assertOk(later, '나중 읽기 기록 실패');
        assertEqual(later.file.sizeBytes, 1024, '더 늦게 시작한 작은 읽기는 받아야 한다');
        assertEqual(later.file.cursor, null, '받은 크기와 커서는 함께 움직인다');
        assertEqual(later.file.scannedAt.getTime(), LATER.getTime(), '시작 시각 누락');

        const reset = await store.recordTranscriptFile(
          sampleTranscriptFileInput({
            sizeBytes: 512,
            fingerprint: `sha256:${'f'.repeat(64)}`,
            cursor: { lastHarnessMessageId: 'm1', fingerprint: `sha256:${'0'.repeat(64)}` },
            scannedAt: SCANNED,
            reset: true,
          }),
        );
        assertOk(reset, 'the reset record failed');
        assertEqual(reset.file.sizeBytes, 512, 'a reset must be allowed to shrink the row');
        assertEqual(
          reset.file.cursor?.lastHarnessMessageId,
          'm1',
          'a reset must move the cursor back with the size',
        );
      });
    }),
  ];
}
