import { isoWithOffset } from 'second_brain';
import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { configHome } from '../config/paths.js';
import { daemonDeadReason, daemonLiveness } from '../daemon/liveness.js';

export interface DaemonStatusData {
  alive: boolean;
  commit: string | null;
  pid: number | null;
  heartbeat_at: string | null;
  reason: string | null;
}

export const daemonStatusCommand: CommandSpec<DaemonStatusData> = {
  ns: 'daemon',
  verb: 'status',
  nsDescription: '상주하면서 밀린 일을 처리합니다',
  usedFor: '데몬의 생존 여부와 마지막 heartbeat를 봅니다',
  required: [],
  examples: ['brain daemon status', 'brain daemon status --json'],
  output: '생존 여부 `alive`, 주인 `pid`, 마지막 시각 `heartbeat_at`, 죽은 까닭 `reason`, 빌드 `commit`',
  risk: 'read',
  hook: false,
  dryRun: false,
  standalone: true,
  async run(context: StandaloneCommandContext) {
    const state = await daemonLiveness({ home: configHome(context.env), clock: context.clock });
    const heartbeat = state.heartbeatAt === null ? null : isoWithOffset(state.heartbeatAt);
    return {
      ok: true as const,
      data: { commit: state.commit, alive: state.alive, pid: state.pid, heartbeat_at: heartbeat, reason: state.alive ? null : state.reason },
      text: [`빌드 ${state.commit?.slice(0, 7) ?? '알 수 없음'}, 데몬이 ${state.alive ? '살아 있습니다' : '살아 있지 않습니다'}, 주인 pid ${state.pid === null ? '없음' : String(state.pid)}${state.alive ? '' : `, 까닭 ${daemonDeadReason(state.reason)}`}${heartbeat === null ? '' : `, 마지막 heartbeat ${heartbeat}`}`],
    };
  },
};
