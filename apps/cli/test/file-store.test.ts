import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { contentHashOfBytes } from 'second_brain';
import { fileStoreContract } from 'second_brain/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { localFileStore } from '../src/runtime/file-store.js';
const roots: string[] = [];
async function scratch() { const root = await mkdtemp(join(tmpdir(), 'brain-files-')); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true, force:true}))); });
describe('로컬 FileStore', () => {
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
