import { maskSecrets } from './secret-patterns.js';
import { sha256Hex, utf8Bytes } from './sha256.js';

/**
 * The failure record, and the two functions that decide what goes in it
 * (AD-21, Table Contract).
 *
 * `failures` is a record and not a queue: it says what went wrong, which piece
 * of work it was about, and whether anybody has fixed it. The queue is
 * `work_items`, which is why there are no claim columns here.
 */

/**
 * One row of `failures` (0004).
 *
 * The target key is `work_items`'s, column for column, because they are the two
 * halves of the same question: which piece of work is this about. A session
 * collection failure is `targetKind: 'session'` and the session token
 * `harness:harness_session_id`, which is the one spelling a session has outside
 * this process and which exists whether or not a session row does (AD-8).
 *
 * `harness` and `sessionId` are information and both nullable: a failure about a
 * file, a project or a transcript folder has neither to give (2026-10-16).
 */
export interface Failure {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `targetId`, `stage` and `fingerprint`. */
  targetKind: string;
  targetId: string;
  /** Which step failed. For a work item, the kind of work. */
  stage: string;
  /** Distinguishes two different failures of the same stage (`failureFingerprint`). */
  fingerprint: string;
  /** Information only: which harness this was about, when that is a thing. */
  harness: string | null;
  sessionId: string | null;
  /** Coded, so a retry can decide what to do (Conventions). */
  code: string;
  /** Already through `failureText`: masked, and inside the byte limit. */
  message: string;
  occurredAt: Date;
  /** Filled by drain once the work went through (Table Contract). */
  resolvedAt: Date | null;
}

/** What one fingerprint is made of (`epic-capture` Notes, spine Deferred). */
export interface FailureFingerprintInput {
  /** Which step failed: for a work item, the kind of work. */
  stage: string;
  /**
   * A stable identifier of what was being worked on. Stable is the whole of the
   * requirement: a path that moves, an instant, or a line number would make the
   * same recurring problem a new row every time.
   */
  input: string;
  /** The classification code, not the sentence: `DB_LOCKED`, not its message. */
  code: string;
}

/**
 * `sha256:` and the hash of `[stage, input, code]` as JSON.
 *
 * Three things and no more. The message, the instant, the path and the stack are
 * deliberately out: the fingerprint is what makes "the same cause a hundred
 * times" one row (I/O matrix), and any of those four would make it a hundred.
 * JSON of an array rather than a joined string, because `JSON.stringify` escapes
 * the separator — two different triples cannot be spelled the same way.
 */
export function failureFingerprint(input: FailureFingerprintInput): string {
  return `sha256:${sha256Hex(JSON.stringify([input.stage, input.input, input.code]))}`;
}

/**
 * The most a stored failure sentence may take, in UTF-8 bytes.
 *
 * It applies to `failures.message` and to `work_items.last_error`, which carry
 * the same sentence. A limit exists because the sentence comes from outside —
 * a driver, an HTTP body, a stack — and a megabyte of it in a row nobody can
 * read is a row that costs every later read.
 */
export const FAILURE_MESSAGE_MAX_BYTES = 8192;

/**
 * `text`, cut to at most `maxBytes` UTF-8 bytes at a code point boundary.
 *
 * The boundary matters twice. A multi-byte character cut in half is a broken
 * character, and a surrogate pair cut in half is not a character at all — so
 * the loop walks code points (`for…of`) rather than UTF-16 units, and a pair is
 * either wholly in or wholly out.
 *
 * Nothing is appended to say it was cut. The marker would itself take bytes out
 * of the budget, and a sentence that ends mid-word reads as cut without one.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  // The common case, and the only one that costs nothing: already short enough.
  if (utf8Bytes(text).length <= maxBytes) return text;

  let kept = '';
  let bytes = 0;
  for (const codePoint of text) {
    const size = utf8Bytes(codePoint).length;
    if (bytes + size > maxBytes) break;
    kept += codePoint;
    bytes += size;
  }
  return kept;
}

/**
 * One failure sentence as it is stored: masked, then cut.
 *
 * Masked first and cut second, because the other order could leave the tail of
 * a secret behind — a cut that landed inside a token would hand the masker a
 * fragment its pattern no longer matches (AD-11).
 *
 * This is the one place either rule is applied. `failures.message` and
 * `work_items.last_error` both come through here, so a sentence stored in one
 * cannot be spelled differently in the other. It is masked on the way *in*,
 * which is the exception to "mask on the way out" and is deliberate: an error
 * sentence is not conversation data, it is a log line, and nothing re-reads it
 * from a transcript later (Decision 5, 2026-10-19).
 *
 * No payload goes anywhere near it: a failure says what went wrong, not what was
 * being written when it did (Boundaries).
 */
export function failureText(text: string): string {
  return truncateUtf8(maskSecrets(text, 'body').text, FAILURE_MESSAGE_MAX_BYTES);
}
