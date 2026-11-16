import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { extHome } from './ext-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
it('공개 catalog, guide schema와 이름 설치는 같은 fixture와 registry 상태를 사용한다', async () => {
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = await realpath(fixture.env.SECOND_BRAIN_TEST_EXTENSIONS);
  (fixture.env as NodeJS.ProcessEnv).SECOND_BRAIN_TEST_CATALOG = '1';
  const before = await fixture.run(['ext', 'catalog', '--json']);
  expect(before.body).toMatchObject({ ok: true, meta: { count: 2 }, data: [expect.objectContaining({ name: 'garmin', installed: false, login_required: true }), expect.objectContaining({ name: 'testext', installed: false, login_required: false })] });
  expect((await fixture.run(['ext', 'list', '--json'])).body.data).toEqual([]);
  const guide = await fixture.run(['guide', 'schema', 'ext', 'catalog', '--json']);
  expect(guide.body.data.commands[0]).toMatchObject({ verb: 'catalog', output_schema: { type: 'array', items: { required: ['name', 'version', 'description', 'login_required', 'installed'] } } });
  const first = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(first.code, first.stdout + first.stderr).toBe(0);
  const after = await fixture.run(['ext', 'catalog', '--json']);
  expect(after.body.data[1]).toEqual({ ...before.body.data[1], installed: true });
  expect((await fixture.run(['ext', 'install', 'testext', '--json'])).code).toBe(0);
  expect(await fixture.ledger('testext')).toHaveLength(1);
  expect((await fixture.run(['ext', 'install', 'unknownext', '--json'])).body.error.code).toBe('EXTENSION_NOT_FOUND');
  expect((await fixture.run(['ext', 'install', 'testext', '--package', '/bad', '--json'])).body.error.code).toBe('EXTENSION_NOT_FOUND');
});

it('변조된 카탈로그 digest는 목록과 이름 설치 모두 고정 오류로 거부한다', async () => {
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'catalog-corrupt-'))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL('./fixtures/extensions/catalog/', import.meta.url)), join(root, 'catalog'), { recursive: true });
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = root; (fixture.env as NodeJS.ProcessEnv).SECOND_BRAIN_TEST_CATALOG = '1';
  const digest = join(root, 'catalog/testext/digest'), original = await readFile(digest, 'utf8');
  await writeFile(digest, 'bad\n');
  expect((await fixture.run(['ext', 'catalog', '--json'])).body).toMatchObject({ ok: false, error: { code: 'EXTENSION_INVALID' } });
  expect((await fixture.run(['ext', 'install', 'testext', '--json'])).body).toMatchObject({ ok: false, error: { code: 'EXTENSION_INVALID' } });
  await writeFile(digest, original);
  expect((await fixture.run(['ext', 'catalog', '--json'])).body.ok).toBe(true);
});

it.each(['description', 'login_required'] as const)('정상 digest에서 catalog 필수 %s 누락은 목록과 이름 설치를 거부한다', async field => {
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'catalog-metadata-'))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL('./fixtures/extensions/catalog/', import.meta.url)), join(root, 'catalog'), { recursive: true });
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = root; (fixture.env as NodeJS.ProcessEnv).SECOND_BRAIN_TEST_CATALOG = '1';
  expect((await fixture.run(['ext', 'catalog', '--json'])).body.ok).toBe(true);
  const pack = join(root, 'catalog/testext'), path = join(pack, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')); delete manifest[field];
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  const hash = createHash('sha256');
  for (const file of manifest.files as string[]) {
    const name = Buffer.from(file), bytes = await readFile(join(pack, file));
    hash.update(`f${name.length}:`); hash.update(name); hash.update(`:${bytes.length}:`); hash.update(bytes);
  }
  await writeFile(join(pack, 'digest'), `${hash.digest('hex')}\n`);
  // The generic package verifier must accept this: only the catalog requires metadata.
  const { prepareExtensionPackage } = await import('../src/runtime/extension-package.js');
  const prepared = await prepareExtensionPackage(pack); await prepared.cleanup();
  const catalog = (await fixture.run(['ext', 'catalog', '--json'])).body;
  expect(catalog).toMatchObject({ ok: false, error: { code: 'EXTENSION_INVALID' } });
  expect(catalog.data).toBeUndefined();
  const install = (await fixture.run(['ext', 'install', 'testext', '--json'])).body;
  expect(install).toMatchObject({ ok: false, error: { code: 'EXTENSION_INVALID' } });
  expect((await fixture.run(['ext', 'list', '--json'])).body.data).toEqual([]);
});
