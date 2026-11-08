import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { acquireTestDatabase } from '@second-brain/test-db';
it('queries an isolated database', async () => {
  if (process.env.BRAIN_SLOT_SENTINEL_MARKER) await writeFile(process.env.BRAIN_SLOT_SENTINEL_MARKER, 'started');
  const db = await acquireTestDatabase();
  try { expect(await db.rows('select 1 as value')).toEqual([{ value: 1 }]); console.log(JSON.stringify({ slot: process.env.BRAIN_TEST_SLOT_ID, url: new URL(db.url).port, fixtureOwned: Boolean(db.fixtureContainer) })); }
  finally { await db.drop(); }
});
