import { describe, expect, it } from 'vitest';
import { checkSchema } from '../src/schema.js';
import { memorySchemaStore } from '../src/testing/index.js';

/**
 * The write guard of AD-20, against the memory fake. The dispatcher of the CLI
 * runs this before every `writes` command, so what matters here is that each
 * answer is a value the caller can turn straight into an envelope.
 */
describe('checkSchema', () => {
  it('passes when the stored version is the expected one', async () => {
    const result = await checkSchema(memorySchemaStore({ version: 1 }), { core: 1 });

    expect(result).toEqual({ ok: true, versions: { core: { version: 1, appliedAt: expect.any(Date) } } });
  });

  it('reports SCHEMA_MISMATCH when the database is at another version', async () => {
    const result = await checkSchema(memorySchemaStore({ version: 2 }), { core: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SCHEMA_MISMATCH');
    if (result.code !== 'SCHEMA_MISMATCH') return;
    expect(result.found).toBe(2);
    expect(result.expected).toBe(1);
    // The database is ahead of this build, and migrations only go forwards, so
    // naming a command here would name one that does nothing. `setup upgrade`
    // is an epic 5 plan and must not be named either.
    expect(result.message).toContain('더 새 빌드를 설치하세요');
    expect(result.message).not.toContain('setup run');
    expect(result.message).not.toContain('setup upgrade');
  });

  it('tells the reader to run setup when the database is behind this build', async () => {
    const result = await checkSchema(memorySchemaStore({ version: 1 }), { core: 2 });

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
    const result = await checkSchema(memorySchemaStore({ version: null }), { core: 1 });

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

    const result = await checkSchema(store, { core: 1 });

    expect(result).toEqual({
      ok: false,
      code: 'DB_UNAVAILABLE',
      message: 'connect ECONNREFUSED',
    });
  });

  it('reads the version exactly once per check', async () => {
    const store = memorySchemaStore();

    await checkSchema(store, { core: 1 });

    expect(store.reads()).toBe(1);
  });
});

// The warning and error codes have their own file now that they live in
// `src/codes.ts`: see `test/codes.test.ts`.


it('preserves DB_LOCKED from the schema store',async()=>{
  expect(await checkSchema(memorySchemaStore({result:{ok:false,code:'DB_LOCKED',message:'lock timeout'}}),{core:1})).toEqual({ok:false,code:'DB_LOCKED',message:'lock timeout'});
});

it('checks every expected owner, core first then name order, and ignores unknown owners', async () => {
  const row = (version: number) => ({ version, appliedAt: new Date(0) });
  const store = memorySchemaStore({ versions: { core: row(2), zebra: row(4), alpha: row(3), garmin: row(99) } });
  expect(await checkSchema(store, { zebra: 1, alpha: 1, core: 1 })).toMatchObject({ ok: false, owner: 'core', found: 2, expected: 1, message: expect.stringContaining('core') });
  expect(await checkSchema(store, { zebra: 1, alpha: 1, core: 2 })).toMatchObject({ ok: false, owner: 'alpha', found: 3, expected: 1 });
  expect(await checkSchema(store, { core: 2 })).toMatchObject({ ok: true });
  expect(await checkSchema(store, { core: 2, missing: 1 })).toMatchObject({ ok: false, owner: 'missing', found: null, expected: 1 });
  expect(await checkSchema(store, { core: 2, alpha: 3, zebra: 4 })).toMatchObject({ ok: true });
});
