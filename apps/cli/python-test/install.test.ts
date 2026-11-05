import { readFile, mkdtemp, rm, cp, mkdir, writeFile, chmod, stat, rename, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('잠긴 Python fixture를 설치하고 연결을 기록한다', async () => {
  const fixture = await extHome();
  try {
    const installed = await fixture.run(['ext', 'install', 'pyfixture', '--json']);
    expect(installed, installed.stderr + installed.stdout).toMatchObject({ code: 0 });
    const directory = join(fixture.home, 'extensions', 'pyfixture');
    expect(execFileSync(join(directory, '.venv/bin/python'), ['-c', 'import platform; print(platform.python_version())'], { encoding: 'utf8' }).trim()).toBe((await readFile(join(directory, '.python-version'), 'utf8')).trim());
    await compareDistributedFixtures(directory);
    const status = await fixture.run(['ext', 'status', 'pyfixture', '--json']);
    expect(status.body.data).toMatchObject({ installed: true, connection: { status: 'connected' }, python_environment: { status: 'succeeded', code: null } });
  } finally { await fixture.cleanup(); }
});

it('설치와 마이그레이션 전에 uv 부재 실패를 기록한다', async () => {
  const fixture = await extHome();
  try {
    fixture.env.PATH = '';
    const installed = await fixture.run(['ext', 'install', 'pyfixture', '--json']);
    expect(installed.code).not.toBe(0);
    expect(installed.body).toMatchObject({ error: { code: 'EXTENSION_UV_NOT_FOUND' } });
    const status = await fixture.run(['ext', 'status', 'pyfixture', '--json']);
    expect(status.body.data).toMatchObject({ installed: false, python_environment: { status: 'failed', code: 'EXTENSION_UV_NOT_FOUND' } });
    expect(await fixture.ledger('pyfixture')).toEqual([]);
  } finally { await fixture.cleanup(); }
});

async function compareDistributedFixtures(directory: string) {
  const temporary = await mkdtemp(join(tmpdir(), 'brain-core-pack-'));
  try {
    const coreDirectory = fileURLToPath(new URL('../../../packages/core/', import.meta.url));
    const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: coreDirectory, encoding: 'utf8' }));
    execFileSync('tar', ['-xzf', join(temporary, pack[0].filename), '-C', temporary]);
    const core = join(temporary, 'package');
    const codec = await import(pathToFileURL(join(core, 'dist/process-abi/codec.js')).href);
    const manifest = await import(pathToFileURL(join(core, 'dist/extensions/manifest.js')).href);
    const read = async (path: string) => JSON.parse(await readFile(join(core, path), 'utf8'));
    const manifests = await read('fixtures/extensions/v1/manifests.json');
    const deepRecipe = await read('fixtures/extensions/v1/deep-schema.json');
    const env = await read('fixtures/process-abi/v1/env.json');
    const events = await read('fixtures/process-abi/v1/events.json');
    const runs = await read('fixtures/process-abi/v1/runs.json');
    const snapshots = await read('fixtures/process-abi/v1/settings-snapshots.json');
    const { validateSchema } = await import('../src/runtime/json-schema.js');
    const typescript = {
      manifests: manifests.map((c: any) => ({ name: c.name, verdict: manifest.decodeExtensionManifest(JSON.stringify(c.manifest), validateSchema).ok })),
      'deep-manifest': [{ name: deepRecipe.name, verdict: manifest.decodeExtensionManifest(JSON.stringify(manifests[0].manifest).replace(/}$/, `,\"commands\":[{\"name\":\"echo\",\"runtime\":\"node\",\"entry\":\"echo.mjs\",\"description\":\"조회\",\"input_schema\":${'{\"type\":\"object\",\"properties\":{\"x\":'.repeat(deepRecipe.depth)}{}${'}}'.repeat(deepRecipe.depth)},\"output_schema\":{\"type\":\"object\"},\"timeout_ms\":100,\"risk\":\"read\"}]}`), validateSchema).ok }],
      env: env.map((c: any) => ({ name: c.name, verdict: codec.decodeAbiEnv(c.env).ok })),
      events: events.map((c: any) => { const result = codec.decodeAbiLine(c.line); return { name: c.name, verdict: result.ok ? true : result.code }; }),
      runs: runs.map((c: any) => {
        const run = codec.createAbiRun();
        run.feed(c.stdout.map((part: any) => typeof part === 'string' ? part : part.repeat.repeat(part.count)).join(''));
        run.end(); const { message: _message, ...verdict } = run.verdict(c.exit);
        return { name: c.name, verdict };
      }),
      'settings-snapshots': snapshots.map((c: any) => ({ name: c.name, verdict: codec.decodeSettingsSnapshot(c.snapshot, 'testext', { 'testext.limit': 'number', 'testext.token': 'string' }).ok })),
    };
    expect(typescript['deep-manifest'][0]!.verdict).toBe(deepRecipe.expect === 'valid');
    for (const [fixtures, verdicts] of [[manifests, typescript.manifests], [env, typescript.env], [snapshots, typescript['settings-snapshots']]] as const) {
      fixtures.forEach((fixture: any, i: number) => expect(verdicts[i]!.verdict, fixture.name).toBe(fixture.expect === 'valid'));
    }
    events.forEach((fixture: any, i: number) => expect(typescript.events[i]!.verdict, fixture.name).toBe(fixture.expect === 'valid' ? true : fixture.code));
    runs.forEach((fixture: any, i: number) => expect(typescript.runs[i]!.verdict, fixture.name).toEqual(fixture.expect));
    const python = JSON.parse(execFileSync(join(directory, '.venv/bin/python'), [join(directory, 'judge.py'), core, fileURLToPath(new URL('../dist/runtime/json-schema.js', import.meta.url))], { encoding: 'utf8' }));
    for (const [file, cases] of Object.entries(typescript)) {
      expect(python[file], `${file}: 이름, 개수, 판정`).toEqual(cases);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}


