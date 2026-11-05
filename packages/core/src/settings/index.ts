import type { SchemaVersions } from '../schema.js';
import type { Clock } from '../ports/clock.js';
import type { SettingsStore, SchemaStore } from '../ports/store.js';
import { checkSchema } from '../schema.js';

export type SettingValidation = { ok: true; value: string } | { ok: false; message: string };
export interface SettingDefinition {
  key: string;
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
export const TIMEZONE_SETTING: SettingDefinition & { defaultValue: string } = { key: 'timezone', defaultValue: 'Asia/Seoul', normalize: normalizeTimeZone };
export const CORE_SETTING_DEFINITIONS: readonly SettingDefinition[] = [TIMEZONE_SETTING];
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
export interface SettingValue { key: string; value: string; source: 'default' | 'db'; updatedAt: Date | null }
export type SettingResult = ({ ok: true } & SettingValue) | { ok: false; code: 'CONFIG_INVALID' | 'DB_UNAVAILABLE' | 'DB_LOCKED' | 'SCHEMA_MISMATCH'; message: string };
export interface SettingsDependencies {
  store: SettingsStore & SchemaStore;
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
  const read = await deps.store.getSetting(input);
  if (!read.ok) return read;
  if (read.setting === null) return definition.defaultValue === undefined ? invalid('설정 값이 없습니다') : { ok: true, key: input.key, value: definition.defaultValue, source: 'default', updatedAt: null };
  const parsed = definition.normalize(read.setting.value);
  if (!parsed.ok) return invalid(parsed.message);
  return { ok: true, key: input.key, value: parsed.value, source: 'db', updatedAt: read.setting.updatedAt };
}
export async function setSetting(deps: SettingsDependencies, input: { key: string; value: string }): Promise<SettingResult> {
  const definition = settingDefinitions(deps.settingDefinitions).get(input.key);
  if (definition === undefined) return invalid(`모르는 사용자 설정 키입니다: ${input.key}`);
  const parsed = definition.normalize(input.value);
  if (!parsed.ok) return invalid(parsed.message);
  const schema = await checkSchema(deps.store, deps.schemaVersions);
  if (!schema.ok) return schema;
  const updatedAt = deps.clock.now();
  const written = await deps.store.setSetting({ key: input.key, value: parsed.value, updatedAt });
  return written.ok ? { ok: true, key: input.key, value: parsed.value, source: 'db', updatedAt } : written;
}
