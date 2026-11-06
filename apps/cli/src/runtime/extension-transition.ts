import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isExtensionName, validateMigrationNames } from 'second_brain';

/** Call under the home install lock and the extension advisory lock. The caller
 * owns the quiesce gate and must not release it while registry and files differ. */
export interface ExtensionTransitionJournal {
  name: string; owner: string; digest: string;
  phase: 'preparing' | 'prepared' | 'discarding' | 'switching' | 'active' | 'committing' | 'rolling_back' | 'rolled_back';
  hadPrevious: boolean | null;
}
type Rename = typeof rename;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export function extensionTransitions(home: string, move: Rename = rename) {
  const folder = resolve(home, 'extensions');
  const validName = (name: string) => { if (!isExtensionName(name)) throw new Error('invalid extension name'); };
  const journalPath = (name: string) => join(folder, `.transition-${name}.json`);
  const stagePath = (j: ExtensionTransitionJournal) => join(folder, `.transition-${j.name}-${j.owner}`);
  const targetPath = (j: ExtensionTransitionJournal) => join(folder, j.name);
  const exists = async (path: string) => { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } };
  async function tree(path: string): Promise<void> {
    const st = await lstat(path);
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new Error('invalid extension tree');
    if (st.isDirectory()) for (const child of await readdir(path)) await tree(join(path, child));
  }
  async function read(name: string): Promise<ExtensionTransitionJournal | null> {
    validName(name);
    let data: unknown;
    try { data = JSON.parse(await readFile(journalPath(name), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid transition journal');
    const j = data as Record<string, unknown>;
    if (Object.keys(j).sort().join(',') !== 'digest,hadPrevious,name,owner,phase' || j.name !== name || typeof j.owner !== 'string' || !uuid.test(j.owner) || typeof j.digest !== 'string' || !/^[a-f0-9]{64}$/.test(j.digest) || !['preparing','prepared','discarding','switching','active','committing','rolling_back','rolled_back'].includes(String(j.phase)) || !(j.hadPrevious === null || typeof j.hadPrevious === 'boolean')) throw new Error('invalid transition journal');
    if ((j.phase === 'preparing' || j.phase === 'prepared' || j.phase === 'discarding') !== (j.hadPrevious === null)) throw new Error('invalid transition phase');
    return j as unknown as ExtensionTransitionJournal;
  }
  async function save(j: ExtensionTransitionJournal): Promise<void> {
    const temp = join(folder, `.transition-write-${randomUUID()}`);
    try { await writeFile(temp, `${JSON.stringify(j)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temp, journalPath(j.name)); }
    finally { await rm(temp, { force: true }); }
  }
  async function owned(name: string, owner: string): Promise<ExtensionTransitionJournal> {
    const j = await read(name); if (!j || j.owner !== owner) throw new Error('transition owner mismatch'); return j;
  }
  async function prepare(input: { name: string; owner: string; digest: string; directory: string }): Promise<ExtensionTransitionJournal> {
    validName(input.name);
    if (!uuid.test(input.owner) || !/^[a-f0-9]{64}$/.test(input.digest)) throw new Error('invalid transition identity');
    await mkdir(folder, { recursive: true, mode: 0o700 }); await chmod(folder, 0o700);
    let j = await read(input.name);
    if (j && (j.owner !== input.owner || j.digest !== input.digest)) throw new Error('transition identity mismatch');
    if (!j) { j = { name: input.name, owner: input.owner, digest: input.digest, phase: 'preparing', hadPrevious: null }; await save(j); }
    if (j.phase !== 'preparing') return j;
    const stage = stagePath(j), staged = join(stage, 'new'), target = targetPath(j);
    // A crash during copying can leave an incomplete stage; only our own
    // pre-switch stage is discarded. The installed tree is still untouched.
    await rm(stage, { recursive: true, force: true }); await mkdir(stage, { mode: 0o700 });
    await tree(input.directory); await cp(input.directory, staged, { recursive: true, errorOnExist: true, force: false }); await tree(staged);
    if (await exists(target)) { const st = await lstat(target); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('invalid installed extension'); }
    for (const item of ['reports', 'staging', 'tokenstore']) {
      const previous = join(target, item), dest = join(staged, item);
      await rm(dest, { recursive: true, force: true });
      if (await exists(previous)) {
        const st = await lstat(previous);
        if (st.isSymbolicLink() || (item !== 'tokenstore' && !st.isDirectory()) || (!st.isDirectory() && !st.isFile())) throw new Error('invalid persistent extension data');
        await tree(previous); await cp(previous, dest, { recursive: true, errorOnExist: true, force: false });
      }
    }
    j = { ...j, phase: 'prepared' }; await save(j); return j;
  }
  async function activate(name: string, owner: string): Promise<string> {
    let j = await owned(name, owner), stage = stagePath(j), target = targetPath(j), staged = join(stage, 'new'), backup = join(stage, 'previous');
    if (j.phase === 'prepared') { j = { ...j, phase: 'switching', hadPrevious: await exists(target) }; await save(j); }
    if (j.phase === 'active') {
      if (!await exists(target) || await exists(staged) || (j.hadPrevious && !await exists(backup))) throw new Error('ambiguous active transition');
      return target;
    }
    if (j.phase !== 'switching') throw new Error('transition not prepared');
    const s = await exists(staged), b = await exists(backup), t = await exists(target);
    if (j.hadPrevious) {
      if (s && t && !b) await move(target, backup);
      else if (!(s && !t && b) && !(!s && t && b)) throw new Error('ambiguous transition state');
    } else if (b || (s && t) || (!s && !t)) throw new Error('ambiguous transition state');
    if (await exists(staged)) await move(staged, target);
    j = { ...j, phase: 'active' }; await save(j); return target;
  }
  async function commit(name: string, owner: string): Promise<void> {
    let j = await owned(name, owner);
    if (j.phase === 'active') { await activate(name, owner); j = { ...j, phase: 'committing' }; await save(j); }
    if (!await exists(targetPath(j))) throw new Error('missing active extension');
    if (j.phase !== 'committing') throw new Error('transition not active');
    await rm(stagePath(j), { recursive: true, force: true }); await rm(journalPath(name));
  }
  async function rollback(name: string, owner: string): Promise<void> {
    let j = await owned(name, owner);
    if (j.phase === 'preparing' || j.phase === 'prepared') { j = { ...j, phase: 'discarding' }; await save(j); }
    if (j.phase === 'discarding') { await rm(stagePath(j), { recursive: true, force: true }); await rm(journalPath(name), { force: true }); return; }
    if (j.phase === 'committing') throw new Error('committed transition cannot be rolled back');
    if (j.phase === 'rolled_back') { await rm(stagePath(j), { recursive: true, force: true }); await rm(journalPath(name)); return; }
    if (j.phase !== 'rolling_back') { j = { ...j, phase: 'rolling_back' }; await save(j); }
    const stage = stagePath(j), target = targetPath(j), staged = join(stage, 'new'), backup = join(stage, 'previous'), discarded = join(stage, 'discarded');
    const t = await exists(target), b = await exists(backup), s = await exists(staged), d = await exists(discarded);
    if (j.hadPrevious) {
      if (b && t && !d && !s) await move(target, discarded);
      else if (b && t) throw new Error('ambiguous rollback state');
      if (await exists(backup)) { if (await exists(target)) throw new Error('ambiguous rollback target'); await move(backup, target); }
      else if (!await exists(target) || (!s && !d)) throw new Error('missing rollback backup');
    } else if (t && !s && !d) await move(target, discarded);
    else if ((t && (s || d)) || b) throw new Error('ambiguous rollback state');
    j = { ...j, phase: 'rolled_back' }; await save(j);
    await rm(stage, { recursive: true, force: true }); await rm(journalPath(name));
  }
  async function stagedDirectory(name: string, owner: string): Promise<string> {
    const j = await owned(name, owner);
    if (j.phase !== 'prepared') throw new Error('transition stage not prepared');
    return join(stagePath(j), 'new');
  }
  async function refreshPreparedMigrations(input: { name: string; owner: string; source: string; migrations: string; digest: string; verify(stage: string): Promise<boolean> }): Promise<void> {
    const j = await owned(input.name, input.owner);
    if (j.phase !== 'prepared' || !/^[a-f0-9]{64}$/.test(input.digest)) throw new Error('transition not prepared');
    const parts = input.migrations.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('invalid migrations path');
    const stage = stagePath(j), root = join(stage, 'new');
    async function directory(base: string) {
      let path = base;
      for (const part of parts) { path = join(path, part); const st = await lstat(path); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('invalid migrations directory'); }
      return path;
    }
    const source = await directory(input.source), target = await directory(root);
    const sourceNames = await readdir(source), targetNames = await readdir(target);
    validateMigrationNames(sourceNames);
    for (const [dir, names] of [[source, sourceNames], [target, targetNames]] as const) for (const name of names) {
      const st = await lstat(join(dir, name)); if (!st.isFile() || st.isSymbolicLink()) throw new Error('invalid migration file');
    }
    // Temps live outside the package tree, so an interrupted copy never appears
    // in a package digest or reaches the migration runner.
    const temp = join(stage, 'migration-copy');
    await rm(temp, { recursive: true, force: true }); await mkdir(temp, { mode: 0o700 });
    try {
      for (const name of sourceNames.sort()) {
        const file = join(temp, name); await cp(join(source, name), file, { errorOnExist: true, force: false }); await move(file, join(target, name));
      }
      for (const name of targetNames) if (!sourceNames.includes(name)) await rm(join(target, name));
      if (!await input.verify(root)) throw new Error('corrected stage digest mismatch');
      await save({ ...j, digest: input.digest });
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  return { read, prepare, stagedDirectory, refreshPreparedMigrations, activate, commit, rollback };
}
