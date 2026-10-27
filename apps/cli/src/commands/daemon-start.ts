import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { startDaemon, DaemonControlError, type DaemonStartData } from '../daemon/control.js';
import { systemLaunchctl } from '../daemon/launchd.js';

export const daemonStartCommand: CommandSpec<DaemonStartData> = {
  ns: 'daemon', verb: 'start', nsDescription: '상주하면서 밀린 일을 처리합니다',
  usedFor: '등록된 데몬을 다시 올립니다', required: [],
  examples: ['brain daemon start', 'brain daemon start --json'],
  output: '재적재 상태 `status`, 등록 파일 `plist_path`',
  risk: 'write', hook: false, dryRun: false, standalone: true,
  async run(context: StandaloneCommandContext) {
    try {
      const data = await startDaemon({ env: context.env,
        launchctl: systemLaunchctl({ env: context.env, uid: process.getuid?.() }), platform: process.platform });
      return { ok: true as const, data, text: [data.status === 'started' ? '데몬을 다시 올렸습니다' : data.status === 'already-loaded' ? '데몬이 이미 올라 있습니다' : '이 운영체제에는 launchd가 없습니다'] };
    } catch (error) {
      if (!(error instanceof DaemonControlError)) throw error;
      return { ok: false as const, code: error.code, message: error.message, exit: error.code === 'DAEMON_NOT_INSTALLED' ? 2 : 1 };
    }
  },
};
