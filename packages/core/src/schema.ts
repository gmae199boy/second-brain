import type { SchemaVersion } from './domain/schema-version.js';
import type { SchemaStore } from './ports/store.js';

export type SchemaVersions = Readonly<Record<string, number>>;
export const CORE_SCHEMA_OWNER = 'core';

/**
 * Verdict of the write guard. A mismatch names both versions so the caller can
 * tell the user what to run; `found: null` is an empty database, which from the
 * guard's point of view is just another version that is not the expected one.
 */
export type SchemaCheck =
  | { ok: true; versions: Readonly<Record<string, SchemaVersion>> }
  | {
      ok: false;
      code: 'SCHEMA_MISMATCH';
      owner: string;
      message: string;
      /** Version the database is at, or `null` when it holds no version row. */
      found: number | null;
      expected: number;
    }
  | { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/**
 * Compare the stored schema version with the one this code was built for
 * (AD-20). Every command that writes asks this first and does not write when
 * the answer is not `ok`; read commands never ask. Migrating is not this
 * function's business — only `setup run` and `setup upgrade` migrate.
 *
 * Failures are values, never exceptions, so the caller turns them straight into
 * a `SCHEMA_MISMATCH` or `DB_UNAVAILABLE` envelope (Conventions).
 */
export async function checkSchema(store: SchemaStore, expected: SchemaVersions): Promise<SchemaCheck> {
  const stored = await store.readSchemaVersions();
  if (!stored.ok) {
    return { ok: false, code: stored.code, message: stored.message };
  }

  const owners = Object.keys(expected).sort((a, b) =>
    a === CORE_SCHEMA_OWNER ? -1 : b === CORE_SCHEMA_OWNER ? 1 : a < b ? -1 : a > b ? 1 : 0);
  for (const owner of owners) {
    const found = stored.versions[owner]?.version ?? null;
    const wanted = expected[owner]!;
    if (found !== wanted) return {
      ok: false, code: 'SCHEMA_MISMATCH', owner,
      message: mismatchMessage(owner, found, wanted), found, expected: wanted,
    };
  }
  return { ok: true, versions: stored.versions };
}

/**
 * What the person can do about it, which depends on which way the versions
 * differ. `brain setup run` is the one command that migrates today —
 * `setup upgrade` is an epic 5 plan — but it only migrates forwards: the runner
 * skips every migration at or below the stored version. So a database that is
 * ahead of this build cannot be fixed by running anything here, and saying
 * otherwise would send the reader to a command that changes nothing.
 */
function mismatchMessage(owner: string, found: number | null, expected: number): string {
  if (found === null) {
    return `데이터베이스에 \`${owner}\` 스키마 버전이 없습니다. 이 코드는 ${String(expected)}을 기대합니다. \`brain setup run\`을 실행하세요.`;
  }
  const versions = `데이터베이스는 \`${owner}\` 스키마 버전 ${String(found)}이고, 이 코드는 ${String(expected)}을 기대합니다.`;
  return found > expected
    ? `${versions} 이 빌드가 데이터베이스보다 오래되었습니다. 더 새 빌드를 설치하세요.`
    : `${versions} \`brain setup run\`을 실행하세요.`;
}
