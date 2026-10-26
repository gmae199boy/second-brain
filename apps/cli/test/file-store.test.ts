import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, mkdir, writeFile, readFile, readdir, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { brainLocator, contentHashOfBytes, externalLocator, externalPath, isExternalLocator } from 'second_brain';
import { fileStoreContract } from 'second_brain/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { localFileStore } from '../src/runtime/file-store.js';
const roots: string[] = [];
async function scratch() { const root = await mkdtemp(join(tmpdir(), 'brain-files-')); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true, force:true}))); });
describe('로컬 FileStore', () => {
  it('second_brain에서 external 코덱을 공개한다', () => {
    expect(externalLocator('/h/u/a', '/h/u')).toBe('~/a');
    expect(isExternalLocator('~/a')).toBe(true);
    expect(externalPath('~/a', '/h/u')).toBe('/h/u/a');
  });
  for (const c of fileStoreContract()) it(c.name, () => c.run(async () => localFileStore({root: join(await scratch(), 'files')})));
  it('생성자는 디스크를 건드리지 않고 폴더 0700과 파일 0600으로 쓴다', async () => {
    const root = join(await scratch(), 'files');
    const store = localFileStore({root});
    await expect(stat(root)).rejects.toMatchObject({code:'ENOENT'});
    const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,0]);
    const put = await store.put(bytes); expect(put.ok).toBe(true); if (!put.ok) return;
    expect(put.contentHash).toBe(contentHashOfBytes(bytes));
    expect(put.contentHash).toBe('sha256:' + createHash('sha256').update(bytes).digest('hex'));
    const path = join(root, put.location.locator);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    for (const folder of [root, dirname(dirname(path)), dirname(path)]) expect((await stat(folder)).mode & 0o777).toBe(0o700);
    const before = (await stat(path)).mtimeMs;
    await store.put(bytes); expect((await stat(path)).mtimeMs).toBe(before);
    expect((await store.url(put.location))).toEqual({ok:true,url:new URL('file://' + path).href});
  });
  it('루트가 파일이면 예외 없이 저장 실패를 돌려준다', async () => {
    const root = join(await scratch(), 'file'); await writeFile(root, 'x');
    expect(await localFileStore({root}).put(Uint8Array.of(1))).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'});
  });
  it('이미 있는 0700 루트 아래에 폴더 0700과 파일 0600을 만든다', async () => {
    const root = join(await scratch(), 'files');
    await mkdir(root, { mode: 0o700 });
    const put = await localFileStore({root}).put(Uint8Array.of(4, 5, 6));
    expect(put.ok).toBe(true); if (!put.ok) throw new Error('저장 실패');
    const path = join(root, put.location.locator);
    for (const folder of [root, dirname(dirname(path)), dirname(path)]) expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it('블롭 파일 링크의 모든 연산과 같은 바이트 쓰기를 거부하고 바깥 파일을 보존한다', async () => {
    const root = join(await scratch(), 'files');
    const outside = join(await scratch(), 'source');
    const bytes = Uint8Array.of(7, 8, 9);
    await writeFile(outside, bytes);
    const store = localFileStore({root});
    const put = await store.put(bytes);
    expect(put.ok).toBe(true); if (!put.ok) throw new Error('저장 실패');
    const path = join(root, put.location.locator);
    await rm(path);
    await symlink(outside, path);
    for (const op of [store.get, store.exists, store.url, store.delete]) {
      expect(await op(put.location)).toMatchObject({ok:false,code:'LOCATION_REFUSED'});
    }
    expect(await store.put(bytes)).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'});
    expect(new Uint8Array(await readFile(outside))).toEqual(bytes);
    expect((await stat(outside)).isFile()).toBe(true);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });
  it('하위 폴더 링크를 통한 새 바이트 쓰기는 바깥에 파일을 만들지 않는다', async () => {
    const root = join(await scratch(), 'files');
    const outside = await scratch();
    const bytes = Uint8Array.of(10, 11, 12);
    const locator = brainLocator(contentHashOfBytes(bytes).slice(7), bytes);
    await mkdir(root, {mode:0o700});
    await symlink(outside, join(root, locator.slice(0, 2)));
    expect(await localFileStore({root}).put(bytes)).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'});
    expect(await readdir(outside)).toEqual([]);
  });
  it('남은 임시 파일은 저장과 읽기에 영향을 주지 않고 위치로도 접근할 수 없다', async () => {
    const root = join(await scratch(), 'files');
    const store = localFileStore({root});
    const bytes = Uint8Array.of(13, 14, 15);
    const locator = brainLocator(contentHashOfBytes(bytes).slice(7), bytes);
    const folder = dirname(join(root, locator));
    await mkdir(folder, {recursive:true, mode:0o700});
    const temporaryName = `.${randomUUID()}.tmp`;
    const temporary = join(folder, temporaryName);
    const leftover = Uint8Array.of(16, 17, 18);
    await writeFile(temporary, leftover, {mode:0o600});
    for (const data of [bytes, bytes, Uint8Array.of(19, 20, 21)]) {
      const put = await store.put(data);
      expect(put.ok).toBe(true); if (!put.ok) throw new Error('저장 실패');
      expect(await store.get(put.location)).toEqual({ok:true,bytes:data});
    }
    const location = {storeKind:'local' as const, ownership:'brain' as const, locator:locator.slice(0, 6) + temporaryName};
    for (const op of [store.get, store.exists, store.url, store.delete]) {
      expect(await op(location)).toMatchObject({ok:false,code:'LOCATION_REFUSED'});
    }
    expect(new Uint8Array(await readFile(temporary))).toEqual(leftover);
  });
  it('하위 심볼릭 링크가 밖을 가리키면 읽기와 삭제를 거부한다', async () => {
    const root = join(await scratch(),'files'); const outside = await scratch();
    const store = localFileStore({root}); const put = await store.put(Uint8Array.of(3));
    if (!put.ok) throw new Error('저장 실패');
    const first = put.location.locator.slice(0,2);
    await rm(join(root,first),{recursive:true}); await mkdir(join(outside,put.location.locator.slice(3,5)),{recursive:true});
    await symlink(outside,join(root,first));
    expect(await store.get(put.location)).toMatchObject({ok:false,code:'LOCATION_REFUSED'});
    expect(await store.delete(put.location)).toMatchObject({ok:false,code:'LOCATION_REFUSED'});
  });
});
