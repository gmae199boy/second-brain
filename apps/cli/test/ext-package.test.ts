import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { comparePackagePaths } from 'second_brain';
import { afterEach, expect, it } from 'vitest';
import { prepareExtensionPackage, compareRelease, readPackageObservation } from '../src/runtime/extension-package.js';
import { extHome } from './ext-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function packageFixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'package-fixture-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), dir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  Object.assign(manifest, { files: ['bin/check.mjs', 'bin/echo-stats.mjs', 'manifest.json', 'migrations/0001_testext.sql'], core_compat: { min: '0.0.0', max_exclusive: '1.0.0' }, plugin_version: '1.0.0' });
  async function seal() {
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const hash = createHash('sha256');
    for (const path of manifest.files as string[]) { const data = await readFile(join(dir, path)), pathBytes = Buffer.from(path); hash.update(`f${pathBytes.length}:`); hash.update(pathBytes); hash.update(`:${data.length}:`); hash.update(data); }
    await writeFile(join(dir, 'digest'), `${hash.digest('hex')}\n`);
  }
  await seal(); return { dir, manifest, seal };
}
it('고정된 패키지 바이트와 release 범위를 검증한다', async () => {
  const fixture = await packageFixture(), prepared = await prepareExtensionPackage(fixture.dir);
  cleanup.push(prepared.cleanup);
  expect(prepared.name).toBe('testext'); expect(prepared.digest).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(join(fixture.dir, 'bin/check.mjs'), 'changed');
  expect(await readFile(join(prepared.dir, 'bin/check.mjs'), 'utf8')).not.toBe('changed');
  expect(compareRelease('1.10.0', '1.9.99')).toBeGreaterThan(0);
  expect(compareRelease('0.0.0', '0.0.0')).toBe(0);
});
it.each(['digest', 'missing', 'extra', 'symlink', 'escape', 'duplicate', 'partial', 'range'] as const)('잘못된 %s 패키지를 거부한다', async kind => {
  const f = await packageFixture();
  if (kind === 'digest') await writeFile(join(f.dir, 'digest'), 'wrong\n');
  if (kind === 'missing') await rm(join(f.dir, 'bin/check.mjs'));
  if (kind === 'extra') await writeFile(join(f.dir, 'extra'), 'extra');
  if (kind === 'symlink') { await rm(join(f.dir, 'bin/check.mjs')); await symlink('../manifest.json', join(f.dir, 'bin/check.mjs')); }
  if (kind === 'escape') { f.manifest.files.push('../escape'); await writeFile(join(f.dir, 'manifest.json'), JSON.stringify(f.manifest)); }
  if (kind === 'duplicate') { f.manifest.files.push('manifest.json'); await writeFile(join(f.dir, 'manifest.json'), JSON.stringify(f.manifest)); }
  if (kind === 'partial') { delete f.manifest.plugin_version; await writeFile(join(f.dir, 'manifest.json'), JSON.stringify(f.manifest)); }
  if (kind === 'range') { f.manifest.core_compat.max_exclusive = '0.0.0'; await writeFile(join(f.dir, 'manifest.json'), JSON.stringify(f.manifest)); }
  await expect(prepareExtensionPackage(f.dir)).rejects.toThrow();
});
it('실제 CLI --package가 합성 core 신원에서 설치하고 불일치는 거부한다', async () => {
  const f = await packageFixture(), world = await extHome(); cleanup.push(world.cleanup);
  const build = JSON.parse(await readFile(new URL('../dist/build.json', import.meta.url), 'utf8'));
  expect(build.version).toBe('0.0.0'); expect(build.commit).toMatch(/^[a-f0-9]{40}$/);
  await writeFile(join(world.home, 'installed.json'), JSON.stringify({ commit: build.commit, schema_version: build.schema_version, node: process.execPath, plugin_root: null, installed_at: new Date().toISOString() }));
  const ok = await world.run(['ext', 'install', '--package', f.dir, '--json']);
  expect(ok.code, ok.stdout + ok.stderr).toBe(0); expect(ok.body.data.name).toBe('testext');
  const before = await readFile(join(world.home, 'extensions/testext/manifest.json'), 'utf8');
  f.manifest.core_compat = { min: '1.0.0', max_exclusive: '2.0.0' }; await f.seal();
  const rejected = await world.run(['ext', 'install', '--package', f.dir, '--json']);
  expect(rejected.body.error.code).toBe('EXTENSION_INVALID');
  expect(await readFile(join(world.home, 'extensions/testext/manifest.json'), 'utf8')).toBe(before);
  await rm(join(world.home, 'installed.json'));
  expect((await world.run(['ext', 'install', '--package', f.dir, '--json'])).body.error.code).toBe('EXTENSION_INVALID');
});

