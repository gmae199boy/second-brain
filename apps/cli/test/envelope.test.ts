// The offset in `now` comes from the local zone, so pin the zone before the
// first `Date` is built. Node re-reads `TZ` on each conversion, which is what
// makes the snapshot below exact rather than machine-dependent.
process.env.TZ = 'Asia/Seoul';

import { describe, expect, it } from 'vitest';
import { ERROR_CODES, type VerbCall } from 'second_brain';
import { fixedClock } from 'second_brain/testing';
import {
  argumentName,
  errorEnvelope,
  okEnvelope,
  requireConfirmation,
  retryArgv,
} from '../src/envelope.js';

const INSTANT = new Date('2026-01-02T03:04:05.678Z');

/**
 * The CLI reuses Core's codec whole, so the shape of an envelope is tested in
 * `packages/core/test/envelope.test.ts` and not again here. What is this
 * surface's own is `retry_argv`: the call as a command line, which no other
 * surface has any use for.
 */
describe('the envelope this surface prints', () => {
  it('is Core’s, and fills a blank hint from the code table', () => {
    const envelope = errorEnvelope(fixedClock(INSTANT), {
      code: 'SHIM_MISSING',
      message: 'no shim',
    });

    expect(envelope.now).toBe('2026-01-02T12:04:05.678+09:00');
    expect(envelope.error?.exit_code).toBe(1);
    expect(envelope.error?.hint).toBe(ERROR_CODES.SHIM_MISSING.hint);
    expect(okEnvelope(fixedClock(INSTANT), { ok: 1 }).ok).toBe(true);
  });
});

describe('the argv of a retry', () => {
  /** The gate's own answer, so the argv is rendered from what a command sends. */
  function gated(args: Record<string, unknown>): VerbCall {
    const retry = requireConfirmation({ ns: 'setup', verb: 'run', args })?.retry;
    if (retry === undefined) throw new Error('the gate opened for a call with no consent');
    return retry;
  }

  it('is the whole command line, with --yes for the consent', () => {
    expect(retryArgv(gated({}), [], true)).toEqual(['brain', 'setup', 'run', '--yes', '--json']);
  });

  it('keeps the output choice of the invocation it is answering', () => {
    expect(retryArgv(gated({}), [], false)).toEqual(['brain', 'setup', 'run', '--yes']);
  });

  it('spells a camelCase key as the kebab-case flag with its value', () => {
    expect(retryArgv(gated({ storePath: '/abs/b.db' }), [], true)).toEqual([
      'brain',
      'setup',
      'run',
      '--store-path',
      '/abs/b.db',
      '--yes',
      '--json',
    ]);
  });

  it('repeats a flag per item rather than joining a list', () => {
    // A harness name with a comma in it has to stay one name.
    expect(retryArgv(gated({ connect: ['claude-code', 'other'] }))).toEqual([
      'brain',
      'setup',
      'run',
      '--connect',
      'claude-code',
      '--connect',
      'other',
      '--yes',
    ]);
  });

  it('puts a declared argument in bare, in the order the command declares them', () => {
    const retry: VerbCall = {
      ns: 'messages',
      verb: 'redact',
      args: { id: 'm-1', reason: 'secret', confirm: true },
    };

    expect(retryArgv(retry, ['<id>'], true)).toEqual([
      'brain',
      'messages',
      'redact',
      'm-1',
      '--reason',
      'secret',
      '--yes',
      '--json',
    ]);
  });

  it('writes a boolean flag as the flag alone, and leaves a false one out', () => {
    const retry: VerbCall = {
      ns: 'files',
      verb: 'redact',
      args: { dryRun: true, force: false, confirm: true },
    };

    expect(retryArgv(retry)).toEqual(['brain', 'files', 'redact', '--dry-run', '--yes']);
  });

  it('leaves out a declared argument the call says nothing about', () => {
    const retry: VerbCall = { ns: 'fake', verb: 'verb', args: { confirm: true } };

    expect(retryArgv(retry, ['<id>', '[extra]'])).toEqual(['brain', 'fake', 'verb', '--yes']);
  });
});

describe('the name behind a declared argument', () => {
  it.each([
    ['<harness>', 'harness'],
    ['[harness]', 'harness'],
    ['<names...>', 'names'],
    ['<session-id>', 'sessionId'],
    ['[session-id...]', 'sessionId'],
  ])('reads %s as %s', (declared, name) => {
    expect(argumentName(declared)).toBe(name);
  });
});
