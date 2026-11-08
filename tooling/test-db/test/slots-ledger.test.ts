import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { liveness, readLedger, writeLedger } from '../src/slots/ledger.js';
it('writes and replaces a complete ledger atomically', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ledger-'));
  try { const ledger = { runId: 'run', coordinator: { pid: 1, started: 'start' }, slots: [], files: [], resources: [], cleanup: [{ error: 'x' }] }; await writeLedger(repo, ledger); expect(await readLedger(repo, 'run')).toEqual(ledger); expect(await readdir(join(repo, '.brain-test-runs'))).toEqual(['run.json']); } finally { await rm(repo, { recursive: true, force: true }); }
});
it('distinguishes dead identities from lookup failure', async () => {
  const identity = { pid: 10, started: 'old' };
  expect(await liveness(identity, async () => null)).toBe('dead');
  expect(await liveness(identity, async () => 'new')).toBe('dead');
  expect(await liveness(identity, async () => 'old')).toBe('alive');
  expect(await liveness(identity, async () => { throw new Error('denied'); })).toBe('unknown');
});
