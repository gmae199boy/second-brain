// Holds the write lock of a database on the real schema, from another process,
// for a fixed time. `lock-holder.mjs` writes a row into the fixture schema's
// `notes`; the real schema has no table a test may write to, so this one
// creates a table of its own inside the transaction and rolls it back, which
// leaves the schema exactly as it was.
//
// Usage: node schema-lock-holder.mjs <path> <holdMs>
// It prints `held` once the lock is taken, and `released` after the rollback.

import { DatabaseSync } from 'node:sqlite';

const [path, holdMs] = [process.argv[2], Number(process.argv[3])];

const database = new DatabaseSync(path, { timeout: 10_000 });
database.exec('begin immediate');
// A write, so the lock is really taken and not merely asked for.
database.exec('create table brain_lock_holder(x)');

process.stdout.write('held\n');

setTimeout(() => {
  database.exec('rollback');
  database.close();
  process.stdout.write('released\n');
}, holdMs);
