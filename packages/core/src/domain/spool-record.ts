import { formatInstant, parseInstant } from '../instant.js';
import type { SessionToken } from './session-token.js';
import { utf8Bytes } from './sha256.js';

/**
 * One line of the spool, and the codec that is the only thing allowed to spell
 * it (AD-9).
 *
 * The spool is the queue of writes the database could not take: a line of JSON
 * per record, in a file per process, replayed later by drain. It is text on
 * disk, so it has the same problem every stored format has — it outlives the
 * code that wrote it — and the same answer: one version number on every line,
 * one function that writes them, one that reads them, and no second spelling
 * anywhere.
 *
 * The codec is pure, and both directions are values. A broken line is the
 * normal state of a file a process was killed while writing, and a reader that
 * threw on one would turn a recoverable file into a crash on the hook path.
 */

/**
 * Version of the *line format*, carried on every line as `schema_version`.
 *
 * It is not the database's schema version and the two move independently: a
 * migration that adds a column changes nothing about how a record is spelled,
 * and a new field on a record changes nothing about the database. A line whose
 * version this build does not know is left alone rather than guessed at.
 */
export const SPOOL_RECORD_VERSION = 1;

/**
 * The most one line may take, in UTF-8 bytes, newline included (AD-9).
 *
 * A limit exists at all because a line is the unit of replay: a record nothing
 * can read back is a record that is lost, and the one way to lose a whole file
 * is to let a single huge record into it. 64 KiB is well past anything a record
 * of this build carries — attachment bytes never go in the spool (AD-23), and a
 * transcript is re-read rather than copied.
 */
export const SPOOL_LINE_MAX_BYTES = 65_536;

/**
 * How long a claim may be held before the next drain takes the file back
 * (AD-9). A process that was killed between the claim and the replay leaves a
 * `.claiming` file nothing will ever finish, and the pid check catches that at
 * once — but a pid can be reused, and a process can be stopped rather than
 * killed, so the age of the claim is the second answer.
 */
export const SPOOL_CLAIM_STALE_MS = 600_000;

/**
 * Why a write went to the spool instead of the database. All three mean "the
 * database could not take this", and none of them is a failure of the write
 * itself (AD-9, AD-21).
 *
 * Two of them are also warning codes, so a degraded result names them in
 * `warnings[]`; `DB_LOCKED` is not, because a lock that was held too long is
 * reported as the retry it is rather than as a state of the brain.
 */
export type SpoolCause = 'DB_UNAVAILABLE' | 'DB_LOCKED' | 'SCHEMA_MISMATCH';

/** The causes above as a list, for a decoder that has to check one. */
export const SPOOL_CAUSES: readonly SpoolCause[] = [
  'DB_UNAVAILABLE',
  'DB_LOCKED',
  'SCHEMA_MISMATCH',
];

/**
 * What kinds of record a spool line may carry. Slice 1 writes two: the mark
 * that says a session has to be ingested again, and the failure record the
 * database would not take. The log entries, the injection attempts and the
 * attachment metadata of AD-9 are their own epics, and each one adds a kind here
 * and a handler to the replay frame.
 */
export type SpoolRecordKind = 'session_ingest' | 'failure';

/** The kinds above as a list, for a decoder that has to check one. */
export const SPOOL_RECORD_KINDS: readonly SpoolRecordKind[] = ['session_ingest', 'failure'];

/**
 * "This session has to be ingested again, and here is where to read it from."
 *
 * The transcript is not in here — only the path to it. A transcript is a file
 * the harness keeps and the ingest re-reads, so copying it into the spool would
 * put a second copy of a conversation on disk for no gain: the replay reads the
 * file again and gets whatever has been added since (story 12).
 */
export interface SessionIngestSpoolPayload {
  /** `harness:harness_session_id`, the only session id that travels (AD-8). */
  session: SessionToken;
  /** Where the harness was writing the transcript when this was spooled. */
  transcriptPath: string;
  cause: SpoolCause;
}