it('상위 package 신원과 재설치 충돌 및 낮은 버전의 무변경을 관찰한다', async () => {
  const f = await packageFixture(), world = await extHome(); cleanup.push(world.cleanup);
  const build = JSON.parse(await readFile(new URL('../dist/build.json', import.meta.url), 'utf8'));
  await writeFile(join(world.home, 'installed.json'), JSON.stringify({ commit: build.commit, schema_version: build.schema_version, node: process.execPath, plugin_root: null, installed_at: new Date().toISOString() }));
  const first = await world.run(['ext', 'install', '--package', f.dir, '--json']);
  expect(first.code, first.stdout + first.stderr).toBe(0);
  expect(first.body.data).toMatchObject({ version: '0.1.0', package_digest: expect.stringMatching(/^[a-f0-9]{64}$/), plugin_version: '1.0.0' });
  const status = await world.run(['ext', 'status', 'testext', '--json']);
  expect(status.body.data.package_digest).toBe(first.body.data.package_digest);
  f.manifest.version = '0.2.0'; f.manifest.plugin_version = '1.1.0'; await f.seal();
  const upgraded = await world.run(['ext', 'install', '--package', f.dir, '--json']);
  expect(upgraded.code, upgraded.stdout + upgraded.stderr).toBe(0);
  expect(upgraded.body.data).toMatchObject({ version: '0.2.0', plugin_version: '1.1.0' });
  expect(upgraded.body.data.package_digest).not.toBe(first.body.data.package_digest);
  const installed = await readFile(join(world.home, 'extensions/testext/manifest.json'), 'utf8');
  const registry = await world.db.rows("select * from brain.extensions where name='testext'");
  const progress = await world.db.rows("select * from brain.extension_install_progress where name='testext'");
  f.manifest.version = '0.1.0'; f.manifest.plugin_version = '1.0.0'; await f.seal();
  const lower = await world.run(['ext', 'install', '--package', f.dir, '--json']);
  expect(lower.code).toBe(0);
  const doctorLower = await world.run(['doctor', 'run', '--json']);
  expect(doctorLower.body.data.checks).toContainEqual(expect.objectContaining({ id: 'extensions', status: 'warn', code: 'PLUGIN_BEHIND' }));
  expect(await readPackageObservation(world.home, 'testext')).toMatchObject({ name: 'testext', version: '0.1.0', pluginVersion: '1.0.0', digest: first.body.data.package_digest });
  expect(await readFile(join(world.home, 'extensions/testext/manifest.json'), 'utf8')).toBe(installed);
  expect(await world.db.rows("select * from brain.extensions where name='testext'")).toEqual(registry);
  expect(await world.db.rows("select * from brain.extension_install_progress where name='testext'")).toEqual(progress);
  f.manifest.core_compat = { min: '1.0.0', max_exclusive: '2.0.0' }; await f.seal();
  const incompatible = await world.run(['ext', 'install', '--package', f.dir, '--json']);
  expect(incompatible.body.error.code).toBe('EXTENSION_INVALID');
  expect(await readPackageObservation(world.home, 'testext')).toMatchObject({ version: '0.1.0', digest: first.body.data.package_digest });
  expect(await world.db.rows("select * from brain.extensions where name='testext'")).toEqual(registry);
  f.manifest.core_compat = { min: '0.0.0', max_exclusive: '1.0.0' };
  f.manifest.version = '0.2.0'; f.manifest.plugin_version = '1.1.0'; await f.seal();
  expect((await world.run(['ext', 'install', '--package', f.dir, '--json'])).code).toBe(0);
  expect(await readPackageObservation(world.home, 'testext')).toMatchObject({ version: '0.2.0', pluginVersion: '1.1.0' });
  expect((await world.run(['doctor', 'run', '--json'])).body.data.checks).toContainEqual(expect.objectContaining({ id: 'extensions', status: 'ok' }));
  f.manifest.version = '0.2.0'; f.manifest.plugin_version = '1.2.0'; await f.seal();
  expect((await world.run(['ext', 'install', '--package', f.dir, '--json'])).body.error.code).toBe('EXTENSION_INVALID');
  expect(await world.db.rows("select * from brain.extensions where name='testext'")).toEqual(registry);
  const observation = await readPackageObservation(world.home, 'testext');
  const conflictDoctor = await world.run(['doctor', 'run', '--json']);
  expect(conflictDoctor.body.data.checks).toContainEqual(expect.objectContaining({ id: 'extensions', status: 'warn', code: 'EXTENSION_PACKAGE_CONFLICT' }));
  expect(await readPackageObservation(world.home, 'testext')).toEqual(observation);
  expect(await world.db.rows("select * from brain.extensions where name='testext'")).toEqual(registry);
  expect(await world.db.rows("select * from brain.extension_install_progress where name='testext'")).toEqual(progress);
  expect(await readFile(join(world.home, 'extensions/testext/manifest.json'), 'utf8')).toBe(installed);
  f.manifest.plugin_version = '1.1.0'; await f.seal();
  expect((await world.run(['ext', 'install', '--package', f.dir, '--json'])).code).toBe(0);
  expect((await world.run(['doctor', 'run', '--json'])).body.data.checks).toContainEqual(expect.objectContaining({ id: 'extensions', status: 'ok' }));
});

