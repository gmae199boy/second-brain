import { it } from 'vitest';
import { channelStoreContract, memoryStore } from '../src/testing/index.js';
for (const test of channelStoreContract()) it(test.name, () => test.run(async () => memoryStore()));
