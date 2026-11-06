import type { SchemaVersions } from '../schema.js';
import type { Clock } from '../ports/clock.js';
import type { SettingsStore, SchemaStore, UserStore } from '../ports/store.js';
import { resolveSelfUser } from '../users/self.js';
import { checkSchema } from '../schema.js';

export type SettingValidation = { ok: true; value: string } | { ok: false; message: string };
export interface SettingDefinition {
  key: string;
  scope?: 'user' | 'global';
  defaultValue?: string;
  normalize(raw: string): SettingValidation;
}
export function normalizeTimeZone(value: string): SettingValidation {
  if (value === '' || /^[+-]/.test(value)) return { ok: false, message: 'timezone은 유효한 IANA 시간대 이름이어야 합니다' };
  try {
    return { ok: true, value: new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone };
  } catch { return { ok: false, message: `timezone "${value}"은 유효한 IANA 시간대 이름이 아닙니다` }; }
}
export function isTimeZone(value: string): boolean { return normalizeTimeZone(value).ok; }
export const TIMEZONE_SETTING: SettingDefinition & { defaultValue: string } = { key: 'timezone', scope: 'user', defaultValue: 'Asia/Seoul', normalize: normalizeTimeZone };
export function normalizeKeepLocalDays(raw: string): SettingValidation {
  const match = /^(?:0|[1-9][0-9]*)$/.exec(raw);
  if (match === null || match[0] !== raw) return {ok:false, message:'drive.keep_local_days는 0 이상의 정수여야 합니다'};
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days > 100_000_000) return {ok:false, message:'drive.keep_local_days가 허용 범위를 넘습니다'};
  return {ok:true,value:String(days)};
}
export const DRIVE_KEEP_LOCAL_DAYS: SettingDefinition = {key:'drive.keep_local_days', scope:'user', defaultValue:'30', normalize:normalizeKeepLocalDays};
export const CORE_SETTING_DEFINITIONS: readonly SettingDefinition[] = [TIMEZONE_SETTING, DRIVE_KEEP_LOCAL_DAYS];
/** Extensions register complete definitions; unknown namespaces stay unknown. */
export function settingDefinitions(extensions: readonly SettingDefinition[] = []): ReadonlyMap<string, SettingDefinition> {
  const definitions = new Map(CORE_SETTING_DEFINITIONS.map(def => [def.key, def]));
  for (const definition of extensions) {
    if (definitions.has(definition.key) || !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(definition.key)) {
      throw new TypeError(`설정 키 정의가 겹치거나 확장 키 형식이 아닙니다: ${definition.key}`);
    }
    if (definition.defaultValue === undefined) { definitions.set(definition.key, definition); continue; }
    const normalized = definition.normalize(definition.defaultValue);
    if (!normalized.ok) throw new TypeError(normalized.message);
    definitions.set(definition.key, { ...definition, defaultValue: normalized.value });
  }
  return definitions;
}
/** Scope-aware bulk read shared by config and extension snapshots. */
export async function readScopedSettings(store: Pick<SettingsStore, 'getSettings'>, userId: string | null, definitions: readonly { key: string; scope?: 'user' | 'global' }[]) {
  const userKeys = definitions.filter(d => (d.scope ?? 'user') === 'user').map(d => d.key);
  const globalKeys = definitions.filter(d => d.scope === 'global').map(d => d.key);
  const user = userKeys.length ? await store.getSettings({ userId, keys: userKeys }) : { ok: true as const, settings: [] };
  if (!user.ok) return user;
  const global = globalKeys.length ? await store.getSettings({ userId: null, keys: globalKeys }) : { ok: true as const, settings: [] };
  if (!global.ok) return global;
  return { ok: true as const, settings: [...user.settings, ...global.settings] };
}
export interface SettingValue { scope: 'user' | 'global'; key: string; value: string; source: 'default' | 'db'; updatedAt: Date | null }
export type SettingResult = ({ ok: true } & SettingValue) | { ok: false; code: 'CONFIG_INVALID' | 'USER_MISSING' | 'DB_UNAVAILABLE' | 'DB_LOCKED' | 'SCHEMA_MISMATCH'; message: string };
export interface SettingsDependencies {
  store: SettingsStore & SchemaStore & Pick<UserStore, 'readSelfUser'>;
  /** Current schema version supplied by the adapter. */
  schemaVersions: SchemaVersions;
  clock: Clock;
  settingDefinitions?: readonly SettingDefinition[];
}
function invalid(message: string): SettingResult { return { ok: false, code: 'CONFIG_INVALID', message }; }
export async function getSetting(deps: SettingsDependencies, input: { key: string }): Promise<SettingResult> {
  const definition = settingDefinitions(deps.settingDefinitions).get(input.key);
  if (definition === undefined) return invalid(`모르는 사용자 설정 키입니다: ${input.key}`);
  const schema = await checkSchema(deps.store, deps.schemaVersions);
  if (!schema.ok) return schema;
  const scope = definition.scope ?? 'user';
  const self = scope === 'user' ? await resolveSelfUser(deps.store) : null;
  if (self && !self.ok) return self;
  const read = await readScopedSettings(deps.store, self?.userId ?? null, [definition]);
  if (!read.ok) return read;
  const setting = read.settings[0] ?? null;
  if (setting === null) return definition.defaultValue === undefined ? invalid('설정 값이 없습니다') : { ok: true, scope, key: input.key, value: definition.defaultValue, source: 'default', updatedAt: null };
  const parsed = definition.normalize(setting.value);
  if (!parsed.ok) return invalid(parsed.message);
  return { ok: true, scope, key: input.key, value: parsed.value, source: 'db', updatedAt: setting.updatedAt };
}
export async function setSetting(deps: SettingsDependencies, input: { key: string; value: string; scope?: 'user' | 'global' }): Promise<SettingResult> {
  const definition = settingDefinitions(deps.settingDefinitions).get(input.key);
  if (definition === undefined) return invalid(`모르는 사용자 설정 키입니다: ${input.key}`);
  const scope = definition.scope ?? 'user';
  if (input.scope !== undefined && input.scope !== scope) return invalid('설정 scope가 일치하지 않습니다');
  const parsed = definition.normalize(input.value);
  if (!parsed.ok) return invalid(parsed.message);
  const schema = await checkSchema(deps.store, deps.schemaVersions);
  if (!schema.ok) return schema;
  const self = scope === 'user' ? await resolveSelfUser(deps.store) : null;
  if (self && !self.ok) return self;
  const updatedAt = deps.clock.now();
  const written = await deps.store.setSetting({ userId: self?.userId ?? null, key: input.key, value: parsed.value, updatedAt });
  return written.ok ? { ok: true, scope, key: input.key, value: parsed.value, source: 'db', updatedAt } : written;
}
