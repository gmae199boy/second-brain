import { afterEach, expect, it, vi } from 'vitest';
const file = vi.hoisted(() => ({ text: '' }));
vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(),
  readFile: vi.fn(async () => file.text),
}));
import { readBuildIdentity, readInstalled } from '../src/install/installed.js';

const base = { commit: 'a'.repeat(40), schema_version: 9 };
afterEach(() => { file.text = ''; });
it('reads both the legacy SQLite version and PostgreSQL owner versions from the build', async () => {
  file.text = JSON.stringify({ ...base, schema_versions: { core: 1, garmin: 2 } });
  expect(await readBuildIdentity()).toEqual({ ...base, schema_versions: { core: 1, garmin: 2 } });
});
it.each([undefined, null, [], 1, 'core:1', { core: '1' }, { core: 1.5 }])('rejects malformed build owner maps: %j', async schema_versions => {
  file.text = JSON.stringify({ ...base, schema_versions });
  expect(await readBuildIdentity()).toBeUndefined();
});
it.each([undefined, { core: 1 }])('accepts installed records with optional owner versions: %j', async schema_versions => {
  const record = { ...base, schema_versions, node: '/runtime/node', plugin_root: null, installed_at: '2026-10-28T00:00:00Z' };
  file.text = JSON.stringify(record);
  expect(await readInstalled('/brain')).toEqual(JSON.parse(file.text));
});
it('rejects malformed installed owner versions', async () => {
  file.text = JSON.stringify({ ...base, schema_versions: { core: '1' }, node: '/runtime/node', plugin_root: null, installed_at: '2026-10-28T00:00:00Z' });
  expect(await readInstalled('/brain')).toBeUndefined();
});