it('실제 CLI 상태와 doctor는 소유자를 숨기고 정지와 복구를 읽기 전용으로 알린다', async () => {
  const f = await packageFixture(), world = await extHome(); cleanup.push(world.cleanup);
  expect((await world.run(['ext', 'install', '--package', f.dir, '--json'])).code).toBe(0);
  const owner = '00000000-0000-7000-8000-000000000090';
  await world.db.query(`insert into brain.extension_quiesce(name,owner,started_at) values ('testext','${owner}',now())`);
  await world.db.query("insert into brain.work_hold_groups(name,held_at) values ('extension:testext',now()) on conflict do nothing");
  const snapshot = async () => ({ registry: await world.db.rows("select * from brain.extensions where name='testext'"), progress: await world.db.rows("select * from brain.extension_install_progress where name='testext'"), gate: await world.db.rows("select * from brain.extension_quiesce where name='testext'"), holds: await world.db.rows("select * from brain.work_hold_groups where name='extension:testext'"), manifest: await readFile(join(world.home, 'extensions/testext/manifest.json'), 'utf8'), observation: await readPackageObservation(world.home, 'testext') });
  const before = await snapshot();
  const status = await world.run(['ext', 'status', 'testext', '--json']); expect(status.body.data.quiesced).toBe(true); expect(status.stdout).not.toContain(owner);
  const doctor = await world.run(['doctor', 'run', '--json']);
  expect(doctor.body.data.checks).toContainEqual(expect.objectContaining({ id: 'extensions', status: 'warn', detail: expect.stringContaining('정지 중: 설치 복구 필요') }));
  expect(doctor.stdout).not.toContain(owner); expect(await snapshot()).toEqual(before);
  await world.db.query(`delete from brain.extension_quiesce where name='testext' and owner='${owner}'`);
  expect((await world.run(['ext', 'status', 'testext', '--json'])).body.data.quiesced).toBe(false);
  const recovered = await world.run(['doctor', 'run', '--json']);
  expect(recovered.body.data.checks).toContainEqual(expect.objectContaining({ id: 'extensions', status: 'ok' }));
  expect(recovered.body.data.checks.find((check: { id: string }) => check.id === 'extensions').detail).not.toContain('정지 중');
  expect(await world.db.rows("select * from brain.work_hold_groups where name='extension:testext'")).toEqual(before.holds);
});

