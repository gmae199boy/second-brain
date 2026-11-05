import { maskOutputValue } from '../output/mask.js';
import { extensionSettingDefinitions, type ExtensionSettingDeclaration } from './snapshot.js';
export const EXTENSION_CORE_VERSION = 1;
export function isExtensionName(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,30}$/.test(value) && !/^(core|brain|public|pg_)/.test(value);
}
export interface ExtensionManifest {
  name: string; version: string; core: 1; abi: 1; migrations: string;
  files?: string[]; core_compat?: { min: string; max_exclusive: string }; plugin_version?: string;
  connection_check: { runtime: 'node' | 'python'; entry: string };
  settings?: ExtensionSettingDeclaration[];
  error_codes?: string[];
  work?: { kind: string; execution: 'supervised'; runtime: 'node' | 'python'; entry: string; manual?: string; followup?: string; missed?: 'latest' | 'coalesce' | 'skip'; public_report?: { counts: string[]; checks: string[] }; required_settings?: string[] }[];
  auth?: { kind: string; execution: 'supervised'; runtime: 'node' | 'python'; entry: string };
  default_schedules?: { kind: string; target_kind: string; target_id: string; key?: string; local_time?: string; cron?: string; time_zone?: string }[];
  raw_views?: string[];
  commands?: ExtensionCommandDeclaration[];
}
export interface ExtensionCommandDeclaration {
  name: string; runtime: 'node' | 'python'; entry: string; description: string;
  examples?: string[]; input_schema: Record<string, unknown>; output_schema: Record<string, unknown>;
  timeout_ms: number; risk: 'read';
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function hasAsyncSchema(value: unknown): boolean {
  if (!object(value)) return false;
  if (value['$async'] === true) return true;
  for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']) {
    const map = value[key]; if (object(map) && Object.values(map).some(hasAsyncSchema)) return true;
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const schemas = value[key]; if (Array.isArray(schemas) && schemas.some(hasAsyncSchema)) return true;
  }
  return ['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'].some(key => hasAsyncSchema(value[key]));
}
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).length === allowed.length && Object.keys(value).every(k => allowed.includes(k));
/** Lexicographic Unicode code point order, shared with Python's string order. */
export function comparePackagePaths(a: string, b: string): number {
  const left = Array.from(a, char => char.codePointAt(0)!), right = Array.from(b, char => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  return left.length - right.length;
}
const inside = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && value.split('/').every(part => part !== '..' && part !== '.' && part !== '');
function decodeManifestUnchecked(text: string, validateSchema?: (schema: Record<string, unknown>) => boolean): { ok: true; manifest: ExtensionManifest } | { ok: false; code: 'EXTENSION_INVALID'; message: string } {
  const invalid = { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 manifest의 필드나 패키지 상대 경로가 올바르지 않습니다' };
  let v: unknown; try { v = JSON.parse(text); } catch { return invalid; }
  if (!object(v) || !['name', 'version', 'core', 'abi', 'migrations', 'connection_check'].every(k => Object.hasOwn(v, k)) || !Object.keys(v).every(k => ['name', 'version', 'core', 'abi', 'migrations', 'connection_check', 'settings', 'error_codes', 'work', 'auth', 'default_schedules', 'raw_views', 'commands', 'files', 'core_compat', 'plugin_version'].includes(k))) return invalid;
  const check = v['connection_check'];
  if (typeof v['name'] !== 'string' || !isExtensionName(v['name']) || typeof v['version'] !== 'string' || !v['version'].trim() || /[\u0000-\u001f\u007f-\u009f]/.test(v['version']) || v['core'] !== EXTENSION_CORE_VERSION || v['abi'] !== 1 || !inside(v['migrations']) || !object(check) || !keys(check, ['runtime', 'entry']) || !['node', 'python'].includes(check['runtime'] as string) || !inside(check['entry'])) return invalid;
  const semver = (x: unknown): x is string => typeof x === 'string' && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(x);
  const packageFields = [v['files'], v['core_compat'], v['plugin_version']];
  if (packageFields.some(x => x !== undefined)) {
    const files = v['files'], compat = v['core_compat'];
    if (!Array.isArray(files) || !files.length || files.some(x => !inside(x) || x === 'digest') || !files.includes('manifest.json') || files.some((x, i) => i > 0 && comparePackagePaths(files[i - 1], x) >= 0) ||
        !object(compat) || !keys(compat, ['min', 'max_exclusive']) || !semver(compat['min']) || !semver(compat['max_exclusive']) ||
        !semver(v['version']) || !semver(v['plugin_version'])) return invalid;
    const compare = (a: string, b: string) => { const x = a.split('.').map(BigInt), y = b.split('.').map(BigInt); for (let i = 0; i < 3; i++) { if (x[i]! < y[i]!) return -1; if (x[i]! > y[i]!) return 1; } return 0; };
    if (compare(compat['min'], compat['max_exclusive']) >= 0) return invalid;
  }
  if (v['commands'] !== undefined) {
    if (!Array.isArray(v['commands']) || (v['commands'].length > 0 && (v['name'].includes('_') || ['install', 'run', 'login', 'list', 'status', 'enable', 'disable'].includes(v['name'])))) return invalid;
    const seen = new Set<string>();
    for (const command of v['commands']) {
      if (!object(command) || !['name', 'runtime', 'entry', 'description', 'input_schema', 'output_schema', 'timeout_ms', 'risk'].every(k => Object.hasOwn(command, k)) ||
          !Object.keys(command).every(k => ['name', 'runtime', 'entry', 'description', 'examples', 'input_schema', 'output_schema', 'timeout_ms', 'risk'].includes(k)) ||
          typeof command['name'] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(command['name']) || seen.has(command['name']) ||
          !['node', 'python'].includes(command['runtime'] as string) || !inside(command['entry']) ||
          typeof command['description'] !== 'string' || !command['description'].trim() ||
          (command['examples'] !== undefined && (!Array.isArray(command['examples']) || command['examples'].some((x: unknown) => typeof x !== 'string' || !x.trim()))) ||
          !object(command['input_schema']) || command['input_schema']['type'] !== 'object' || JSON.stringify(maskOutputValue(command['input_schema'])) !== JSON.stringify(command['input_schema']) || !object(command['output_schema']) || hasAsyncSchema(command['input_schema']) || hasAsyncSchema(command['output_schema']) ||
          !Number.isSafeInteger(command['timeout_ms']) || ((command['timeout_ms'] as number) < 1 || (command['timeout_ms'] as number) > 2147483647) || command['risk'] !== 'read') return invalid;
      try { if (!validateSchema || validateSchema(command['input_schema']) !== true || validateSchema(command['output_schema']) !== true) return invalid; } catch { return invalid; }
      seen.add(command['name']);
    }
  }
  if (v['settings'] !== undefined) {
    if (!Array.isArray(v['settings'])) return invalid;
    const seen = new Set<string>();
    for (const setting of v['settings']) {
      if (!object(setting) || !Object.keys(setting).every(k => ['key', 'type', 'required', 'secret', 'default', 'machine', 'scope'].includes(k)) ||
          typeof setting['key'] !== 'string' || !setting['key'].startsWith(`${v['name']}.`) || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(setting['key']) || seen.has(setting['key']) ||
          !['string', 'number', 'boolean'].includes(setting['type'] as string) || !Array.isArray(setting['required']) ||
          setting['required'].some((stage: unknown) => !['connect', 'auth', 'work'].includes(stage as string)) || new Set(setting['required']).size !== setting['required'].length ||
          (setting['scope'] !== undefined && !['user', 'global'].includes(setting['scope'] as string)) ||
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
      if (!object(work) || !['kind', 'execution', 'runtime', 'entry'].every(k => Object.hasOwn(work, k)) || !Object.keys(work).every(k => ['kind', 'execution', 'runtime', 'entry', 'manual', 'followup', 'public_report', 'required_settings', 'missed'].includes(k)) || typeof work['kind'] !== 'string' ||
          !work['kind'].startsWith(`${v['name']}.`) || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(work['kind']) || seen.has(work['kind']) ||
          work['execution'] !== 'supervised' || !['node', 'python'].includes(work['runtime'] as string) || !inside(work['entry'])) return invalid;
      if (work['missed'] !== undefined && !['latest', 'coalesce', 'skip'].includes(work['missed'] as string)) return invalid;
      if (work['manual'] !== undefined && (typeof work['manual'] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(work['manual']) || aliases.has(work['manual']))) return invalid;
      if (typeof work['manual'] === 'string') aliases.add(work['manual']);
      const report = work['public_report'];
      const labels = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v)) && new Set(x).size === x.length;
      if (report !== undefined && (!object(report) || !keys(report, ['counts', 'checks']) || !labels(report['counts']) || !labels(report['checks']) || report['counts'].some(k => (report['checks'] as string[]).includes(k)))) return invalid;
      if (work['required_settings'] !== undefined && (!Array.isArray(work['required_settings']) || work['required_settings'].some((k: unknown) => typeof k !== 'string' || !Array.isArray(v['settings']) || !v['settings'].some(s => object(s) && s['key'] === k)) || new Set(work['required_settings']).size !== work['required_settings'].length)) return invalid;
      seen.add(work['kind']);
    }
    for (const work of v['work']) {
      if (!object(work) || work['followup'] === undefined) continue;
      const target = v['work'].find(candidate => object(candidate) && candidate['kind'] === work['followup']);
      if (typeof work['followup'] !== 'string' || !object(target) || target === work || target['followup'] !== undefined) return invalid;
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
    const seen = new Set<string>();
    for (const schedule of v['default_schedules']) {
      if (!object(schedule) || !['kind','target_kind','target_id'].every(k => Object.hasOwn(schedule,k)) || !Object.keys(schedule).every(k => ['kind','target_kind','target_id','key','local_time','cron','time_zone'].includes(k)) ||
          typeof schedule['kind'] !== 'string' || !Array.isArray(v['work']) || !v['work'].some(work => object(work) && work['kind'] === schedule['kind']) ||
          typeof schedule['target_kind'] !== 'string' || !schedule['target_kind'].trim() || typeof schedule['target_id'] !== 'string' || !schedule['target_id'].trim() ||
          (schedule['key'] !== undefined && (typeof schedule['key'] !== 'string' || !schedule['key'].trim() || /[\u0000-\u001f\u007f-\u009f]/.test(schedule['key']))) ||
          (schedule['local_time'] === undefined) === (schedule['cron'] === undefined) ||
          (schedule['local_time'] !== undefined && (typeof schedule['local_time'] !== 'string' || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(schedule['local_time']) || schedule['time_zone'] !== undefined)) ||
          (schedule['cron'] !== undefined && (typeof schedule['cron'] !== 'string' || !/^[\d*,/A-Za-z-]+(?:\s+[\d*,/A-Za-z-]+){4}$/.test(schedule['cron'].trim()))) ||
          (schedule['time_zone'] !== undefined && (typeof schedule['time_zone'] !== 'string' || !schedule['time_zone'].trim()))) return invalid;
      const key = typeof schedule['key'] === 'string' ? schedule['key'] : `${schedule['kind']}:${schedule['target_kind']}:${schedule['target_id']}`;
      if (seen.has(key)) return invalid; seen.add(key);
    }
  }
  if (v['error_codes'] !== undefined && (!Array.isArray(v['error_codes']) || v['error_codes'].some((code: unknown) => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) || new Set(v['error_codes']).size !== v['error_codes'].length)) return invalid;
  return { ok: true, manifest: v as unknown as ExtensionManifest };
}

export function decodeExtensionManifest(text: string, validateSchema?: (schema: Record<string, unknown>) => boolean): ReturnType<typeof decodeManifestUnchecked> {
  try { return decodeManifestUnchecked(text, validateSchema); } catch { return { ok: false, code: 'EXTENSION_INVALID', message: '확장 manifest의 필드나 패키지 상대 경로가 올바르지 않습니다' }; }
}
