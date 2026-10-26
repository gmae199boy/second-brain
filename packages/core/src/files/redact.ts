import { requireConfirmation, type Failure } from '../envelope.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { AttachmentStore, FileRef, RedactFileCurrent, RedactFilePlan } from '../ports/store.js';
import { blobDeleteWork } from './blob-delete-work.js';
import { DOCUMENT_EXTRACT_KIND } from './extract-work.js';

/**
 * Masking one stored file: the verb behind `brain files redact` (AD-11, AD-23).
 *
 * Attachments are kept as the original bytes, and masking happens where text
 * leaves Brain (마스킹 B). That leaves one thing a person may need and nothing
 * else offers: taking a file's *content* out of the brain — Brain's own copy of
 * the bytes, the text that was read out of it, the searchable name index
 * (`file_names` and its FTS rows) and the metadata read off the bytes.
 *
 * What stays is the provenance. `message_attachments` is immutable (0008), so
 * the name the attachment was carried under and what it pointed at stay on the
 * row, and the `external` location keeps saying where the user's own file was.
 * Neither is content Brain read: they are the record that this conversation
 * attached something, which masking must not rewrite.
 *
 * It is by *content* and not by attachment, because that is what a file row is:
 * the same bytes attached to five messages are one row, one blob and one set of
 * pieces, so masking them removes the file from all five. The confirmation
 * message is where that is said, which is why the gate sits inside this verb
 * and after the sharing read rather than in a CLI preflight: the count cannot
 * be known before the database has been asked (Design Notes).
 *
 * What it never touches is the user's own file. `external` locations are
 * records of where the bytes came from, and this verb neither reads nor deletes
 * nor rewrites them: only Brain's own local copies are queued for deletion.
 */

/** The kind a whole-file masking is recorded under. A person asked for it. */
export const FILE_REDACTION_KIND = 'manual';

/**
 * Which failure rows a file masking settles: this file's own reading failures
 * (AD-24).
 *
 * Left open they would keep `doctor run`'s `failures` check at `warn` for ever
 * and make every `failures retry` count the file as `redacted` — a problem
 * nobody can fix, because the file's bytes are gone on purpose. Nothing else is
 * touched: a `blob_delete` failure is about a place and is settled when that
 * place is finally emptied (Design Notes).
 */
export const FILE_REDACTION_RESOLVES = {
  targetKind: 'file',
  stage: DOCUMENT_EXTRACT_KIND,
} as const;

export interface FilesRedactInput {
  /**
   * The file: its UUIDv7, or `sha256:` and 64 lowercase hex characters of the
   * content hash — which a person can work out from the original bytes with
   * `shasum -a 256` (Design Notes).
   */
  file: string;
  confirm?: boolean;
}

export interface FilesRedactData {
  fileId: string;
  contentHash: string;
  /** How many messages shared this content, and so lost an attachment here. */
  messages: number;
  alreadyRedacted: boolean;
  extractionsRemoved: number;
  chunksRemoved: number;
  namesRemoved: number;
  metadataRemoved: number;
  blobDeletesQueued: number;
  failuresResolved: number;
}

export type FilesRedactResult = ({ ok: true } & FilesRedactData) | ({ ok: false } & Failure);