/**
 * "This failure could not be written to `failures`, so here it is."
 *
 * Drain records a failure only on the last attempt of an item (AD-21), which
 * means the row is the one place that attempt is remembered: an item closed
 * with no record anywhere would be work that quietly stopped. So when the
 * database refuses the record itself, the same content comes here, and a later
 * drain puts it in (story 12 writes that handler).
 *
 * The fields are `failures`'s own, plus `workItemId`: the item the record was
 * going to close. The replay needs it to close the item too, and it is nullable
 * because a path that records a failure outside the queue has none.
 */
export interface FailureSpoolPayload {
  /** The key of `failures`, column for column (Table Contract). */
  targetKind: string;
  targetId: string;
  stage: string;
  fingerprint: string;
  /** Information, both nullable: not every failure is about a session (AD-12). */
  harness: string | null;
  sessionId: string | null;
  code: string;
  /** Already through `failureText`: masked, and inside the byte limit. */
  message: string;
  /** When the failure happened, in the canonical spelling on the line (AD-13). */
  occurredAt: Date;
  /** The work item this record closes, or `null` outside the queue. */
  workItemId: string | null;
}

/**
 * One record of the spool.
 *
 * `id` and `occurredAt` belong to the process that first made the record and
 * are never changed by a replay (AD-9): the instant is when the thing happened,
 * not when the database finally took it, and the id is what makes a replay of
 * the same line idempotent (AD-8).
 *
 * It is a union on `kind`, so a handler that took the wrong payload apart is a
 * compile error rather than an undefined at replay time.
 */
export type SpoolRecord = SessionIngestSpoolRecord | FailureSpoolRecord;

/** What every record carries, whatever its kind. */
interface SpoolRecordBase {
  /** `SPOOL_RECORD_VERSION` as this build writes it. */
  schemaVersion: number;
  /** UUIDv7, minted by the process that made the record (AD-8). */
  id: string;
  /** When the thing this record is about happened, read once from `Clock`. */
  occurredAt: Date;
}

export interface SessionIngestSpoolRecord extends SpoolRecordBase {
  kind: 'session_ingest';
  payload: SessionIngestSpoolPayload;
}

export interface FailureSpoolRecord extends SpoolRecordBase {
  kind: 'failure';
  payload: FailureSpoolPayload;
}

/**
 * A line, or why there is none. No code: this is a codec and not a command, and
 * the one caller — `Spool.append` — reports the failure under the code of
 * whatever sent it to the spool in the first place (Boundaries).
 */
export type EncodeSpoolLineResult =
  | { ok: true; line: string }
  | { ok: false; message: string };

export type DecodeSpoolLineResult =
  | { ok: true; record: SpoolRecord }
  | { ok: false; message: string };

/**
 * One record as the line that goes in the file, newline included.
 *
 * The JSON keys are `snake_case`, like every other stored and transported shape
 * of this project, and the TypeScript stays `camelCase` (Conventions, 이름).
 * The key order is fixed so that two writes of the same record are the same
 * bytes — which is what lets a test compare files rather than parse them.
 *
 * A record whose instant is not a real one, or whose line would be over the
 * limit, is refused here: the adapter writes what this hands back and never
 * builds a line of its own, so this is the only place either can be caught.
 */
export function encodeSpoolLine(record: SpoolRecord): EncodeSpoolLineResult {
  const occurredAt = formatInstant(record.occurredAt);
  if (!occurredAt.ok) {
    return { ok: false, message: `spool 레코드의 occurred_at: ${occurredAt.message}` };
  }
  if (record.schemaVersion !== SPOOL_RECORD_VERSION) {
    return {
      ok: false,
      message:
        `이 빌드는 spool 줄 형식 ${String(SPOOL_RECORD_VERSION)}만 씁니다. ` +
        `레코드는 ${String(record.schemaVersion)}입니다`,
    };
  }
  if (record.id === '') {
    return { ok: false, message: 'spool 레코드에 id가 없습니다' };
  }

  const payload = encodePayload(record);
  if (!payload.ok) return payload;

  const line = `${JSON.stringify({
    schema_version: record.schemaVersion,
    id: record.id,
    kind: record.kind,
    occurred_at: occurredAt.value,
    payload: payload.value,
  })}\n`;

  const bytes = utf8Bytes(line).length;
  if (bytes > SPOOL_LINE_MAX_BYTES) {
    return {
      ok: false,
      message:
        `spool 한 줄은 ${String(SPOOL_LINE_MAX_BYTES)}바이트까지입니다. ` +
        `이 레코드는 ${String(bytes)}바이트입니다`,
    };
  }
  return { ok: true, line };
}

