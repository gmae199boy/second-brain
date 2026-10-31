import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { FileStore, ImportStore } from 'second_brain';

/** 스냅샷은 현재 시도에만 전달하며 파일 위치와 바이트는 포함하지 않는다. */
export async function prepareImportVerification(input: { directory: string; source: string; workId: string; token: string; python: string; now: () => Date; rawViews: readonly string[]; imports: ImportStore; files: FileStore }): Promise<string> {
  const snapshot = await input.imports.readVerification({ ...input, now: input.now() });
  if (!snapshot.ok) throw Error('IMPORT_VERIFICATION_INVALID');
  const observations = [];
  for (const file of snapshot.data.files) {
    let status = file.redacted ? 'redacted' : file.deleted ? 'deleted' : file.failed ? 'failed' : file.fileId === null ? 'pending' : file.location === null ? 'missing' : 'available';
    let sha256: string | null = null; let size: number | null = null;
    if (status === 'available' && file.location) {
      const result = await input.files.get(file.location);
      if (!result.ok) status = result.code === 'FILE_NOT_FOUND' ? 'missing' : 'unavailable';
      else { sha256 = createHash('sha256').update(result.bytes).digest('hex'); size = result.bytes.length; }
    }
    observations.push({ request_id: file.requestId, file_id: file.fileId, status, sha256, size_bytes: size, request_sha256: file.expectedHash, request_size_bytes: file.expectedSize, stored_sha256: file.storedHash, stored_size_bytes: file.storedSize,
      metadata_matches: sha256 !== null && sha256 === file.expectedHash && `sha256:${sha256}` === file.storedHash && size === file.expectedSize && size === file.storedSize });
  }
  // 파일 I/O 동안 시도가 교체되었다면 이전 시도에 결과를 넘기지 않는다.
  if (!(await input.imports.readVerification({ ...input, now: input.now() })).ok) throw Error('IMPORT_VERIFICATION_INVALID');
  const directoryInfo = await lstat(input.directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw Error('IMPORT_VERIFICATION_INVALID');
  const base = await realpath(input.directory);
  if (base !== input.directory) throw Error('IMPORT_VERIFICATION_INVALID');
  const serialized = JSON.stringify({ version: 1, source: input.source, work_id: input.workId, attempt_token: input.token, tables: snapshot.data.tables, files: observations }, function (this: Record<string, unknown>, key, value: unknown) {
    const original = this[key];
    if (Buffer.isBuffer(original)) return { encoding: 'base64', data: original.toString('base64') };
    return value;
  });
  const name = await writePrivateSnapshot(input.python, base, serialized);
  return join(base, 'verification-snapshots', name);
}

// 고정된 core 코드만 실행하고, 내용은 인자가 아닌 표준 입력으로 전달한다.
const writer = String.raw`
import os, sys, stat, secrets
home = sys.argv[1]
fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
try:
    for part in home.split('/')[1:]:
        if not part: continue
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd); fd = child
    try: os.mkdir('verification-snapshots', 0o700, dir_fd=fd)
    except FileExistsError: pass
    child = os.open('verification-snapshots', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    os.close(fd); fd = child
    if stat.S_IMODE(os.fstat(fd).st_mode) & 0o077: raise ValueError('mode')
    name = secrets.token_hex(16) + '.json'
    temp = '.' + name + '.tmp'
    try:
        out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(out, 'wb') as f:
            while True:
                block = sys.stdin.buffer.read(65536)
                if not block: break
                f.write(block)
            f.flush(); os.fsync(f.fileno())
        os.rename(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try: os.unlink(temp, dir_fd=fd)
        except FileNotFoundError: pass
    sys.stdout.write(name)
finally: os.close(fd)
`;
function writePrivateSnapshot(python: string, directory: string, serialized: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-c', writer, directory], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; let failed = false;
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; if (output.length > 128) { failed = true; child.kill(); } });
    child.on('error', () => { failed = true; reject(Error('IMPORT_VERIFICATION_INVALID')); });
    child.stdin.on('error', () => { failed = true; });
    child.on('close', code => code === 0 && !failed && /^[0-9a-f]{32}\.json$/.test(output) ? resolve(output) : reject(Error('IMPORT_VERIFICATION_INVALID')));
    child.stdin.end(serialized);
  });
}
