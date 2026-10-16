// The offset in `now` comes from the local zone, so pin the zone before the
// first `Date` is built. Node re-reads `TZ` on each conversion, which is what
// makes the snapshot below exact rather than machine-dependent.
process.env.TZ = 'Asia/Seoul';

import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/codes.js';
import {
  errorEnvelope,
  isoWithOffset,
  okEnvelope,
  requireConfirmation,
  type VerbCall,
} from '../src/envelope.js';
import { fixedClock, steppingClock } from '../src/testing/index.js';

const INSTANT = new Date('2026-01-02T03:04:05.678Z');

describe('the ok envelope', () => {
  it('matches the shape of the Conventions table, at the instant of the clock', () => {
    expect(okEnvelope(fixedClock(INSTANT), { checks: [] })).toEqual({
      ok: true,
      now: '2026-01-02T12:04:05.678+09:00',
      data: { checks: [] },
      warnings: [],
    });
  });

  it('carries the warning codes it was given', () => {
    const envelope = okEnvelope(fixedClock(INSTANT), null, ['DB_UNAVAILABLE', 'SCHEMA_MISMATCH']);

    expect(envelope.warnings).toEqual(['DB_UNAVAILABLE', 'SCHEMA_MISMATCH']);
    expect(envelope.error).toBeUndefined();
  });

  it('copies the warnings, so the caller cannot change a sent envelope', () => {
    const warnings: ('SPOOLED' | 'UNINDEXED')[] = ['SPOOLED'];
    const envelope = okEnvelope(fixedClock(INSTANT), null, warnings);

    warnings.push('UNINDEXED');

    expect(envelope.warnings).toEqual(['SPOOLED']);
  });

  it('carries meta when there is any, and leaves the key out when there is none', () => {
    const meta = { count: 3, has_more: true };

    expect(okEnvelope(fixedClock(INSTANT), [], [], meta).meta).toEqual(meta);
    expect('meta' in okEnvelope(fixedClock(INSTANT), [])).toBe(false);
  });
});

describe('the error envelope', () => {
  it('matches the shape of the Conventions table and carries no data', () => {
    expect(
      errorEnvelope(fixedClock(INSTANT), { code: 'CONFIG_MISSING', message: 'no config.toml' }),
    ).toEqual({
      ok: false,
      now: '2026-01-02T12:04:05.678+09:00',
      warnings: [],
      error: {
        code: 'CONFIG_MISSING',
        message: 'no config.toml',
        // All three from the code table: the failure named none of them.
        exit_code: 2,
        retryable: false,
        hint: ERROR_CODES.CONFIG_MISSING.hint,
      },
    });
  });

  it('still reports the warnings collected before the failure', () => {
    const envelope = errorEnvelope(
      fixedClock(INSTANT),
      { code: 'SCHEMA_MISMATCH', message: 'at 2, expected 1' },
      ['CONFIG_UNKNOWN_KEY', 'SCHEMA_MISMATCH'],
    );

    expect(envelope.warnings).toEqual(['CONFIG_UNKNOWN_KEY', 'SCHEMA_MISMATCH']);
    expect(envelope.data).toBeUndefined();
  });

  it('lets one failure keep an exit code the table would have changed', () => {
    // The write guard of AD-20 has always exited 1 on an unreachable database,
    // and the table puts `DB_UNAVAILABLE` at 2. An explicit exit wins, so the
    // move to a code table cannot change what an existing failure exits with.
    const envelope = errorEnvelope(fixedClock(INSTANT), {
      code: 'DB_UNAVAILABLE',
      message: 'no file at that path',
      exit: 1,
    });

    expect(envelope.error?.exit_code).toBe(1);
    expect(ERROR_CODES.DB_UNAVAILABLE.exit).toBe(2);
  });

  it('prefers the failure’s own hint and retryability over the table’s', () => {
    const envelope = errorEnvelope(fixedClock(INSTANT), {
      code: 'SEARCH_FAILED',
      message: 'the index is being rebuilt',
      retryable: true,
      hint: 'wait for the rebuild to finish',
    });

    expect(envelope.error?.retryable).toBe(true);
    expect(envelope.error?.hint).toBe('wait for the rebuild to finish');
  });

  it('fills the hint from the table when the failure left it blank', () => {
    const envelope = errorEnvelope(fixedClock(INSTANT), {
      code: 'DB_LOCKED',
      message: 'database is locked',
    });

    expect(envelope.error?.hint).toBe(ERROR_CODES.DB_LOCKED.hint);
    expect(envelope.error?.retryable).toBe(true);
  });

  it('exits 1 and says nothing more for a code it does not know', () => {
    // A connector names its own codes (`ports/connector.ts`), and inventing a
    // hint for one would be this codec claiming to know what it means.
    const envelope = errorEnvelope(fixedClock(INSTANT), {
      code: 'CLAUDE_CODE_SETTINGS_UNREADABLE',
      message: 'settings.json could not be parsed',
    });

    expect(envelope.error).toEqual({
      code: 'CLAUDE_CODE_SETTINGS_UNREADABLE',
      message: 'settings.json could not be parsed',
      exit_code: 1,
    });
  });

  it('leaves retryable out rather than guessing where the code does not say', () => {
    const envelope = errorEnvelope(fixedClock(INSTANT), {
      code: 'FILES_UNAVAILABLE',
      message: 'EACCES on the file store root',
    });

    expect('retryable' in (envelope.error ?? {})).toBe(false);
  });
});