/**
 * One record's payload as the object that goes on the line, `snake_case` and in
 * a fixed key order, or why it cannot be spelled.
 *
 * It is a `switch` on the kind rather than a spread of the payload, so a kind
 * added to the union without a case here does not compile — a record written as
 * `{}` would be a line the decoder refuses and a record nobody can get back.
 */
function encodePayload(
  record: SpoolRecord,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  switch (record.kind) {
    case 'session_ingest':
      return {
        ok: true,
        value: {
          session: record.payload.session,
          transcript_path: record.payload.transcriptPath,
          cause: record.payload.cause,
        },
      };
    case 'failure': {
      const occurredAt = formatInstant(record.payload.occurredAt);
      if (!occurredAt.ok) {
        return { ok: false, message: `실패 레코드의 occurred_at: ${occurredAt.message}` };
      }
      return {
        ok: true,
        value: {
          target_kind: record.payload.targetKind,
          target_id: record.payload.targetId,
          stage: record.payload.stage,
          fingerprint: record.payload.fingerprint,
          harness: record.payload.harness,
          session_id: record.payload.sessionId,
          code: record.payload.code,
          message: record.payload.message,
          occurred_at: occurredAt.value,
          work_item_id: record.payload.workItemId,
        },
      };
    }
  }
}

/**
 * The record one line names, or why it is not one.
 *
 * Everything is checked, because the input is a file: a line half-written by a
 * process that was killed, a line from a build that is not this one, a line
 * somebody edited. The newline is optional — a caller that split a file on it
 * has already taken it off — and a line that is only whitespace is still a
 * broken line, because the caller is the one who decides whether to skip empty
 * lines or to stop at them.
 */
export function decodeSpoolLine(line: string): DecodeSpoolLineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    return { ok: false, message: `spool 줄이 JSON이 아닙니다: ${oneLine(error)}` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, message: 'spool 줄이 JSON 객체가 아닙니다' };
  }

  const version = parsed['schema_version'];
  if (version !== SPOOL_RECORD_VERSION) {
    return {
      ok: false,
      message:
        `이 빌드는 spool 줄 형식 ${String(SPOOL_RECORD_VERSION)}만 읽습니다. ` +
        `이 줄은 ${describe(version)}입니다`,
    };
  }

  const id = parsed['id'];
  if (typeof id !== 'string' || id === '') {
    return { ok: false, message: `spool 줄의 id가 문자열이 아닙니다: ${describe(id)}` };
  }

  const kind = parsed['kind'];
  if (!isRecordKind(kind)) {
    return { ok: false, message: `spool 줄의 kind를 모릅니다: ${describe(kind)}` };
  }

  const occurredAt = parsed['occurred_at'];
  if (typeof occurredAt !== 'string') {
    return {
      ok: false,
      message: `spool 줄의 occurred_at이 문자열이 아닙니다: ${describe(occurredAt)}`,
    };
  }
  const instant = parseInstant(occurredAt);
  if (!instant.ok) {
    return { ok: false, message: `spool 줄의 occurred_at: ${instant.message}` };
  }

  const payload = parsed['payload'];
  if (!isRecord(payload)) {
    return { ok: false, message: 'spool 줄의 payload가 JSON 객체가 아닙니다' };
  }

  if (kind === 'failure') {
    const decoded = decodeFailurePayload(payload);
    if (!decoded.ok) return decoded;
    return {
      ok: true,
      record: {
        schemaVersion: SPOOL_RECORD_VERSION,
        id,
        kind,
        occurredAt: instant.value,
        payload: decoded.value,
      },
    };
  }

  const session = payload['session'];
  const transcriptPath = payload['transcript_path'];
  const cause = payload['cause'];
  if (typeof session !== 'string' || session === '') {
    return { ok: false, message: `spool 줄의 session이 세션 토큰이 아닙니다: ${describe(session)}` };
  }
  if (typeof transcriptPath !== 'string') {
    return {
      ok: false,
      message: `spool 줄의 transcript_path가 문자열이 아닙니다: ${describe(transcriptPath)}`,
    };
  }
  if (!isCause(cause)) {
    return { ok: false, message: `spool 줄의 cause를 모릅니다: ${describe(cause)}` };
  }

  return {
    ok: true,
    record: {
      schemaVersion: SPOOL_RECORD_VERSION,
      id,
      kind,
      occurredAt: instant.value,
      payload: { session, transcriptPath, cause },
    },
  };
}

