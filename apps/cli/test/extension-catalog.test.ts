import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { catalogCandidates, prepareCatalogCandidate, readCatalogCandidates } from '../src/runtime/extension-catalog.js';
import { testExtensionsFolder } from '../src/runtime/extensions.js';

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'brain-catalog-'))); cleanup.push(root);
  const home = join(root, 'home'), extensions = join(root, 'extensions');
  await cp(fileURLToPath(new URL('./fixtures/extensions/catalog/', import.meta.url)), join(extensions, 'catalog'), { recursive: true });
  return { root, home, extensions, env: { SECOND_BRAIN_TEST_EXTENSIONS: extensions, SECOND_BRAIN_TEST_CATALOG: '1' } };
}

it('고정 Garmin만 일반 목록에 넣고 격리 harness에서만 testext를 추가한다', async () => {
  const f = await fixture();
  expect((await readCatalogCandidates(f.home, {})).map(item => item.name)).toEqual(['garmin']);
  expect(await readCatalogCandidates(f.home, f.env)).toEqual([
    expect.objectContaining({ name: 'garmin', version: JSON.parse(await readFile(fileURLToPath(new URL('../../../plugins/garmin/package/manifest.json', import.meta.url)), 'utf8')).version, description: expect.any(String), login_required: true }),
    expect.objectContaining({ name: 'testext', description: '시험용 확장', login_required: false }),
  ]);
  expect((await catalogCandidates(join(homedir(), '.second_brain'), f.env)).map(item => item.name)).toEqual(['garmin']);
  const defaultHome = join(f.root, 'default-home'), alias = join(f.root, 'default-alias');
  await mkdir(defaultHome); await symlink(defaultHome, alias);
  expect(await testExtensionsFolder(alias, f.env, defaultHome)).toBeUndefined();
});

it('고정 후보 외 이름은 거부하고 snapshot은 원본 변경과 독립적이다', async () => {
  const f = await fixture();
  expect(await prepareCatalogCandidate(f.home, f.env, '../testext')).toBeNull();
  const prepared = await prepareCatalogCandidate(f.home, f.env, 'testext');
  expect(prepared).not.toBeNull();
  try {
    const original = await readFile(join(prepared!.dir, 'manifest.json'), 'utf8');
    await writeFile(join(f.extensions, 'catalog/testext/manifest.json'), '{}');
    expect(await readFile(join(prepared!.dir, 'manifest.json'), 'utf8')).toBe(original);
    await expect(readCatalogCandidates(f.home, f.env)).rejects.toThrow();
  } finally { await prepared!.cleanup(); }
});

it('digest 변조와 누락 또는 다른 이름의 패키지를 부분 성공 없이 거부한다', async () => {
  const f = await fixture();
  await writeFile(join(f.extensions, 'catalog/testext/digest'), 'bad\n');
  await expect(readCatalogCandidates(f.home, f.env)).rejects.toThrow();
  await rm(join(f.extensions, 'catalog/testext'), { recursive: true });
  await expect(readCatalogCandidates(f.home, f.env)).rejects.toThrow();
  await cp(fileURLToPath(new URL('../../../plugins/garmin/package/', import.meta.url)), join(f.extensions, 'catalog/testext'), { recursive: true });
  await expect(prepareCatalogCandidate(f.home, f.env, 'testext')).rejects.toThrow();
});
