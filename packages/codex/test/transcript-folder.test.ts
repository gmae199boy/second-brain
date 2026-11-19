import { mkdtemp, mkdir, writeFile, rename, rm, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ parent: '', child: '' }));
vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof import('node:fs/promises')>();
  return { ...fs, readdir: async (...args: Parameters<typeof fs.readdir>) => {
    const entries = await fs.readdir(...args);
    if (String(args[0]) === race.parent) {
      race.parent = '';
      await fs.rm(race.child, { recursive: true });
      await fs.writeFile(race.child, 'replacement');
    }
    return entries;
  } };
});
import { codexTranscriptFolder } from '../src/index.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const content = (id: string, value = 'one') => JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n' + JSON.stringify({ value }) + '\n';
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'codex-folder-')); dirs.push(home);
  const active = join(home, 'sessions', '2026', '01', '01'); const archive = join(home, 'archived_sessions');
  await mkdir(active, { recursive: true }); await mkdir(archive, { recursive: true });
  return { home, active, archive };
}
describe('Codex transcript discovery', () => {
  it('discovers both roots by metadata, deduplicates copies and follows a move', async () => {
    const { home, active, archive } = await fixture();
    const a = join(active, 'different-name.jsonl'), b = join(archive, 'copy.jsonl');
    await writeFile(a, content('synthetic-id')); await copyFile(a, b);
    const folder = codexTranscriptFolder({ configDir: home });
    const first = await folder.list(); expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.files).toHaveLength(1); expect(first.files[0]).toMatchObject({ harnessSessionId: 'synthetic-id', path: a });
    await rm(b); await rename(a, b);
    const moved = await folder.list(); expect(moved.ok && moved.files[0]?.path).toBe(b);
  });
  it('reports different records sharing an id and malformed metadata', async () => {
    const { home, active, archive } = await fixture();
    await writeFile(join(active, 'a.jsonl'), content('synthetic-id'));
    await writeFile(join(archive, 'b.jsonl'), content('synthetic-id', 'two'));
    expect(await codexTranscriptFolder({ configDir: home }).list()).toMatchObject({ ok: false, message: expect.stringContaining('중복') });
    await rm(join(archive, 'b.jsonl')); await writeFile(join(archive, 'bad.jsonl'), '{}\n');
    expect(await codexTranscriptFolder({ configDir: home }).list()).toMatchObject({ ok: false });
  });
  it('treats absent roots as empty', async () => {
    const { home } = await fixture(); await rm(join(home, 'sessions'), { recursive: true }); await rm(join(home, 'archived_sessions'), { recursive: true });
    expect(await codexTranscriptFolder({ configDir: home }).list()).toEqual({ ok: true, files: [] });
  });
  it('defers empty and partial metadata without hiding complete sessions', async () => {
    const {home, active} = await fixture();
    await writeFile(join(active, 'empty.jsonl'), '');
    await writeFile(join(active, 'partial.jsonl'), '\n{"type":"session_meta"');
    await writeFile(join(active, 'valid.jsonl'), content('valid'));
    const listed = await codexTranscriptFolder({configDir:home}).list();
    expect(listed.ok && listed.files.map(file => file.harnessSessionId)).toEqual(['valid']);
    await writeFile(join(active, 'partial.jsonl'), '{}\n');
    expect(await codexTranscriptFolder({configDir:home}).list()).toMatchObject({ok:false});
  });
  it('does not follow external file or directory symlinks', async () => {
    const {home, active} = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'codex-external-')); dirs.push(outside);
    await writeFile(join(outside, 'external.jsonl'), content('external'));
    await writeFile(join(active, 'valid.jsonl'), content('valid'));
    await symlink(outside, join(active, 'external-dir'));
    await symlink(join(outside, 'external.jsonl'), join(active, 'external.jsonl'));
    const listed = await codexTranscriptFolder({configDir:home}).list();
    expect(listed.ok && listed.files.map(file => file.harnessSessionId)).toEqual(['valid']);
  });

});

it('reports a root that is a file as unreadable rather than empty', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-root-file-')); dirs.push(home);
  await writeFile(join(home, 'sessions'), 'not a directory');
  const result = await codexTranscriptFolder({ configDir: home }).list();
  expect(result.ok).toBe(false);
});

it('skips a child directory replaced by a file after enumeration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-race-')); dirs.push(home);
  const root = join(home, 'sessions');
  const child = join(root, 'replaced');
  await mkdir(child, { recursive: true });
  await writeFile(join(root, 'valid.jsonl'), content('valid'));
  race.parent = root; race.child = child;
  const result = await codexTranscriptFolder({ configDir: home }).list();
  expect(result.ok && result.files.map(file => file.harnessSessionId)).toEqual(['valid']);
});
