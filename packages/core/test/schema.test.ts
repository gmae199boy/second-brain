import { describe, expect, it } from 'vitest';
import { checkSchema } from '../src/schema.js';
import { WARNING_CODES, isWarningCode } from '../src/warnings.js';
import { memorySchemaStore } from '../src/testing/index.js';

/**
 * The write guard of AD-20, against the memory fake. The dispatcher of the CLI
 * runs this before every `writes` command, so what matters here is that each
 * answer is a value the caller can turn straight into an envelope.
 */
describe('checkSchema', () => {
  it('passes when the stored version is the expected one', async () => {
    const result = await checkSchema(memorySchemaStore({ version: 1 }), 1);

    expect(result).toEqual({ ok: true, version: 1 });
  });

  it('reports SCHEMA_MISMATCH when the database is at another version', async () => {
    const result = await checkSchema(memorySchemaStore({ version: 2 }), 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SCHEMA_MISMATCH');
    if (result.code !== 'SCHEMA_MISMATCH') return;
    expect(result.found).toBe(2);
    expect(result.expected).toBe(1);
    // The database is ahead of this build, and migrations only go forwards, so
    // naming a command here would name one that does nothing. `setup upgrade`
    // is an epic 5 plan and must not be named either.
    expect(result.message).toContain('install a newer build');
    expect(result.message).not.toContain('setup run');
    expect(result.message).not.toContain('setup upgrade');
  });

  it('tells the reader to run setup when the database is behind this build', async () => {
    const result = await checkSchema(memorySchemaStore({ version: 1 }), 2);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SCHEMA_MISMATCH');
    if (result.code !== 'SCHEMA_MISMATCH') return;
    expect(result.found).toBe(1);
    expect(result.expected).toBe(2);
    // The one command that migrates today; `setup upgrade` is an epic 5 plan.
    expect(result.message).toContain('setup run');
    expect(result.message).not.toContain('setup upgrade');
  });

  it('reports SCHEMA_MISMATCH when the database holds no version row', async () => {
    const result = await checkSchema(memorySchemaStore({ version: null }), 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SCHEMA_MISMATCH');
    if (result.code !== 'SCHEMA_MISMATCH') return;
    expect(result.found).toBeNull();
    expect(result.message).toContain('setup run');
  });

  it('passes the store failure through as DB_UNAVAILABLE', async () => {
    const store = memorySchemaStore({
      result: { ok: false, code: 'DB_UNAVAILABLE', message: 'connect ECONNREFUSED' },
    });

    const result = await checkSchema(store, 1);

    expect(result).toEqual({
      ok: false,
      code: 'DB_UNAVAILABLE',
      message: 'connect ECONNREFUSED',
    });
  });

  it('reads the version exactly once per check', async () => {
    const store = memorySchemaStore();

    await checkSchema(store, 1);

    expect(store.reads()).toBe(1);
  });
});

describe('the warning codes', () => {
  it('holds the nine codes of the Conventions table plus CONFIG_UNKNOWN_KEY', () => {
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
