import { access } from 'node:fs/promises';
import type { Connector } from 'second_brain';
import { configHome } from '../config/paths.js';
import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { shimPath } from '../install/shim.js';

/**
 * `brain setup connect <harness>`: register the shim with one harness. It is
 * the whole of what the installer's harness step does, as a command, so a
 * harness installed after the install does not mean re-running the installer.
 *
 * Standalone: writing a harness's own configuration needs neither the
 * configuration folder's contents nor the database, and a brain whose Postgres
 * is down must still be able to wire up an editor.
 */

export interface SetupConnectData {
  harness: string;
  /** The harness file the entry lives in. */
  target: string;
  /** False when the harness already said exactly this. */
  changed: boolean;
}

/**
 * Built from a registry rather than importing the one registry, so a test can
 * hand it a fake harness: the real connectors are epic 2's, and until then the
 * registry is empty.
 */
export function setupConnectCommand(
  registry: readonly Connector[],
): CommandSpec<SetupConnectData> {
  return {
    ns: 'setup',
    verb: 'connect',
    nsDescription: 'install, re-configure and connect harnesses',
    description: 'register this brain with one harness',
    standalone: true,
    arguments: ['<harness>'],

    async run(context: StandaloneCommandContext) {
      const name = context.args[0] ?? '';
      const connector = registry.find((candidate) => candidate.harness === name);
      if (connector === undefined) {
        return {
          ok: false as const,
          code: 'USAGE',
          message: `no connector for "${name}". ${known(registry)}`,
          exit: 2 as const,
        };
      }

      // The shim is what gets registered, so there is nothing to register
      // without it — and writing a hook that points at a file that is not
      // there would be a harness that fails on every turn.
      const path = shimPath(configHome(context.env));
      if (!(await exists(path))) {
        return {
          ok: false as const,
          code: 'SHIM_MISSING',
          message: `${path} does not exist. Run \`brain setup run\` first.`,
        };
      }

      const result = await connector.connect({ shimPath: path });
      if (!result.ok) {
        return { ok: false as const, code: result.code, message: result.message };
      }
      return {
        ok: true as const,
        data: { harness: connector.harness, target: result.target, changed: result.changed },
        text: [
          result.changed
            ? `connected ${connector.label} in ${result.target}`
            : `${connector.label} was already connected in ${result.target}`,
        ],
      };
    },
  };
}

/** The names this build accepts, for the `USAGE` message. */
function known(registry: readonly Connector[]): string {
  if (registry.length === 0) return 'This build registers no connector yet (epic 2).';
  return `Known harnesses: ${registry.map((connector) => connector.harness).join(', ')}.`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
