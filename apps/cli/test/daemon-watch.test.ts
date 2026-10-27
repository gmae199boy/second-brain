import { EventEmitter } from 'node:events';
import type { FSWatcher, WatchListener } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_WATCH_BATCH_MS, startTranscriptWatch, type TranscriptWatchFunction } from '../src/daemon/watch.js';
import { assertKoreanLines } from './language.js';
import { tempHomes } from './temp-home.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const temporary = tempHomes();
const cleanups: (() => void)[] = [];
afterEach(async () => {
  cleanups.splice(0).forEach((close) => close());
  vi.useRealTimers();
  await temporary.cleanup();
});

function fixture() {
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as FSWatcher;
  let event!: WatchListener<string>;
  const watch = vi.fn<TranscriptWatchFunction>((_folder, _options, listener) => {
    event = listener;
    return watcher;
  });
  const lines: string[] = [];
  const onBatch = vi.fn();
  const started = startTranscriptWatch({
    folders: ['temporary-projects'], watch, onBatch,
    log: { write: async (line) => { lines.push(line); } },
  });
  cleanups.push(started.close);
  return { ...started, watcher, watch, lines, onBatch, event: (name: string | null) => event('change', name) };
}

describe('transcript watch', () => {
  it('uses a fixed two-second window, then opens a fresh window', async () => {
    vi.useFakeTimers();
    const kit = fixture();
    expect(DAEMON_WATCH_BATCH_MS).toBe(2_000);
    kit.event('one.jsonl');
    await vi.advanceTimersByTimeAsync(1_500);
    kit.event('two.jsonl');
    await vi.advanceTimersByTimeAsync(500);
    expect(kit.onBatch).toHaveBeenCalledTimes(1);
    kit.event('three.jsonl');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(kit.onBatch).toHaveBeenCalledTimes(2);
    expect(kit.watch).toHaveBeenCalledWith('temporary-projects', { recursive: true }, expect.any(Function));
  });

  it('ignores other extensions, counts unknown names, and cancels on close', async () => {
    vi.useFakeTimers();
    const kit = fixture();
    kit.event('notes.txt');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(kit.onBatch).not.toHaveBeenCalled();
    kit.event(null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(kit.onBatch).toHaveBeenCalledOnce();
    kit.event('pending.jsonl');
    kit.close();
    kit.event(null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(kit.onBatch).toHaveBeenCalledOnce();
    expect(kit.watcher.close).toHaveBeenCalledOnce();
    await kit.retry();
    expect(kit.watch).toHaveBeenCalledOnce();
  });

  it('closes an errored watcher, logs a persistent failure once, and reports recovery', async () => {
    const kit = fixture();
    await kit.retry();
    kit.watcher.emit('error', new Error('감시 오류'));
    kit.watch.mockImplementation(() => { throw new Error('계속 실패'); });
    await kit.retry();
    await kit.retry();
    expect(kit.lines).toHaveLength(2);
    expect(kit.lines[1]).toContain('temporary-projects');
    expect(kit.watcher.close).toHaveBeenCalledOnce();
    const replacement = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as FSWatcher;
    kit.watch.mockReturnValue(replacement);
    await kit.retry();
    expect(kit.lines).toHaveLength(3);
    expect(kit.lines[2]).toContain('감시를 시작했습니다');
    kit.watcher.emit('error', new Error('늦은 오류'));
    expect(replacement.close).not.toHaveBeenCalled();
    assertKoreanLines(kit.lines.join('\n'), { label: 'watch log' });
  });

  it('retries a missing real folder without repeated failure lines', async () => {
    const parent = await temporary.create('brain-watch-');
    const folder = join(parent, 'projects');
    const lines: string[] = [];
    const kit = startTranscriptWatch({ folders: [folder], onBatch: vi.fn(), log: {
      write: async (line) => { lines.push(line); },
    } });
    cleanups.push(kit.close);
    await kit.retry();
    await kit.retry();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(folder);
    await mkdir(folder);
    await kit.retry();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('감시를 시작했습니다');
  });
});
