import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as install from '../src/install.js';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';
import { memoryConnector } from 'second_brain/testing';
import { runInstallerWithFlags } from '../src/install.js';
import { installerDeps, pgRunner, runPgCommand } from './pg-home.js';
import { tempHomes } from './temp-home.js';
import { withoutHarnessFolders } from './environment.js';
import { readInstalled } from '../src/install/installed.js';
const temporary = tempHomes();
afterEach(async () => { vi.restoreAllMocks(); await temporary.cleanup(); });
it('installs when the argv it asked for is run back, and only then', async () => {
  const home = await temporary.create('brain-setup-retry-');
  const env = withoutHarnessFolders({ ...process.env, SECOND_BRAIN_HOME: home });
  delete env.DOCKER_HOST;
  const deps = await installerDeps(home, env);
  deps.connectors = [memoryConnector({ harness: 'demo' })];
  vi.spyOn(install, 'systemInstallDeps').mockReturnValue(deps);
  const mirror = join(home, 'chosen-mirror');
  const plugin = join(home, 'chosen-plugin');
  async function run(argv: string[]) {
    let stdout = '', stderr = '';
    const code = await dispatch(commands, argv, {
      env, runner: pgRunner, clock: { now: () => new Date() },
      stdout: value => { stdout += value; }, stderr: value => { stderr += value; },
    });
    expect(stderr).toBe('');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    return { code, envelope: JSON.parse(stdout) };
  }

  const refused = await run(['setup', 'run', '--mirror-path', mirror, '--plugin-root', plugin, '--connect', 'demo', '--json']);
  expect(refused.code).toBe(3);
  expect(refused.envelope).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED', exit_code: 3, retryable: false } });
  const argv = ['brain', 'setup', 'run', '--mirror-path', mirror, '--plugin-root', plugin, '--connect', 'demo', '--yes', '--json'];
  expect(refused.envelope.error.retry_argv).toEqual(argv);
  expect(await readInstalled(home)).toBeUndefined();

  const accepted = await run(refused.envelope.error.retry_argv.slice(1));
  expect(accepted.code).toBe(0);
  expect(accepted.envelope).toMatchObject({ ok: true, data: { mirror_path: mirror, postgres: { schema_version: 20 }, harnesses: [{ harness: 'demo' }] } });
  expect(await readInstalled(home)).toMatchObject({ plugin_root: plugin });
});

it('sets up the same PG home through flags, imports disk transcripts and writes completion last', async () => {
  const home = await temporary.create('brain-setup-');
  const configDir = join(home, 'claude');
  const env: NodeJS.ProcessEnv = { ...withoutHarnessFolders({ ...process.env, SECOND_BRAIN_HOME: home }), CLAUDE_CONFIG_DIR: configDir };
  delete env.BRAIN_DATABASE_URL; delete env.DOCKER_HOST;
  const deps = await installerDeps(home, env); deps.log = () => {};
  const folder = join(configDir, 'projects', '-fixture'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'fixture.jsonl'), await readFile(new URL('../../../packages/claude-code/test/fixtures/two-turns.jsonl', import.meta.url)));
  const result = await runInstallerWithFlags({ yes: true, help: false, connect: [] }, env, deps);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, report: { postgres: { schema_version: 20, import: { enqueued: 1 } } } });
  expect(await readInstalled(home)).toMatchObject({ schema_version: 20 });
  const doctor = await runPgCommand(['doctor', 'run', '--json'], env);
  expect(doctor.code).toBe(0);
  const checks = JSON.parse(doctor.stdout).data.checks;
  for (const id of ['orbstack', 'container', 'db', 'writable', 'pg_trgm', 'schema-version']) expect(checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
});
