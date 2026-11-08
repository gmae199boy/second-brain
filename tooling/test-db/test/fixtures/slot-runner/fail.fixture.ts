import { expect, it } from 'vitest';
import { acquireTestDatabase } from '@second-brain/test-db';
it('fails intentionally', async () => {
  const db = await acquireTestDatabase();
  try { expect(await db.rows('select 1 as value')).toEqual([{ value: 2 }]); } finally { await db.drop(); }
});
