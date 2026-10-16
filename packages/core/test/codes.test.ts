import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  WARNING_CODES,
  errorCodeSpec,
  isErrorCode,
  isWarningCode,
  type ErrorCode,
} from '../src/codes.js';

/**
 * The two code lists against the Conventions table. They are a constant rather
 * than a convention precisely so a test can hold them against the document: if
 * these lists and the table ever disagree, one of the two is wrong and nobody
 * reading an envelope can tell which.
 */
describe('the warning codes', () => {
  it('holds the sixteen codes of the Conventions table, in its order', () => {
    expect([...WARNING_CODES]).toEqual([
      'SPOOLED',
      'DB_UNAVAILABLE',
      'SCHEMA_MISMATCH',
      'RERANK_FAILED',
      'INDEX_CONFIG_MISMATCH',
      'UNINDEXED',
      'RESULT_TRUNCATED',
      'RULE_UNVERIFIED',
      'CURSOR_RESET',
      'CONFIG_UNKNOWN_KEY',
      'ATTACHMENT_NOT_REDACTED',
      'FILE_SOURCE_UNREACHABLE',
      'DAEMON_UNAVAILABLE',
      'PLUGIN_NOT_INSTALLED',
      'PLUGIN_BEHIND',
      'PLUGIN_DUPLICATE',
    ]);
    expect(new Set(WARNING_CODES).size).toBe(WARNING_CODES.length);
  });

  it('recognises its own codes and nothing else', () => {
    for (const code of WARNING_CODES) {
      expect(isWarningCode(code)).toBe(true);
    }
    expect(isWarningCode('CONFIG_MISSING')).toBe(false);
    expect(isWarningCode('db_unavailable')).toBe(false);
    expect(isWarningCode('')).toBe(false);
  });
});

describe('the error codes', () => {
  it('holds every code of the Conventions table with the exit code it names', () => {
    const exits = Object.fromEntries(
      Object.entries(ERROR_CODES).map(([code, spec]) => [code, spec.exit]),
    );

    expect(exits).toEqual({
      USAGE: 2,
      CONFIG_MISSING: 2,
      CONFIG_INVALID: 2,
      DB_UNAVAILABLE: 2,
      SESSION_REQUIRED: 2,
      USER_MISSING: 2,
      DB_LOCKED: 1,
      SCHEMA_MISMATCH: 1,
      MIGRATION_FAILED: 1,
      FILES_UNAVAILABLE: 1,
      SHIM_MISSING: 1,
      SEARCH_FAILED: 1,
      VERSION_MISMATCH: 1,
      CONFIRMATION_REQUIRED: 3,
    });
  });

  it('never gives a failure the exit code of success', () => {
    for (const spec of Object.values(ERROR_CODES)) {
      expect([1, 2, 3]).toContain(spec.exit);
    }
  });

  it('says a lock is worth running again, and a usage mistake is not', () => {
    expect(ERROR_CODES.DB_LOCKED.retryable).toBe(true);
    expect(ERROR_CODES.USAGE.retryable).toBe(false);
    expect(ERROR_CODES.CONFIRMATION_REQUIRED.retryable).toBe(false);
    // Left out where it depends on what went wrong: the envelope reports that
    // as "nobody knows" rather than as a guess either way (Conventions).
    expect(ERROR_CODES.FILES_UNAVAILABLE.retryable).toBeUndefined();
  });

  it('recognises its own codes and nothing else', () => {
    for (const code of Object.keys(ERROR_CODES)) {
      expect(isErrorCode(code)).toBe(true);
    }
    // A warning code is not an error code, and a connector's own code is
    // neither: `errorCodeSpec` has to answer `undefined` rather than guess.
    expect(isErrorCode('SPOOLED')).toBe(false);
    expect(isErrorCode('CLAUDE_CODE_SETTINGS_UNREADABLE')).toBe(false);
    expect(errorCodeSpec('CLAUDE_CODE_SETTINGS_UNREADABLE')).toBeUndefined();
    expect(errorCodeSpec('USAGE')).toBe(ERROR_CODES.USAGE);
  });
});

/**
 * The hint style of the Conventions table, on every code: lower case, no full
 * stop, commands in backticks. A hint is what an agent reads instead of
 * guessing a next step, so one written in another voice is one it will skip.
 */
describe('the hint of every error code', () => {
  const codes = Object.keys(ERROR_CODES) as ErrorCode[];

  it.each(codes)('%s has one', (code) => {
    expect(ERROR_CODES[code].hint).not.toBe('');
  });

  it.each(codes)('%s starts in lower case and ends without a full stop', (code) => {
    const { hint } = ERROR_CODES[code];

    expect(hint).toMatch(/^[a-z]/);
    expect(hint).not.toMatch(/\.$/);
  });

  it.each(codes)('%s spells every command in backticks', (code) => {
    // Everything inside backticks removed: what is left must not read like a
    // command, which here means it must not name the binary at all.
    const prose = ERROR_CODES[code].hint.replace(/`[^`]*`/g, '');

    expect(prose).not.toContain('brain ');
    expect(ERROR_CODES[code].hint.split('`').length % 2).toBe(1);
  });

  it.each(codes)('%s never suggests removing anything', (code) => {
    // A code a typo can produce must not point at a destructive command
    // (Conventions): the hint is read by something that will run it.
    expect(ERROR_CODES[code].hint).not.toMatch(/\b(rm|delete|remove|uninstall|drop)\b/);
  });
});
