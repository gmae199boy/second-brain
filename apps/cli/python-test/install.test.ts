import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
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
    const env = await read('fixtures/process-abi/v1/env.json');
    const events = await read('fixtures/process-abi/v1/events.json');
    const runs = await read('fixtures/process-abi/v1/runs.json');
    const snapshots = await read('fixtures/process-abi/v1/settings-snapshots.json');
    const typescript = {
      manifests: manifests.map((c: any) => ({ name: c.name, verdict: manifest.decodeExtensionManifest(JSON.stringify(c.manifest)).ok })),
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
    for (const [fixtures, verdicts] of [[manifests, typescript.manifests], [env, typescript.env], [snapshots, typescript['settings-snapshots']]] as const) {
      fixtures.forEach((fixture: any, i: number) => expect(verdicts[i]!.verdict, fixture.name).toBe(fixture.expect === 'valid'));
    }
    events.forEach((fixture: any, i: number) => expect(typescript.events[i]!.verdict, fixture.name).toBe(fixture.expect === 'valid' ? true : fixture.code));
    runs.forEach((fixture: any, i: number) => expect(typescript.runs[i]!.verdict, fixture.name).toEqual(fixture.expect));
    const python = JSON.parse(execFileSync(join(directory, '.venv/bin/python'), [join(directory, 'judge.py'), core], { encoding: 'utf8' }));
    for (const [file, cases] of Object.entries(typescript)) {
      expect(python[file], `${file}: 이름, 개수, 판정`).toEqual(cases);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