it('외부 package 이행 중 프로세스 종료 후 같은 패키지로 정지를 해제하고 재개한다', async () => {
  const { spawn } = await import('node:child_process'); const { default: pg } = await import('pg');
  const f = await packageFixture(), world = await extHome(); cleanup.push(world.cleanup);
  const initial = await world.run(['ext', 'install', '--package', f.dir, '--json']); expect(initial.code, initial.stdout + initial.stderr).toBe(0);
  f.manifest.version = '0.2.0'; f.manifest.files.push('migrations/0002_more.sql'); f.manifest.files.sort();
  await writeFile(join(f.dir, 'migrations/0002_more.sql'), 'select 1;\n'); await f.seal();
  const blocker = new pg.Client({ connectionString: world.db.url }); let child: ReturnType<typeof spawn> | undefined;
  try {
    await blocker.connect(); await blocker.query('begin'); await blocker.query('select pg_advisory_xact_lock($1)', [4919270911]);
    child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'ext', 'install', '--package', f.dir, '--json'], { env: world.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.resume(); child.stderr!.resume(); const exited = new Promise<void>(resolve => child!.once('close', () => resolve()));
    await expect.poll(async () => { try { return JSON.parse(await readFile(join(world.home, 'extensions/.transition-testext.json'), 'utf8')).phase; } catch { return ''; } }, { timeout: 10000 }).toBe('prepared');
    child.kill('SIGKILL'); await exited; child = undefined; await blocker.query('rollback');
    await rm(join(world.home, 'install.lock'), { recursive: true });
    const resumed = await world.run(['ext', 'install', '--package', f.dir, '--json']);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(resumed.body.data.version).toBe('0.2.0');
    expect(await world.db.rows("select owner from brain.extension_quiesce where name='testext'")).toEqual([]);
    expect(await world.ledger('testext')).toHaveLength(2);
  } finally { child?.kill('SIGKILL'); await blocker.query('rollback').catch(() => {}); await blocker.end().catch(() => {}); }
});

