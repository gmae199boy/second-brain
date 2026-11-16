import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIsolatedTestDatabase, type TestDatabase } from '../../../src/index.js';

let fixture: TestDatabase | undefined;
beforeEach(async () => {
  writeFileSync(process.env.DIAGNOSTIC_METRICS_POINTER!, process.env.BRAIN_TEST_METRICS_LOG!);
  fixture = await createIsolatedTestDatabase();
});
afterEach(async () => { await fixture?.drop(); fixture = undefined; });
describe('synthetic failed assertion', () => { it('same name', () => { expect(false).toBe(true); }); });
describe('synthetic timeout', () => { it('same name', async () => { await new Promise(() => {}); }); });
