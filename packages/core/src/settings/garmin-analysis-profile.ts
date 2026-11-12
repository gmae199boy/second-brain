import type { SettingValidation } from './index.js';

export const GARMIN_PROFILE_KEY = 'garmin.analysis_profile';
export type ProfilePatch = { expected_value?: string; set?: Record<string, unknown>; unset?: string[] };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && [...v].length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const list = (v: unknown) => Array.isArray(v) && v.length <= 100 && v.every(text);
const day = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && v.slice(0, 4) !== '0000' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
type Validator = (v: unknown) => boolean;
const fields: Record<string, Validator> = {
  'goals.primary': text, 'goals.secondary': list, 'goals.target_weight_kg': positive, 'goals.target_date': day,
  height_cm: positive, 'equipment.gym': list, 'equipment.home': list, 'equipment.availability': text,
  'preferences.preferred': list, 'preferences.avoid': list, constraints: list, 'diet.usual_pattern': text,
  alcohol_units: v => Array.isArray(v) && v.length <= 100 && v.every(unit => object(unit) && text(unit['kind']) && text(unit['unit']) &&
    Object.entries(unit).every(([k, x]) => k === 'kind' || k === 'unit' ? text(x) : k === 'ml' || k === 'grams_alcohol' ? positive(x) : k === 'abv_percent' ? typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 100 : k === 'source' && text(x))) &&
    new Set(v.map(unit => (unit as Record<string, unknown>)['kind'])).size === v.length,
};
const invalid = (): SettingValidation => ({ ok: false, message: 'Garmin 프로필은 버전 1 JSON과 지원 항목·양수 단위·유효 날짜를 사용해야 합니다' });
/** 이 키의 검증은 config 전체 저장과 항목 수정, 확장 snapshot에 동일하게 적용한다. */
export function normalizeGarminProfile(raw: string): SettingValidation {
  if (raw === '') return { ok: true, value: '' };
  if (new TextEncoder().encode(raw).length > 8192) return invalid();
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value['schema_version'] !== 1) return invalid();
    for (const [key, item] of Object.entries(value)) {
      if (key === 'schema_version') continue;
      const validate = !key.includes('.') && Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (validate) { if (!validate(item)) return invalid(); continue; }
      if (!object(item) || !['goals', 'equipment', 'preferences', 'diet'].includes(key)) return invalid();
      for (const [name, v] of Object.entries(item)) if (!Object.hasOwn(fields, `${key}.${name}`) || !fields[`${key}.${name}`]?.(v)) return invalid();
    }
    const normalized = JSON.stringify(value);
    // 16KiB snapshot의 절반을 나머지 설정과 envelope를 위해 남긴다.
    if (new TextEncoder().encode(JSON.stringify(normalized)).length > 8192) return invalid();
    return { ok: true, value: normalized };
  } catch { return invalid(); }
}
export function patchGarminProfile(raw: string, patch: ProfilePatch): SettingValidation {
  try {
    if (!object(patch) || Object.keys(patch).some(k => k !== 'set' && k !== 'unset' && k !== 'expected_value') ||
        (patch.set !== undefined && !object(patch.set)) || (patch.unset !== undefined && (!Array.isArray(patch.unset) || !patch.unset.every(x => typeof x === 'string')))) return invalid();
    if (patch.expected_value !== undefined && typeof patch.expected_value !== 'string') return invalid();
    const sets = Object.entries(patch.set ?? {}), unsets = patch.unset ?? [];
    if ((sets.some(([k]) => k === 'alcohol_units') || unsets.includes('alcohol_units')) && patch.expected_value === undefined) return { ok: false, message: '음주 단위 배열 수정에는 조회한 전체 value를 expected_value로 전달하세요' };
    const paths = [...sets.map(([k]) => k), ...unsets];
    if (!paths.length || new Set(paths).size !== paths.length || paths.some(k => !Object.hasOwn(fields, k))) return invalid();
    const checked = normalizeGarminProfile(raw || '{"schema_version":1}'); if (!checked.ok) return checked;
    const value = JSON.parse(checked.value) as Record<string, unknown>;
    for (const [path, item] of [...sets, ...unsets.map(k => [k, undefined] as const)]) {
      const [root, leaf] = path.split('.');
      if (leaf) {
        const group = object(value[root!]) ? value[root!] as Record<string, unknown> : {};
        if (item === undefined) delete group[leaf]; else group[leaf] = item;
        if (Object.keys(group).length) value[root!] = group; else delete value[root!];
      } else if (item === undefined) delete value[root!]; else value[root!] = item;
    }
    return normalizeGarminProfile(JSON.stringify(value));
  } catch { return invalid(); }
}
