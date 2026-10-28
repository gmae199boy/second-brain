import { createInterface } from 'node:readline';
import { postgresStore } from '../../dist/index.js';

// Receive credentials over stdin so they never enter process arguments.
const lines = createInterface({ input: process.stdin });
let store;
let batch;
try {
  for await (const line of lines) {
    if (store === undefined) {
      const input = JSON.parse(line);
      batch = input.batch;
      for (const message of batch.messages) message.occurredAt = new Date(message.occurredAt);
      batch.tracking.ingestedAt = new Date(batch.tracking.ingestedAt);
      if (batch.tracking.endedAt !== null) batch.tracking.endedAt = new Date(batch.tracking.endedAt);
      store = postgresStore({ databaseUrl: input.databaseUrl });
      // Warm the independent connection before the parent releases both workers.
      const health = await store.checkHealth();
      if (!health.ok) throw new Error(health.message);
      process.stdout.write('ready\n');
    } else if (line === 'go') {
      const result = await store.ingest(batch);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      break;
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  lines.close();
  await store?.close();
}
