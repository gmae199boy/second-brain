import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extLoginCommand, launchTerminal } from '../src/commands/ext-login.js';

describe('terminal extension login', () => {
  it('rejects non-terminal input before opening the store', async () => {
    expect(extLoginCommand.standalone).toBe(true);
    if (extLoginCommand.standalone !== true) throw new Error('wrong command');
    const result = await extLoginCommand.run({ args: ['garmin'], env: {}, options: {}, clock: {} as never, stdin: async () => '', recordHookArrival: async () => {} });
    expect(result).toMatchObject({ ok: false, code: 'LOGIN_REQUIRED' });
  });
  it('accepts only a declared final error code from a child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'login-test-'));
    const entry = join(dir, 'entry.mjs');
    try {
      await writeFile(entry, "process.exit(0);\n");
      expect(await launchTerminal(process.execPath, entry, {}, ['RATE_LIMITED'])).toMatchObject({ status: 0 });
      await writeFile(entry, "console.error('RATE_LIMITED'); process.exit(1);\n");
      expect(await launchTerminal(process.execPath, entry, {}, ['RATE_LIMITED'])).toEqual({ status: 1, code: 'RATE_LIMITED' });
      await writeFile(entry, "console.error('private response'); process.exit(1);\n");
      expect(await launchTerminal(process.execPath, entry, {}, ['RATE_LIMITED'])).toEqual({ status: 1, code: 'LOGIN_REQUIRED' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
