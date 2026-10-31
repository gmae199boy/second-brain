import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileStore, ImportStore } from 'second_brain';
import { prepareImportVerification } from '../src/runtime/import-verification.js';

const location = { storeKind: 'local' as const, ownership: 'brain' as const, locator: 'private-location' };
function fixture() {
  const readVerification = async () => ({ ok: true as const, data: { tables: { health: [{ body_raw: Buffer.from([0, 255]), value_json: { encoding: 'jsonb-text-v1', data: '{"n":9007199254740993}' }, metadata_json: { type: 'Buffer', data: [0, 255] } }] }, files: [{ requestId: 'request', fileId: 'file', expectedHash: 'ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73', expectedSize: 7, storedHash: 'sha256:ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73', storedSize: 7, failed: false, redacted: false, deleted: false, location }] } });
  const files = { get: async () => ({ ok: true as const, bytes: Buffer.from('content') }) } as unknown as FileStore;
  return { source: 'example', workId: 'work', token: 'token', python: '/usr/bin/python3', now: () => new Date(), rawViews: [], imports: { readVerification } as unknown as ImportStore, files };
}
describe('반입 검증 스냅샷', () => {
  it('현재 파일을 다시 읽고 위치와 바이트를 제외한 비공개 원자 파일을 만든다', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'verify-')));
    try {
      const path = await prepareImportVerification({ ...fixture(), directory });
      const text = await readFile(path, 'utf8'); const result = JSON.parse(text);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(result).toMatchObject({ source: 'example', work_id: 'work', attempt_token: 'token', tables: { health: [{ body_raw: { encoding: 'base64', data: 'AP8=' }, value_json: { encoding: 'jsonb-text-v1', data: '{"n":9007199254740993}' }, metadata_json: { type: 'Buffer', data: [0, 255] } }] }, files: [{ status: 'available', size_bytes: 7, metadata_matches: true, sha256: 'ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73' }] });
      expect(text).not.toContain('private-location'); expect(text).not.toContain('content');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('사라진 파일을 현재 상태로 기록한다', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'verify-')));
    try {
      const f = fixture();
      f.files.get = async () => ({ ok: false, code: 'FILE_NOT_FOUND', message: '없음' });
      const path = await prepareImportVerification({ ...f, directory });
      expect(JSON.parse(await readFile(path, 'utf8')).files).toMatchObject([{ request_id: 'request', file_id: 'file', status: 'missing', sha256: null, size_bytes: null, metadata_matches: false }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('상위 경로 교체와 writer 실패를 거부한다', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'verify-')));
    try {
      await mkdir(join(root, 'actual')); await mkdir(join(root, 'actual', 'extension'));
      await symlink(join(root, 'actual'), join(root, 'alias'));
      await expect(prepareImportVerification({ ...fixture(), directory: join(root, 'alias', 'extension') })).rejects.toThrow('IMPORT_VERIFICATION_INVALID');
      await expect(prepareImportVerification({ ...fixture(), directory: join(root, 'actual', 'extension'), python: '/nonexistent/synthetic-python' })).rejects.toThrow('IMPORT_VERIFICATION_INVALID');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('writer 시작 직전 부모가 바뀌어도 외부에 쓰지 않는다', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'verify-')));
    try {
      const directory = join(root, 'extension'), outside = join(root, 'outside'), wrapper = join(root, 'python-wrapper');
      await mkdir(directory); await mkdir(outside);
      await writeFile(wrapper, `#!/usr/bin/python3\nimport os,sys\nos.rename(${JSON.stringify(directory)},${JSON.stringify(directory + '-old')})\nos.symlink(${JSON.stringify(outside)},${JSON.stringify(directory)})\nos.execv('/usr/bin/python3',['/usr/bin/python3',*sys.argv[1:]])\n`, { mode: 0o700 });
      await expect(prepareImportVerification({ ...fixture(), directory, python: wrapper })).rejects.toThrow('IMPORT_VERIFICATION_INVALID');
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('시도 교체와 심볼릭 링크 디렉터리를 거부한다', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'verify-')));
    try {
      const f = fixture(); let calls = 0; const original = f.imports.readVerification;
      f.imports.readVerification = async input => ++calls === 1 ? original(input) : { ok: false, code: 'stale', message: 'stale' };
      await expect(prepareImportVerification({ ...f, directory })).rejects.toThrow('IMPORT_VERIFICATION_INVALID');
      await symlink(tmpdir(), join(directory, 'verification-snapshots'));
      await expect(prepareImportVerification({ ...fixture(), directory })).rejects.toThrow('IMPORT_VERIFICATION_INVALID');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
