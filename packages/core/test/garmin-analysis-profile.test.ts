import { expect, it } from 'vitest';
import { createSettingsBrain } from '../src/brain.js';
import { extensionSettingDefinitions, createExtensionSnapshot, acquireExtensionSnapshot } from '../src/extensions/snapshot.js';
import { normalizeGarminProfile, GARMIN_PROFILE_KEY as key } from '../src/settings/garmin-analysis-profile.js';
import { readScopedSettings } from '../src/settings/index.js';
import { memorySettingsStore, memorySchemaStore } from '../src/testing/index.js';

const user = '019a0000-0000-7000-8000-000000000001';
const declarations = [{ key, type: 'string' as const, scope: 'user' as const, required: [], default: '' }];
const definition = extensionSettingDefinitions(declarations);
function kit() {
  const store = { ...memorySettingsStore(), ...memorySchemaStore({ version: 1 }), async readSelfUser() { return { ok: true as const, user: { id: user, name: '합성', isSelf: true, createdAt: new Date(0) } }; } };
  const brain = createSettingsBrain({ store, clock: { now: () => new Date(1) }, schemaVersions: { core: 1 }, settingDefinitions: definition });
  return { store, brain };
}
it('사용자 프로필 저장·조회·항목 수정과 해제는 다른 항목을 보존한다', async () => {
  const { brain } = kit();
  expect(await brain.config.get({ key })).toMatchObject({ value: '', source: 'default' });
  expect(await brain.config.set({ key, value: JSON.stringify({ schema_version: 1, goals: { primary: '감량' }, constraints: [] }) })).toMatchObject({ ok: true });
  expect(await brain.config.patch({ key, patch: { expected_value: '{"schema_version":1,"goals":{"primary":"감량"},"constraints":[]}', set: { 'goals.target_weight_kg': 75, alcohol_units: [{ kind: '소주', unit: '병' }] } } })).toMatchObject({ ok: true });
  const value = await brain.config.get({ key });
  expect(value.ok && JSON.parse(value.value)).toEqual({ schema_version: 1, goals: { primary: '감량', target_weight_kg: 75 }, constraints: [], alcohol_units: [{ kind: '소주', unit: '병' }] });
  expect(await brain.config.patch({ key, patch: { unset: ['goals.target_weight_kg'] } })).toMatchObject({ ok: true });
  const after = await brain.config.get({ key });
  expect(after.ok && JSON.parse(after.value).goals).toEqual({ primary: '감량' });
  expect(await brain.config.patch({ key: 'timezone', patch: { set: { value: 'UTC' } } })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
});
it.each([
  '{', '{}', '{"schema_version":2}', '{"schema_version":true}', '{"schema_version":1,"unknown":1}',
  '{"schema_version":1,"goals.primary":"감량"}', '{"schema_version":1,"toString":"x"}',
  '{"schema_version":1,"goals":{"target_weight_kg":0}}', '{"schema_version":1,"goals":{"target_weight_kg":-1}}',
  '{"schema_version":1,"goals":{"target_weight_kg":"75"}}', '{"schema_version":1,"goals":{"target_date":"2026-02-30"}}',
  '{"schema_version":1,"goals":{"target_date":"0000-01-01"}}', '{"schema_version":1,"equipment":{"home":[null]}}',
  '{"schema_version":1,"alcohol_units":[{"kind":"소주","unit":"병","abv_percent":101}]}',
  '{"schema_version":1,"alcohol_units":[{"kind":"소주","unit":"병","ml":0}]}',
  '{"schema_version":1,"alcohol_units":[{"kind":"소주","unit":"병"},{"kind":"소주","unit":"잔"}]}',
])('무효 입력은 기존 값을 보존한다: %s', async raw => {
  const { brain } = kit();
  await brain.config.patch({ key, patch: { set: { 'goals.primary': '감량' } } });
  const before = await brain.config.get({ key });
  expect(await brain.config.set({ key, value: raw })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
  expect(await brain.config.get({ key })).toEqual(before);
});
it('크기·항목 경로·빈 수정·set/unset 충돌을 거부한다', async () => {
  expect(normalizeGarminProfile(JSON.stringify({ schema_version: 1, constraints: ['x'.repeat(24000)] })).ok).toBe(false);
  const { brain } = kit();
  for (const patch of [{}, { set: { '__proto__.x': 1 } }, { unset: ['schema_version'] }, { set: { 'goals.primary': '감량' }, unset: ['goals.primary'] }]) {
    expect(await brain.config.patch({ key, patch })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
  }
});
it('동시 첫 수정과 기존 수정은 한 요청만 저장하며 다른 사용자·global 값은 섞지 않는다', async () => {
  const { brain, store } = kit();
  await store.setSetting({ userId: null, key, value: '{"schema_version":1,"goals":{"primary":"global"}}', updatedAt: new Date() });
  await store.setSetting({ userId: '019a0000-0000-7000-8000-000000000002', key, value: '{"schema_version":1,"goals":{"primary":"other"}}', updatedAt: new Date() });
  expect(await brain.config.get({ key })).toMatchObject({ value: '', source: 'default' });
  const results = await Promise.all(['감량', '유지'].map(primary => brain.config.patch({ key, patch: { set: { 'goals.primary': primary } } })));
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.filter(r => !r.ok)).toEqual([expect.objectContaining({ code: 'DB_LOCKED' })]);
  const before = await store.getExactSetting({ userId: user, key });
  expect(await store.setSetting({ userId: user, key, value: '{}', updatedAt: new Date(), expectedValue: null })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(await store.setSetting({ userId: user, key, value: '{}', updatedAt: new Date(), expectedValue: 'stale' })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(await store.getExactSetting({ userId: user, key })).toEqual(before);
});
it('snapshot은 동일 검증을 적용하며 user scope 외의 프로필은 전달하지 않는다', async () => {
  const { store, brain } = kit();
  await store.setSetting({ userId: null, key, value: '{"schema_version":1,"goals":{"primary":"global"}}', updatedAt: new Date() });
  const read = () => acquireExtensionSnapshot({ extension: 'garmin', userId: user, stage: 'work', declarations, getSettings: store.getSettings, readSecrets: async () => ({}) });
  const absent = await read(); expect(absent.ok && JSON.parse(absent.serialized).values[key]).toBe('');
  await brain.config.patch({ key, patch: { set: { 'goals.primary': '감량' } } });
  const pinned = await read(); expect(pinned.ok && JSON.parse(pinned.serialized).values[key]).toContain('감량');
  await brain.config.patch({ key, patch: { set: { 'goals.primary': '유지' } } });
  expect(pinned.ok && JSON.parse(pinned.serialized).values[key]).toContain('감량');
  expect(createExtensionSnapshot({ extension: 'garmin', userId: user, stage: 'work', declarations, settings: { [key]: '{"schema_version":9}' }, secrets: {} })).toMatchObject({ ok: false });
});

it('manifest 원본으로 호출하는 daemon·로그인 공통 조회도 전역 프로필을 제외한다', async () => {
  const { store } = kit();
  await store.setSetting({ userId: null, key, value: '{"schema_version":1,"goals":{"primary":"global"}}', updatedAt: new Date() });
  expect(await readScopedSettings(store, user, declarations)).toEqual({ ok: true, settings: [] });
});
it('조회 뒤 다른 음주 종류가 추가되면 오래된 배열로 덮어쓰지 않고 충돌한다', async () => {
  const { brain } = kit();
  const first = await brain.config.patch({ key, patch: { expected_value: '', set: { alcohol_units: [{ kind: '맥주', unit: '캔' }] } } });
  if (!first.ok) throw Error('저장 실패');
  const second = await brain.config.patch({ key, patch: { expected_value: first.value, set: { alcohol_units: [{ kind: '맥주', unit: '캔' }, { kind: '소주', unit: '병' }] } } });
  expect(second.ok).toBe(true);
  expect(await brain.config.patch({ key, patch: { expected_value: first.value, set: { alcohol_units: [{ kind: '맥주', unit: '잔' }] } } })).toMatchObject({ code: 'DB_LOCKED' });
  expect(await brain.config.patch({ key, patch: { set: { alcohol_units: [] } } })).toMatchObject({ code: 'CONFIG_INVALID' });
  expect(await brain.config.get({ key })).toEqual(second);
});

it('프로필이 snapshot 문자열 인코딩 예산을 넘으면 저장 전에 거부한다', () => {
  const raw = JSON.stringify({ schema_version: 1, constraints: ['\\'.repeat(1800), '\\'.repeat(1800)] });
  expect(new TextEncoder().encode(raw).length).toBeLessThan(8192);
  expect(normalizeGarminProfile(raw).ok).toBe(false);
  const valid = normalizeGarminProfile(JSON.stringify({ schema_version: 1, goals: { primary: '감량' }, constraints: ['명시된 제약'] }));
  expect(valid.ok).toBe(true);
});
