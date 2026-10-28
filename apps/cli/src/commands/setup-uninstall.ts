import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { requireConfirmation } from 'second_brain';
import { homeResources } from '../config/resources.js';
import { probeOrbStack } from '../runtime/orbstack.js';
import { commandEnv, composeArgs, systemCommandRunner } from '../runtime/command-runner.js';
import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { configHome } from '../config/paths.js';
import { uninstallDaemon, DaemonControlError, type DaemonUninstallData } from '../daemon/control.js';
import { systemLaunchctl } from '../daemon/launchd.js';

export const setupUninstallCommand: CommandSpec<DaemonUninstallData & { postgres?: { down: boolean; volume: string; volume_removed: boolean } | null }> = {
  ns: 'setup', verb: 'uninstall', nsDescription: '설치하고, 다시 설정하고, 하네스를 연결합니다',
  usedFor: '데몬을 내리고 데몬 흔적을 지웁니다', required: [],
  examples: ['brain setup uninstall', 'brain setup uninstall --json'],
  output: '데몬 Label `label`, plist 경로 `plist_path`, 내린 여부 `unloaded`, plist 삭제 여부 `plist_removed`, 지운 파일 `removed`, PG 홈의 컨테이너·볼륨 보고 `postgres`(`down`, `volume`, `volume_removed`)',
  risk: 'destructive', hook: false, dryRun: false, standalone: true,
  options: [{ flags: '--delete-volume', description: '동의하면 PostgreSQL 볼륨도 지웁니다' }, { flags: '-y, --yes', description: '볼륨 삭제에 미리 동의합니다' }],
  async run(context: StandaloneCommandContext) {
    const home = configHome(context.env);
    const deleteVolume = context.options['deleteVolume'] === true;
    if (deleteVolume && context.options['yes'] !== true) return { ok: false as const, ...requireConfirmation({ ns: 'setup', verb: 'uninstall', args: { deleteVolume: true } }, '볼륨을 지우려면 `--delete-volume --yes`로 동의하세요')! };
    try {
      const data = await uninstallDaemon({ home: configHome(context.env), clock: context.clock, env: context.env,
        launchctl: systemLaunchctl({ env: context.env, uid: process.getuid?.() }), platform: process.platform });
      const text = [data.unloaded || data.plist_removed || data.removed.length > 0 ? '데몬 흔적을 지웠습니다' : '지울 데몬 흔적이 없습니다'];
      const hasCompose = await access(join(home, 'postgres', 'compose.yaml')).then(() => true, () => false);
      if (!hasCompose) return { ok: true as const, data: { ...data, postgres: null }, text };
      const orb = await probeOrbStack({ env: context.env, runner: context.runner });
      if (!orb.ok) return { ok: false as const, code: 'ORBSTACK_UNAVAILABLE', message: `데몬 정리는 끝났지만 컨테이너를 남겼습니다. ${orb.message}`, hint: orb.hint, exit: 2 as const };
      const down = await (context.runner ?? systemCommandRunner)({ command: 'docker', args: composeArgs(home, deleteVolume ? ['down', '-v'] : ['down']), env: commandEnv(context.env), timeoutMs: 120_000 });
      if (!down.ok) return { ok: false as const, code: 'DB_UNAVAILABLE', message: `데몬 정리는 끝났지만 PostgreSQL 컨테이너를 내리지 못했습니다\n${(down.stderr || down.stdout || down.message).slice(-2000)}`, exit: 2 as const };
      const volume = homeResources(home).volume;
      text.push(deleteVolume ? `PostgreSQL 컨테이너와 볼륨 ${volume}을 지웠습니다` : `PostgreSQL 볼륨 ${volume}은 남겼습니다. 지우려면 \`setup uninstall --delete-volume --yes\`를 실행하세요`);
      return { ok: true as const, data: { ...data, postgres: { down: true, volume, volume_removed: deleteVolume } }, text };
    } catch (error) {
      if (!(error instanceof DaemonControlError)) throw error;
      return { ok: false as const, code: error.code, message: error.message, ...(error.hint === undefined ? {} : { hint: error.hint }), exit: error.code === 'DAEMON_NOT_INSTALLED' ? 2 : 1 };
    }
  },
};
