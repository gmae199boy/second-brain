import { join, resolve } from 'node:path';

/** Preserve the caller's temporary root across nested ordinary Vitest runs. */
export function configureFileTempDir(env: NodeJS.ProcessEnv, testPath: string | undefined, repo: string, fileDir: string): void {
  const inheritedOwnedTemp = env.BRAIN_TEST_FILE_DIR !== undefined && env.TMPDIR === env.BRAIN_TEST_FILE_DIR;
  if (!inheritedOwnedTemp || (env.BRAIN_TEST_ORIGINAL_TMPDIR_SET !== 'yes' && env.BRAIN_TEST_ORIGINAL_TMPDIR_SET !== 'no')) {
    env.BRAIN_TEST_ORIGINAL_TMPDIR_SET = env.TMPDIR === undefined ? 'no' : 'yes';
    if (env.TMPDIR !== undefined) env.BRAIN_TEST_ORIGINAL_TMPDIR = env.TMPDIR;
    else delete env.BRAIN_TEST_ORIGINAL_TMPDIR;
  }
  const hook = join(repo, 'tooling/bootstrap/test/hook.test.ts');
  if (testPath && resolve(testPath) === hook) env.TMPDIR = fileDir;
  else if (inheritedOwnedTemp && env.BRAIN_TEST_ORIGINAL_TMPDIR_SET === 'yes') env.TMPDIR = env.BRAIN_TEST_ORIGINAL_TMPDIR;
  else if (inheritedOwnedTemp) delete env.TMPDIR;
}