it('marketplace fixture entrypoint delegates its bundled package to the installed CLI', async () => {
  const { spawn } = await import('node:child_process'); const { chmod, mkdir } = await import('node:fs/promises');
  const world = await extHome(); cleanup.push(world.cleanup);
  const plugin = fileURLToPath(new URL('../../../plugins/testext/', import.meta.url));
  const cli = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
  const shim = join(world.home, 'bin', 'brain'); await mkdir(join(world.home, 'bin'), { recursive: true });
  await writeFile(shim, '#!/bin/sh\nexec "$TEST_NODE" "$TEST_CLI" "$@"\n'); await chmod(shim, 0o700);
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('sh', [join(plugin, 'bin/install.sh'), '--json'], { env: { ...world.env, CLAUDE_PLUGIN_ROOT: plugin, TEST_NODE: process.execPath, TEST_CLI: cli }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).data).toMatchObject({ name: 'testext', version: '0.1.0', plugin_version: '0.1.0', package_digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
});

it.each(['migration-gap', 'migration-duplicate', 'migration-filename', 'reports', 'staging', 'tokenstore', 'python-pin-missing', 'python-pin-invalid', 'python-pin-old', 'python-project-missing', 'python-lock-missing', 'python-venv-file', 'python-venv-entry', 'hex-digest-mismatch'] as const)(
  '외부 패키지 사전검사 %s 오류는 실제 CLI에서 거부하고 기존 상태를 보존한다', async kind => {
    const f = await packageFixture(), world = await extHome(); cleanup.push(world.cleanup);
    const first = await world.run(['ext', 'install', '--package', f.dir, '--json']); expect(first.code, first.stdout + first.stderr).toBe(0);
    const target = join(world.home, 'extensions/testext');
    const installed = await readFile(join(target, 'manifest.json'), 'utf8');
    const installedCode = await readFile(join(target, 'bin/check.mjs'), 'utf8');
    for (const folder of ['reports', 'staging', 'tokenstore']) { await mkdir(join(target, folder), { recursive: true }); await writeFile(join(target, folder, 'synthetic'), folder); }
    const snapshot = async () => ({ registry: await world.db.rows("select * from brain.extensions where name='testext'"), progress: await world.db.rows("select * from brain.extension_install_progress where name='testext'"), gate: await world.db.rows("select * from brain.extension_quiesce where name='testext'"), ledger: await world.ledger('testext') });
    const before = await snapshot(); f.manifest.version = '0.2.0';
    if (kind === 'migration-gap' || kind === 'migration-filename') {
      const path = kind === 'migration-gap' ? 'migrations/0002_only.sql' : 'migrations/abcd_bad.sql';
      await rm(join(f.dir, 'migrations/0001_testext.sql')); f.manifest.files = f.manifest.files.filter((x: string) => x !== 'migrations/0001_testext.sql');
      await writeFile(join(f.dir, path), 'select 1;\n'); f.manifest.files.push(path);
    }
    if (kind === 'migration-duplicate') { await writeFile(join(f.dir, 'migrations/0001_other.sql'), 'select 1;\n'); f.manifest.files.push('migrations/0001_other.sql'); }
    if (kind === 'reports' || kind === 'staging' || kind === 'tokenstore') {
      await mkdir(join(f.dir, kind)); await writeFile(join(f.dir, kind, 'entry.mjs'), 'export {};\n');
      f.manifest.files.push(`${kind}/entry.mjs`); f.manifest.connection_check.entry = `${kind}/entry.mjs`;
    }
    if (kind.startsWith('python-')) {
      f.manifest.connection_check = { runtime: 'python', entry: 'check.py' };
      await writeFile(join(f.dir, 'check.py'), 'print("ok")\n'); f.manifest.files.push('check.py');
      if (kind === 'python-venv-file' || kind === 'python-venv-entry') {
        await mkdir(join(f.dir, '.venv/bin'), { recursive: true });
        const path = kind === 'python-venv-file' ? '.venv/pyvenv.cfg' : '.venv/bin/entry.py';
        await writeFile(join(f.dir, path), 'synthetic'); f.manifest.files.push(path);
        if (kind === 'python-venv-entry') f.manifest.connection_check.entry = path;
      }
      for (const path of ['.python-version', 'pyproject.toml', 'uv.lock']) {
        if ((kind === 'python-pin-missing' && path === '.python-version') || (kind === 'python-project-missing' && path === 'pyproject.toml') || (kind === 'python-lock-missing' && path === 'uv.lock')) continue;
        const value = path === '.python-version' ? (kind === 'python-pin-invalid' ? '3.12\n' : kind === 'python-pin-old' ? '3.11.9\n' : '3.12.13\n') : '';
        await writeFile(join(f.dir, path), value); f.manifest.files.push(path);
      }
    }
    f.manifest.files.sort(); await f.seal();
    if (kind === 'hex-digest-mismatch') {
      expect(await readFile(join(f.dir, 'digest'), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
      await writeFile(join(f.dir, 'bin/check.mjs'), 'changed after sealing\n');
      await expect(prepareExtensionPackage(f.dir)).rejects.toThrow();
    }
    const rejected = await world.run(['ext', 'install', '--package', f.dir, '--json']);
    expect(rejected.body).toMatchObject({ ok: false, error: { code: 'EXTENSION_INVALID' } });
    expect(rejected.code).not.toBe(0); expect(await snapshot()).toEqual(before);
    expect(await readFile(join(target, 'manifest.json'), 'utf8')).toBe(installed);
    expect(await readFile(join(target, 'bin/check.mjs'), 'utf8')).toBe(installedCode);
    for (const folder of ['reports', 'staging', 'tokenstore']) expect(await readFile(join(target, folder, 'synthetic'), 'utf8')).toBe(folder);
  },
);

it('유효한 Python 외부 패키지는 정적 검사를 통과해 격리 환경에서 설치한다', async () => {
  const f = await packageFixture(), world = await extHome(); cleanup.push(world.cleanup);
  f.manifest.connection_check = { runtime: 'python', entry: 'check.py' };
  for (const [path, content] of Object.entries({ 'check.py': 'print("synthetic")\n', '.python-version': '3.12.13\n', 'pyproject.toml': '', 'uv.lock': '' })) { await writeFile(join(f.dir, path), content); f.manifest.files.push(path); }
  f.manifest.files.sort(); await f.seal();
  const bin = join(world.home, 'fake-bin'); await mkdir(bin);
  const uv = `#!/bin/sh
case "$1" in
  --version) exit 0;;
  python) echo /synthetic/python; exit 0;;
  sync) /bin/mkdir -p .venv/bin; /bin/cat > .venv/bin/python <<'PYTHON'
#!/bin/sh
if [ "$1" = "-c" ]; then echo 3.12.13; else echo '{"abi":1,"type":"result","summary":"synthetic"}'; fi
PYTHON
  /bin/chmod +x .venv/bin/python; exit 0;;
esac
exit 1
`;
  await writeFile(join(bin, 'uv'), uv); await chmod(join(bin, 'uv'), 0o755); (world.env as NodeJS.ProcessEnv).PATH = `${bin}:/usr/bin:/bin`;
  const result = await world.run(['ext', 'install', '--package', f.dir, '--json']);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.body.data).toMatchObject({ name: 'testext', package_digest: expect.stringMatching(/^[0-9a-f]{64}$/), python_environment: { status: 'succeeded' } });
});

it('탐색 중 상위 디렉터리를 외부 symlink로 교체해도 패키지를 거부한다', async () => {
  const f = await packageFixture();
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'outside-package-'))); cleanup.push(() => rm(outside, { recursive: true, force: true }));
  await cp(join(f.dir, 'bin'), outside, { recursive: true });
  await writeFile(join(outside, 'check.mjs'), 'outside bytes\n');
  let swapped = false;
  await expect(prepareExtensionPackage(f.dir, { async onDirectoryOpened(path) {
    if (path !== 'bin' || swapped) return;
    swapped = true; await rename(join(f.dir, 'bin'), join(f.dir, 'previous-bin')); await symlink(outside, join(f.dir, 'bin'));
  } })).rejects.toThrow();
  expect(swapped).toBe(true);
});

