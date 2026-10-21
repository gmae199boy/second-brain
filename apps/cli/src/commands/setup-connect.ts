import type { Connector } from 'second_brain';
import { configHome } from '../config/paths.js';
import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { inspectShim } from '../doctor/checks.js';
import { installedPluginRoot, connectionLines } from '../connectors/plugin.js';

/**
 * `brain setup connect <harness>`: register the shim with one harness. It is
 * the whole of what the installer's harness step does, as a command, so a
 * harness installed after the install does not mean re-running the installer.
 *
 * Standalone: writing a harness's own configuration needs neither the
 * configuration folder's contents nor the database, and a brain whose database
 * file is missing must still be able to wire up an editor.
 */

export interface SetupConnectData {
  harness: string;
  /** The harness file the entry lives in. */
  target: string;
  /** False when the harness already said exactly this. */
  changed: boolean;
  plugin_root: string | null;
}

/**
 * Built from a registry rather than importing the one registry, so a test can
 * hand it a fake harness. The production factory reads this invocation's environment.
 */
export function setupConnectCommand(
  registry: readonly Connector[] | ((env: NodeJS.ProcessEnv) => readonly Connector[]),
): CommandSpec<SetupConnectData> {
  return {
    ns: 'setup',
    verb: 'connect',
    nsDescription: '설치하고, 다시 설정하고, 하네스를 연결합니다',
    usedFor: '이 brain을 하네스 하나에 등록합니다',
    required: ['harness'],
    examples: ['brain setup connect claude-code'],
    output: '연결한 하네스 `harness`, 설정 파일 `target`, 바뀌었는지인 `changed`, 플러그인 폴더 `plugin_root`(없으면 null)',
    risk: 'write',
    hook: false,
    dryRun: false,
    standalone: true,
    arguments: ['<harness>'],

    async run(context: StandaloneCommandContext) {
      const available = typeof registry === 'function' ? registry(context.env) : registry;
      const name = context.args[0] ?? '';
      const connector = available.find((candidate) => candidate.harness === name);
      if (connector === undefined) {
        return {
          ok: false as const,
          code: 'USAGE',
          message: `"${name}"를 위한 커넥터가 없습니다. ${known(available)}`,
          exit: 2 as const,
        };
      }

      const home = configHome(context.env);
      const state = await inspectShim(home);
      if (state.message !== undefined) {
        return { ok: false as const, code: state.shim === undefined ? 'SHIM_MISSING' : 'SHIM_INVALID', message: state.message };
      }
      const pluginRoot = await installedPluginRoot(home);
      const result = await connector.connect({ shimPath: state.path, pluginRoot });
      if (!result.ok) {
        return { ok: false as const, code: result.code, message: result.message };
      }
      return {
        ok: true as const,
        data: { harness: connector.harness, target: result.target, changed: result.changed, plugin_root: pluginRoot },
        warnings: result.warnings,
        text: connectionLines(connector, result, pluginRoot),
      };
    },
  };
}

/** The names this build accepts, for the `USAGE` message. */
function known(registry: readonly Connector[]): string {
  if (registry.length === 0) return '이 빌드는 아직 커넥터를 등록하지 않습니다 (epic 2).';
  return `아는 하네스: ${registry.map((connector) => connector.harness).join(', ')}.`;
}
