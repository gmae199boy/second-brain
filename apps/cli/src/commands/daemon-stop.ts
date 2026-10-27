import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { configHome } from '../config/paths.js';
import { stopDaemon, DaemonControlError, type DaemonStopData } from '../daemon/control.js';
import { systemLaunchctl } from '../daemon/launchd.js';

export const daemonStopCommand: CommandSpec<DaemonStopData> = {
  ns: 'daemon', verb: 'stop', nsDescription: '상주하면서 밀린 일을 처리합니다',
  usedFor: '데몬을 잠시 멈춥니다', required: [],
  examples: ['brain daemon stop', 'brain daemon stop --json'],
  output: '내린 여부 `unloaded`, 신호를 받은 주인 `signalled_pid`, 생존 여부 `alive`',
  risk: 'write', hook: false, dryRun: false, standalone: true,
  async run(context: StandaloneCommandContext) {
    try {
      const data = await stopDaemon({ home: configHome(context.env), clock: context.clock, env: context.env,
        launchctl: systemLaunchctl({ env: context.env, uid: process.getuid?.() }), platform: process.platform });
      return { ok: true as const, data, text: ['데몬을 멈췄습니다'] };
    } catch (error) {
      if (!(error instanceof DaemonControlError)) throw error;
      return { ok: false as const, code: error.code, message: error.message, exit: error.code === 'DAEMON_NOT_INSTALLED' ? 2 : 1 };
    }
  },
};