it('Python 환경을 보존하고 최초 DDL 실패 뒤 앞 SQL을 반복하지 않는다', async () => {
  const fixture = await extHome();
  try {
    const roots = join(fixture.home, 'packages'), source = join(roots, 'pyresume');
    await mkdir(roots); await cp(fileURLToPath(new URL('../test/fixtures/extensions/pyfixture/', import.meta.url)), source, { recursive: true });
    for (const file of ['manifest.json', 'check.py']) {
      const path = join(source, file); await writeFile(path, (await readFile(path, 'utf8')).replaceAll('pyfixture', 'pyresume'));
    }
    await writeFile(join(source, 'migrations/0002_failure.sql'), 'select nonexistent_column;\n');
    const bin = join(fixture.home, 'fake-bin'), log = join(fixture.home, 'uv-log'); await mkdir(bin);
    const uv = execFileSync('which', ['uv'], { encoding: 'utf8' }).trim();
    await writeFile(join(bin, 'uv'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${uv}" "$@"\n`); await chmod(join(bin, 'uv'), 0o755);
    fixture.env.PATH = `${bin}:${process.env.PATH ?? ''}`; fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = roots;
    const failed = await fixture.run(['ext', 'install', 'pyresume', '--json']);
    expect(failed.body).toMatchObject({ ok: false, error: { code: 'MIGRATION_FAILED' }, data: { install: { failed_stage: 'migration' } } });
    expect(await fixture.ledger('pyresume')).toEqual([{ owner: 'pyresume', version: 1 }]);
    const owner = ((await fixture.db.rows("select progress from brain.extension_install_progress where name='pyresume'"))[0]!.progress as { transition: { owner: string } }).transition.owner;
    const stage = join(fixture.home, 'extensions', `.transition-pyresume-${owner}`, 'new');
    const marker = join(stage, '.venv/marker'); await writeFile(marker, 'preserved'); const inode = (await stat(marker)).ino;
    const uvCalls = await readFile(log, 'utf8'); expect(uvCalls).toContain('venv --relocatable'); expect(uvCalls).toContain('sync --frozen --no-dev --no-editable');
    const interpreter = join(stage, '.venv/bin/python'), savedInterpreter = `${interpreter}.saved`;
    await rename(interpreter, savedInterpreter);
    for (const damaged of ['missing', 'wrong-pin']) {
      if (damaged === 'wrong-pin') await writeFile(interpreter, '#!/bin/sh\necho 3.12.0\n', { mode: 0o755 });
      const denied = await fixture.run(['ext', 'install', 'pyresume', '--json']);
      expect(denied.body.error.code).toBe('EXTENSION_PYTHON_VERSION_MISMATCH');
      expect(await fixture.ledger('pyresume')).toEqual([{ owner: 'pyresume', version: 1 }]);
      const progress = ((await fixture.db.rows("select progress from brain.extension_install_progress where name='pyresume'"))[0]!.progress as { transition: { owner: string } });
      expect(progress.transition.owner).toBe(owner); expect((await stat(marker)).ino).toBe(inode);
    }
    await rm(interpreter, { force: true }); await rename(savedInterpreter, interpreter);
    await writeFile(join(source, 'migrations/0002_failure.sql'), 'select 1;\n');
    const resumed = await fixture.run(['ext', 'install', 'pyresume', '--json']);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(await readFile(log, 'utf8')).toBe(uvCalls);
    expect((await stat(join(fixture.home, 'extensions/pyresume/.venv/marker'))).ino).toBe(inode);
    await expect(stat(stage)).rejects.toThrow();
    expect(await fixture.ledger('pyresume')).toEqual([{ owner: 'pyresume', version: 1 }, { owner: 'pyresume', version: 2 }]);
  } finally { await fixture.cleanup(); }
});

it('build-system 프로젝트와 console entry가 stage 이동 뒤 실제로 실행된다', async () => {
  const fixture = await extHome();
  try {
    const roots = join(fixture.home, 'packages'), source = join(roots, 'pyresume'); await mkdir(roots);
    await cp(fileURLToPath(new URL('../test/fixtures/extensions/pyfixture/', import.meta.url)), source, { recursive: true });
    for (const file of ['manifest.json', 'check.py']) { const path = join(source, file); await writeFile(path, (await readFile(path, 'utf8')).replaceAll('pyfixture', 'pyresume')); }
    await writeFile(join(source, 'pyproject.toml'), `[project]\nname = "brain-relocation"\nversion = "1.0.0"\nrequires-python = ">=3.12"\ndependencies = ["jsonschema==4.25.1"]\n[project.scripts]\nrelocation-probe = "samplepkg:main"\n[build-system]\nrequires = []\nbuild-backend = "local_backend"\nbackend-path = ["."]\n`);
    await writeFile(join(source, 'local_backend.py'), `import os, zipfile\ndef build_wheel(wheel_directory, config_settings=None, metadata_directory=None):\n    os.makedirs('build', exist_ok=True)\n    open('build/backend-output', 'w').write('synthetic')\n    name = 'brain_relocation-1.0.0-py3-none-any.whl'\n    with zipfile.ZipFile(os.path.join(wheel_directory, name), 'w') as z:\n        z.writestr('samplepkg/__init__.py', "def main():\\n    print('console-ok')\\n")\n        z.writestr('samplepkg/data.txt', 'package-data-ok')\n        z.writestr('brain_relocation-1.0.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: brain-relocation\\nVersion: 1.0.0\\n')\n        z.writestr('brain_relocation-1.0.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: synthetic\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')\n        z.writestr('brain_relocation-1.0.0.dist-info/entry_points.txt', '[console_scripts]\\nrelocation-probe = samplepkg:main\\n')\n        z.writestr('brain_relocation-1.0.0.dist-info/RECORD', '')\n    return name\n`);
    const lockPath = join(source, 'uv.lock');
    const lockText = await readFile(lockPath, 'utf8');
    await writeFile(lockPath, lockText.replace('name = "brain-pyfixture"', 'name = "brain-relocation"').replace('source = { virtual = "." }', 'source = { editable = "." }'));
    const lock = await readFile(join(source, 'uv.lock')); fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = roots;
    const result = await fixture.run(['ext', 'install', 'pyresume', '--json']); expect(result.code, result.stdout + result.stderr).toBe(0); expect(result.body.data.connection.status).toBe('connected');
    const target = join(fixture.home, 'extensions/pyresume');
    await expect((await import('node:fs/promises')).readdir(join(fixture.home, 'extensions'))).resolves.toEqual(['pyresume']);
    const python = join(target, '.venv/bin/python');
    const probe = execFileSync(python, ['-c', "import importlib.resources, platform, jsonschema, samplepkg; print(platform.python_version()); print(importlib.resources.files('samplepkg').joinpath('data.txt').read_text()); print(jsonschema.__version__)"] , { encoding: 'utf8' });
    expect(probe.trim().split('\n')).toEqual(['3.12.13', 'package-data-ok', '4.25.1']);
    expect(execFileSync(join(target, '.venv/bin/relocation-probe'), [], { encoding: 'utf8' }).trim()).toBe('console-ok');
    expect(await readFile(join(source, 'uv.lock'))).toEqual(lock);
  } finally { await fixture.cleanup(); }
});


it('manifest.files package Python 환경을 중단 뒤 재사용하고 이동 후 실행한다', async () => {
  const fixture = await extHome();
  try {
    const roots = join(await realpath(fixture.home), 'packages'), source = join(roots, 'pyresume'); await mkdir(roots);
    await cp(fileURLToPath(new URL('../test/fixtures/extensions/pyfixture/', import.meta.url)), source, { recursive: true });
    for (const file of ['manifest.json', 'check.py']) { const path = join(source, file); await writeFile(path, (await readFile(path, 'utf8')).replaceAll('pyfixture', 'pyresume')); }
    await writeFile(join(source, 'pyproject.toml'), `[project]\nname = "brain-relocation"\nversion = "1.0.0"\nrequires-python = ">=3.12"\ndependencies = ["jsonschema==4.25.1"]\n[project.scripts]\nrelocation-probe = "samplepkg:main"\n[build-system]\nrequires = []\nbuild-backend = "local_backend"\nbackend-path = ["."]\n`);
    await writeFile(join(source, 'local_backend.py'), `import os, zipfile\ndef build_wheel(wheel_directory, config_settings=None, metadata_directory=None):\n    os.makedirs('build', exist_ok=True)\n    open('build/backend-output', 'w').write('synthetic')\n    os.makedirs('brain_relocation.egg-info', exist_ok=True)\n    open('brain_relocation.egg-info/PKG-INFO', 'w').write('synthetic')\n    name = 'brain_relocation-1.0.0-py3-none-any.whl'\n    with zipfile.ZipFile(os.path.join(wheel_directory, name), 'w') as z:\n        z.writestr('samplepkg/__init__.py', "def main():\\n    print('console-ok')\\n")\n        z.writestr('samplepkg/data.txt', 'package-data-ok')\n        z.writestr('brain_relocation-1.0.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: brain-relocation\\nVersion: 1.0.0\\n')\n        z.writestr('brain_relocation-1.0.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: synthetic\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')\n        z.writestr('brain_relocation-1.0.0.dist-info/entry_points.txt', '[console_scripts]\\nrelocation-probe = samplepkg:main\\n')\n        z.writestr('brain_relocation-1.0.0.dist-info/RECORD', '')\n    return name\n`);
    const lockPath = join(source, 'uv.lock');
    const lockText = await readFile(lockPath, 'utf8');
    await writeFile(lockPath, lockText.replace('name = "brain-pyfixture"', 'name = "brain-relocation"').replace('source = { virtual = "." }', 'source = { editable = "." }'));
    const files = ['.python-version', 'check.py', 'judge.py', 'local_backend.py', 'manifest.json', 'migrations/0001_pyfixture.sql', 'pyproject.toml', 'uv.lock'].sort();
    const manifestPath = join(source, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    Object.assign(manifest, { files, core_compat: { min: '0.0.0', max_exclusive: '1.0.0' }, plugin_version: '1.0.0' });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const contents = new Map(await Promise.all(files.map(async path => [path, await readFile(join(source, path))] as const)));
    const hash = createHash('sha256'); for (const path of files) { const bytes = contents.get(path)!, pathBytes = Buffer.from(path); hash.update(`f${pathBytes.length}:`); hash.update(pathBytes); hash.update(`:${bytes.length}:`); hash.update(bytes); }
    const digest = hash.digest('hex'); await writeFile(join(source, 'digest'), `${digest}\n`);
    const treeFiles = async (root: string) => {
      const found: string[] = [];
      const walk = async (relative: string): Promise<void> => { for (const entry of await readdir(join(root, relative), { withFileTypes: true })) { const path = relative ? `${relative}/${entry.name}` : entry.name; if (path === '.venv') continue; if (entry.isDirectory()) await walk(path); else { expect(entry.isFile()).toBe(true); found.push(path); } } };
      await walk(''); return found.sort();
    };

    const lock = contents.get('uv.lock')!, bin = join(fixture.home, 'fake-bin'), log = join(fixture.home, 'uv-log'), temp = join(fixture.home, 'scratch');
    await mkdir(bin); await mkdir(temp); const uv = execFileSync('which', ['uv'], { encoding: 'utf8' }).trim();
    await writeFile(join(bin, 'uv'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${uv}" "$@"\n`, { mode: 0o755 });
    fixture.env.PATH = `${bin}:${process.env.PATH ?? ''}`; fixture.env.TMPDIR = temp;
    const { default: pg } = await import('pg'); const blocker = new pg.Client({ connectionString: fixture.db.url });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await blocker.connect(); await blocker.query('begin'); await blocker.query('select pg_advisory_xact_lock($1)', [4919270911]);
      child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'ext', 'install', '--package', source, '--json'], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', childExited = false; child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; }); const exited = new Promise<void>(resolve => child!.once('close', () => { childExited = true; resolve(); }));
      await expect.poll(async () => { if (childExited) throw new Error(`install exited: ${output}`); const rows = await fixture.db.rows("select progress from brain.extension_install_progress where name='pyresume'"); return (rows[0]?.progress as any)?.stages?.environment?.status; }, { timeout: 10000 }).toBe('succeeded');
      const progress = (await fixture.db.rows("select progress from brain.extension_install_progress where name='pyresume'"))[0]!.progress as { transition: { owner: string } };
      const stage = join(fixture.home, 'extensions', `.transition-pyresume-${progress.transition.owner}`, 'new');
      const marker = join(stage, '.venv/marker'); await writeFile(marker, 'preserved'); const inode = (await stat(marker)).ino;
      const calls = await readFile(log, 'utf8'); expect(calls).toContain('sync --frozen --no-dev --no-editable');
      expect((await readdir(temp)).filter(name => name.startsWith('brain-python-build-'))).toEqual([]);
      expect(await treeFiles(stage)).toEqual([...files, 'digest'].sort());
      for (const path of files) expect(await readFile(join(stage, path))).toEqual(contents.get(path));
      await expect(stat(join(stage, 'build'))).rejects.toThrow();
      child.kill('SIGKILL'); await exited; child = undefined; await blocker.query('rollback');
      await rm(join(fixture.home, 'install.lock'), { recursive: true });
      const result = await fixture.run(['ext', 'install', '--package', source, '--json']);
      expect(result.code, result.stdout + result.stderr).toBe(0); expect(result.body.data).toMatchObject({ package_digest: digest, connection: { status: 'connected' } });
      expect(await readFile(log, 'utf8')).toBe(calls); expect((await stat(join(fixture.home, 'extensions/pyresume/.venv/marker'))).ino).toBe(inode);
      await expect(stat(stage)).rejects.toThrow(); expect((await readdir(temp)).filter(name => name.startsWith('brain-python-build-'))).toEqual([]);
    } finally { child?.kill('SIGKILL'); await blocker.query('rollback').catch(() => {}); await blocker.end().catch(() => {}); }
    const target = join(fixture.home, 'extensions/pyresume');
    await expect((await import('node:fs/promises')).readdir(join(fixture.home, 'extensions'))).resolves.toEqual(['pyresume']);
    const python = join(target, '.venv/bin/python');
    const probe = execFileSync(python, ['-c', "import importlib.resources, platform, jsonschema, samplepkg; print(platform.python_version()); print(importlib.resources.files('samplepkg').joinpath('data.txt').read_text()); print(jsonschema.__version__)"] , { encoding: 'utf8' });
    expect(probe.trim().split('\n')).toEqual(['3.12.13', 'package-data-ok', '4.25.1']);
    expect(execFileSync(join(target, '.venv/bin/relocation-probe'), [], { encoding: 'utf8' }).trim()).toBe('console-ok');
    expect(await readFile(join(source, 'uv.lock'))).toEqual(lock);
    expect(await treeFiles(source)).toEqual([...files, 'digest'].sort()); expect(await treeFiles(target)).toEqual([...files, 'digest'].sort());
    expect(await readFile(join(source, 'digest'), 'utf8')).toBe(`${digest}\n`); expect(await readFile(join(target, 'digest'), 'utf8')).toBe(`${digest}\n`);
    for (const path of files) { expect(await readFile(join(source, path))).toEqual(contents.get(path)); expect(await readFile(join(target, path))).toEqual(contents.get(path)); }
    await expect(stat(join(source, 'build'))).rejects.toThrow(); await expect(stat(join(target, 'build'))).rejects.toThrow();
  } finally { await fixture.cleanup(); }
});

it('Python 인증과 연결이 로컬 모듈을 import해도 환경과 인증을 반복하지 않는다', async () => {
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome();
  const controller = new AbortController();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const roots = join(fixture.home, 'packages'), source = join(roots, 'pyresume');
    await mkdir(roots); await cp(fileURLToPath(new URL('../test/fixtures/extensions/pyfixture/', import.meta.url)), source, { recursive: true });
    const manifestPath = join(source, 'manifest.json');
    const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replaceAll('pyfixture', 'pyresume'));
    manifest.auth = { kind: 'pyresume.login', execution: 'supervised', runtime: 'python', entry: 'auth.py' };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(source, 'helper.py'), 'VALUE = 1\n');
    await writeFile(join(source, 'auth.py'), "import helper, json\nprint(json.dumps({'abi': 1, 'type': 'result'}))\n");
    const check = (await readFile(join(source, 'check.py'), 'utf8')).replaceAll('pyfixture', 'pyresume');
    await writeFile(join(source, 'check.py'), 'import helper\n' + check);
    const bin = join(fixture.home, 'fake-bin'), log = join(fixture.home, 'uv-log'); await mkdir(bin);
    const uv = execFileSync('which', ['uv'], { encoding: 'utf8' }).trim();
    await writeFile(join(bin, 'uv'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${uv}" "$@"\n`); await chmod(join(bin, 'uv'), 0o755);
    fixture.env.PATH = `${bin}:${process.env.PATH ?? ''}`; fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = roots;
    daemon = runDaemon({ home: fixture.home, env: fixture.env, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25 } });
    const first = await fixture.run(['ext', 'install', 'pyresume', '--json']);
    expect(first.body.error.code).toBe('EXTENSION_LOGIN_REQUIRED');
    await expect.poll(async () => (await fixture.db.rows("select outcome from brain.work_items where kind='pyresume.login'"))[0]?.outcome, { timeout: 15000 }).toBe('succeeded');
    const beforeCalls = await readFile(log, 'utf8');
    const completed = await fixture.run(['ext', 'install', 'pyresume', '--json']);
    expect(completed.code, completed.stdout + completed.stderr).toBe(0);
    const again = await fixture.run(['ext', 'install', 'pyresume', '--json']);
    expect(again.code, again.stdout + again.stderr).toBe(0);
    expect(again.body.data).toEqual(completed.body.data);
    expect(await readFile(log, 'utf8')).toBe(beforeCalls);
    expect(await fixture.db.rows("select id from brain.work_items where kind='pyresume.login'")).toHaveLength(1);
    expect(await fixture.ledger('pyresume')).toEqual([{ owner: 'pyresume', version: 1 }]);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(fixture.home, 'extensions/pyresume/__pycache__'))).some(name => name.startsWith('helper.') && name.endsWith('.pyc'))).toBe(true);
    await writeFile(join(source, 'helper.py'), 'VALUE = 2\n');
    const changed = await fixture.run(['ext', 'install', 'pyresume', '--json']);
    expect(changed.body.error.code).toBe('EXTENSION_LOGIN_REQUIRED');
    await expect.poll(async () => (await fixture.db.rows("select count(*)::integer as count from brain.work_items where kind='pyresume.login' and outcome='succeeded'"))[0]?.count, { timeout: 15000 }).toBe(2);
    expect((await readFile(log, 'utf8')).length).toBeGreaterThan(beforeCalls.length);
  } finally { controller.abort(); await daemon; await fixture.cleanup(); }
});
