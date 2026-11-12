import { readScopedSettings } from '../settings/index.js';
import type { SettingsStore } from '../ports/store.js';
import { decodeSettingsSnapshot, PROCESS_ABI_SNAPSHOT_MAX_BYTES } from '../process-abi/codec.js';
import { utf8Bytes } from '../domain/sha256.js';

export type ExtensionStage = 'connect' | 'auth' | 'work';
export interface ExtensionSettingDeclaration {
  key: string;
  type: 'string' | 'number' | 'boolean';
  required: readonly ExtensionStage[];
  scope?: 'user' | 'global';
  secret?: boolean;
  machine?: 'tokenstore';
  default?: string;
  enum?: readonly string[];
}
export type SnapshotResult = { ok: true; serialized: string } | { ok: false; code: 'EXTENSION_CONFIG_INVALID'; retryable: false; message: string };
/** 일관된 설정 조회와 한 번 읽은 환경 값으로 snapshot을 만든다. */
export function createExtensionSnapshot(input: {
  extension: string; userId: string; stage: ExtensionStage; declarations: readonly ExtensionSettingDeclaration[];
  requiredKeys?: readonly string[]; settings: Readonly<Record<string, string>>; secrets: Readonly<Record<string, string>>; machine?: Readonly<Record<string, string>>;
}): SnapshotResult {
  const invalid = (): SnapshotResult => ({ ok: false, code: 'EXTENSION_CONFIG_INVALID', retryable: false, message: '확장 설정을 확인하세요' });
  const values: Record<string, string | number | boolean> = Object.create(null);
  const types: Record<string, 'string' | 'number' | 'boolean'> = Object.create(null);
  for (const declaration of input.declarations) {
    if (!declaration.key.startsWith(`${input.extension}.`) || Object.hasOwn(types, declaration.key) ||
        (declaration.secret && declaration.type !== 'string')) return invalid();
    types[declaration.key] = declaration.type;
    let raw = declaration.machine ? input.machine?.[declaration.machine] : Object.hasOwn(input.settings, declaration.key) ? input.settings[declaration.key] : declaration.default;
    if (raw === undefined) { if (input.requiredKeys ? input.requiredKeys.includes(declaration.key) : declaration.required.includes(input.stage)) return invalid(); else continue; }
    if (declaration.secret) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return invalid();
      raw = Object.hasOwn(input.secrets, raw) ? input.secrets[raw] : undefined;
      if (raw === undefined || raw === '') return invalid();
    }
    if (declaration.enum && !declaration.enum.includes(raw)) return invalid();
    if (declaration.type === 'number') {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) return invalid();
      const number = Number(raw); if (!Number.isFinite(number)) return invalid();
      values[declaration.key] = number;
    } else if (declaration.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') return invalid();
      values[declaration.key] = raw === 'true';
    } else values[declaration.key] = raw;
  }
  const serialized = JSON.stringify({ version: 1, extension: input.extension, user_id: input.userId, values });
  if (utf8Bytes(serialized).length > PROCESS_ABI_SNAPSHOT_MAX_BYTES || !decodeSettingsSnapshot(serialized, input.extension, types).ok) return invalid();
  return { ok: true, serialized };
}

/** 기존 scope 조회와 비밀 읽기 순서를 유지하여 소비자용 snapshot을 취득한다. */
export async function acquireExtensionSnapshot(input: {
  extension: string; userId: string; stage: ExtensionStage; declarations: readonly ExtensionSettingDeclaration[];
  requiredKeys?: readonly string[]; getSettings?: SettingsStore['getSettings'];
  readSecrets?: () => Promise<Readonly<Record<string, string>>>;
  machineValues?: () => Readonly<Record<string, string>>;
}) {
  const invalid = () => ({ ok: false as const, kind: 'config' as const, result: { ok: false as const, code: 'EXTENSION_CONFIG_INVALID' as const, retryable: false as const, message: '확장 설정을 확인하세요' } });
  if (input.declarations.length && (!input.getSettings || !input.readSecrets)) return invalid();
  const read = input.declarations.length
    ? await readScopedSettings({ getSettings: input.getSettings! }, input.userId, input.declarations)
    : { ok: true as const, settings: [] };
  if (!read.ok) return { ok: false as const, kind: 'settings' as const, result: read };
  let secrets: Readonly<Record<string, string>> = {};
  try { if (input.declarations.some(d => d.secret)) secrets = await input.readSecrets!(); }
  catch { return invalid(); }
  const snapshot = createExtensionSnapshot({ ...input, settings: Object.fromEntries(read.settings.map(s => [s.key, s.value])), secrets, machine: input.machineValues?.() ?? {} });
  return snapshot.ok ? snapshot : { ok: false as const, kind: 'snapshot' as const, result: snapshot };
}

/** 비밀의 참조만 반환하는 설정 CLI 정의를 만든다. */
export function extensionSettingDefinitions(declarations: readonly ExtensionSettingDeclaration[]): import('../settings/index.js').SettingDefinition[] {
  return declarations.filter(declaration => !declaration.machine).map(declaration => ({
    key: declaration.key,
    scope: declaration.scope ?? 'user',
    ...(declaration.default === undefined ? {} : { defaultValue: declaration.default }),
    normalize(raw: string) {
      if (declaration.enum && !declaration.enum.includes(raw)) return { ok: false as const, message: '확장 설정의 허용 값이 아닙니다' };
      const valid = declaration.secret ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) : declaration.type === 'boolean' ? raw === 'true' || raw === 'false' : declaration.type === 'number' ? /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) && Number.isFinite(Number(raw)) : true;
      return valid ? { ok: true as const, value: raw } : { ok: false as const, message: '확장 설정 값이 올바르지 않습니다' };
    },
  }));
}
