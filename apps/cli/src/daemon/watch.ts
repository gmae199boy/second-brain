import { watch as fsWatch, type FSWatcher, type WatchListener } from 'node:fs';
import { errorLine } from 'second_brain';
import type { DaemonLog } from './log.js';

/** Group a turn's consecutive writes into one scan while staying inside ten seconds. */
export const DAEMON_WATCH_BATCH_MS = 2_000;

export type TranscriptWatchFunction = (
  folder: string,
  options: { recursive: true },
  listener: WatchListener<string>,
) => FSWatcher;

export interface TranscriptWatchOptions {
  folders: readonly string[];
  batchMs?: number;
  log: DaemonLog;
  onBatch(): void;
  watch?: TranscriptWatchFunction;
}

/** Watch events only wake the drain; its scan remains the source of work. */
export function startTranscriptWatch(options: TranscriptWatchOptions): {
  close(): void;
  retry(): Promise<void>;
} {
  const watch = options.watch ?? fsWatch;
  const states = [...new Set(options.folders)].map((folder) => ({
    folder,
    watcher: undefined as FSWatcher | undefined,
    failed: false,
  }));
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let logging = Promise.resolve();
  const log = (line: string): void => {
    logging = logging.then(() => options.log.write(line));
  };
  const changed: WatchListener<string> = (_event, filename) => {
    if (closed || (filename !== null && !filename.endsWith('.jsonl')) || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) options.onBatch();
    }, options.batchMs ?? DAEMON_WATCH_BATCH_MS);
  };
  const retry = async (): Promise<void> => {
    if (closed) return;
    for (const state of states) {
      if (state.watcher !== undefined) continue;
      const failed = (error: unknown): void => {
        state.watcher?.close();
        state.watcher = undefined;
        if (!closed && !state.failed) {
          state.failed = true;
          log(`파일 감시를 시작하거나 유지할 수 없습니다 — 폴더 ${state.folder}, 오류: ${errorLine(error)}`);
        }
      };
      try {
        const watcher = watch(state.folder, { recursive: true }, changed);
        state.watcher = watcher;
        watcher.on('error', (error) => {
          // An old watcher's late error must not close its replacement.
          if (state.watcher === watcher) failed(error);
        });
        state.failed = false;
        log(`파일 감시를 시작했습니다 — 폴더 ${state.folder}`);
      } catch (error) {
        failed(error);
      }
    }
    await logging;
  };
  void retry();
  return {
    retry,
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const state of states) {
        state.watcher?.close();
        state.watcher = undefined;
      }
    },
  };
}
