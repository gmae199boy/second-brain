import type { SchemaStore } from './ports/store.js';

/**
 * Verdict of the write guard. A mismatch names both versions so the caller can
 * tell the user what to run; `found: null` is an empty database, which from the
 * guard's point of view is just another version that is not the expected one.
 */
export type SchemaCheck =
  | { ok: true; version: number }
  | {
      ok: false;
      code: 'SCHEMA_MISMATCH';
      message: string;
      /** Version the database is at, or `null` when it holds no version row. */
      found: number | null;
      expected: number;
    }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/**
 * Compare the stored schema version with the one this code was built for
 * (AD-20). Every command that writes asks this first and does not write when
 * the answer is not `ok`; read commands never ask. Migrating is not this
 * function's business — only `setup run` and `setup upgrade` migrate.
 *
 * Failures are values, never exceptions, so the caller turns them straight into
 * a `SCHEMA_MISMATCH` or `DB_UNAVAILABLE` envelope (Conventions).
 */
export async function checkSchema(store: SchemaStore, expected: number): Promise<SchemaCheck> {
  const stored = await store.readSchemaVersion();
  if (!stored.ok) {
    return { ok: false, code: 'DB_UNAVAILABLE', message: stored.message };
  }

  const found = stored.version?.version ?? null;
  if (found === expected) {
    return { ok: true, version: found };
  }

  return {
    ok: false,
    code: 'SCHEMA_MISMATCH',
    message:
      found === null
        ? `the database holds no schema version; this code expects ${String(expected)}. Run \`brain setup run\`.`
        : `the database is at schema version ${String(found)}; this code expects ${String(expected)}. Run \`brain setup upgrade\`.`,
    found,
    expected,
  };
}
