import type { ExtensionInstallProgress } from './install-progress.js';
import type { ExtensionPublicStatus, ExtensionRecord, ExtensionPythonEnvironment } from '../ports/store.js';

/** 공개 필드만 복사하여 원문 진단과 내부 식별자를 제외한다. */
export function extensionPublicProjection(name: string, extension: ExtensionRecord | null, progress: ExtensionInstallProgress | null, heldScheduleCount: number, interruptedWorkCount: number, python: ExtensionPythonEnvironment | null = null): ExtensionPublicStatus {
  const fixedCode = (code: string | null) => code !== null && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
  const stages = progress?.stages ?? {};
  return {
    name, installed: extension !== null, version: extension?.version ?? null, installedAt: extension?.installedAt ?? null, pythonEnvironment: python ? { ...python, code: fixedCode(python.code) } : null, authWorkId: progress?.authWorkId ?? null, scheduleIds: progress?.scheduleIds ?? [], disabledScheduleKeys: progress?.disabledScheduleKeys ?? [], enabled: extension?.enabled ?? null,
    journalPresent: progress !== null, login: stages.login ?? null,
    connection: { status: extension?.connectionStatus ?? null, code: fixedCode(extension?.connectionCode ?? null), checkedAt: extension?.connectionCheckedAt ?? null },
    schedule: stages.schedule ?? null, heldScheduleCount, interruptedWorkCount,
    installResult: progress?.result ?? null, failedStage: progress?.failedStage ?? null,
    lastFailure: progress?.lastFailure ?? null, stages,
  };
}
