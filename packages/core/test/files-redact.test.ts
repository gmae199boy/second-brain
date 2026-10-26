import { describe, expect, it } from 'vitest';
import { BLOB_DELETE_KIND, FILE_LOCATION_TARGET_KIND } from '../src/files/blob-delete-work.js';
import {
  FILE_REDACTION_KIND,
  checkFilesRedact,
  planFileRedaction,
  redactFile,
} from '../src/files/redact.js';
import type {
  AttachmentStore,
  FileLocationRow,
  ReadFileSharingResult,
  RedactFileCurrent,
  RedactFileResult,
} from '../src/ports/store.js';
import { fixedClock } from '../src/testing/fakes/clock.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';

const FILE_ID = '01940000-0000-7000-8000-000000000001';
const HASH = `sha256:${'ab'.repeat(32)}`;
const NOW = new Date('2026-03-04T05:06:07.000Z');

function dependencies(store: Pick<AttachmentStore, 'readFileSharing' | 'redactFile'>) {
  return { store, clock: fixedClock(NOW), idGen: sequenceIdGen({ start: 900, timestampMs: 1770000000000 }) };
}

/** A store that answers one sharing read and records what was asked of it. */
function sharingStore(
  sharing: ReadFileSharingResult,
  redacted: RedactFileResult = {
    ok: true, fileId: FILE_ID, contentHash: HASH, messages: 2, alreadyRedacted: false,
    extractionsRemoved: 1, chunksRemoved: 3, namesRemoved: 2, metadataRemoved: 0,
    blobDeletesQueued: 1, failuresResolved: 1,
  },
) {
  const asked: unknown[] = [];
  return {
    asked,
    store: {
      async readFileSharing(ref: unknown) {
        asked.push({ read: ref });
        return sharing;
      },
      async redactFile(input: { fileId: string }) {
        asked.push({ redact: input.fileId });
        return redacted;
      },
    } as Pick<AttachmentStore, 'readFileSharing' | 'redactFile'>,
  };
}

const FOUND: ReadFileSharingResult = {
  ok: true, file: { id: FILE_ID, contentHash: HASH, redactedAt: null }, messages: 2,
};

function location(overrides: Partial<FileLocationRow> = {}): FileLocationRow {
  return {
    id: '01940000-0000-7000-8000-00000000000a',
    fileId: FILE_ID,
    storeKind: 'local',
    locator: 'ab/ab/' + 'ab'.repeat(32),
    ownership: 'brain',
    deletedAt: null,
    ...overrides,
  };
}

function current(locations: readonly FileLocationRow[], redactedAt: Date | null = null): RedactFileCurrent {
  return { file: { id: FILE_ID, contentHash: HASH, redactedAt }, locations };
}

describe('checkFilesRedact', () => {
  it('takes a file UUIDv7 and a lowercase content hash, and nothing else', () => {
    expect(checkFilesRedact({ file: FILE_ID })).toBeUndefined();
    expect(checkFilesRedact({ file: HASH, confirm: true })).toBeUndefined();
    for (const file of [
      '',
      'not-a-file',
      // A UUID that is not version 7, and one whose variant is wrong.
      '01940000-0000-4000-8000-000000000001',
      '01940000-0000-7000-7000-000000000001',
      // The hash under the wrong prefix, the wrong length, and in upper case.
      `sha1:${'ab'.repeat(32)}`,
      `sha256:${'ab'.repeat(31)}`,
      `sha256:${'AB'.repeat(32)}`,
      HASH + 'a',
    ]) {
      const failure = checkFilesRedact({ file });
      expect(failure?.code, file).toBe('USAGE');
    }
    expect(checkFilesRedact({ file: FILE_ID, confirm: 'yes' as unknown as boolean })?.code).toBe('USAGE');
  });

  it('never gates: the count the gate has to say is only in the database', () => {
    // The confirmation lives in the verb, after the sharing read (Design Notes).
    expect(checkFilesRedact({ file: FILE_ID })).toBeUndefined();
  });
});

