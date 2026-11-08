import { access } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { acquireTestDatabase } from '@second-brain/test-db';
it('queries an isolated database', async () => {
  if (process.env.BRAIN_SLOT_SENTINEL_MARKER) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) { try { await access(process.env.BRAIN_SLOT_SENTINEL_MARKER); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
    await access(process.env.BRAIN_SLOT_SENTINEL_MARKER);
  }
  const db = await acquireTestDatabase();
  try { expect(await db.rows('select 1 as value')).toEqual([{ value: 1 }]); console.log(JSON.stringify({ slot: process.env.BRAIN_TEST_SLOT_ID, url: new URL(db.url).port, fixtureOwned: Boolean(db.fixtureContainer) })); }
  finally { await db.drop(); }
});
