import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ImportStaging } from 'second_brain';
const run = promisify(execFile);
export function importStaging(home: string): ImportStaging {
  async function path(source: string, locator: string) {
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(source) || !locator || locator.startsWith('/') || locator.split('/').some(part => !part || part === '.' || part === '..') || locator.includes('\\') || /[\x00-\x1f\x7f]/.test(locator)) throw Error('경로 거부');
    const base = resolve(home, 'extensions', source, 'staging');
    const target = join(base, locator);
    for (const part of [resolve(home, 'extensions'), resolve(home, 'extensions', source), base, ...locator.split('/').map((_, i, parts) => join(base, ...parts.slice(0, i + 1)))]) {
      if ((await lstat(part)).isSymbolicLink()) throw Error('심볼릭 링크 거부');
    }
    const actualBase = await realpath(base), actual = await realpath(target);
    if (!actual.startsWith(`${actualBase}/`)) throw Error('경계 밖');
    return target;
  }
  return {
    async read(source, locator, maxBytes) {
      try {
        const target = await path(source, locator), handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat(); if (!stat.isFile() || stat.size > maxBytes) throw Error('파일 거부');
          const checkedPath = await path(source, locator), expected = await realpath(checkedPath);
          const current = await lstat(checkedPath);
          if (current.dev !== stat.dev || current.ino !== stat.ino) throw Error('파일 교체');
          // 열린 descriptor가 가리키는 실제 파일도 확인한다. 확인할 수 없으면 닫힌다.
          let opened: string;
          if (process.platform === 'linux') opened = await realpath(`/proc/self/fd/${handle.fd}`);
          else if (process.platform === 'darwin') {
            const result = await run('/usr/sbin/lsof', ['-a', '-p', String(process.pid), '-d', String(handle.fd), '-Fn'], { timeout: 5000, maxBuffer: 8192 });
            const names = result.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
            if (names.length !== 1) throw Error('descriptor 확인 실패');
            opened = names[0]!;
          } else throw Error('지원하지 않는 descriptor');
          if (opened !== expected) throw Error('descriptor 경계 밖');
          const bytes = await handle.readFile(); if (bytes.length !== stat.size) throw Error('크기 변경');
          return { ok: true, bytes };
        } finally { await handle.close(); }
      } catch { return { ok: false, code: 'IMPORT_FILE_INVALID', message: '파일 요청을 확인할 수 없습니다' }; }
    },
    async remove(source, locator) { try { await unlink(await path(source, locator)); } catch { /* 이미 제거됐거나 경로가 바뀌었다. */ } },
  };
}
