import type { CommandSpec } from '../dispatch.js';
import { extensionData, extensionProgressText } from './ext-status.js';
export const extInstallCommand: CommandSpec = {
  ns: 'ext', verb: 'install', nsDescription: '선택 확장을 관리합니다', usedFor: '확장을 설치하고 연결을 확인합니다', required: ['name'], arguments: ['<name>'],
  examples: ['brain ext install testext --json'], output: '확장 이름과 설치·활성·연결 확인 사실을 반환합니다', risk: 'write', writes: true, drain: false, hook: false, dryRun: false,
  async run(context) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    let r;
    try { r = await context.brain.ext.install({ name: String(context.args[0]), signal: controller.signal }); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    if (!r.ok) {
      if ('status' in r && r.status) return { ...r, data: extensionData(r.status.name, r.status.extension, r.status.pythonEnvironment, r.status.progress), text: extensionProgressText(r.status.progress) };
      return r;
    }
    return { ok: true, data: extensionData(r.name, r.extension, r.pythonEnvironment, r.progress), text: [`확장 ${r.name}을 설치하고 연결을 확인했습니다.`, ...extensionProgressText(r.progress)] };
  },
};
