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

it('validates and persists drive retention days with a 30-day default', async () => {
  const {brain}=kit();
  expect(await brain.config.get({key:'drive.keep_local_days'})).toMatchObject({ok:true,value:'30',source:'default'});
  for (const value of ['-1','1.5','', '1e2', '9007199254740992', '100000001', '0\n']) expect(await brain.config.set({key:'drive.keep_local_days',value})).toMatchObject({ok:false,code:'CONFIG_INVALID'});
  expect(await brain.config.set({key:'drive.keep_local_days',value:'0'})).toMatchObject({ok:true,value:'0',source:'db'});
  expect(await brain.config.get({key:'drive.keep_local_days'})).toMatchObject({ok:true,value:'0',source:'db'});
});

it('validates the Drive root setting and keeps it in the self user scope',async()=>{
  const {brain}=kit();expect(await brain.config.get({key:'drive.root_folder_id'})).toMatchObject({ok:true,value:'',source:'default'});
  expect(await brain.config.set({key:'drive.root_folder_id',value:'synthetic-root_1'})).toMatchObject({ok:true,value:'synthetic-root_1',scope:'user'});
  for(const value of ['root/other','root\n','has space'])expect(await brain.config.set({key:'drive.root_folder_id',value})).toMatchObject({ok:false,code:'CONFIG_INVALID'});
});

it('normalizes watched Drive folders and validates the interval',async()=>{
 const {brain}=kit();expect(await brain.config.get({key:'drive.watch_folders'})).toMatchObject({ok:true,value:'[]'});expect(await brain.config.get({key:'drive.sync_interval_minutes'})).toMatchObject({ok:true,value:'30'});
 expect(await brain.config.set({key:'drive.watch_folders',value:'["z","a","z"]'})).toMatchObject({ok:true,value:'["a","z"]'});
 for(const value of ['{}','["a/b"]','[3]','not-json'])expect(await brain.config.set({key:'drive.watch_folders',value})).toMatchObject({ok:false,code:'CONFIG_INVALID'});
 for(const value of ['0','-1','1.5','1\n','525601'])expect(await brain.config.set({key:'drive.sync_interval_minutes',value})).toMatchObject({ok:false,code:'CONFIG_INVALID'});
 expect(await brain.config.set({key:'drive.sync_interval_minutes',value:'2'})).toMatchObject({ok:true,value:'2'});
});

it('writes explicit self overrides even when the inherited or default value is identical',async()=>{
 const store={...memorySettingsStore(),...self,...memorySchemaStore({version:1})};const def:SettingDefinition={key:'probe.label',scope:'user',defaultValue:'same',normalize:value=>({ok:true,value:value.trim()})};const deps={store,clock:{now:()=>at},schemaVersions:{core:1},settingDefinitions:[def]};const {setSetting}=await import('../src/settings/index.js');
 expect(await setSetting(deps,{key:'timezone',value:'Asia/Seoul'})).toMatchObject({ok:true,source:'db',updatedAt:at});expect(await store.getExactSetting({userId,key:'timezone'})).toMatchObject({value:'Asia/Seoul'});
 await store.setSetting({userId:null,key:def.key,value:'same',updatedAt:new Date(0)});expect(await setSetting(deps,{key:def.key,value:' same '})).toMatchObject({ok:true,source:'db',updatedAt:at});expect(await store.getExactSetting({userId,key:def.key})).toMatchObject({value:'same'});
 await store.setSetting({userId:null,key:def.key,value:'different',updatedAt:new Date(1)});expect(await store.getSetting({userId,key:def.key})).toMatchObject({ok:true,setting:{value:'same'}});
});

it('retries interval reconciliation for the same persisted value after a callback failure',async()=>{
 const store={...memorySettingsStore(),...self,...memorySchemaStore({version:1})};let calls=0;const deps={store,clock:{now:()=>at},schemaVersions:{core:1},onSettingChanged:async()=>{calls++;if(calls===1)throw Error('synthetic failure');}};const {setSetting}=await import('../src/settings/index.js');
 expect(await setSetting(deps,{key:'drive.sync_interval_minutes',value:'2'})).toMatchObject({ok:false,code:'DB_UNAVAILABLE'});expect(await setSetting(deps,{key:'drive.sync_interval_minutes',value:'2'})).toMatchObject({ok:true,source:'db',value:'2',updatedAt:at});expect(calls).toBe(2);
});

it('fake retention refresh serializes changes and reads the latest effective value',async()=>{
  const seen:number[]=[];let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const store=memorySettingsStore({selfUserId:userId,async applyRetention(days){seen.push(days);if(days===10){entered();await hold;}return {ok:true};}});
  const first=store.setSetting({userId,key:'drive.keep_local_days',value:'10',updatedAt:at});
  await started;const second=store.setSetting({userId,key:'drive.keep_local_days',value:'40',updatedAt:at});release();
  expect(await first).toEqual({ok:true});expect(await second).toEqual({ok:true});expect(await store.refreshDriveRetention()).toEqual({ok:true});
  expect(seen).toEqual([10,40,40]);expect(await store.getSetting({userId,key:'drive.keep_local_days'})).toMatchObject({ok:true,setting:{value:'40'}});
});

it('fake uncertain delete barrier rejects retention writes and preserves prior setting',async()=>{
  let locked=false;const store=memorySettingsStore({selfUserId:userId,async applyRetention(){return locked?{ok:false,code:'DB_LOCKED',message:'uncertain'}:{ok:true};}});
  expect(await store.setSetting({userId,key:'drive.keep_local_days',value:'30',updatedAt:at})).toEqual({ok:true});locked=true;
  expect(await store.setSetting({userId,key:'drive.keep_local_days',value:'10',updatedAt:at})).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect(await store.refreshDriveRetention()).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect(await store.getSetting({userId,key:'drive.keep_local_days'})).toMatchObject({ok:true,setting:{value:'30'}});
});

it('Telegram 사용자 설정은 빈 값으로 해제하고 토큰·chat id 형식을 검사한다', async () => {
  const { brain } = kit();
  const token = '123456789:' + 'A'.repeat(35);
  for (const [key, value] of [['telegram.bot_token', token], ['telegram.chat_id', '-1001234567890'], ['telegram.chat_id', '123456789']]) {
    expect(await brain.config.set({ key: key!, value: value! })).toMatchObject({ ok: true, value, scope: 'user' });
    expect(await brain.config.set({ key: key!, value: '' })).toMatchObject({ ok: true, value: '' });
  }
  for (const value of ['invalid', token + '\n', token + '!', '123:', ':' + 'A'.repeat(35)]) {
    const result = await brain.config.set({ key: 'telegram.bot_token', value });
    expect(result).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
    expect(JSON.stringify(result)).not.toContain(value);
  }
  for (const value of ['0', '-0', '1.2', '+1', '-100x', '1\n', '9007199254740992']) expect(await brain.config.set({ key: 'telegram.chat_id', value })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
});
