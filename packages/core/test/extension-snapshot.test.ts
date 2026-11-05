import { expect, it } from 'vitest';
import { createExtensionSnapshot } from '../src/extensions/snapshot.js';
const declarations = [
  { key: 'testext.limit', type: 'number' as const, required: ['work' as const], default: '10' },
  { key: 'testext.token', type: 'string' as const, required: ['work' as const], secret: true },
];
const base = { userId: '019a0000-0000-7000-8000-000000000001', extension: 'testext', declarations, settings: {}, secrets: {} };
it('permits the initial auth without a token but requires it for work', () => {
  expect(createExtensionSnapshot({ ...base, stage: 'auth' })).toEqual({ ok: true, serialized: '{"version":1,"extension":"testext","user_id":"019a0000-0000-7000-8000-000000000001","values":{"testext.limit":10}}' });
  expect(createExtensionSnapshot({ ...base, stage: 'work' })).toMatchObject({ ok: false, code: 'EXTENSION_CONFIG_INVALID', retryable: false });
});
it('resolves references without trimming and rejects invalid configured values in every stage', () => {
  const input = { ...base, stage: 'auth' as const, settings: { 'testext.token': 'MY_SECRET' }, secrets: { MY_SECRET: ' secret ' } };
  const result = createExtensionSnapshot(input);
  expect(result.ok && JSON.parse(result.serialized).values['testext.token']).toBe(' secret ');
  expect(createExtensionSnapshot({ ...input, secrets: { MY_SECRET: '' } }).ok).toBe(false);
  expect(createExtensionSnapshot({ ...input, settings: { 'testext.token': 'invalid-name' } }).ok).toBe(false);
});
it('uses the machine tokenstore path instead of settings or secret contents', () => {
  const result = createExtensionSnapshot({ extension: 'testext', userId: '019a0000-0000-7000-8000-000000000001', stage: 'auth', declarations: [{ key: 'testext.tokenstore', type: 'string', required: ['auth'], machine: 'tokenstore' }], settings: { 'testext.tokenstore': 'untrusted' }, secrets: {}, machine: { tokenstore: '/runtime/tokenstore' } });
  expect(result.ok && JSON.parse(result.serialized).values).toEqual({ 'testext.tokenstore': '/runtime/tokenstore' });
});

it('extension setting definitions retain declared scope and default to user', async () => {
  const { extensionSettingDefinitions } = await import('../src/extensions/snapshot.js');
  const definitions = extensionSettingDefinitions([
    { key: 'testext.user', type: 'string', required: [] },
    { key: 'testext.global', type: 'string', required: [], scope: 'global' },
  ]);
  expect(definitions.map(definition => definition.scope)).toEqual(['user', 'global']);
});

it('acquires empty snapshots without capabilities or IO', async () => {
  const { acquireExtensionSnapshot } = await import('../src/extensions/snapshot.js');
  expect(await acquireExtensionSnapshot({ extension: 'testext', userId: base.userId, stage: 'connect', declarations: [] })).toEqual({ ok: true, serialized: `{"version":1,"extension":"testext","user_id":"${base.userId}","values":{}}` });
  let settingsReads = 0, secretReads = 0;
  expect(await acquireExtensionSnapshot({ extension: 'testext', userId: base.userId, stage: 'connect', declarations: [],
    getSettings: async () => { settingsReads++; return { ok: true, settings: [] }; },
    readSecrets: async () => { secretReads++; return {}; },
  })).toEqual({ ok: true, serialized: `{"version":1,"extension":"testext","user_id":"${base.userId}","values":{}}` });
  expect([settingsReads, secretReads]).toEqual([0, 0]);
});

it('acquires scoped values, defaults, secrets and machine values in the original order', async () => {
  const { acquireExtensionSnapshot } = await import('../src/extensions/snapshot.js');
  const { memoryStore } = await import('../src/testing/index.js');
  const store = memoryStore(), calls: string[] = [];
  await store.setSetting({ userId: null, key: 'testext.user', value: 'fallback', updatedAt: new Date(0) });
  await store.setSetting({ userId: base.userId, key: 'testext.user', value: 'self', updatedAt: new Date(0) });
  await store.setSetting({ userId: null, key: 'testext.global', value: 'true', updatedAt: new Date(0) });
  await store.setSetting({ userId: base.userId, key: 'testext.token', value: 'REF', updatedAt: new Date(0) });
  const result = await acquireExtensionSnapshot({ extension: 'testext', userId: base.userId, stage: 'connect', declarations: [
    { key: 'testext.user', type: 'string', required: [] }, { key: 'testext.global', type: 'boolean', scope: 'global', required: [] },
    { key: 'testext.default', type: 'number', default: '3', required: [] }, { key: 'testext.token', type: 'string', secret: true, required: [] },
    { key: 'testext.machine', type: 'string', machine: 'tokenstore', required: [] },
  ], getSettings: async input => { calls.push(input.userId ?? 'global'); return store.getSettings(input); }, readSecrets: async () => { calls.push('secrets'); return { REF: 'synthetic' }; }, machineValues: () => { calls.push('machine'); return { tokenstore: '/tokenstore' }; } });
  expect(calls).toEqual([base.userId, 'global', 'secrets', 'machine']);
  expect(result.ok && JSON.parse(result.serialized)).toEqual({ version: 1, extension: 'testext', user_id: base.userId, values: { 'testext.user': 'self', 'testext.global': true, 'testext.default': 3, 'testext.token': 'synthetic', 'testext.machine': '/tokenstore' } });
});

it('preserves capability, database, secret and required-stage failures', async () => {
  const { acquireExtensionSnapshot } = await import('../src/extensions/snapshot.js');
  const { memoryStore } = await import('../src/testing/index.js');
  const store = memoryStore(); let secretsRead = 0;
  const common = { extension: 'testext', userId: base.userId, stage: 'connect' as const, declarations: [{ key: 'testext.required', type: 'string' as const, required: ['connect' as const, 'work' as const] }] };
  expect(await acquireExtensionSnapshot(common)).toMatchObject({ ok: false, kind: 'config' });
  expect(await acquireExtensionSnapshot({ ...common, getSettings: store.getSettings.bind(store) })).toMatchObject({ ok: false, kind: 'config' });
  expect(await acquireExtensionSnapshot({ ...common, getSettings: async () => ({ ok: false, code: 'DB_LOCKED', message: 'locked' }), readSecrets: async () => { secretsRead++; return {}; } })).toMatchObject({ ok: false, kind: 'settings', result: { code: 'DB_LOCKED', message: 'locked' } });
  const caps = { getSettings: store.getSettings.bind(store), readSecrets: async () => { secretsRead++; return {}; } };
  expect(await acquireExtensionSnapshot({ ...common, ...caps })).toMatchObject({ ok: false, kind: 'snapshot' });
  expect(await acquireExtensionSnapshot({ ...common, ...caps, stage: 'work', requiredKeys: [] })).toMatchObject({ ok: true });
  expect(secretsRead).toBe(0);
  expect(await acquireExtensionSnapshot({ ...common, ...caps, declarations: [{ key: 'testext.secret', type: 'string', secret: true, required: [] }], readSecrets: async () => { throw new Error('secret'); } })).toMatchObject({ ok: false, kind: 'config', result: { code: 'EXTENSION_CONFIG_INVALID' } });
});
