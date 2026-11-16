import { stat } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { TestDatabase } from '@second-brain/test-db';
import { createPgHomeRegistry } from './pg-home.js';
import { tempHomes } from './temp-home.js';

it('preserves a failed database and home for retry while cleaning independent homes', async () => {
  const registry = createPgHomeRegistry(), homes = tempHomes(registry.drop);
  const first = await homes.create('failed-home-'), second = await homes.create('clean-home-');
  let attempts = 0, otherDrops = 0;
  const db = (drop: () => Promise<void>): TestDatabase => ({ url: 'synthetic', appUrl: 'synthetic', maintenanceUrl: 'synthetic', async query() {}, async rows() { return []; }, drop });
  const failed = db(async () => { if (++attempts === 1) throw new Error('drop failed'); });
  registry.set(first, failed); registry.set(second, db(async () => { otherDrops++; }));
  try {
    const cleanup = homes.cleanup(); expect(homes.cleanup()).toBe(cleanup);
    await expect(cleanup).rejects.toThrow('temporary home cleanup failed');
    expect(registry.get(first)).toBe(failed); await expect(stat(first)).resolves.toBeDefined();
    expect(registry.get(second)).toBeUndefined(); await expect(stat(second)).rejects.toThrow(); expect(otherDrops).toBe(1);
    await homes.cleanup(); expect(attempts).toBe(2); expect(registry.get(first)).toBeUndefined(); await expect(stat(first)).rejects.toThrow();
  } finally { await homes.cleanup(); }
});

it('skips an already failed home for this attempt and cleans independent homes', async () => {
  const registry = createPgHomeRegistry(), homes = tempHomes(registry.drop);
  const first = await homes.create('skipped-home-'), second = await homes.create('independent-home-');
  let attempts = 0, otherDrops = 0;
  const db = (drop: () => Promise<void>): TestDatabase => ({ url: 'synthetic', appUrl: 'synthetic', maintenanceUrl: 'synthetic', async query() {}, async rows() { return []; }, drop });
  registry.set(first, db(async () => { if (++attempts === 1) throw new Error('original drop failure'); }));
  registry.set(second, db(async () => { otherDrops++; }));
  try {
    await expect(registry.drop(first)).rejects.toThrow('original drop failure');
    await homes.cleanup({ skip: new Set([first]) });
    expect(attempts).toBe(1); expect(registry.get(first)).toBeDefined(); await expect(stat(first)).resolves.toBeDefined();
    expect(otherDrops).toBe(1); await expect(stat(second)).rejects.toThrow();
    await homes.cleanup(); expect(attempts).toBe(2); expect(registry.get(first)).toBeUndefined(); await expect(stat(first)).rejects.toThrow();
  } finally { await homes.cleanup(); }
});
