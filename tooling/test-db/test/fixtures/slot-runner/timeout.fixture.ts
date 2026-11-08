import { writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { acquireTestDatabase } from '@second-brain/test-db';
it('waits for coordinator timeout', async () => {
  const db = await acquireTestDatabase();
  try { if (process.env.BRAIN_SLOT_STARTED) await writeFile(process.env.BRAIN_SLOT_STARTED, 'ready'); await new Promise(resolve => setTimeout(resolve, 120_000)); }
  finally { await db.drop(); }
}, 180_000);
