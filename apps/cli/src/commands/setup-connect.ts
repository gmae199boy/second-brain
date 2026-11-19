import { codexRoots, codexGuidance } from '../doctor/codex-folders.js';
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
  mode?: string;
  folders?: string;
  guidance?: string;
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
    examples: ['brain setup connect claude-code', 'brain setup connect codex'],
    output: '하네스 `harness`, Claude 설정 파일 또는 Codex 홈 디렉터리 `target`, 변경 여부 `changed`, 플러그인 폴더 `plugin_root`(없으면 null). Codex는 `mode`(scan-only), `folders`(present/missing/unknown), 지원 명령 안내 `guidance`도 반환합니다',
    risk: 'write',
    hook: false,
    dryRun: false,
    standalone: true,
    arguments: ['<harness>'],

    async run(context: StandaloneCommandContext) {
      const available = typeof registry === 'function' ? registry(context.env) : registry;
      const name = context.args[0] ?? '';
      if (name === 'codex') {
        const roots = await codexRoots(context.env);
        const detail = roots.state === 'present' ? '발견' : roots.state === 'missing' ? '미발견' : '확인 불가';
        return { ok: true as const, data: { harness: 'codex', target: roots.home, changed: false, plugin_root: null, mode: 'scan-only', folders: roots.state, guidance: codexGuidance }, warnings: [], text: [`Codex 폴더 ${detail}. ${codexGuidance}`] };
      }
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
  const names = registry.map((connector) => connector.harness);
  return `아는 하네스: ${[...names, 'codex (scan-only)'].join(', ')}.`;
}
