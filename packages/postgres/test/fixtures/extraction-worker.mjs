import { createInterface } from 'node:readline';
import { postgresStore } from '../../dist/index.js';

// Credentials and input arrive over stdin, outside process arguments.
const lines = createInterface({ input: process.stdin });
let store;
let input;
try {
  for await (const line of lines) {
    if (store === undefined) {
      const received = JSON.parse(line);
      input = received.input;
      input.startedAt = new Date(input.startedAt);
      store = postgresStore({ databaseUrl: received.databaseUrl, applicationName: received.applicationName });
      const health = await store.checkHealth();
      if (!health.ok) throw new Error(health.message);
      process.stdout.write('ready\n');
    } else if (line === 'go') {
      process.stdout.write(`${JSON.stringify(await store.beginExtraction(input))}\n`);
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