it('보충 평면 파일 목록과 digest를 Unicode 코드 포인트 순서로 처리한다', async () => {
  const f = await packageFixture();
  for (const path of ['bin/\ue000.txt', 'bin/\u{10000}.txt']) { await writeFile(join(f.dir, path), path); f.manifest.files.push(path); }
  f.manifest.files.sort(comparePackagePaths); await f.seal();
  expect(f.manifest.files.indexOf('bin/\ue000.txt')).toBeLessThan(f.manifest.files.indexOf('bin/\u{10000}.txt'));
  const prepared = await prepareExtensionPackage(f.dir); cleanup.push(prepared.cleanup);
  expect(`${prepared.digest}\n`).toBe(await readFile(join(f.dir, 'digest'), 'utf8'));
  expect(await readFile(join(prepared.dir, 'bin/\ue000.txt'), 'utf8')).toBe('bin/\ue000.txt');
  expect(await readFile(join(prepared.dir, 'bin/\u{10000}.txt'), 'utf8')).toBe('bin/\u{10000}.txt');
});

it('대기 중 디스크 build와 installed 신원이 함께 바뀌면 실행 중인 CLI는 무변경으로 거부한다', async () => {
  const { spawn } = await import('node:child_process'); const { withHomeInstallLock } = await import('../src/runtime/install-lock.js');
  const f = await packageFixture(), world = await extHome(); cleanup.push(world.cleanup);
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'isolated-cli-'))); cleanup.push(() => rm(sandbox, { recursive: true, force: true }));
  const app = join(sandbox, 'app'), dist = join(app, 'dist'); await mkdir(app);
  await cp(fileURLToPath(new URL('../dist/', import.meta.url)), dist, { recursive: true });
  await symlink(await realpath(fileURLToPath(new URL('../node_modules/', import.meta.url))), join(app, 'node_modules'));
  const buildPath = join(dist, 'build.json'), baseline = JSON.parse(await readFile(buildPath, 'utf8'));
  const marker = join(sandbox, 'captured'), preload = join(sandbox, 'preload.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; const read=fs.readFile; let marked=false; fs.readFile=async function(...args){const result=await read.apply(this,args); if(!marked&&String(args[0])===process.env.TEST_BUILD_PATH){marked=true; await fs.writeFile(process.env.TEST_CAPTURED,'captured');} return result;}; syncBuiltinESMExports();\n`);
  const before = { registry: await world.db.rows("select * from brain.extensions where name='testext'"), progress: await world.db.rows("select * from brain.extension_install_progress where name='testext'"), gate: await world.db.rows("select * from brain.extension_quiesce where name='testext'"), ledger: await world.ledger('testext') };
  let unlock!: () => void, acquired!: () => void;
  const locked = new Promise<void>(resolve => { acquired = resolve; });
  const holding = withHomeInstallLock(world.home, async () => { acquired(); await new Promise<void>(resolve => { unlock = resolve; }); }); await locked;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, [join(dist, 'bin.js'), 'ext', 'install', '--package', f.dir, '--json'], { env: { ...world.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, TEST_BUILD_PATH: buildPath, TEST_CAPTURED: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const done = new Promise<number | null>(resolve => child!.once('close', resolve));
    await expect.poll(async () => readFile(marker, 'utf8').catch(() => ''), { timeout: 10000 }).toBe('captured');
    expect(child.exitCode).toBeNull();
    const changed = { ...baseline, commit: baseline.commit === 'b'.repeat(40) ? 'c'.repeat(40) : 'b'.repeat(40) };
    await writeFile(buildPath, JSON.stringify(changed));
    await writeFile(join(world.home, 'installed.json'), JSON.stringify({ commit: changed.commit, schema_version: changed.schema_version, node: process.execPath, plugin_root: null, installed_at: new Date(0).toISOString() }));
    unlock(); await holding; const code = await done; child = undefined;
    expect(code, stdout + stderr).not.toBe(0); expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: 'EXTENSION_INVALID' } });
    expect({ registry: await world.db.rows("select * from brain.extensions where name='testext'"), progress: await world.db.rows("select * from brain.extension_install_progress where name='testext'"), gate: await world.db.rows("select * from brain.extension_quiesce where name='testext'"), ledger: await world.ledger('testext') }).toEqual(before);
    await expect(readFile(join(world.home, 'extensions/testext/manifest.json'))).rejects.toThrow();
  } finally { unlock(); await holding; child?.kill('SIGKILL'); }
});