export interface FilesRedactDependencies {
  store: Pick<AttachmentStore, 'readFileSharing' | 'redactFile'>;
  clock: Clock;
  idGen: IdGen;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u;

/**
 * Shared CLI preflight and SDK check: **the format only**, no port called.
 *
 * The confirmation gate is deliberately not here. `messages redact` can gate in
 * a preflight because its message says nothing a database holds; this one has
 * to say how many messages share the file, so the gate waits until the sharing
 * read has answered (`redactFile`, Design Notes).
 */
export function checkFilesRedact(input: FilesRedactInput): Failure | undefined {
  if (
    typeof input.file !== 'string' ||
    !(UUID_V7.test(input.file) || CONTENT_HASH.test(input.file)) ||
    (input.confirm !== undefined && typeof input.confirm !== 'boolean')
  ) {
    return {
      code: 'USAGE',
      message: '파일 UUIDv7이나 `sha256:` 다음 소문자 16진수 64자의 내용 해시를 주세요.',
    };
  }
  return undefined;
}

/**
 * Which file the argument names, in the shape the store reads by.
 *
 * The id is lowercased, because the format check accepts either case and the
 * stored id is the lower-case spelling every `IdGen` here mints: an upper-case
 * id would otherwise pass the check and then be answered `FILE_NOT_FOUND`,
 * which says the file is not there when it is. The hash is not lowercased —
 * the check already requires lower case for it, so an upper-case hash is a
 * `USAGE` and never reaches here.
 */
function fileRef(file: string): FileRef {
  return CONTENT_HASH.test(file) ? { contentHash: file } : { fileId: file.toLowerCase() };
}

/**
 * Mask one file, after a person has agreed to it.
 *
 * The order is the whole of the use case: check the format, read who shares the
 * content without taking any lock, refuse a file nothing answers to, ask for
 * consent — and only then open the one write transaction. Nothing is written
 * before the consent, which is what makes the gated call safe to run in order
 * to find out what it would do.
 */
export async function redactFile(
  dependencies: FilesRedactDependencies,
  input: FilesRedactInput,
): Promise<FilesRedactResult> {
  const failure = checkFilesRedact(input);
  if (failure !== undefined) return { ok: false, ...failure };

  const { store, clock, idGen } = dependencies;
  const sharing = await store.readFileSharing(fileRef(input.file));
  if (!sharing.ok) return { ok: false, code: sharing.code, message: sharing.message };

  if (input.confirm !== true) {
    // The count goes into the sentence and not into `retry.args`: the retry is
    // meant to be *run*, and the CLI renders it as argv from the arguments this
    // verb declares (`envelope.ts`). An argument nobody can type would be a
    // command nobody can run.
    const gate = requireConfirmation(
      { ns: 'files', verb: 'redact', args: { file: input.file } },
      `이 파일 내용은 메시지 ${String(sharing.messages)}개가 함께 씁니다. ` +
        '가리면 그 모두에서 원본 사본·추출 텍스트·검색용 이름·메타데이터가 사라지고 ' +
        '되돌릴 수 없습니다. 첨부에 적힌 이름과 사용자 원본의 자리는 출처로 남습니다. ' +
        '--yes로 동의하세요.',
    );
    if (gate !== undefined) return { ok: false, ...gate };
  }

  const result = await store.redactFile({
    fileId: sharing.file.id,
    plan: (current) => planFileRedaction(current, { clock, idGen }),
  });
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  return {
    ok: true,
    fileId: result.fileId,
    contentHash: result.contentHash,
    messages: result.messages,
    alreadyRedacted: result.alreadyRedacted,
    extractionsRemoved: result.extractionsRemoved,
    chunksRemoved: result.chunksRemoved,
    namesRemoved: result.namesRemoved,
    metadataRemoved: result.metadataRemoved,
    blobDeletesQueued: result.blobDeletesQueued,
    failuresResolved: result.failuresResolved,
  };
}

/**
 * What masking this file comes to, decided inside the write transaction.
 *
 * The record is written once: a file that is already masked gets `null`, and
 * `redactions` is immutable anyway (0005). The work is asked for either way,
 * because a masked file that still has a Brain copy on the disk is exactly what
 * a second call is for — the open-row key makes asking twice one row (AD-21).
 *
 * Only `local`·`brain` places whose bytes have not already gone are queued. A
 * user's own file is not Brain's to delete, and a Brain copy in Drive is epic
 * 8's: the handler refuses both, so queueing them would be work that fails
 * (`files/blob-delete-work.ts`).
 */
export function planFileRedaction(
  current: RedactFileCurrent,
  dependencies: { clock: Clock; idGen: IdGen },
): RedactFilePlan {
  const { clock, idGen } = dependencies;
  const now = clock.now();
  const work = current.locations
    .filter(
      (location) =>
        location.ownership === 'brain' &&
        location.storeKind === 'local' &&
        location.deletedAt === null,
    )
    .map((location) => blobDeleteWork({ id: idGen.next(), locationId: location.id, at: now }));
  if (current.file.redactedAt !== null) return { redaction: null, work };
  return {
    redaction: {
      id: idGen.next(),
      messageId: null,
      toolNoteId: null,
      fileId: current.file.id,
      // A file has no range: the whole of it went (`redactions_range_check`).
      start: null,
      end: null,
      kind: FILE_REDACTION_KIND,
      contentHash: current.file.contentHash,
      occurredAt: now,
      // No pattern found this: a person asked for it by name (AD-11).
      patternVersion: null,
    },
    work,
  };
}
