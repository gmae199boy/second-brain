import { isoWithOffset, type ExtensionRecord, type ExtensionPythonEnvironment } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';
export function extensionData(name: string, r: ExtensionRecord | null, python: ExtensionPythonEnvironment | null = null) {
  return { name, installed: r !== null, version: r?.version ?? null, installed_at: r ? isoWithOffset(r.installedAt) : null,
    enabled: r?.enabled ?? false, python_environment: { status: python?.status ?? null, code: python?.code ?? null, checked_at: python ? isoWithOffset(python.checkedAt) : null }, connection: { status: r?.connectionStatus ?? null, checked_at: r?.connectionCheckedAt ? isoWithOffset(r.connectionCheckedAt) : null, code: r?.connectionCode ?? null, message: r?.connectionMessage ?? null } };
}
export const extStatusCommand: CommandSpec = {
  ns: 'ext', verb: 'status', nsDescription: '선택 확장을 관리합니다', usedFor: '확장의 설치와 연결 상태를 봅니다', required: ['name'], arguments: ['<name>'],
  examples: ['brain ext status testext --json'], output: '확장 이름과 설치·활성·연결 확인 사실을 반환합니다', risk: 'read', hook: false, dryRun: false,
  async run(context) {
    const r = await context.brain.ext.status({ name: String(context.args[0]) }); if (!r.ok) return r;
    return { ok: true, data: extensionData(r.name, r.extension, r.pythonEnvironment), text: [`확장 ${r.name}: ${r.extension ? `설치됨, 연결 ${r.extension.connectionStatus ?? '미확인'}` : '미설치'}, Python 환경 ${r.pythonEnvironment?.status ?? '미확인'}${r.pythonEnvironment?.code ? ` (${r.pythonEnvironment.code})` : ''}.`] };
  },
};
