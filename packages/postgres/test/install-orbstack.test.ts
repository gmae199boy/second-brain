import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { runSqliteMigrations } from '../../second_brain/dist/index.js';
import type { TestDatabase } from '@second-brain/test-db';
import type { CommandRunner, CommandRequest } from '../../../apps/cli/src/runtime/command-runner.js';
import { database, clock } from './fixture.js';
// These imports deliberately exercise the built CLI, as its installed entry point does.
import { systemInstallDeps, runInstaller, runInstallerWithFlags } from '../../../apps/cli/dist/install.js';
import { installPostgres } from '../../../apps/cli/dist/install/postgres.js';
import { dispatch } from '../../../apps/cli/dist/dispatch.js';
import { commands } from '../../../apps/cli/dist/commands/index.js';
import { homeResources } from '../../../apps/cli/dist/config/resources.js';
const homes: string[] = []; const databases: TestDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.drop())); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const flags = { yes: true, help: false, connect: [] };
async function world(mode = 'running', withDatabase = true) {
  const home = await mkdtemp(join(tmpdir(), 'brain-orbstack-')); homes.push(home);
  const env: NodeJS.ProcessEnv = { ...process.env, SECOND_BRAIN_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), SECOND_BRAIN_LAUNCH_AGENTS: join(home, 'agents'), SECOND_BRAIN_LAUNCHCTL: fileURLToPath(new URL('../../../apps/cli/test/fixtures/fake-launchctl.sh', import.meta.url)), FAKE_LAUNCHCTL_DIR: join(home, 'launchctl') };
  delete env.DOCKER_HOST;
  await mkdir(join(home, 'claude'), { recursive: true });
  await writeFile(join(home, 'config.toml'), 'schema_version=1\n[store]\nurl_env="BRAIN_DATABASE_URL"\n');
  const db = withDatabase ? await database(false) : undefined; if (db) databases.push(db);
  if (db) env.BRAIN_DATABASE_URL = db.appUrl;
  const calls: CommandRequest[] = [];
  let container: 'absent' | 'running' | 'stopped' = 'absent';
  let volumeExists = false;
  const good = (stdout = '') => ({ ok: true as const, stdout, stderr: '' });
  const runner: CommandRunner = async request => {
    calls.push(request);
    if (request.command === 'orb') return mode === 'missing' ? { ok: false, code: 'ENOENT', stdout: '', stderr: '', message: 'missing' } : good(mode === 'stopped' ? 'Stopped' : 'Running');
    const args = request.args;
    if (args[0] === 'context') return good(mode === 'other-context' ? 'desktop-linux' : 'orbstack');
    if (args[0] === 'version') return good('29');
    if (args[0] === 'volume') return volumeExists
      ? good(JSON.stringify([{ Labels: { 'com.docker.compose.project': homeResources(home).project } }]))
      : { ok: false, stdout: '', stderr: 'no such volume', message: 'missing' };
    if (args[0] === 'ps') return good(container === 'absent' ? '' : JSON.stringify({ Labels: 'com.docker.compose.service=postgres', State: container === 'running' ? 'running' : 'exited', Status: container === 'running' ? 'Up (healthy)' : 'Exited' }));
    if (args.includes('up')) { container = 'running'; volumeExists = true; }
    if (args.includes('down')) { container = 'absent'; if (args.includes('-v')) volumeExists = false; }
    return good();
  };
  const deps = systemInstallDeps({ runner }); deps.isTTY = false; deps.log = () => {};
  // Keep installation verification in-process while retaining the actual PG assembly.
  deps.installed.verify = async () => ({ ok: true });
  deps.daemon.register = async () => ({ label: homeResources(home).label, plist_path: null, status: 'unsupported', plist_changed: false });
  if (db) deps.postgres = () => installPostgres({ home, urlEnv: 'BRAIN_DATABASE_URL', env, clock, runner, secrets: { adminUrl: db.url, appPassword: 'brain-test-app' }, databaseName: new URL(db.url).pathname.slice(1) });
  const execute = async (args: string[], commandRunner = runner) => {
    let stdout = ''; const exit = await dispatch(commands, [...args, '--json'], { clock, env, runner: commandRunner, stdout: (s: string) => { stdout += s; }, stderr: () => {} });
    return { exit, ...JSON.parse(stdout) };
  };
  return { home, env, db, calls, runner, deps, execute, stopContainer: () => { container = 'stopped'; }, setup: () => runInstallerWithFlags(flags, env, deps) };
}
it.each(['missing', 'stopped', 'other-context'])('stops setup and doctor with guidance and skipped db checks when OrbStack is %s', async mode => {
  const kit = await world(mode, false); const before = await readdir(kit.home);
  expect(await kit.setup()).toMatchObject({ ok: false, failure: { code: 'ORBSTACK_UNAVAILABLE', exit: 2 } });
  expect(await readdir(kit.home)).toEqual(before);
  const doctor = await kit.execute(['doctor', 'run']);
  expect(doctor.data.checks).toEqual(expect.arrayContaining([{ id: 'orbstack', status: 'fail', code: 'ORBSTACK_UNAVAILABLE', detail: expect.any(String) }]));
  for (const id of ['container', 'db', 'writable', 'pg_trgm', 'redaction_cleanup', 'schema-version', 'failures', 'untagged', 'transcripts']) expect(doctor.data.checks).toContainEqual({ id, status: 'skip', detail: '앞선 점검 실패: orbstack' });
  expect(kit.calls.some(c => c.args.includes('up') || c.args.includes('start'))).toBe(false);
});
it('skips adapter probes with the container prerequisite when postgres is stopped', async () => {
  const kit = await world('running', false);
  const doctor = await kit.execute(['doctor', 'run']);
  expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'orbstack', status: 'ok' }));
  expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'container', status: 'fail' }));
  for (const id of ['db', 'writable', 'pg_trgm', 'redaction_cleanup', 'schema-version', 'failures', 'untagged', 'transcripts']) expect(doctor.data.checks).toContainEqual({ id, status: 'skip', detail: '앞선 점검 실패: container' });
  expect(kit.calls.some(c => c.args.includes('up') || c.args.includes('start'))).toBe(false);
});
it('never invokes the OrbStack runner for SQLite doctor and uninstall without compose', async () => {
  const kit = await world('running', false);
  await writeFile(join(kit.home, 'config.toml'), 'schema_version=1\n');
  expect((await runSqliteMigrations({ path: join(kit.home, 'brain.db') })).ok).toBe(true);
  const doctor = await kit.execute(['doctor', 'run']);
  expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'db', status: 'ok' }));
  const ids = doctor.data.checks.map((check: { id: string }) => check.id);
  expect(ids).not.toContain('orbstack');
  expect(ids).not.toContain('container');
  expect(kit.calls).toHaveLength(0);
  expect(await kit.execute(['setup', 'uninstall'])).toMatchObject({ ok: true });
  expect(kit.calls).toHaveLength(0);
});
it('runs setup twice against one database with compose, roles and migrations once', async () => {
  const kit = await world();
  const first = await kit.setup(); expect(first).toMatchObject({ ok: true, report: { postgres: { owner_created: true, compose_started: true } } });
  const volume = await kit.runner({ command: 'docker', args: ['volume', 'inspect', homeResources(kit.home).volume], env: kit.env, timeoutMs: 5000 });
  expect(volume.ok).toBe(true);
  expect(JSON.parse(volume.stdout)).toEqual([{ Labels: { 'com.docker.compose.project': homeResources(kit.home).project } }]);
  const migrations = await kit.db!.rows('select * from brain.schema_migrations');
  const second = await kit.setup(); expect(second).toMatchObject({ ok: true, report: { postgres: { owner_created: false, applied: [], compose_started: false } } });
  expect(await kit.db!.rows('select * from brain.schema_migrations')).toEqual(migrations);
  expect(kit.calls.filter(c => c.args.includes('up'))).toHaveLength(1);
  const doctor = await kit.execute(['doctor', 'run']);
  for (const id of ['orbstack', 'container', 'db', 'writable', 'pg_trgm', 'schema-version']) expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
});
it('restarts a stopped postgres container with unchanged compose and restores healthy doctor checks', async () => {
  const kit = await world();
  expect(await kit.setup()).toMatchObject({ ok: true, report: { postgres: { compose_started: true } } });
  const composePath = join(kit.home, 'postgres', 'compose.yaml');
  const compose = await readFile(composePath, 'utf8');
  const migrations = await kit.db!.rows('select * from brain.schema_migrations');
  kit.stopContainer();
  expect(await kit.setup()).toMatchObject({ ok: true, report: { postgres: { compose_started: true, applied: [], owner_created: false } } });
  expect(kit.calls.filter(c => c.args.includes('up'))).toHaveLength(2);
  expect(await readFile(composePath, 'utf8')).toBe(compose);
  expect(await kit.db!.rows('select * from brain.schema_migrations')).toEqual(migrations);
  const doctor = await kit.execute(['doctor', 'run']);
  expect(doctor).toMatchObject({ exit: 0, ok: true });
  for (const id of ['orbstack', 'container', 'db', 'writable', 'pg_trgm', 'redaction_cleanup', 'schema-version']) expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
});
it('imports the transcripts on disk during a PG setup', async () => {
  const kit = await world();
  const folder = join(kit.home, 'claude', 'projects', '-tmp-import'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'import.jsonl'), await readFile(new URL('../../claude-code/test/fixtures/two-turns.jsonl', import.meta.url)));
  const legacy = join(kit.home, 'brain.db'); await writeFile(legacy, 'legacy');
  const result = await kit.setup(); expect(result).toMatchObject({ ok: true, report: { postgres: { legacy_sqlite_path: legacy, import: { enqueued: 1 } } } });
  expect(await readFile(legacy, 'utf8')).toBe('legacy');
  expect((await kit.db!.rows('select * from brain.sessions')).length).toBe(1);
  expect((await kit.db!.rows('select * from brain.messages')).length).toBeGreaterThan(0);
});
it('leaves the volume after setup uninstall and removes it only with consent', async () => {
  const kit = await world(); expect((await kit.setup()).ok).toBe(true); kit.calls.length = 0;
  expect(await kit.execute(['setup', 'uninstall', '--delete-volume'])).toMatchObject({ exit: 3, error: { code: 'CONFIRMATION_REQUIRED' } });
  expect(kit.calls).toHaveLength(0);
  expect(await kit.execute(['setup', 'uninstall'])).toMatchObject({ ok: true, data: { postgres: { down: true, volume_removed: false } } });
  expect(kit.calls.filter(c => c.args.includes('down')).at(-1)?.args).not.toContain('-v');
  expect(await kit.execute(['setup', 'uninstall', '--delete-volume', '--yes'])).toMatchObject({ ok: true, data: { postgres: { down: true, volume_removed: true } } });
  expect(kit.calls.filter(c => c.args.includes('down')).at(-1)?.args).toContain('-v');
});
it('uninstalls a PG-configured home without compose without calling the runner', async () => {
  const kit = await world('stopped', false);
  expect(await kit.execute(['setup', 'uninstall'])).toMatchObject({ exit: 0, ok: true, data: { postgres: null } });
  expect(kit.calls).toHaveLength(0);
});
it('removes daemon traces but leaves the container when uninstall finds OrbStack stopped', async () => {
  const kit = await world('stopped', false);
  for (const folder of ['postgres', 'run', 'log']) await mkdir(join(kit.home, folder));
  const compose = join(kit.home, 'postgres', 'compose.yaml');
  await writeFile(compose, '# fixture\n');
  const traces = ['run/daemon.pid', 'run/heartbeat', 'log/daemon.log', 'log/daemon.log.1'].map(path => join(kit.home, path));
  for (const path of traces) await writeFile(path, 'stale trace');
  const result = await kit.execute(['setup', 'uninstall']);
  expect(result).toMatchObject({ exit: 2, ok: false, error: { code: 'ORBSTACK_UNAVAILABLE' } });
  expect(result.error.message).toContain('데몬 정리는 끝났지만');
  expect(result.error.message).toContain('컨테이너를 남겼습니다');
  for (const path of traces) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(compose, 'utf8')).toBe('# fixture\n');
  expect(kit.calls.map(c => [c.command, ...c.args])).toEqual([['orb', 'status']]);
});
it.each(['stderr', 'stdout', 'message'] as const)('reports the bounded %s tail when only compose down fails', async source => {
  const kit = await world('running', false);
  await mkdir(join(kit.home, 'postgres'));
  await writeFile(join(kit.home, 'postgres', 'compose.yaml'), '# fixture\n');
  const failure = { ok: false as const, stderr: '', stdout: '', message: '', [source]: 'discard-prefix' + 'x'.repeat(2100) + 'down-failure-tail' };
  const runner: CommandRunner = request => request.args.includes('down') ? Promise.resolve(failure) : kit.runner(request);
  const result = await kit.execute(['setup', 'uninstall'], runner);
  expect(result).toMatchObject({ exit: 2, ok: false, error: { code: 'DB_UNAVAILABLE' } });
  expect(result.error.message).toContain('데몬 정리는 끝났지만');
  expect(result.error.message).not.toContain('discard-prefix');
  expect(result.error.message.split('\n').at(-1)).toBe(failure[source].slice(-2000));
});
it.each(['volume', 'port'])('returns exit 2 from installer and CLI for a %s conflict', async conflict => {
  const kit = await world('running', false);
  const runner: CommandRunner = async request => {
    if (conflict === 'volume' && request.args[0] === 'volume') return { ok: true, stdout: JSON.stringify([{ Labels: { 'com.docker.compose.project': 'other-project' } }]), stderr: '' };
    if (conflict === 'port' && request.args.includes('up')) return { ok: false, stdout: '', stderr: 'port is already allocated', message: 'failed' };
    return kit.runner(request);
  };
  const lines: string[] = [];
  kit.deps.log = line => lines.push(line);
  kit.deps.postgres = () => installPostgres({ home: kit.home, env: kit.env, urlEnv: 'BRAIN_DATABASE_URL', clock, runner });
  expect(await runInstaller(['--yes'], kit.env, kit.deps)).toBe(2);
  expect(lines.join('\n')).toContain('DB_UNAVAILABLE');
  const expectedDetail = conflict === 'volume' ? 'other-project' : String(homeResources(kit.home).port);
  expect(lines.join('\n')).toContain(expectedDetail);
  const result = await kit.execute(['setup', 'run', '--yes'], runner);
  expect(result).toMatchObject({ exit: 2, ok: false, error: { code: 'DB_UNAVAILABLE', message: expect.stringContaining(expectedDetail) } });
  if (conflict === 'volume') expect(kit.calls.some(c => c.args.includes('up'))).toBe(false);
});
