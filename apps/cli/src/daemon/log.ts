import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { encodeTextLine, type Clock } from 'second_brain';
import { daemonLogPath, daemonLogRotatedPath } from '../config/paths.js';

export const DAEMON_LOG_MAX_BYTES = 1_048_576;
export const DAEMON_LOG_KEEP = 5;

/**
 * The daemon's log: `<home>/log/daemon.log`, one line per thing worth knowing.
 *
 * A daemon has no envelope and nobody watching its terminal, so this file is
 * the only place it can say anything at all. It is not a sink in the sense of
 * `test/output-codecs.test.ts` — nothing here reaches stdout or stderr — but
 * the masking is the same rule and for the same reason: an error line is built
 * from whatever the code was holding when it broke, which is as likely to be a
 * secret as any other output (AD-11).
 *
 * A write that fails is swallowed. The daemon exists to work the backlog, and a
 * log file that cannot be written — a full disk, a folder somebody chmodded —
 * must not be what stops it. Writes are serialized, and the lock owner rotates
 * by rename before a whole line would exceed the limit. An oversized line is
 * kept whole even when it exceeds the limit on its own.
 */
export interface DaemonLog {
  /** One Korean sentence, stamped and masked. Never throws. */
  write(line: string): Promise<void>;
}

export function daemonLog(
  home: string,
  clock: Clock,
  options: { maxBytes?: number; keep?: number; rotate?: boolean } = {},
): DaemonLog {
  const path = daemonLogPath(home);
  const maxBytes = options.maxBytes ?? DAEMON_LOG_MAX_BYTES;
  const keep = options.keep ?? DAEMON_LOG_KEEP;
  let pending = Promise.resolve();
  return {
    write(line: string): Promise<void> {
      pending = pending.then(async () => {
        try {
          const encoded = `${clock.now().toISOString()} ${encodeTextLine(line)}\n`;
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          if (options.rotate !== false) {
            try {
              const size = await stat(path).then((file) => file.size, (error: unknown) => {
                if (isMissing(error)) return 0;
                throw error;
              });
              if (size > 0 && size + Buffer.byteLength(encoded) > maxBytes) {
                await ignoreMissing(() => unlink(daemonLogRotatedPath(home, keep)));
                for (let n = keep - 1; n >= 1; n -= 1) {
                  await ignoreMissing(() => rename(
                    daemonLogRotatedPath(home, n), daemonLogRotatedPath(home, n + 1),
                  ));
                }
                await ignoreMissing(() => rename(path, daemonLogRotatedPath(home, 1)));
              }
            } catch {
              // Rotation must not prevent this line from being appended.
            }
          }
          await appendFile(path, encoded, { encoding: 'utf8', mode: 0o600 });
        } catch {
          // See above: the log is not worth the daemon. Keep the chain usable.
        }
      });
      return pending;
    },
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

async function ignoreMissing(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
