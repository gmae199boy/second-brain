export const EXTENSION_CORE_VERSION = 1;
export function isExtensionName(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,30}$/.test(value) && !/^(core|brain|public|pg_)/.test(value);
}
export interface ExtensionManifest {
  name: string; version: string; core: 1; abi: 1; migrations: string;
  connection_check: { runtime: 'node'; entry: string };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).length === allowed.length && Object.keys(value).every(k => allowed.includes(k));
const inside = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && value.split('/').every(part => part !== '..' && part !== '.' && part !== '');
export function decodeExtensionManifest(text: string): { ok: true; manifest: ExtensionManifest } | { ok: false; code: 'EXTENSION_INVALID'; message: string } {
  const invalid = { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 manifest의 필드나 패키지 상대 경로가 올바르지 않습니다' };
  let v: unknown; try { v = JSON.parse(text); } catch { return invalid; }
  if (!object(v) || !keys(v, ['name', 'version', 'core', 'abi', 'migrations', 'connection_check'])) return invalid;
  const check = v['connection_check'];
  if (typeof v['name'] !== 'string' || !isExtensionName(v['name']) || typeof v['version'] !== 'string' || !v['version'].trim() || /[\u0000-\u001f\u007f-\u009f]/.test(v['version']) || v['core'] !== EXTENSION_CORE_VERSION || v['abi'] !== 1 || !inside(v['migrations']) || !object(check) || !keys(check, ['runtime', 'entry']) || check['runtime'] !== 'node' || !inside(check['entry'])) return invalid;
  return { ok: true, manifest: v as unknown as ExtensionManifest };
}
