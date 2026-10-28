import { describe, expect, it, vi } from 'vitest';
import { createSettingsBrain, settingDefinitions, TIMEZONE_SETTING, type SettingDefinition } from '../src/index.js';
import { memorySettingsStore, memorySchemaStore, settingsStoreContract } from '../src/testing/index.js';

for (const test of settingsStoreContract()) it(test.name, () => test.run(async () => memorySettingsStore()));
const at = new Date('2026-10-28T01:02:03.456Z');
function kit(schemaVersion = 1) {
  const store = { ...memorySettingsStore(), ...memorySchemaStore({ version: schemaVersion }) };
  const now = vi.fn(() => at);
  return { store, now, brain: createSettingsBrain({ store, clock: { now }, schemaVersions: { core: schemaVersion } }) };
}
describe('settings', () => {
  it.each([1, 2])('uses adapter schema version %s for default reads, writes and persisted reads', async schemaVersion => {
    const { brain, now } = kit(schemaVersion);
    expect(await brain.config.get({ key: 'timezone' })).toEqual({ ok: true, key: 'timezone', value: 'Asia/Seoul', source: 'default', updatedAt: null });
    expect(await brain.config.set({ key: 'timezone', value: 'america/new_york' })).toEqual({ ok: true, key: 'timezone', value: 'America/New_York', source: 'db', updatedAt: at });
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
    const store = { ...memorySettingsStore(), ...memorySchemaStore(code === 'SCHEMA_MISMATCH' ? { version: 2 } : { result: { ok: false, code, message: 'probe' } }) };
    const brain = createSettingsBrain({ store, clock: { now: () => at }, schemaVersions: { core: 1 } });
    expect(await brain.config.get({ key: 'timezone' })).toMatchObject({ ok: false, code });
    expect(await brain.config.set({ key: 'timezone', value: 'Asia/Seoul' })).toMatchObject({ ok: false, code });
    expect(await store.getSetting({ key: 'timezone' })).toEqual({ ok: true, setting: null });
  });
  it('requires registered, unique extension keys and validates defaults', async () => {
    const definition: SettingDefinition = { key: 'probe.name', defaultValue: '안녕', normalize: value => ({ ok: true, value: value.trim() }) };
    const schemaVersion = 1;
    const store = { ...memorySettingsStore(), ...memorySchemaStore({ version: schemaVersion }) };
    const brain = createSettingsBrain({ store, clock: { now: () => at }, schemaVersions: { core: schemaVersion }, settingDefinitions: [definition] });
    expect(await brain.config.get({ key: 'probe.name' })).toMatchObject({ value: '안녕', source: 'default' });
    expect(await brain.config.set({ key: 'probe.name', value: ' 값 ' })).toMatchObject({ value: '값', source: 'db' });
    for (const key of ['timezone', 'bare', '.name', 'probe.', 'probe..name']) expect(() => settingDefinitions([{ ...definition, key }])).toThrow();
    expect(() => settingDefinitions([definition, definition])).toThrow();
    expect(() => settingDefinitions([{ ...definition, normalize: () => ({ ok: false, message: 'invalid default' }) }])).toThrow('invalid default');
    expect(settingDefinitions().get('timezone')).toBe(TIMEZONE_SETTING);
  });
});