describe('the confirmation gate', () => {
  const call: VerbCall = { ns: 'setup', verb: 'run', args: { storePath: '/abs/b.db' } };

  it('answers a failure that carries the same call plus the consent', () => {
    const gate = requireConfirmation(call);

    expect(gate?.code).toBe('CONFIRMATION_REQUIRED');
    expect(gate?.retry).toEqual({
      ns: 'setup',
      verb: 'run',
      args: { storePath: '/abs/b.db', confirm: true },
    });
  });

  it('lets the code table decide the exit code, the retryability and the hint', () => {
    const envelope = errorEnvelope(fixedClock(INSTANT), requireConfirmation(call) ?? {
      code: 'MISSING',
      message: 'the gate answered nothing',
    });

    expect(envelope.error?.exit_code).toBe(3);
    expect(envelope.error?.retryable).toBe(false);
    expect(envelope.error?.hint).toBe(ERROR_CODES.CONFIRMATION_REQUIRED.hint);
  });

  it('opens for a call that already carries the consent', () => {
    expect(requireConfirmation({ ...call, args: { ...call.args, confirm: true } })).toBeUndefined();
  });

  it('closes for every value but true, so a string from an argv is not consent', () => {
    for (const confirm of ['true', 1, false, null, undefined]) {
      expect(requireConfirmation({ ...call, args: { confirm } })).toBeDefined();
    }
  });

  it('does not change the call it was given', () => {
    const args = { storePath: '/abs/b.db' };

    requireConfirmation({ ns: 'setup', verb: 'run', args });

    expect(args).toEqual({ storePath: '/abs/b.db' });
  });

  it('takes the caller’s message when it has one to give', () => {
    const gate = requireConfirmation(call, 'this is not a terminal, so nothing can be asked');

    expect(gate?.message).toBe('this is not a terminal, so nothing can be asked');
  });
});

describe('the envelope time', () => {
  it('comes from the clock, never from the system clock', () => {
    const clock = steppingClock(INSTANT, 1000);

    expect(okEnvelope(clock, null).now).toBe('2026-01-02T12:04:05.678+09:00');
    expect(okEnvelope(clock, null).now).toBe('2026-01-02T12:04:06.678+09:00');
  });

  it('is an ISO-8601 instant with the offset, that parses back to the same time', () => {
    for (const instant of [INSTANT, new Date('1999-12-31T23:59:59.001Z'), new Date(0)]) {
      const formatted = isoWithOffset(instant);

      expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
      expect(new Date(formatted).getTime()).toBe(instant.getTime());
    }
  });
});
