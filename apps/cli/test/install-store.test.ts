import { chmod, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareFilesRoot } from '../src/install/store.js';
import { tempHomes } from './temp-home.js';
const temporary = tempHomes();
const scratch = () => temporary.create('brain-install-files-');
const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8);
afterEach(() => temporary.cleanup());
describe('prepareFilesRoot', () => {
  it('creates the root at 0700 and says it made it', async () => {
    const path = join(await scratch(), 'files');

    const result = await prepareFilesRoot(path);

    expect(result).toEqual({ ok: true, path, created: true });
    expect(await mode(path)).toBe('700');
  });

  it('answers FILES_UNAVAILABLE rather than throwing when a file is in the way', async () => {
    // `--store-path <home>/files` on an earlier run leaves exactly this.
    const path = join(await scratch(), 'files');
    await writeFile(path, '', 'utf8');

    const result = await prepareFilesRoot(path);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FILES_UNAVAILABLE');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('creates every folder on the way, and writes nothing into it (epic 2)', async () => {
    const path = join(await scratch(), 'nested', 'files');

    const result = await prepareFilesRoot(path);

    expect(result).toMatchObject({ ok: true, created: true });
    expect(await mode(path)).toBe('700');
    expect(await readdir(path)).toEqual([]);
  });

  it('says it created nothing the second time, and tightens a loose folder', async () => {
    const path = join(await scratch(), 'files');
    await prepareFilesRoot(path);
    await chmod(path, 0o755);

    const again = await prepareFilesRoot(path);

    expect(again).toEqual({ ok: true, path, created: false });
    expect(await mode(path)).toBe('700');
  });
});
