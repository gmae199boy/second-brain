import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Keeping the tests out of the developer's own harness folders.
 *
 * `brain` reads every registered harness's transcript folder by default, and where that folder is comes out of the environment. So
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

const EMPTY_LAUNCH_AGENTS = mkdtempSync(join(tmpdir(), 'brain-launch-agents-'));
const FAKE_LAUNCHCTL_DIR = mkdtempSync(join(tmpdir(), 'brain-launchctl-'));

/** Where Claude Code keeps its configuration, when the environment says. */
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Isolate all CLI invocations from real user transcripts. */
export function withoutHarnessFolders(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {
    ...env,
    [CLAUDE_CONFIG_DIR_ENV]: EMPTY_CONFIG_DIR,
    SECOND_BRAIN_LAUNCHCTL: fileURLToPath(new URL('./fixtures/fake-launchctl.sh', import.meta.url)),
    SECOND_BRAIN_LAUNCH_AGENTS: EMPTY_LAUNCH_AGENTS,
    FAKE_LAUNCHCTL_DIR,
  };
  return isolated;
}
