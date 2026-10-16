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
    message: mismatchMessage(found, expected),
    found,
    expected,
  };
}

/**
 * What the person can do about it, which depends on which way the versions
 * differ. `brain setup run` is the one command that migrates today —
 * `setup upgrade` is an epic 5 plan — but it only migrates forwards: the runner
 * skips every migration at or below the stored version. So a database that is
 * ahead of this build cannot be fixed by running anything here, and saying
 * otherwise would send the reader to a command that changes nothing.
 */
function mismatchMessage(found: number | null, expected: number): string {
  if (found === null) {
    return `데이터베이스에 스키마 버전이 없습니다. 이 코드는 ${String(expected)}을 기대합니다. \`brain setup run\`을 실행하세요.`;
  }
  const versions = `데이터베이스는 스키마 버전 ${String(found)}이고, 이 코드는 ${String(expected)}을 기대합니다.`;
  return found > expected
    ? `${versions} 이 빌드가 데이터베이스보다 오래되었습니다. 더 새 빌드를 설치하세요.`
    : `${versions} \`brain setup run\`을 실행하세요.`;
}
