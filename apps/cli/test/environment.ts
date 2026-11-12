import { fileURLToPath } from 'node:url';
import { chmodSync, writeFileSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

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
const FAKE_AGENT_DIR = mkdtempSync(join(tmpdir(), 'brain-agent-'));
const FAKE_AGENT = join(FAKE_AGENT_DIR, 'codex');
const FAKE_LOGIN_SHELL = join(FAKE_AGENT_DIR, 'login-shell');
// 설치/확장 fixture는 이 Mac의 실제 Codex를 탐지하거나 실행하지 않는다.
writeFileSync(FAKE_AGENT, '#!/bin/sh\n[ "$1" = "--version" ] || exit 99\nprintf "codex-cli 1.0.0\\n"\n');
writeFileSync(FAKE_LOGIN_SHELL, `#!/bin/sh\nprintf '%s\\n' '${FAKE_AGENT}'\n`);
chmodSync(FAKE_AGENT, 0o700); chmodSync(FAKE_LOGIN_SHELL, 0o700);

afterAll(async () => {
  await Promise.all([EMPTY_CONFIG_DIR, EMPTY_LAUNCH_AGENTS, FAKE_LAUNCHCTL_DIR, FAKE_AGENT_DIR]
    .map((path) => rm(path, { recursive: true, force: true })));
});

/** Where Claude Code keeps its configuration, when the environment says. */
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Isolate CLI fixtures from real transcripts and inherited primary database URLs. */
export function withoutHarnessFolders(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {
    ...env,
    SHELL: FAKE_LOGIN_SHELL,
    [CLAUDE_CONFIG_DIR_ENV]: EMPTY_CONFIG_DIR,
    SECOND_BRAIN_LAUNCHCTL: fileURLToPath(new URL('./fixtures/fake-launchctl.sh', import.meta.url)),
    SECOND_BRAIN_LAUNCH_AGENTS: EMPTY_LAUNCH_AGENTS,
    FAKE_LAUNCHCTL_DIR,
  };
  // Fixture .env files own the URL. Apply intentional fault overrides after this helper.
  delete isolated.BRAIN_DATABASE_URL;
  return isolated;
}
