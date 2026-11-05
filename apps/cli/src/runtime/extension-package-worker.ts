/** A dedicated process gives this traversal a private cwd. Each directory is
 * entered only after checking its inode, and cwd pins it across renames. */
import { constants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { sep } from 'node:path';

type Identity = { dev: bigint; ino: bigint };
const identity = async (): Promise<Identity> => { const item = await stat('.', { bigint: true }); return { dev: item.dev, ino: item.ino }; };
const equal = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
function send(value: unknown): Promise<void> { return new Promise((resolve, reject) => { if (!process.send) return reject(new Error('IPC unavailable')); process.send(value, error => error ? reject(error) : resolve()); }); }
async function notify(relative: string, type = 'directory'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const response = (message: unknown) => { process.off('disconnect', disconnected); if (message === 'continue') resolve(); else reject(new Error('interrupted')); };
    const disconnected = () => { process.off('message', response); reject(new Error('disconnected')); };
    process.once('message', response); process.once('disconnect', disconnected);
    void send({ type, relative }).catch(error => { process.off('message', response); process.off('disconnect', disconnected); reject(error); });
  });
}
async function enter(name: string): Promise<Identity> {
  const entry = await lstat(name, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('invalid package directory');
  process.chdir(name);
  const actual = await identity(); if (!equal(entry, actual)) throw new Error('package directory changed');
  return actual;
}
async function run(): Promise<void> {
  const root = process.argv[2]; if (!root || !root.startsWith(sep)) throw new Error('invalid package root');
  process.chdir(sep);
  const chain: { name: string; parent: Identity; child: Identity }[] = [];
  for (const name of root.split(sep).filter(Boolean)) {
    const parent = await identity(), child = await enter(name); chain.push({ name, parent, child });
  }
  const files = new Map<string, Buffer>();
  async function walk(relative: string): Promise<void> {
    const parent = await identity(); await notify(relative);
    for (const entry of await readdir('.')) {
      const path = relative ? `${relative}/${entry}` : entry;
      const item = await lstat(entry, { bigint: true });
      if (item.isSymbolicLink()) throw new Error('package symlink');
      if (item.isDirectory()) {
        const child = await enter(entry); await walk(path);
        process.chdir('..'); if (!equal(parent, await identity())) throw new Error('package parent changed');
        const attached = await lstat(entry, { bigint: true });
        if (!attached.isDirectory() || attached.isSymbolicLink() || !equal(child, attached)) throw new Error('package directory changed');
      } else if (item.isFile()) {
        await notify(path, 'file');
        const file = await open(entry, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { const actual = await file.stat({ bigint: true }); if (!actual.isFile() || !equal(item, actual)) throw new Error('package file changed'); files.set(path, await file.readFile()); }
        finally { await file.close(); }
      } else throw new Error('invalid package entry');
    }
  }
  await walk('');
  for (const link of chain.reverse()) {
    process.chdir('..'); if (!equal(link.parent, await identity())) throw new Error('package parent changed');
    const attached = await lstat(link.name, { bigint: true });
    if (!attached.isDirectory() || attached.isSymbolicLink() || !equal(link.child, attached)) throw new Error('package root changed');
  }
  await send({ type: 'result', files });
}
let finished = false;
process.on('disconnect', () => { if (!finished) process.exit(1); });
run().then(() => { finished = true; process.disconnect?.(); }, async () => { try { await send({ type: 'error' }); } finally { finished = true; process.disconnect?.(); process.exitCode = 1; } });