/**
 * One `failure` payload, checked field by field.
 *
 * The four key columns and `code` have to be non-empty strings, because they are
 * what the row is found by and a row keyed on `''` is a row that collides with
 * the next one. `message` may be empty — a driver that said nothing is still a
 * failure — and `harness`, `session_id` and `work_item_id` may be null, which is
 * the normal state of a failure that is not about a session or not about a queue
 * item.
 */
function decodeFailurePayload(
  payload: Record<string, unknown>,
): { ok: true; value: FailureSpoolPayload } | { ok: false; message: string } {
  const required = ['target_kind', 'target_id', 'stage', 'fingerprint', 'code'] as const;
  for (const key of required) {
    const value = payload[key];
    if (typeof value !== 'string' || value === '') {
      return {
        ok: false,
        message: `spool 줄의 ${key}가 비어 있지 않은 문자열이 아닙니다: ${describe(value)}`,
      };
    }
  }

  const message = payload['message'];
  if (typeof message !== 'string') {
    return { ok: false, message: `spool 줄의 message가 문자열이 아닙니다: ${describe(message)}` };
  }

  const occurredAt = payload['occurred_at'];
  if (typeof occurredAt !== 'string') {
    return {
      ok: false,
      message: `spool 줄의 실패 occurred_at이 문자열이 아닙니다: ${describe(occurredAt)}`,
    };
  }
  const instant = parseInstant(occurredAt);
  if (!instant.ok) {
    return { ok: false, message: `spool 줄의 실패 occurred_at: ${instant.message}` };
  }

  const optional = ['harness', 'session_id', 'work_item_id'] as const;
  for (const key of optional) {
    const value = payload[key];
    if (value !== null && typeof value !== 'string') {
      return {
        ok: false,
        message: `spool 줄의 ${key}가 문자열도 null도 아닙니다: ${describe(value)}`,
      };
    }
  }

  return {
    ok: true,
    value: {
      targetKind: payload['target_kind'] as string,
      targetId: payload['target_id'] as string,
      stage: payload['stage'] as string,
      fingerprint: payload['fingerprint'] as string,
      harness: payload['harness'] as string | null,
      sessionId: payload['session_id'] as string | null,
      code: payload['code'] as string,
      message,
      occurredAt: instant.value,
      workItemId: payload['work_item_id'] as string | null,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordKind(value: unknown): value is SpoolRecordKind {
  return typeof value === 'string' && SPOOL_RECORD_KINDS.includes(value as SpoolRecordKind);
}

function isCause(value: unknown): value is SpoolCause {
  return typeof value === 'string' && SPOOL_CAUSES.includes(value as SpoolCause);
}

/** One value as a short, quoted phrase for a message nobody can act on twice. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return '없음';
  return String(value);
}

function oneLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.trim() ?? '알 수 없는 오류';
}
