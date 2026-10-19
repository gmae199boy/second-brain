// A second process that holds the database-wide write lock for a while, so a
// test can watch what an ingest does while it waits (AD-7).
//
// It has to be another process: two connections inside one process would wait
// on a lock nothing can release, because `node:sqlite` is synchronous and the
// waiting blocks the event loop the holder would need to let go.
//
// Usage: node lock-holder.mjs <path to brain.db> <holdMs>
// It prints `held` once the lock is taken, and `released` after the rollback.

import { DatabaseSync } from 'node:sqlite';

const [path, holdMs] = [process.argv[2], Number(process.argv[3])];

const database = new DatabaseSync(path, { timeout: 10_000 });
database.exec('begin immediate');
// A write, so the lock is really taken and not merely asked for. No table of
// this schema may be written to by a test — every one of them is immutable —
// so the holder makes a table of its own and rolls it back below, which leaves
// the schema exactly as it was.
database.exec('create table brain_lock_holder(x)');

process.stdout.write('held\n');

// The lock lives in SQLite, not in this call stack, so the transaction stays
// open across the timer and this process can still flush its output.
setTimeout(() => {
  database.exec('rollback');
  database.close();
  process.stdout.write('released\n');
}, holdMs);
