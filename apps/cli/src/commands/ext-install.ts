import type { CommandSpec } from '../dispatch.js';
import { extensionData } from './ext-status.js';
export const extInstallCommand: CommandSpec = {
  ns: 'ext', verb: 'install', nsDescription: '선택 확장을 관리합니다', usedFor: '확장을 설치하고 연결을 확인합니다', required: ['name'], arguments: ['<name>'],
  examples: ['brain ext install testext --json'], output: '확장 이름과 설치·활성·연결 확인 사실을 반환합니다', risk: 'write', writes: true, drain: false, hook: false, dryRun: false,
  async run(context) {
    const r = await context.brain.ext.install({ name: String(context.args[0]) }); if (!r.ok) return r;
    return { ok: true, data: extensionData(r.name, r.extension, r.pythonEnvironment), text: [`확장 ${r.name}을 설치하고 연결을 확인했습니다.`] };
  },
};
