#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA_VERSION, EXPECTED_SCHEMA_VERSIONS } from 'second_brain/postgres';
import { STAGED_PROMOTION_PROTOCOL } from '../dist/install/promotion-protocol.js';

/**
 * `dist/build.json`: which commit this build was made from, and which store
 * schema it was made for.
 *
 * The installer records both in `<home>/installed.json` when it finishes, and
 * the plugin's `SessionStart` compares the commit it carries against that
 * record to decide whether there is anything to install (AD-19). Nothing else
 * can answer "which source is this `dist/` from": the folder is not in git, and
 * a version number in a manifest is a number somebody has to remember to bump.
 *
 * It runs after `tsc`, from `apps/cli`'s own `build` script, so the file is
 * written into the `dist/` that was just produced. The schema version is
 * imported rather than read out of a migration folder: `pnpm -r build` goes in
 * topological order, so `second_brain` — and the PostgreSQL entry point behind it — is
 * already built by the time this runs.
 */

/** The commit, or `null` on a tree that is not a git clone (an npm tarball). */
function commit() {
  try {
    const found = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // Exactly the 40 hex characters of a full object name. Anything else —
    // `HEAD` in a repository with no commit yet, a short name, a stray line —
    // is not a commit this can be compared against, and a half-read value
    // would make the plugin check compare two things that are not shas.
    return /^[0-9a-f]{40}$/.test(found) ? found : null;
  } catch {
    return null;
  }
}

writeFileSync(
  fileURLToPath(new URL('../dist/build.json', import.meta.url)),
  `${JSON.stringify({ version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, commit: commit(), schema_version: CORE_SCHEMA_VERSION, schema_versions: EXPECTED_SCHEMA_VERSIONS, staged_promotion: STAGED_PROMOTION_PROTOCOL }, undefined, 2)}\n`,
  'utf8',
);

// 기본 resolver에 패키지를 배송하되 로컬 환경은 제외한다.
const packageSource = fileURLToPath(new URL('../../../extensions/garmin/', import.meta.url));
const packageTarget = fileURLToPath(new URL('../extensions/garmin/', import.meta.url));
rmSync(packageTarget, { recursive: true, force: true });
cpSync(packageSource, packageTarget, { recursive: true, filter: source => !['.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'].includes(basename(source)) && !source.endsWith('.pyc') });
