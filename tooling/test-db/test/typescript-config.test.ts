import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { configureFileTempDir } from './typescript-temp-dir.js';

it('uses the owned temporary root only for the hook file and restores the inherited ordinary root', () => {
  const repo = '/synthetic/repo', fileDir = '/synthetic/repo/.brain-test-runs/run/file';
  const env: NodeJS.ProcessEnv = { TMPDIR: '/system/tmp' };
  configureFileTempDir(env, '/synthetic/repo/tooling/bootstrap/test/hook.test.ts', repo, fileDir);
  expect(env.TMPDIR).toBe(fileDir);
  env.BRAIN_TEST_FILE_DIR = fileDir;
  configureFileTempDir(env, '/synthetic/repo/apps/cli/test/sessions-ingest.test.ts', repo, '/synthetic/repo/.brain-test-runs/other/file');
  expect(env.TMPDIR).toBe('/system/tmp');
  const absent: NodeJS.ProcessEnv = {};
  configureFileTempDir(absent, '/synthetic/repo/tooling/bootstrap/test/hook.test.ts', repo, fileDir);
  expect(absent.TMPDIR).toBe(fileDir);
  absent.BRAIN_TEST_FILE_DIR = fileDir;
  configureFileTempDir(absent, '/synthetic/repo/apps/cli/test/sessions-ingest.test.ts', repo, fileDir);
  expect(absent.TMPDIR).toBeUndefined();
  const explicit: NodeJS.ProcessEnv = { TMPDIR: '/different/tmp', BRAIN_TEST_FILE_DIR: fileDir, BRAIN_TEST_ORIGINAL_TMPDIR_SET: 'yes', BRAIN_TEST_ORIGINAL_TMPDIR: '/old/tmp' };
  configureFileTempDir(explicit, '/synthetic/repo/apps/cli/test/sessions-ingest.test.ts', repo, fileDir);
  expect(explicit.TMPDIR).toBe('/different/tmp');
});

it('connects ordinary projects and the direct Python hook lane to ownership setup', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const root = read('../../../vitest.config.ts'), python = read('../../../apps/cli/python-test/vitest.config.ts');
  expect(root).toContain("setupFiles: [join(import.meta.dirname, 'tooling/test-db/test/typescript-file-setup.ts')]");
  expect(root).toContain("join(import.meta.dirname, 'tooling/test-db/test/typescript-global-setup.ts')");
  expect(python).toContain("setupFiles: ['tooling/test-db/test/typescript-file-setup.ts']");
  expect(python).toContain("globalSetup: 'apps/cli/python-test/owned-global-setup.ts'");
});
