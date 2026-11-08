import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireTestDatabase } from '@second-brain/test-db';
it('quick pass', async () => {
  const db = await acquireTestDatabase();
  try { expect(await db.rows('select 1 as value')).toEqual([{ value: 1 }]); if (process.env.BRAIN_SLOT_CASE_MARKER_DIR) await writeFile(join(process.env.BRAIN_SLOT_CASE_MARKER_DIR, 'quick-ran'), 'yes'); } finally { await db.drop(); }
});
it('slow timeout', async () => { await new Promise(resolve => setTimeout(resolve, 120_000)); }, 180_000);
