import pg from 'pg';
import { expect, it } from 'vitest';
it('holds a slot database connection for metrics', async () => {
  const client = new pg.Client({ connectionString: process.env.BRAIN_TEST_DATABASE_URL });
  await client.connect();
  try { expect((await client.query('select 1 as value')).rows[0]?.value).toBe(1); await new Promise(resolve => setTimeout(resolve, 5000)); }
  finally { await client.end(); }
});
