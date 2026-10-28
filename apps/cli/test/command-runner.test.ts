import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { systemCommandRunner } from '../src/runtime/command-runner.js';

it.each([1, 2])('preserves numeric process exit code %i as a string', async code => {
  const result = await systemCommandRunner({
    command: process.execPath,
    args: ['-e', `process.stdout.write('output'); process.stderr.write('failure'); process.exit(${code})`],
    env: process.env, timeoutMs: 5000,
  });
  expect(result).toMatchObject({ ok: false, code: String(code), stdout: 'output', stderr: 'failure' });
});

it('preserves string execution error codes', async () => {
  const result = await systemCommandRunner({
    command: join(tmpdir(), `brain-missing-command-${randomUUID()}`), args: [],
    env: process.env, timeoutMs: 5000,
  });
  expect(result).toMatchObject({ ok: false, code: 'ENOENT' });
});
