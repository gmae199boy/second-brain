import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { configHome } from '../config/paths.js';
import { uninstallDaemon, DaemonControlError, type DaemonUninstallData } from '../daemon/control.js';
import { systemLaunchctl } from '../daemon/launchd.js';

export const setupUninstallCommand: CommandSpec<DaemonUninstallData> = {
  ns: 'setup', verb: 'uninstall', nsDescription: '설치하고, 다시 설정하고, 하네스를 연결합니다',
  usedFor: '데몬을 내리고 데몬 흔적을 지웁니다', required: [],
  examples: ['brain setup uninstall', 'brain setup uninstall --json'],
  output: '데몬 Label `label`, plist 경로 `plist_path`, 내린 여부 `unloaded`, plist 삭제 여부 `plist_removed`, 지운 파일 `removed`',
  risk: 'destructive', hook: false, dryRun: false, standalone: true,
  async run(context: StandaloneCommandContext) {
    try {
      const data = await uninstallDaemon({ home: configHome(context.env), clock: context.clock, env: context.env,
        launchctl: systemLaunchctl({ env: context.env, uid: process.getuid?.() }), platform: process.platform });
      return { ok: true as const, data, text: [data.unloaded || data.plist_removed || data.removed.length > 0 ? '데몬 흔적을 지웠습니다' : '지울 데몬 흔적이 없습니다'] };
    } catch (error) {
      if (!(error instanceof DaemonControlError)) throw error;
      return { ok: false as const, code: error.code, message: error.message, ...(error.hint === undefined ? {} : { hint: error.hint }), exit: error.code === 'DAEMON_NOT_INSTALLED' ? 2 : 1 };
    }
  },
};
