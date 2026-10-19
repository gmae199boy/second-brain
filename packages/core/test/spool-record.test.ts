import { describe, expect, it } from 'vitest';
import {
  SPOOL_CLAIM_STALE_MS,
  SPOOL_LINE_MAX_BYTES,
  SPOOL_RECORD_VERSION,
  decodeSpoolLine,
  encodeSpoolLine,
  type SpoolRecord,
} from '../src/domain/spool-record.js';
import { utf8Bytes } from '../src/domain/sha256.js';
import { sampleSpoolRecord } from '../src/testing/fixtures.js';

/**
 * The one spelling of a spool line (AD-9): the keys, the version, the limit,
 * and what happens to a line that is not one. There is no filesystem in here —
 * the codec is pure, and what writes the lines is tested where the files are.
 */

/** The record as it is spelled on disk, for a test that reads the keys. */
function parsed(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

function encoded(record: SpoolRecord): string {
  const result = encodeSpoolLine(record);
  expect(result.ok, result.ok ? '' : result.message).toBe(true);
  return result.ok ? result.line : '';
}

describe('the spool line format', () => {
  it('spells the five keys in snake_case, with the instant in the stored form', () => {
    const line = encoded(
      sampleSpoolRecord({
        id: '01940000-0000-7000-8000-0000000000b1',
        occurredAt: new Date('2026-01-02T03:06:00.000Z'),
        session: 'demo:session-0001',
        transcriptPath: '/demo/transcripts/session-0001.jsonl',
        cause: 'DB_LOCKED',
      }),
    );

    // One line, newline included, so a file is the lines joined and nothing
    // else has to remember the terminator.
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(parsed(line)).toEqual({
      schema_version: 1,
      id: '01940000-0000-7000-8000-0000000000b1',
      kind: 'session_ingest',
      // The storage form of AD-13, exactly 24 characters, and never an offset.
      occurred_at: '2026-01-02T03:06:00.000Z',
      payload: {
        session: 'demo:session-0001',
        transcript_path: '/demo/transcripts/session-0001.jsonl',
        cause: 'DB_LOCKED',
      },
    });
  });

  it('writes the version this build knows, and nothing else', () => {
    expect(SPOOL_RECORD_VERSION).toBe(1);
    expect(parsed(encoded(sampleSpoolRecord()))['schema_version']).toBe(SPOOL_RECORD_VERSION);

    // A record that claims another version is a bug in the caller, not a line
    // to write: the version is the format's and not the record's to choose.
    const other = { ...sampleSpoolRecord(), schemaVersion: 2 };
    expect(encodeSpoolLine(other)).toMatchObject({ ok: false });
  });

  it('spells the same record the same way every time, byte for byte', () => {
    // Which is what lets a test compare files rather than parse them, and what
    // makes a line's size predictable at the limit below.
    const record = sampleSpoolRecord();
    expect(encoded(record)).toBe(encoded({ ...record }));
  });

  it('carries no transcript, only the path to one', () => {
    // The transcript is a file the harness keeps and the replay re-reads, so a
    // copy in the spool would be stale the moment it was written (story 12).
    const line = encoded(sampleSpoolRecord({ transcriptPath: '/demo/t.jsonl' }));
    expect(line).toContain('/demo/t.jsonl');
    expect(Object.keys((parsed(line)['payload'] as object) ?? {}).sort()).toEqual([
      'cause',
      'session',
      'transcript_path',
    ]);
  });

  it('round-trips a record through both directions', () => {
    const record = sampleSpoolRecord({ cause: 'SCHEMA_MISMATCH' });

    const back = decodeSpoolLine(encoded(record));

    expect(back.ok).toBe(true);
    if (!back.ok) return;
    // Every value as it was: the id and the instant belong to the process that
    // first made the record and a replay must not change either (AD-9).
    expect(back.record).toEqual(record);
  });

  it('reads a line whose newline a caller already took off', () => {
    // Which is what splitting a file on `\n` leaves.
    const line = encoded(sampleSpoolRecord());
    expect(decodeSpoolLine(line.trimEnd())).toMatchObject({ ok: true });
  });
});

describe('the 64KB limit on one spool line', () => {
  it('is the newline included, counted in UTF-8 bytes', () => {
    expect(SPOOL_LINE_MAX_BYTES).toBe(65_536);
    const line = encoded(sampleSpoolRecord());
    expect(utf8Bytes(line).length).toBeLessThanOrEqual(SPOOL_LINE_MAX_BYTES);
  });

  it('accepts a line of exactly the limit and refuses the next byte', () => {
    // The padding goes in the transcript path, which is the only field of this
    // record kind that can be long. The baseline is measured rather than
    // guessed, so this stays true if a field is added.
    const baseline = utf8Bytes(encoded(sampleSpoolRecord({ transcriptPath: '' }))).length;
    const room = SPOOL_LINE_MAX_BYTES - baseline;

    const exact = sampleSpoolRecord({ transcriptPath: 'a'.repeat(room) });
    const atLimit = encodeSpoolLine(exact);
    expect(atLimit.ok, atLimit.ok ? '' : atLimit.message).toBe(true);
    if (atLimit.ok) {
      expect(utf8Bytes(atLimit.line).length).toBe(SPOOL_LINE_MAX_BYTES);
    }

    const over = encodeSpoolLine(sampleSpoolRecord({ transcriptPath: 'a'.repeat(room + 1) }));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain('65536');
  });

  it('counts bytes and not characters, so a multi-byte path is measured right', () => {
    // Each of these is three bytes in UTF-8, so a limit counted in characters
    // would let through a line three times too long.
    const baseline = utf8Bytes(encoded(sampleSpoolRecord({ transcriptPath: '' }))).length;
    const room = SPOOL_LINE_MAX_BYTES - baseline;

    const result = encodeSpoolLine(
      sampleSpoolRecord({ transcriptPath: '한'.repeat(Math.floor(room / 3) + 1) }),
    );

    expect(result.ok).toBe(false);
  });
});

describe('a spool line that is not one', () => {
  it.each([
    ['nothing at all', ''],
    ['text that is not JSON', 'session_ingest'],
    ['a half-written line', '{"schema_version":1,"id":"01940000-0000-7000-8000-0000'],
    ['an array', '[1,2,3]'],
    ['a bare number', '42'],
    ['JSON null', 'null'],
  ])('is reported as a value for %s', (_what, line) => {
    const result = decodeSpoolLine(line);

    // A broken line is the normal state of a file a process was killed while
    // writing, and a reader that threw would turn a recoverable file into a
    // crash on the hook path.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toBe('');
  });

  it('refuses a version this build does not know, rather than guessing', () => {
    const ahead = encoded(sampleSpoolRecord()).replace('"schema_version":1', '"schema_version":2');

    const result = decodeSpoolLine(ahead);

    expect(result.ok).toBe(false);
    // Named both ways round, because the reader needs to know which build is
    // the old one.
    if (!result.ok) {
      expect(result.message).toContain('1');
      expect(result.message).toContain('2');
    }
  });

  it.each([
    ['no version at all', (line: string) => line.replace('"schema_version":1,', '')],
    ['an id that is empty', (line: string) => line.replace(/"id":"[^"]*"/, '"id":""')],
    ['an id that is a number', (line: string) => line.replace(/"id":"[^"]*"/, '"id":7')],
    ['a kind nobody handles', (line: string) => line.replace('"session_ingest"', '"log_append"')],
    [
      'an instant with an offset',
      (line: string) =>
        line.replace(/"occurred_at":"[^"]*"/, '"occurred_at":"2026-01-02T12:06:00.000+09:00"'),
    ],
    [
      'an instant that never happened',
      (line: string) =>
        line.replace(/"occurred_at":"[^"]*"/, '"occurred_at":"2026-13-45T03:06:00.000Z"'),
    ],
    ['no payload', (line: string) => line.replace(/"payload":\{[^}]*\}/, '"payload":null')],
    ['no session', (line: string) => line.replace(/"session":"[^"]*"/, '"session":""')],
    [
      'a transcript path that is not text',
      (line: string) => line.replace(/"transcript_path":"[^"]*"/, '"transcript_path":null'),
    ],
    ['a cause nobody wrote', (line: string) => line.replace('"DB_LOCKED"', '"ELEPHANT"')],
  ])('is reported as a value for %s', (_what, break_) => {
    const result = decodeSpoolLine(break_(encoded(sampleSpoolRecord())));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toBe('');
  });

  it('accepts all three causes, and only those three', () => {
    for (const cause of ['DB_UNAVAILABLE', 'DB_LOCKED', 'SCHEMA_MISMATCH'] as const) {
      const back = decodeSpoolLine(encoded(sampleSpoolRecord({ cause })));
      expect(back.ok).toBe(true);
      // Narrowed on the kind, because the record is a union: a payload read
      // without asking which kind it is would be the bug this shape prevents.
      if (back.ok && back.record.kind === 'session_ingest') {
        expect(back.record.payload.cause).toBe(cause);
      }
    }
  });
});

/**
 * One failure record the database would not take (AD-9, story 11). Written out
 * here rather than put in the fixtures: the one caller is drain, and a fixture
 * would be a second place to keep the shape right.
 */
function failureRecord(overrides: Record<string, unknown> = {}): SpoolRecord {
  return {
    schemaVersion: SPOOL_RECORD_VERSION,
    id: '01940000-0000-7000-8000-0000000000c1',
    kind: 'failure',
    occurredAt: new Date('2026-02-03T04:05:06.000Z'),
    // No replay has failed yet, which is what every record a write path makes
    // carries; the key is left off the line entirely (AD-9).
    attempts: 0,
    payload: {
      targetKind: 'session',
      targetId: 'demo:session-0001',
      stage: 'demo_work',
      fingerprint: 'sha256:0000',
      harness: null,
      sessionId: null,
      code: 'DEMO_FAILED',
      message: '열 번 모두 실패했습니다',
      occurredAt: new Date('2026-02-03T04:05:06.000Z'),
      workItemId: '01940000-0000-7000-8000-000000000010',
      ...overrides,
    },
  };
}

describe('the failure record on a spool line', () => {
  it('spells the key columns, the information columns and the item in snake_case', () => {
    const line = encoded(failureRecord());

    expect(parsed(line)).toEqual({
      schema_version: 1,
      id: '01940000-0000-7000-8000-0000000000c1',
      kind: 'failure',
      occurred_at: '2026-02-03T04:05:06.000Z',
      payload: {
        target_kind: 'session',
        target_id: 'demo:session-0001',
        stage: 'demo_work',
        fingerprint: 'sha256:0000',
        // Information, and null is a value: drain knows which item failed, not
        // which conversation it belonged to (story 11 Boundaries).
        harness: null,
        session_id: null,
        code: 'DEMO_FAILED',
        message: '열 번 모두 실패했습니다',
        occurred_at: '2026-02-03T04:05:06.000Z',
        work_item_id: '01940000-0000-7000-8000-000000000010',
      },
    });
  });

  it('round-trips, keeping the instants and the nulls', () => {
    const record = failureRecord({ harness: 'demo', sessionId: null, workItemId: null });
    const back = decodeSpoolLine(encoded(record));

    expect(back.ok, back.ok ? '' : back.message).toBe(true);
    if (!back.ok) return;
    expect(back.record).toEqual(record);
  });

  it('refuses a line whose key columns are missing or empty', () => {
    for (const key of ['target_kind', 'target_id', 'stage', 'fingerprint', 'code']) {
      const line = parsed(encoded(failureRecord()));
      (line['payload'] as Record<string, unknown>)[key] = '';
      const back = decodeSpoolLine(JSON.stringify(line));
      expect(back.ok, `${key} was accepted empty`).toBe(false);
      if (!back.ok) expect(back.message).toContain(key);
    }
  });

  it('refuses a failure instant that is not the stored form', () => {
    const line = parsed(encoded(failureRecord()));
    (line['payload'] as Record<string, unknown>)['occurred_at'] = '2026-02-03T04:05:06+09:00';

    const back = decodeSpoolLine(JSON.stringify(line));
    expect(back.ok).toBe(false);
  });

  it('refuses an information column that is neither a string nor null', () => {
    const line = parsed(encoded(failureRecord()));
    (line['payload'] as Record<string, unknown>)['harness'] = 7;

    const back = decodeSpoolLine(JSON.stringify(line));
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.message).toContain('harness');
  });
});

describe('the spool constants', () => {
  it('gives a claim ten minutes before the next drain takes it back', () => {
    // AD-9's number, held here because the file adapter and the fake both read
    // it rather than each writing one of their own.
    expect(SPOOL_CLAIM_STALE_MS).toBe(600_000);
  });
});

describe('the retry instant of a spool line', () => {
  it('round-trips, and is left off a line nothing has retried', () => {
    const fresh = encodeSpoolLine(sampleSpoolRecord());
    expect(fresh.ok && fresh.line.includes('next_attempt_at')).toBe(false);

    const due = new Date('2026-02-03T04:05:08.000Z');
    const encoded = encodeSpoolLine({ ...sampleSpoolRecord(), attempts: 1, nextAttemptAt: due });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.line).toContain('"next_attempt_at":"2026-02-03T04:05:08.000Z"');

    const decoded = decodeSpoolLine(encoded.line.trimEnd());
    expect(decoded.ok && decoded.record.nextAttemptAt?.toISOString()).toBe(due.toISOString());
  });

  it('refuses a line whose retry instant is not a stored instant', () => {
    const encoded = encodeSpoolLine(sampleSpoolRecord());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const edited = encoded.line.trimEnd().replace('"payload"', '"next_attempt_at":"tomorrow","payload"');
    expect(decodeSpoolLine(edited)).toMatchObject({ ok: false });
  });
});
