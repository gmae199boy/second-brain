import { describe, expect, it, vi } from 'vitest';
import { createSettingsBrain, settingDefinitions, TIMEZONE_SETTING, type SettingDefinition } from '../src/index.js';
import { memorySettingsStore, memorySchemaStore, settingsStoreContract } from '../src/testing/index.js';

for (const test of settingsStoreContract()) it(test.name, () => test.run(async () => memorySettingsStore()));
const userId = '019a0000-0000-7000-8000-000000000001';
const self = { async readSelfUser() { return { ok: true as const, user: { id: userId, name: 'synthetic', isSelf: true, createdAt: new Date(0) } }; } };
const at = new Date('2026-10-28T01:02:03.456Z');
function kit(schemaVersion = 1) {
  const store = { ...memorySettingsStore(), ...self, ...memorySchemaStore({ version: schemaVersion }) };
  const now = vi.fn(() => at);
  return { store, now, brain: createSettingsBrain({ store, clock: { now }, schemaVersions: { core: schemaVersion } }) };
}
describe('settings', () => {
  it.each([1, 2])('uses adapter schema version %s for default reads, writes and persisted reads', async schemaVersion => {
    const { brain, now } = kit(schemaVersion);
    expect(await brain.config.get({ key: 'timezone' })).toEqual({ ok: true, scope: 'user', key: 'timezone', value: 'Asia/Seoul', source: 'default', updatedAt: null });
    expect(await brain.config.set({ key: 'timezone', value: 'america/new_york' })).toEqual({ ok: true, scope: 'user', key: 'timezone', value: 'America/New_York', source: 'db', updatedAt: at });
    expect(now).toHaveBeenCalledTimes(1);
    expect(await brain.config.get({ key: 'timezone' })).toMatchObject({ value: 'America/New_York', source: 'db', updatedAt: at });
    expect(now).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid input before any database I/O or clock read and leaves the previous value', async () => {
    const { brain, store, now } = kit();
    await brain.config.set({ key: 'timezone', value: 'Europe/Paris' });
    const reads = store.reads();
    for (const value of ['', '+09:00', '-04:00', 'Mars/Base']) expect(await brain.config.set({ key: 'timezone', value })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
    expect(await brain.config.get({ key: 'nope' })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
    expect(await brain.config.set({ key: 'garmin.x', value: '1' })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
    expect(store.reads()).toBe(reads); expect(now).toHaveBeenCalledTimes(1);
    expect(await brain.config.get({ key: 'timezone' })).toMatchObject({ value: 'Europe/Paris' });
  });
  it.each(['DB_LOCKED', 'DB_UNAVAILABLE', 'SCHEMA_MISMATCH'] as const)('propagates %s without writing', async code => {
    const store = { ...memorySettingsStore(), ...self, ...memorySchemaStore(code === 'SCHEMA_MISMATCH' ? { version: 2 } : { result: { ok: false, code, message: 'probe' } }) };
    const brain = createSettingsBrain({ store, clock: { now: () => at }, schemaVersions: { core: 1 } });
    expect(await brain.config.get({ key: 'timezone' })).toMatchObject({ ok: false, code });
    expect(await brain.config.set({ key: 'timezone', value: 'Asia/Seoul' })).toMatchObject({ ok: false, code });
    expect(await store.getSetting({ userId: null, key: 'timezone' })).toEqual({ ok: true, setting: null });
  });
  it('requires registered, unique extension keys and validates defaults', async () => {
    const definition: SettingDefinition = { key: 'probe.name', defaultValue: '안녕', normalize: value => ({ ok: true, value: value.trim() }) };
    const schemaVersion = 1;
    const store = { ...memorySettingsStore(), ...self, ...memorySchemaStore({ version: schemaVersion }) };
    const brain = createSettingsBrain({ store, clock: { now: () => at }, schemaVersions: { core: schemaVersion }, settingDefinitions: [definition] });
    expect(await brain.config.get({ key: 'probe.name' })).toMatchObject({ value: '안녕', source: 'default' });
    expect(await brain.config.set({ key: 'probe.name', value: ' 값 ' })).toMatchObject({ value: '값', source: 'db' });
    for (const key of ['timezone', 'bare', '.name', 'probe.', 'probe..name']) expect(() => settingDefinitions([{ ...definition, key }])).toThrow();
    expect(() => settingDefinitions([definition, definition])).toThrow();
    expect(() => settingDefinitions([{ ...definition, normalize: () => ({ ok: false, message: 'invalid default' }) }])).toThrow('invalid default');
    expect(settingDefinitions().get('timezone')).toBe(TIMEZONE_SETTING);
  });
});

it('reads user before global before default, rejects scope mismatch, and requires self', async () => {
  const store = { ...memorySettingsStore(), ...self, ...memorySchemaStore({ version: 1 }) };
  const definition: SettingDefinition = { key: 'probe.value', scope: 'user', defaultValue: 'default', normalize: value => ({ ok: true, value }) };
  const deps = { store, clock: { now: () => at }, schemaVersions: { core: 1 }, settingDefinitions: [definition] };
  const { getSetting, setSetting } = await import('../src/settings/index.js');
  expect(await getSetting(deps, { key: definition.key })).toMatchObject({ value: 'default', scope: 'user' });
  await store.setSetting({ userId: null, key: definition.key, value: 'global', updatedAt: at });
  expect(await getSetting(deps, { key: definition.key })).toMatchObject({ value: 'global' });
  await store.setSetting({ userId, key: definition.key, value: 'user', updatedAt: at });
  expect(await getSetting(deps, { key: definition.key })).toMatchObject({ value: 'user' });
  expect(await setSetting(deps, { key: definition.key, value: 'bad', scope: 'global' })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
  expect(await getSetting(deps, { key: definition.key })).toMatchObject({ value: 'user' });
  const missing = { ...deps, store: { ...store, async readSelfUser() { return { ok: true as const, user: null }; } } };
  expect(await getSetting(missing, { key: definition.key })).toMatchObject({ ok: false, code: 'USER_MISSING' });
  expect(await setSetting(missing, { key: definition.key, value: 'x' })).toMatchObject({ ok: false, code: 'USER_MISSING' });
  const global = { ...deps, settingDefinitions: [{ ...definition, scope: 'global' as const }] };
  expect(await setSetting(global, { key: definition.key, value: 'bad', scope: 'user' })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
});

it('global scope reads and writes without self using only the global row', async () => {
  const store = { ...memorySettingsStore(), ...memorySchemaStore({ version: 1 }), async readSelfUser() { return { ok: true as const, user: null }; } };
  const definition: SettingDefinition = { key: 'probe.global', scope: 'global', defaultValue: 'fallback', normalize: value => ({ ok: true, value }) };
  const brain = createSettingsBrain({ store, clock: { now: () => at }, schemaVersions: { core: 1 }, settingDefinitions: [definition] });
  expect(await brain.config.get({ key: definition.key })).toMatchObject({ ok: true, scope: 'global', value: 'fallback' });
  expect(await brain.config.set({ key: definition.key, value: 'stored' })).toMatchObject({ ok: true, scope: 'global', value: 'stored' });
  expect(await brain.config.get({ key: definition.key })).toMatchObject({ ok: true, scope: 'global', value: 'stored' });
});

it('global config and extension snapshot select the same global value over a user row', async () => {
  const { readScopedSettings } = await import('../src/settings/index.js');
  const { createExtensionSnapshot, extensionSettingDefinitions } = await import('../src/extensions/snapshot.js');
  const store = { ...memorySettingsStore(), ...self, ...memorySchemaStore({ version: 1 }) };
  const declarations = [{ key: 'probe.value', type: 'string' as const, required: [] as const, scope: 'global' as const, default: 'default' }];
  await store.setSetting({ userId: null, key: 'probe.value', value: 'global', updatedAt: at });
  await store.setSetting({ userId, key: 'probe.value', value: 'user', updatedAt: at });
  const brain = createSettingsBrain({ store, clock: { now: () => at }, schemaVersions: { core: 1 }, settingDefinitions: extensionSettingDefinitions(declarations) });
  const config = await brain.config.get({ key: 'probe.value' });
  const read = await readScopedSettings(store, userId, declarations);
  if (!config.ok || !read.ok) throw Error('setting read failed');
  const snapshot = createExtensionSnapshot({ extension: 'probe', userId, stage: 'work', declarations, settings: Object.fromEntries(read.settings.map(row => [row.key, row.value])), secrets: {} });
  expect(snapshot.ok).toBe(true);
  if (snapshot.ok) expect(JSON.parse(snapshot.serialized).values['probe.value']).toBe(config.value);
  expect(config.value).toBe('global');
});

it.each(['DB_LOCKED', 'DB_UNAVAILABLE'] as const)('propagates self lookup %s without writing', async code => {
  const set = vi.fn(async () => ({ ok: true as const }));
  const store = { ...memorySettingsStore(), ...memorySchemaStore({ version: 1 }), setSetting: set, async readSelfUser() { return { ok: false as const, code, message: 'self lookup failed' }; } };
  const brain = createSettingsBrain({ store, clock: { now: () => at }, schemaVersions: { core: 1 } });
  expect(await brain.config.get({ key: 'timezone' })).toEqual({ ok: false, code, message: 'self lookup failed' });
  expect(await brain.config.set({ key: 'timezone', value: 'UTC' })).toEqual({ ok: false, code, message: 'self lookup failed' });
  expect(set).not.toHaveBeenCalled();
});
