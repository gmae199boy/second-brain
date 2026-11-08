import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { lookupProcess } from '../../../src/slots/ledger.js';
import { acquireTestDatabase } from '@second-brain/test-db';
it('leaves a detached descendant for the coordinator to stop', async () => {
  const db = await acquireTestDatabase();
  try {
    const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' }); child.unref();
    if (!child.pid || !process.env.BRAIN_SLOT_HANG_PID) throw new Error('missing child PID path');
    const started = await lookupProcess(child.pid); if (!started) throw new Error('missing child identity');
    await writeFile(process.env.BRAIN_SLOT_HANG_PID, JSON.stringify({ pid: child.pid, started }));
    await new Promise(resolve => setTimeout(resolve, 2500));
    expect(await db.rows('select 1 as value')).toEqual([{ value: 1 }]);
  } finally { await db.drop(); }
});
