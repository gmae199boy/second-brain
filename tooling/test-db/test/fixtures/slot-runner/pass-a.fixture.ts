import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireTestDatabase } from '@second-brain/test-db';
it('queries an isolated database', async () => {
  if (process.env.BRAIN_SLOT_SENTINEL_MARKER) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) { try { await access(process.env.BRAIN_SLOT_SENTINEL_MARKER); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
    await access(process.env.BRAIN_SLOT_SENTINEL_MARKER);
  }
  const db = await acquireTestDatabase();
  try {
    expect(await db.rows('select 1 as value')).toEqual([{ value: 1 }]);
    if (process.env.BRAIN_SLOT_OWNERSHIP_OBSERVATION) {
      const fileDir = process.env.BRAIN_TEST_FILE_DIR!;
      await writeFile(process.env.BRAIN_SLOT_OWNERSHIP_OBSERVATION, JSON.stringify({ fileDir, runId: process.env.BRAIN_TEST_RUN_ID, fileId: process.env.BRAIN_TEST_FILE_ID, resource: process.env.BRAIN_TEST_PG_RESOURCE_LOG, hook: process.env.BRAIN_TEST_HOOK_RESOURCE_LOG, process: process.env.BRAIN_TEST_PROCESS_LOG, metrics: process.env.BRAIN_TEST_METRICS_LOG, marker: await readFile(join(fileDir, 'shared-db.jsonl'), 'utf8') }));
    }
    console.log(JSON.stringify({ slot: process.env.BRAIN_TEST_SLOT_ID, url: new URL(db.url).port, fixtureOwned: Boolean(db.fixtureContainer) }));
  }
  finally { await db.drop(); }
});
