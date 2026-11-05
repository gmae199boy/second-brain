import { it } from 'vitest';
import { extensionQuiesceContract } from '../src/testing/contracts/extension-quiesce.js';
import { memoryStore } from '../src/testing/fakes/store.js';
for (const c of extensionQuiesceContract()) it(c.name, () => c.run(async () => ({ ...memoryStore(), async close() {} })));
