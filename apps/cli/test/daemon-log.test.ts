import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeTextLine } from 'second_brain';
import { daemonLogPath, daemonLogRotatedPath } from '../src/config/paths.js';
import { DAEMON_LOG_KEEP, DAEMON_LOG_MAX_BYTES, daemonLog } from '../src/daemon/log.js';
import { tempHomes } from './temp-home.js';

const temporary = tempHomes();
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const clock = { now: () => new Date('2026-10-27T00:00:00.000Z') };
const encoded = (message: string) => `${clock.now().toISOString()} ${encodeTextLine(message)}\n`;
const message = (n: number) => `기록 ${String(n).padStart(4, '0')} — 온전한 문장입니다`;

afterEach(async () => {
  vi.mocked(rename).mockClear();
  await temporary.cleanup();
});

async function home() {
  return temporary.create('brain-daemon-log-');
}

async function contents(home: string, n = 0) {
  return readFile(n === 0 ? daemonLogPath(home) : daemonLogRotatedPath(home, n), 'utf8');
}

describe('daemon log rotation', () => {
  it('exports the production limits and the shared retained-file path', () => {
    expect(DAEMON_LOG_MAX_BYTES).toBe(1_048_576);
    expect(DAEMON_LOG_KEEP).toBe(5);
    expect(daemonLogRotatedPath('example', 3)).toBe(join('example', 'log', 'daemon.log.3'));
  });

  it('creates private files and appends unchanged stamped, masked lines below the limit', async () => {
    const folder = await home();
    const log = daemonLog(folder, clock, { maxBytes: 500 });
    const messages = ['기록 첫째\n다음 줄입니다', '기록 둘째입니다'];
    for (const line of messages) await log.write(line);
    expect(await contents(folder)).toBe(messages.map(encoded).join(''));
    expect(await readdir(dirname(daemonLogPath(folder)))).toEqual(['daemon.log']);
    expect((await stat(dirname(daemonLogPath(folder)))).mode & 0o777).toBe(0o700);
    expect((await stat(daemonLogPath(folder))).mode & 0o777).toBe(0o600);
  });

  it('allows exact equality and rotates before a whole UTF-8 line crosses the boundary', async () => {
    const folder = await home();
    const line = encoded(message(1));
    const log = daemonLog(folder, clock, { maxBytes: Buffer.byteLength(line) * 2 });
    await log.write(message(1));
    await log.write(message(2));
    expect(await readdir(dirname(daemonLogPath(folder)))).toEqual(['daemon.log']);
    await log.write(message(3));
    expect(await contents(folder, 1)).toBe(encoded(message(1)) + encoded(message(2)));
    expect(await contents(folder)).toBe(encoded(message(3)));
  });

  it('retains five bounded archives with a contiguous suffix after over ten limits of writes', async () => {
    const folder = await home();
    const maxBytes = 300;
    const log = daemonLog(folder, clock, { maxBytes });
    const count = 100;
    for (let n = 1; n <= count; n += 1) await log.write(message(n));
    expect(Buffer.byteLength(encoded(message(1))) * count).toBeGreaterThan(maxBytes * 10);
    expect((await readdir(dirname(daemonLogPath(folder)))).sort()).toEqual([
      'daemon.log', 'daemon.log.1', 'daemon.log.2', 'daemon.log.3', 'daemon.log.4', 'daemon.log.5',
    ]);
    let retained = '';
    for (const n of [5, 4, 3, 2, 1, 0]) {
      const text = await contents(folder, n);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxBytes);
      retained += text;
    }
    const lines = retained.trimEnd().split('\n');
    const first = Number(lines[0]!.match(/기록 (\d+)/)![1]);
    expect(first).toBeGreaterThan(1);
    expect(retained).toBe(Array.from({ length: count - first + 1 }, (_, i) => encoded(message(first + i))).join(''));
    expect(await contents(folder)).toMatch(new RegExp(`${message(count)}\n$`));
  });

  it('supports a smaller retention count with serialized concurrent writes in invocation order', async () => {
    const folder = await home();
    const log = daemonLog(folder, clock, { maxBytes: 300, keep: 2 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => log.write(message(i + 1))));
    const retained = await contents(folder, 2) + await contents(folder, 1) + await contents(folder);
    const first = Number(retained.match(/기록 (\d+)/)![1]);
    expect(retained).toBe(Array.from({ length: 11 - first }, (_, i) => encoded(message(first + i))).join(''));
    expect((await readdir(dirname(daemonLogPath(folder)))).sort()).toEqual([
      'daemon.log', 'daemon.log.1', 'daemon.log.2',
    ]);
  });

  it('keeps an oversized line whole in a new file, including when it is the first write', async () => {
    const folder = await home();
    const log = daemonLog(folder, clock, { maxBytes: 200 });
    const long = `긴 문장 ${'가'.repeat(200)}`;
    await log.write(long);
    expect(await contents(folder)).toBe(encoded(long));
    expect(await readdir(dirname(daemonLogPath(folder)))).toEqual(['daemon.log']);
    await log.write(message(1));
    expect(await contents(folder, 1)).toBe(encoded(long));
    await log.write(long);
    expect(await contents(folder, 1)).toBe(encoded(message(1)));
    expect(await contents(folder)).toBe(encoded(long));
  });

  it('appends the line when a retained-file rename fails and recovers on the next write', async () => {
    const folder = await home();
    const log = daemonLog(folder, clock, { maxBytes: 100 });
    await log.write(message(1));
    await writeFile(daemonLogRotatedPath(folder, 1), 'older\n');
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('rename denied'), { code: 'EACCES' }));
    await expect(log.write(message(2))).resolves.toBeUndefined();
    expect(await contents(folder)).toBe(encoded(message(1)) + encoded(message(2)));
    await log.write(message(3));
    expect(await contents(folder, 1)).toBe(encoded(message(1)) + encoded(message(2)));
    expect(await contents(folder)).toBe(encoded(message(3)));
  });

  it('also appends when an archive cannot be removed because it is a nonempty folder', async () => {
    const folder = await home();
    const log = daemonLog(folder, clock, { maxBytes: 100 });
    await log.write(message(1));
    await mkdir(daemonLogRotatedPath(folder, 5));
    await writeFile(join(daemonLogRotatedPath(folder, 5), 'blocker'), 'blocked');
    await expect(log.write(message(2))).resolves.toBeUndefined();
    expect(await contents(folder)).toBe(encoded(message(1)) + encoded(message(2)));
  });

  it('keeps the write chain usable after an append failure', async () => {
    const folder = await home();
    await mkdir(daemonLogPath(folder), { recursive: true });
    const log = daemonLog(folder, clock);
    await expect(log.write(message(1))).resolves.toBeUndefined();
    await rm(daemonLogPath(folder), { recursive: true });
    await log.write(message(2));
    expect(await contents(folder)).toBe(encoded(message(2)));
  });

  it('only appends when rotation is disabled even above the limit', async () => {
    const folder = await home();
    const log = daemonLog(folder, clock, { maxBytes: 1, rotate: false });
    await log.write(message(1));
    await log.write(message(2));
    expect(await contents(folder)).toBe(encoded(message(1)) + encoded(message(2)));
    expect(await readdir(dirname(daemonLogPath(folder)))).toEqual(['daemon.log']);
  });

  it('rotates at the actual default 1MiB boundary without losing either boundary line', async () => {
    const folder = await home();
    const log = daemonLog(folder, clock);
    const messages = Array.from({ length: 18 }, (_, i) => `기록 ${String(i)} ${'가'.repeat(20_000)}`);
    for (const line of messages) await log.write(line);
    const before = await contents(folder, 1);
    const after = await contents(folder);
    expect(Buffer.byteLength(before)).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
    expect(Buffer.byteLength(after)).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
    expect(before + after).toBe(messages.map(encoded).join(''));
    const boundary = before.trimEnd().split('\n').length;
    expect(before.endsWith(encoded(messages[boundary - 1]!))).toBe(true);
    expect(after.startsWith(encoded(messages[boundary]!))).toBe(true);
  });
});
