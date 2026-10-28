import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { drainQueue } from '../../../core/dist/index.js';
import { postgresStore } from '../../dist/index.js';

// Credentials and the fixture instant travel over stdin, never process arguments.
const lines = createInterface({ input: process.stdin });
const inputLines = lines[Symbol.asyncIterator]();
let store;
const spool = {
  append: async () => ({ ok: false, message: 'this worker has no spool' }),
  claim: async () => ({ ok: true, claim: null }), complete: async () => ({ ok: true }),
  release: async () => ({ ok: true }), stats: async () => ({ ok: true, records: 0, earliest: null }),
};
async function expectLine(expected) {
  const line = await inputLines.next();
  if (line.done || line.value !== expected) throw new Error(`expected ${expected} from parent`);
}
try {
  const first = await inputLines.next();
  if (first.done) throw new Error('missing worker input');
  const input = JSON.parse(first.value);
  store = postgresStore({ databaseUrl: input.databaseUrl, path: 'drain' });
  const health = await store.checkHealth(); if (!health.ok) throw new Error(health.message);
  process.stdout.write('ready\n');
  await expectLine('go');
  const anchor = new Date(input.now).getTime();
  const started = performance.now();
  let firstHandler = true;
  const result = await drainQueue({ store, spool, clock: { now: () => new Date(anchor + Math.floor(performance.now() - started)) }, idGen: { next: randomUUID } }, {
    budgetMs: input.budgetMs, handlers: { demo_work: async item => {
      if (firstHandler) {
        firstHandler = false;
        process.stdout.write('entered\n');
        await expectLine('continue');
      }
      await appendFile(input.log, `${item.id}\n`, 'utf8');
      return { ok: true };
    } },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.stopped !== 'empty') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
} finally { lines.close(); await store?.close(); }
