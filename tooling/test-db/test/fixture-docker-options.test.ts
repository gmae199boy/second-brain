import { expect, it } from 'vitest';
import { fixtureDockerCreateArgs } from '../src/index.js';

it('creates disposable fixtures with tmpfs and exact run and file labels', () => {
  const args = fixtureDockerCreateArgs('brain-fixture-abc', 'abc', { BRAIN_TEST_RUN_ID: 'run', BRAIN_TEST_FILE_ID: 'file' });
  expect(args).toContain('--tmpfs');
  expect(args[args.indexOf('--tmpfs') + 1]).toBe('/var/lib/postgresql');
  expect(args).toContain('brain.test-run=run'); expect(args).toContain('brain.test-file=file');
});
