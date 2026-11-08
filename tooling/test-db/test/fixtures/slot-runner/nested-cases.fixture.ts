import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'vitest';
async function mark(name: string) { await appendFile(join(process.env.BRAIN_SLOT_CASE_MARKER_DIR!, 'nested.jsonl'), JSON.stringify(name) + '\n'); }
describe('outer suite', () => {
  describe('inner (x)', () => {
    it('case a', () => mark('case a'));
    it.each(['p', 'q'])('case %s', value => mark(`case ${value}`));
  });
});
