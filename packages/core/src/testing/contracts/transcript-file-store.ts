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
 * The whole of it is "forward only". Two reads of a growing transcript can
 * finish out of order — a hook and a drain, or two hooks of overlapping turns —
 * and the older one must not wind the history back, because the only thing that
 * would come of that is the next scan reading a stretch of file it has already
 * stored. The one exception is a parse that reset its cursor: a compacted
 * transcript really is smaller than it was, and a row that kept the old number
 * would call that file unchanged for ever.
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

    contractCase<TranscriptFileStore>('a smaller size is dropped unless it is a reset', async (make) => {
      await withSubject(make, async (store) => {
        assertOk(
          await store.recordTranscriptFile(sampleTranscriptFileInput({ sizeBytes: 2048 })),
          'the first record failed',
        );

        const backwards = await store.recordTranscriptFile(
          sampleTranscriptFileInput({
            sizeBytes: 1024,
            fingerprint: `sha256:${'e'.repeat(64)}`,
            cursor: null,
            scannedAt: LATER,
          }),
        );
        assertOk(backwards, 'the backwards record failed');
        assertEqual(
          backwards.file.sizeBytes,
          2048,
          'a smaller size must be dropped: the history only moves forward (Table Contract)',
        );
        assertTrue(
          backwards.file.cursor !== null,
          'a dropped size must leave the cursor where it was',
        );
        assertEqual(
          backwards.file.scannedAt.getTime(),
          SCANNED.getTime(),
          'a dropped record must change nothing at all about the row',
        );

        // A reset is the one case where a smaller file is the truth: the
        // transcript was compacted, and the row has to follow it down or the
        // scan would call that file unchanged for ever.
        const reset = await store.recordTranscriptFile(
          sampleTranscriptFileInput({
            sizeBytes: 512,
            fingerprint: `sha256:${'f'.repeat(64)}`,
            cursor: { lastHarnessMessageId: 'm1', fingerprint: `sha256:${'0'.repeat(64)}` },
            scannedAt: LATER,
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
