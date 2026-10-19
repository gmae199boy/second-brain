// A second process that claims a spool file and then never finishes, so a test
// can kill it and watch the next drain take the file back (AD-9).
//
// It has to be another process: the pid in a `.claiming` name is checked with
// `kill(pid, 0)`, and this process's own pid is always alive.
//
// Usage: node spool-claimer.mjs <spool folder>
// It prints the claimed handle on one line and then waits to be killed.

import { fileSpool } from '../../dist/runtime/spool.js';

const folder = process.argv[2];

const spool = fileSpool({ folder, clock: { now: () => new Date() } });
const claimed = await spool.claim();

if (!claimed.ok) {
  process.stderr.write(`${claimed.message}\n`);
  process.exit(1);
}
if (claimed.claim === null) {
  process.stderr.write('nothing to claim\n');
  process.exit(1);
}

process.stdout.write(`${claimed.claim.handle}\n`);

// The claim lives in the file name, not in this call stack, so holding the
// process open is the whole of what is left to do.
setInterval(() => {}, 60_000);