it.each(['digest', 'symlink', 'escape'] as const)('실제 CLI는 %s 패키지를 거부하고 기존 설치 상태를 보존한다', async kind => {
  const f=await packageFixture(), world=await extHome(); cleanup.push(world.cleanup);
  expect((await world.run(['ext','install','--package',f.dir,'--json'])).code).toBe(0);
  const snapshot=async()=>({registry:await world.db.rows("select * from brain.extensions where name='testext'"),progress:await world.db.rows("select * from brain.extension_install_progress where name='testext'"),gate:await world.db.rows('select * from brain.extension_quiesce'),ledger:await world.ledger('testext'),manifest:await readFile(join(world.home,'extensions/testext/manifest.json'),'utf8')});
  const before=await snapshot();
  if(kind==='digest') await writeFile(join(f.dir,'bin/check.mjs'),'tampered\n');
  if(kind==='symlink') { await rm(join(f.dir,'bin/check.mjs')); await symlink('../manifest.json',join(f.dir,'bin/check.mjs')); }
  if(kind==='escape') { f.manifest.files.push('../escape'); await writeFile(join(f.dir,'manifest.json'),JSON.stringify(f.manifest)); }
  const rejected=await world.run(['ext','install','--package',f.dir,'--json']);
  expect(rejected.code).not.toBe(0); expect(rejected.body).toMatchObject({ok:false,error:{code:'EXTENSION_INVALID'}});
  expect(await snapshot()).toEqual(before);
});

