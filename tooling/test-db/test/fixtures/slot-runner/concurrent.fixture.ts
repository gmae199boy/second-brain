import { expect, it } from 'vitest';
import { acquireTestDatabase } from '@second-brain/test-db';
it('uses a distinct cluster for a simultaneous fixture', async () => {
  const [first, second] = await Promise.all([acquireTestDatabase(), acquireTestDatabase()]);
  try {
    expect([first, second].filter(db => db.fixtureContainer)).toHaveLength(1);
    expect((await first.rows('select 1 as value'))[0]?.value).toBe(1);
    expect((await second.rows('select 1 as value'))[0]?.value).toBe(1);
  } finally { await Promise.all([first.drop(), second.drop()]); }
});
