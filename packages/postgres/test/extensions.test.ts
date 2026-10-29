import { it } from 'vitest';
import { extensionStoreContract } from '@second-brain/core/testing';
import { subject } from './fixture.js';
for (const c of extensionStoreContract()) it(c.name, () => c.run(subject));
