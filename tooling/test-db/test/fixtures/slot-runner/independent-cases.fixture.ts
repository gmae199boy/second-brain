import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireTestDatabase } from '@second-brain/test-db';

async function runCase(name: string) {
  const dir = process.env.BRAIN_SLOT_CASE_MARKER_DIR;
  if (!dir) throw new Error('missing case marker directory');
  const db = await acquireTestDatabase();
  try {
    await appendFile(join(dir, 'cases.jsonl'), JSON.stringify(name) + '\n');
    expect(await db.rows('select 1 as value')).toEqual([{ value: 1 }]);
  } finally { await db.drop(); }
}
it('first independent case', () => runCase('first independent case'));
it('case (a+b)? [x]', () => runCase('case (a+b)? [x]'));
it.each(['alpha', 'beta'])('expanded case %s', value => runCase(`expanded case ${value}`));
