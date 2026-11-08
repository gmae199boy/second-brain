import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireTestDatabase } from '@second-brain/test-db';
const markerDir = process.env.BRAIN_SLOT_CASE_MARKER_DIR!;
async function waitFor(path: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) { try { await access(path); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
  throw new Error(`marker unavailable: ${path}`);
}
it('mixed pass', async () => {
  await writeFile(join(markerDir, 'pass-ready'), 'ready');
  await waitFor(join(markerDir, 'sentinel-started'));
  const db = await acquireTestDatabase();
  try { expect(await db.rows('select 1 as value')).toEqual([{ value: 1 }]); } finally { await db.drop(); }
});
it('mixed fail', async () => {
  await waitFor(join(markerDir, 'pass-ready'));
  const db = await acquireTestDatabase();
  try { expect(await db.rows('select 1 as value')).toEqual([{ value: 2 }]); } finally { await db.drop(); }
});
it.each(['expanded'])('mixed %s', async value => {
  const db = await acquireTestDatabase();
  try { expect(value).toBe('expanded'); expect(await db.rows('select 1 as value')).toEqual([{ value: 1 }]); } finally { await db.drop(); }
});
