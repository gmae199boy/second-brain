import type { CommandSpec } from '../dispatch.js';
import { publicExtensionData, extensionProgressText } from './ext-status.js';
export const extInstallCommand: CommandSpec = {
  ns: 'ext', verb: 'install', nsDescription: '선택 확장을 관리합니다', usedFor: '확장을 설치하고 연결을 확인합니다', required: [], arguments: ['[name]'], options: [{ flags: '--package <path>', description: '확장 패키지 경로' }],
  examples: ['brain ext install testext --json'], output: '확장 이름과 설치·활성·연결 확인 사실을 반환합니다', risk: 'write', writes: true, drain: false, hook: false, dryRun: false,
  async run(context) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    let r;
    try { r = await context.brain.ext.install({ ...(context.args[0] === undefined ? {} : { name: context.args[0] }), ...(typeof context.options.package === 'string' ? { packagePath: context.options.package } : {}), signal: controller.signal }); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    if (!r.ok) {
      if ('status' in r && r.status) {
        const status = await context.brain.ext.status({ name: r.status.name }); if (!status.ok) return status;
        return { ...r, data: publicExtensionData(status.status), text: extensionProgressText(r.status.progress) };
      }
      return r;
    }
    const status = await context.brain.ext.status({ name: r.name }); if (!status.ok) return status;
    return { ok: true, data: publicExtensionData(status.status), text: [`확장 ${r.name}을 설치하고 연결을 확인했습니다.`, ...extensionProgressText(r.progress)] };
  },
};