describe('redactFile', () => {
  it('refuses a bad argument before it reads anything', async () => {
    const { asked, store } = sharingStore(FOUND);
    const result = await redactFile(dependencies(store), { file: 'nope', confirm: true });
    expect(result).toMatchObject({ ok: false, code: 'USAGE' });
    expect(asked).toEqual([]);
  });

  it('gates after the sharing read, names the count, and writes nothing', async () => {
    const { asked, store } = sharingStore(FOUND);
    const result = await redactFile(dependencies(store), { file: FILE_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIRMATION_REQUIRED');
    expect(result.message).toContain('메시지 2개');
    expect(result.message).toContain('--yes');
    // The count is in the sentence and not in the retry: the retry is argv.
    expect(result.retry).toEqual({ ns: 'files', verb: 'redact', args: { file: FILE_ID, confirm: true } });
    expect(asked).toEqual([{ read: { fileId: FILE_ID } }]);
  });

  it('lowercases an id the check accepted in upper case', async () => {
    // The format check is case-insensitive about the id, and the stored id is
    // the lower-case spelling every `IdGen` mints. Handing the upper-case form
    // to the store would answer `FILE_NOT_FOUND` about a file that is there.
    const { asked, store } = sharingStore(FOUND);
    expect(await redactFile(dependencies(store), { file: FILE_ID.toUpperCase(), confirm: true }))
      .toMatchObject({ ok: true, fileId: FILE_ID });
    expect(asked).toEqual([{ read: { fileId: FILE_ID } }, { redact: FILE_ID }]);
  });

  it('reads by content hash and masks the row that hash names', async () => {
    const { asked, store } = sharingStore(FOUND);
    const result = await redactFile(dependencies(store), { file: HASH, confirm: true });
    expect(result).toMatchObject({ ok: true, fileId: FILE_ID, contentHash: HASH, messages: 2,
      alreadyRedacted: false, extractionsRemoved: 1, chunksRemoved: 3, namesRemoved: 2,
      metadataRemoved: 0, blobDeletesQueued: 1, failuresResolved: 1 });
    expect(asked).toEqual([{ read: { contentHash: HASH } }, { redact: FILE_ID }]);
  });

  it('passes the store codes through and never reaches the write on a missing file', async () => {
    const missing = sharingStore({ ok: false, code: 'FILE_NOT_FOUND', message: '지정한 파일이 없습니다' });
    expect(await redactFile(dependencies(missing.store), { file: FILE_ID, confirm: true }))
      .toMatchObject({ ok: false, code: 'FILE_NOT_FOUND' });
    expect(missing.asked).toEqual([{ read: { fileId: FILE_ID } }]);

    const away = sharingStore({ ok: false, code: 'DB_UNAVAILABLE', message: '닿지 못했습니다' });
    expect(await redactFile(dependencies(away.store), { file: FILE_ID }))
      .toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });

    const locked = sharingStore(FOUND, { ok: false, code: 'DB_LOCKED', message: '잠겼습니다' });
    expect(await redactFile(dependencies(locked.store), { file: FILE_ID, confirm: true }))
      .toMatchObject({ ok: false, code: 'DB_LOCKED' });
  });
});

describe('planFileRedaction', () => {
  it('records the whole file with no range and queues only Brain local places', () => {
    const ids = sequenceIdGen({ start: 500, timestampMs: 1770000000000 });
    const brain = location({ id: 'loc-brain' });
    const plan = planFileRedaction(
      current([
        brain,
        // Somebody else's file: a record of where the bytes came from, never
        // Brain's to delete.
        location({ id: 'loc-external', ownership: 'external', locator: '~/project/note.txt' }),
        // Brain's copy in Drive: epic 8's to remove, and the handler refuses it.
        location({ id: 'loc-drive', storeKind: 'drive', locator: 'drive-file-id' }),
        // A Brain copy that is already empty: nothing left to ask for.
        location({ id: 'loc-gone', deletedAt: new Date('2026-02-01T00:00:00.000Z') }),
      ]),
      { clock: fixedClock(NOW), idGen: ids },
    );
    expect(plan.work.map((work) => work.targetId)).toEqual(['loc-brain']);
    expect(plan.work[0]).toMatchObject({
      kind: BLOB_DELETE_KIND, targetKind: FILE_LOCATION_TARGET_KIND,
      createdAt: NOW, nextAttemptAt: NOW,
    });
    expect(plan.redaction).toMatchObject({
      messageId: null, toolNoteId: null, fileId: FILE_ID,
      start: null, end: null, kind: FILE_REDACTION_KIND,
      contentHash: HASH, occurredAt: NOW, patternVersion: null,
    });
    // Two ids, and neither is the other's: the work row and the record.
    expect(plan.redaction?.id).not.toBe(plan.work[0]?.id);
  });

  it('writes no second record for a file somebody already masked, and still asks for the bytes', () => {
    const ids = sequenceIdGen({ start: 600, timestampMs: 1770000000000 });
    const plan = planFileRedaction(
      current([location({ id: 'loc-brain' })], new Date('2026-02-02T00:00:00.000Z')),
      { clock: fixedClock(NOW), idGen: ids },
    );
    expect(plan.redaction).toBe(null);
    expect(plan.work.map((work) => work.targetId)).toEqual(['loc-brain']);
  });

  it('asks for nothing when every Brain copy is already gone', () => {
    const plan = planFileRedaction(
      current([location({ deletedAt: NOW }), location({ id: 'loc-external', ownership: 'external', locator: '~/a' })]),
      { clock: fixedClock(NOW), idGen: sequenceIdGen({ start: 700, timestampMs: 1770000000000 }) },
    );
    expect(plan.work).toEqual([]);
    expect(plan.redaction).not.toBe(null);
  });
});
