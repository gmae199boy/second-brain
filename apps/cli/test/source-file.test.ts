import { mkdtemp, mkdir, rm, stat, symlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { fileSourceReader } from '../src/runtime/source-file.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('읽기 전용 원본 파일', () => {
  it('일반 파일과 링크를 읽고 원본의 내용·mtime·권한을 보존한다', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'brain-source-')); folders.push(folder);
    const path = join(folder, 'note.md');
    const link = join(folder, 'link.md');
    await writeFile(path, 'neutral note', { mode: 0o640 });
    await symlink(path, link);
    const before = await stat(path);
    for (const source of [path, link]) {
      expect(await fileSourceReader().read(source, 64)).toEqual({ ok: true, bytes: new Uint8Array(Buffer.from('neutral note')) });
    }
    const after = await stat(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode).toBe(before.mode);
    expect(await readFile(path, 'utf8')).toBe('neutral note');
  });
  it('폴더·없는 파일·한도 초과는 실패 값이며 경로를 오류에 싣지 않는다', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'brain-source-')); folders.push(folder);
    const path = join(folder, 'file'); await writeFile(path, '1234');
    const directory = join(folder, 'directory'); await mkdir(directory);
    for (const source of [path, directory, join(folder, 'gone')]) {
      const result = await fileSourceReader().read(source, 3);
      expect(result).toEqual({ ok: false, message: '원본 파일을 읽을 수 없습니다' });
    }
    expect(await fileSourceReader().read(path, 4)).toMatchObject({ ok: true });
    await writeFile(path, '');
    expect(await fileSourceReader().read(path, 0)).toEqual({ ok: true, bytes: new Uint8Array() });
  });
});
