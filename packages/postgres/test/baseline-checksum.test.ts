import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

// 적용된 baseline은 바꾸지 않는다. 바꿀 것은 0002_*.sql로.
const APPLIED_CORE_BASELINE_SHA256 = '0cb16e9adb7fccf75eb08ed84533da7ce37e3ecb1c9a1ca8858d97f9af37c005';
it('pins the checksum of the applied core baseline 0001', async () => {
  const sql = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  expect(createHash('sha256').update(sql).digest('hex')).toBe(APPLIED_CORE_BASELINE_SHA256);
});
