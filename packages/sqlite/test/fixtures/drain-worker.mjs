// One drain in a process of its own, so a test can run two at the same moment
// and watch the claim transaction hand every item to exactly one of them
// (AD-21).
//
// It has to be another process: `node:sqlite` is synchronous, so two
// connections in one process would wait on a write lock nothing can release.
//
// Usage: node drain-worker.mjs <database path> <log path>
// The handler appends the id it was given and waits a moment, which is what
// makes the two workers overlap rather than take turns.

import { appendFile } from 'node:fs/promises';
import { drainQueue } from '../../../core/dist/index.js';
import { sqliteStore } from '../../dist/index.js';

const [, , path, log] = process.argv;

const store = sqliteStore({ path });
const clock = { now: () => new Date() };
// The spool is never reached here: nothing in this run records a failure, and a
// drain that tried to would say so on stderr rather than write a file.
const spool = {
  append: async () => ({ ok: false, message: 'this worker has no spool' }),
  claim: async () => ({ ok: true, claim: null }),
  complete: async () => ({ ok: true }),
  release: async () => ({ ok: true }),
  stats: async () => ({ ok: true, records: 0, earliest: null }),
};
let serial = 0;
const idGen = { next: () => `${String(process.pid)}-${String((serial += 1))}` };

try {
  const report = await drainQueue(
    { store, spool, clock, idGen },
    {
      // Well past what twenty quick items need, so a worker never stops on the
      // budget and the test is about the claim and nothing else.
      budgetMs: 30_000,
      handlers: {
        demo_work: async (item) => {
          await appendFile(log, `${item.id}\n`, 'utf8');
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { ok: true };
        },
      },
    },
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.stopped !== 'empty') {
    process.stderr.write(`drain stopped on ${report.stopped}: ${report.code ?? ''}\n`);
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
