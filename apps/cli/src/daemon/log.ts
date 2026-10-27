import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { encodeTextLine, type Clock } from 'second_brain';
import { daemonLogPath } from '../config/paths.js';

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
 * must not be what stops it. Story 9.9 adds rotation to this one function.
 */
export interface DaemonLog {
  /** One Korean sentence, stamped and masked. Never throws. */
  write(line: string): Promise<void>;
}

export function daemonLog(home: string, clock: Clock): DaemonLog {
  const path = daemonLogPath(home);
  return {
    async write(line: string): Promise<void> {
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await appendFile(path, `${clock.now().toISOString()} ${encodeTextLine(line)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch {
        // See above: the log is not worth the daemon.
      }
    },
  };
}
