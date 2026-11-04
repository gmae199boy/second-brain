import { expect, it } from 'vitest';
import { handoffChannelRequests } from '@second-brain/core';

it('resolves a workspace dependency to its TypeScript source during tests', async () => {
  const store = { listUnhandedChannelRequests() { throw new Error('source trace'); } };
  try {
    await handoffChannelRequests(store as never, {} as never, {} as never);
    throw new Error('expected a source trace');
  } catch (error) {
    expect((error as Error).stack).toMatch(/packages\/core\/src\/channels\/handoff\.ts/);
  }
});
