import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { postgresStore } from '../../dist/index.js';

// Connection credentials travel over stdin, never argv.
const lines = createInterface({ input: process.stdin });
const inputLines = lines[Symbol.asyncIterator]();
let store;
try {
  const first = await inputLines.next();
  if (first.done) throw new Error('missing worker input');
  const input = JSON.parse(first.value);
  store = postgresStore({ databaseUrl: input.databaseUrl });
  const health = await store.checkHealth();
  if (!health.ok) throw new Error('worker database unavailable');
  process.stdout.write('ready\n');
  for await (const line of inputLines) {
    if (line !== 'go') throw new Error('expected go');
    const items = [];
    for (;;) {
      const query = { now: new Date(input.now), claimedBy: input.path, kinds: input.path === 'core' ? ['demo_work', 'demo_other'] : ['process_probe'] };
      const result = input.path === 'core' ? await store.claimWork(query)
        : await store.claimSupervisedWork({ ...query, attemptToken: randomUUID() });
      if (!result.ok) throw new Error('worker claim failed');
      if (result.item === null) break;
      items.push({ id: result.item.id, key: result.item.serializationKey });
    }
    process.stdout.write(`${JSON.stringify(items)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally { lines.close(); await store?.close(); }
