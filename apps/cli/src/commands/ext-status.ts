import { isoWithOffset, type ExtensionRecord, type ExtensionPythonEnvironment, type ExtensionInstallProgress, type ExtensionPublicStatus, installStages } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';
export function extensionData(name: string, r: ExtensionRecord | null, python: ExtensionPythonEnvironment | null = null, progress: ExtensionInstallProgress | null = null) {
  return { name, installed: r !== null, version: r?.version ?? null, installed_at: r ? isoWithOffset(r.installedAt) : null,
    enabled: r?.enabled ?? false, replacement_required: !!progress?.replacement, install: progress ? { result: progress.result, failed_stage: progress.failedStage, last_failure: progress.lastFailure, stages: progress.stages, auth_work_id: progress.authWorkId, schedule_ids: progress.scheduleIds, disabled_schedule_keys: progress.disabledScheduleKeys ?? [] } : null, python_environment: { status: python?.status ?? null, code: python?.code ?? null, checked_at: python ? isoWithOffset(python.checkedAt) : null }, connection: { status: r?.connectionStatus ?? null, checked_at: r?.connectionCheckedAt ? isoWithOffset(r.connectionCheckedAt) : null, code: r?.connectionCode ?? null, message: null } };
}
export function extensionProgressText(progress: ExtensionInstallProgress | null): string[] {
  if (!progress) return ['설치 진행 기록이 없습니다.'];
  return [`설치 결과: ${progress.result ?? '진행 중'}${progress.failedStage ? `, 실패 단계: ${progress.failedStage}` : ''}.`,
    ...(progress.disabledScheduleKeys?.length ? [`비활성화된 예약 키: ${progress.disabledScheduleKeys.join(', ')}.`] : []),
    ...installStages.map(stage => { const entry = progress.stages[stage]; return `설치 단계 ${stage}: ${entry?.status ?? '미완료'}${entry?.code ? ` (${entry.code})` : ''}.`; })];
}
export function publicExtensionData(status: ExtensionPublicStatus) {
  return { name: status.name, installed: status.installed, version: status.version, package_digest: status.packageDigest, plugin_version: status.pluginVersion, installed_at: status.installedAt ? isoWithOffset(status.installedAt) : null, enabled: status.enabled ?? false,
    python_environment: { status: status.pythonEnvironment?.status ?? null, code: status.pythonEnvironment?.code ?? null, checked_at: status.pythonEnvironment ? isoWithOffset(status.pythonEnvironment.checkedAt) : null },
    replacement_required: status.replacementRequired, journal_present: status.journalPresent, login: status.login, connection: { status: status.connection.status,
      code: status.connection.code, message: status.connection.status === 'failed' ? '확장 실행에 실패했습니다' : null, checked_at: status.connection.checkedAt ? isoWithOffset(status.connection.checkedAt) : null },
    schedule: status.schedule, held_schedule_count: status.heldScheduleCount, interrupted_work_count: status.interruptedWorkCount, quiesced: status.quiesced,
    install: status.journalPresent ? { result: status.installResult, failed_stage: status.failedStage, last_failure: status.lastFailure, stages: status.stages, auth_work_id: status.authWorkId, schedule_ids: status.scheduleIds, disabled_schedule_keys: status.disabledScheduleKeys } : null };
}
export function publicExtensionText(status: ExtensionPublicStatus): string[] {
  return [`확장 ${status.name}: ${status.installed ? (status.enabled ? '활성' : '비활성') : '미설치'}, 연결 ${status.connection.status ?? '미확인'}, 중단 일감 ${status.interruptedWorkCount}건, 보류 예약 ${status.heldScheduleCount}건.`,
    `설치 결과: ${status.installResult ?? (status.journalPresent ? '진행 중' : '미확인')}.`,
    ...(status.replacementRequired ? ['현재 형식의 호환 패키지를 `ext install --package`로 설치해야 합니다.'] : []),
    ...(status.quiesced ? ['확장이 정지되어 있습니다. 설치 복구가 필요할 수 있습니다.'] : []),
    ...(status.disabledScheduleKeys.length ? [`비활성화된 예약 키: ${status.disabledScheduleKeys.join(', ')}.`] : []),
    ...installStages.map(stage => { const entry = status.stages[stage]; return `설치 단계 ${stage}: ${entry?.status ?? '미완료'}${entry?.code ? ` (${entry.code})` : ''}.`; })];
}
export const extStatusCommand: CommandSpec = {
  ns: 'ext', verb: 'status', nsDescription: '선택 확장을 관리합니다', usedFor: '확장의 설치와 연결 상태를 봅니다', required: ['name'], arguments: ['<name>'],
  examples: ['brain ext status testext --json'], output: '확장 이름과 설치·활성·연결 확인 사실을 반환합니다', risk: 'read', hook: false, dryRun: false,
  async run(context) {
    const r = await context.brain.ext.status({ name: String(context.args[0]) }); if (!r.ok) return r;
    return { ok: true, data: publicExtensionData(r.status), text: publicExtensionText(r.status) };
  },
};