it.each(['before', 'during', 'after-result'] as const)('snapshot %s 취소는 임시 디렉터리를 정리한다', async phase => {
  const f = await packageFixture(), controller = new AbortController(); let stage: string | undefined;
  if (phase === 'before') controller.abort();
  await expect(prepareExtensionPackage(f.dir, {
    signal: controller.signal,
    async onStage(path) { stage = path; },
    async onDirectoryOpened() { if (phase === 'during') controller.abort(); },
    async onSnapshot() { if (phase === 'after-result') controller.abort(); },
  })).rejects.toThrow();
  if (phase === 'before') expect(stage).toBeUndefined();
  else { expect(stage).toBeDefined(); await expect(readFile(join(stage!, 'manifest.json'))).rejects.toThrow(); const { access } = await import('node:fs/promises'); await expect(access(stage!)).rejects.toThrow(); }
});

it('일반 파일을 lstat 직후 writer 없는 FIFO로 바꾸면 비차단으로 거부한다', async () => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const f = await packageFixture(); let swapped = false;
  await expect(prepareExtensionPackage(f.dir, { async onFileStated(path) {
    if (path !== 'bin/check.mjs') return;
    swapped = true; await rm(join(f.dir, path)); await promisify(execFile)('mkfifo', [join(f.dir, path)]);
  } })).rejects.toThrow();
  expect(swapped).toBe(true);
}, 10000);

it('실제 CLI는 snapshot 중 SIGINT를 전달해 자식을 종료하고 임시 snapshot을 정리한다', async () => {
  const { spawn } = await import('node:child_process'); const { access, readdir } = await import('node:fs/promises');
  const f = await packageFixture(), world = await extHome(); cleanup.push(world.cleanup);
  const temp = join(world.home, 'snapshot-tmp'), marker = join(world.home, 'worker-pid'), preload = join(world.home, 'snapshot-preload.mjs'); await mkdir(temp);
  await writeFile(preload, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
if (process.argv[1]?.endsWith('extension-package-worker.js')) { const original=fs.lstat; fs.lstat=async function(path,...args) { const value=await original.call(this,path,...args); if(path==='check.mjs') { await fs.writeFile(process.env.SNAPSHOT_MARKER,String(process.pid)); await new Promise(()=>{}); } return value; }; syncBuiltinESMExports(); }
`);
  const before = { registry: await world.db.rows('select * from brain.extensions'), gates: await world.db.rows('select * from brain.extension_quiesce'), ledger: await world.ledger('testext') };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'ext', 'install', '--package', f.dir, '--json'], { env: { ...world.env, TMPDIR: temp, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, SNAPSHOT_MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  try {
    await expect.poll(async () => readFile(marker, 'utf8').catch(() => ''), { timeout: 10000 }).toMatch(/^\d+$/);
    const pid = Number(await readFile(marker, 'utf8')); child.kill('SIGINT');
    expect(await done, stdout + stderr).not.toBe(0); expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: 'EXTENSION_INSTALL_CANCELLED' } });
    expect(() => process.kill(pid, 0)).toThrow(); expect(await readdir(temp)).toEqual([]); await expect(access(join(world.home, 'install.lock'))).rejects.toThrow();
    expect({ registry: await world.db.rows('select * from brain.extensions'), gates: await world.db.rows('select * from brain.extension_quiesce'), ledger: await world.ledger('testext') }).toEqual(before);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await done; }
}, 20000);
