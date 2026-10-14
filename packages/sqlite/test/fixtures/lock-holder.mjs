// A second process that holds the database-wide write lock for a while, so the
// test can measure what the first one does while it waits. It has to be another
// process: two connections inside one process would wait on a lock nothing can
// release, because `node:sqlite` is synchronous and the waiting blocks the
// event loop the holder would need to let go.
//
// Usage: node lock-holder.mjs <path> <holdMs>
// It prints `held` once the lock is taken, and `released` after the commit.

import { DatabaseSync } from 'node:sqlite';

const [path, holdMs] = [process.argv[2], Number(process.argv[3])];

const database = new DatabaseSync(path, { timeout: 10_000 });
database.exec('begin immediate');
// A write, so the lock is really taken and not merely asked for.
database.exec("insert into notes (id, body) values ('held', 'held')");

process.stdout.write('held\n');

// The lock lives in SQLite, not in this call stack, so the transaction stays
// open across the timer and this process can still flush its output.
setTimeout(() => {
  database.exec('commit');
  database.close();
  process.stdout.write('released\n');
}, holdMs);
