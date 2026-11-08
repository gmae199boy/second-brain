import { expect, it } from 'vitest';
import { acquireTestDatabase } from '@second-brain/test-db';
it('leaves a database at the file boundary', async () => {
  const db = await acquireTestDatabase();
  expect(await db.rows('select 1 as value')).toEqual([{ value: 1 }]);
});
