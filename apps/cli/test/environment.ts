import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Keeping the tests out of the developer's own harness folders.
 *
 * `brain` reads a harness's transcript folder when the capture switch is on
 * (`harnesses.ts`), and where that folder is comes out of the environment. So
 * every test that runs this CLI — in process or as a child — has to say where
 * it is, or a drain in a test could scan the machine's real `~/.claude`, open
 * actual conversations and collect them into whatever database the test made
 * (Boundaries).
 *
 * The folder is real and empty rather than absent, because "there is nothing
 * there" and "there is no folder" are different answers and a test should not
 * depend on which one it got by accident.
 */

/** An empty folder standing in for a harness's configuration directory. */
export const EMPTY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'brain-no-harness-'));

/** The switch that turns the folder scan on at all (`CAPTURE_ENV`). */
const CAPTURE_ENV = 'SECOND_BRAIN_CAPTURE';

/** Where Claude Code keeps its configuration, when the environment says. */
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * One environment with no reachable harness folder: the switch unset and the
 * configuration directory pointed at an empty folder.
 *
 * Both halves, on purpose. The switch alone would be enough today, and a test
 * that sets it — or story 2.14, which removes it — must still not reach the
 * machine's real transcripts.
 */
export function withoutHarnessFolders(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = { ...env, [CLAUDE_CONFIG_DIR_ENV]: EMPTY_CONFIG_DIR };
  delete isolated[CAPTURE_ENV];
  return isolated;
}
