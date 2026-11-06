/** journal에는 고정 코드, 불투명 식별자와 시각만 저장한다. */
export const installStages = ['package', 'environment', 'migration', 'role', 'configuration', 'login', 'connection', 'schedule'] as const;
export type InstallStage = typeof installStages[number];
export type InstallResult = 'installed' | 'failed' | 'cancelled' | 'login_required' | 'connection_failed' | 'scheduler_unavailable';
export interface InstallStageProgress { status: 'succeeded' | 'failed' | 'skipped' | 'pending'; code: string | null; at: string }
export interface ExtensionInstallProgress {
  name: string;
  /** 패키지 내용의 SHA-256이며 경로나 자격 증명은 저장하지 않는다. */
  packageDigest: string;
  result: InstallResult | null;
  failedStage: InstallStage | null;
  lastFailure: { stage: InstallStage; code: string; at: string } | null;
  stages: Partial<Record<InstallStage, InstallStageProgress>>;
  authWorkId: string | null;
  scheduleIds: string[];
  disabledScheduleKeys?: string[];
  transition?: { owner: string; registered: boolean };
  replacement?: { owner: string; fromVersion: string; at: string };
}
export interface StoredExtensionInstallProgress { revision: number; progress: ExtensionInstallProgress }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join(',') === expected.sort().join(',');
const code = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const stage = (value: unknown): value is InstallStage => typeof value === 'string' && (installStages as readonly string[]).includes(value);
/** 예상하지 않은 속성과 임의 진단 문구를 거부한다. */
export function validInstallProgress(value: unknown): value is ExtensionInstallProgress {
  if (!object(value)) return false;
  const expected = ['name', 'packageDigest', 'result', 'failedStage', 'lastFailure', 'stages', 'authWorkId', 'scheduleIds'];
  if (Object.hasOwn(value, 'disabledScheduleKeys')) expected.push('disabledScheduleKeys');
  if (Object.hasOwn(value, 'transition')) expected.push('transition');
  if (Object.hasOwn(value, 'replacement')) expected.push('replacement');
  if (!keys(value, expected)) return false;
  if (Object.hasOwn(value, 'replacement') && (!object(value.replacement) || !keys(value.replacement, ['owner', 'fromVersion', 'at']) || !uuid(value.replacement.owner) || typeof value.replacement.fromVersion !== 'string' || !value.replacement.fromVersion.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value.replacement.fromVersion) || !timestamp(value.replacement.at))) return false;
  if (value.transition !== undefined && (!object(value.transition) || !keys(value.transition, ['owner', 'registered']) || !uuid(value.transition.owner) || typeof value.transition.registered !== 'boolean')) return false;
  if (value.disabledScheduleKeys !== undefined && (!Array.isArray(value.disabledScheduleKeys) || value.disabledScheduleKeys.some(key => typeof key !== 'string' || !key.trim() || key.includes('\u0000')) || new Set(value.disabledScheduleKeys).size !== value.disabledScheduleKeys.length)) return false;
  if (typeof value.name !== 'string' || (!/^[a-z][a-z0-9_]{0,30}$/.test(value.name) || /^(core|brain|public|pg_)/.test(value.name)) || typeof value.packageDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.packageDigest)) return false;
  if (value.result !== null && !['installed', 'failed', 'cancelled', 'login_required', 'connection_failed', 'scheduler_unavailable'].includes(value.result as string)) return false;
  if (value.failedStage !== null && !stage(value.failedStage)) return false;
  if (value.lastFailure !== null && (!object(value.lastFailure) || !keys(value.lastFailure, ['stage', 'code', 'at']) || !stage(value.lastFailure.stage) || !code(value.lastFailure.code) || !timestamp(value.lastFailure.at))) return false;
  if (!object(value.stages) || Object.entries(value.stages).some(([name, entry]) => !stage(name) || !object(entry) || !keys(entry, ['status', 'code', 'at']) || !['succeeded', 'failed', 'skipped', 'pending'].includes(entry.status as string) || !(entry.code === null || code(entry.code)) || !timestamp(entry.at))) return false;
  return (value.authWorkId === null || uuid(value.authWorkId)) && Array.isArray(value.scheduleIds) && value.scheduleIds.every(uuid) && new Set(value.scheduleIds).size === value.scheduleIds.length;
}
