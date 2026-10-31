import { extensionSettingDefinitions, type ExtensionSettingDeclaration } from './snapshot.js';
export const EXTENSION_CORE_VERSION = 1;
export function isExtensionName(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,30}$/.test(value) && !/^(core|brain|public|pg_)/.test(value);
}
export interface ExtensionManifest {
  name: string; version: string; core: 1; abi: 1; migrations: string;
  connection_check: { runtime: 'node' | 'python'; entry: string };
  settings?: ExtensionSettingDeclaration[];
  error_codes?: string[];
  work?: { kind: string; execution: 'supervised'; runtime: 'node' | 'python'; entry: string; manual?: string; public_report?: { counts: string[]; checks: string[] }; required_settings?: string[] }[];
  auth?: { kind: string; execution: 'supervised'; runtime: 'node' | 'python'; entry: string };
  default_schedules?: { kind: string; target_kind: string; target_id: string; local_time: string }[];
  raw_views?: string[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).length === allowed.length && Object.keys(value).every(k => allowed.includes(k));
const inside = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && value.split('/').every(part => part !== '..' && part !== '.' && part !== '');
export function decodeExtensionManifest(text: string): { ok: true; manifest: ExtensionManifest } | { ok: false; code: 'EXTENSION_INVALID'; message: string } {
  const invalid = { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 manifest의 필드나 패키지 상대 경로가 올바르지 않습니다' };
  let v: unknown; try { v = JSON.parse(text); } catch { return invalid; }
  if (!object(v) || !['name', 'version', 'core', 'abi', 'migrations', 'connection_check'].every(k => Object.hasOwn(v, k)) || !Object.keys(v).every(k => ['name', 'version', 'core', 'abi', 'migrations', 'connection_check', 'settings', 'error_codes', 'work', 'auth', 'default_schedules', 'raw_views'].includes(k))) return invalid;
  const check = v['connection_check'];
  if (typeof v['name'] !== 'string' || !isExtensionName(v['name']) || typeof v['version'] !== 'string' || !v['version'].trim() || /[\u0000-\u001f\u007f-\u009f]/.test(v['version']) || v['core'] !== EXTENSION_CORE_VERSION || v['abi'] !== 1 || !inside(v['migrations']) || !object(check) || !keys(check, ['runtime', 'entry']) || !['node', 'python'].includes(check['runtime'] as string) || !inside(check['entry'])) return invalid;
  if (v['settings'] !== undefined) {
    if (!Array.isArray(v['settings'])) return invalid;
    const seen = new Set<string>();
    for (const setting of v['settings']) {
      if (!object(setting) || !Object.keys(setting).every(k => ['key', 'type', 'required', 'secret', 'default', 'machine'].includes(k)) ||
          typeof setting['key'] !== 'string' || !setting['key'].startsWith(`${v['name']}.`) || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(setting['key']) || seen.has(setting['key']) ||
          !['string', 'number', 'boolean'].includes(setting['type'] as string) || !Array.isArray(setting['required']) ||
          setting['required'].some((stage: unknown) => !['connect', 'auth', 'work'].includes(stage as string)) || new Set(setting['required']).size !== setting['required'].length ||
          (setting['secret'] !== undefined && typeof setting['secret'] !== 'boolean') || (setting['secret'] === true && setting['type'] !== 'string') ||
          (setting['default'] !== undefined && typeof setting['default'] !== 'string') ||
          (setting['machine'] !== undefined && (setting['machine'] !== 'tokenstore' || setting['type'] !== 'string' || setting['secret'] === true || setting['default'] !== undefined))) return invalid;
      const definition = extensionSettingDefinitions([setting as unknown as ExtensionSettingDeclaration])[0];
      if (definition?.defaultValue !== undefined && !definition.normalize(definition.defaultValue).ok) return invalid;
      seen.add(setting['key']);
    }
  }
  if (v['work'] !== undefined) {
    if (!Array.isArray(v['work'])) return invalid;
    const seen = new Set<string>();
    const aliases = new Set<string>();
    for (const work of v['work']) {
      if (!object(work) || !['kind', 'execution', 'runtime', 'entry'].every(k => Object.hasOwn(work, k)) || !Object.keys(work).every(k => ['kind', 'execution', 'runtime', 'entry', 'manual', 'public_report', 'required_settings'].includes(k)) || typeof work['kind'] !== 'string' ||
          !work['kind'].startsWith(`${v['name']}.`) || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(work['kind']) || seen.has(work['kind']) ||
          work['execution'] !== 'supervised' || !['node', 'python'].includes(work['runtime'] as string) || !inside(work['entry'])) return invalid;
      if (work['manual'] !== undefined && (typeof work['manual'] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(work['manual']) || aliases.has(work['manual']))) return invalid;
      if (typeof work['manual'] === 'string') aliases.add(work['manual']);
      const report = work['public_report'];
      const labels = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v)) && new Set(x).size === x.length;
      if (report !== undefined && (!object(report) || !keys(report, ['counts', 'checks']) || !labels(report['counts']) || !labels(report['checks']) || report['counts'].some(k => (report['checks'] as string[]).includes(k)))) return invalid;
      if (work['required_settings'] !== undefined && (!Array.isArray(work['required_settings']) || work['required_settings'].some((k: unknown) => typeof k !== 'string' || !Array.isArray(v['settings']) || !v['settings'].some(s => object(s) && s['key'] === k)) || new Set(work['required_settings']).size !== work['required_settings'].length)) return invalid;
      seen.add(work['kind']);
    }
  }
  if (v['auth'] !== undefined) {
    const auth = v['auth'];
    if (!object(auth) || !keys(auth, ['kind', 'execution', 'runtime', 'entry']) || typeof auth['kind'] !== 'string' ||
        !auth['kind'].startsWith(`${v['name']}.`) || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(auth['kind']) ||
        auth['execution'] !== 'supervised' || !['node', 'python'].includes(auth['runtime'] as string) || !inside(auth['entry']) ||
        (Array.isArray(v['work']) && v['work'].some(work => object(work) && work['kind'] === auth['kind']))) return invalid;
  }
  if (v['raw_views'] !== undefined && (!Array.isArray(v['raw_views']) || v['raw_views'].some((view: unknown) => typeof view !== 'string' || !/^[a-z][a-z0-9_]*$/.test(view)) || new Set(v['raw_views']).size !== v['raw_views'].length)) return invalid;
  if (v['default_schedules'] !== undefined) {
    if (!Array.isArray(v['default_schedules'])) return invalid;
    for (const schedule of v['default_schedules']) {
      if (!object(schedule) || !keys(schedule, ['kind', 'target_kind', 'target_id', 'local_time']) ||
          typeof schedule['kind'] !== 'string' || !Array.isArray(v['work']) || !v['work'].some(work => object(work) && work['kind'] === schedule['kind']) ||
          typeof schedule['target_kind'] !== 'string' || !schedule['target_kind'].trim() || typeof schedule['target_id'] !== 'string' || !schedule['target_id'].trim() ||
          typeof schedule['local_time'] !== 'string' || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(schedule['local_time'])) return invalid;
    }
  }
  if (v['error_codes'] !== undefined && (!Array.isArray(v['error_codes']) || v['error_codes'].some((code: unknown) => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) || new Set(v['error_codes']).size !== v['error_codes'].length)) return invalid;
  return { ok: true, manifest: v as unknown as ExtensionManifest };
}
