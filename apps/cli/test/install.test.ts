import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInstaller, runInstallerWithFlags } from '../src/install.js';
import { readConfig } from '../src/config/codec.js';
import { readInstalled } from '../src/install/installed.js';
import { installerDeps, pgDatabaseUrl } from './pg-home.js';
import { PgTestClient } from './pg-client.js';
import { tempHomes } from './temp-home.js';
import { withoutHarnessFolders } from './environment.js';
const temporary = tempHomes();
afterEach(() => temporary.cleanup());
async function world() {
  const home = await temporary.create('brain-install-');
  const env = withoutHarnessFolders({ ...process.env, SECOND_BRAIN_HOME: home });
  delete env.BRAIN_DATABASE_URL; delete env.DOCKER_HOST;
  const deps = await installerDeps(home, env); const lines: string[] = []; deps.log = line => lines.push(line);
  await rm(join(home, 'config.toml'));
  return { home, env, deps, lines, run: (args: string[] = ['--yes']) => runInstaller(args, env, deps) };
}
describe('real PG installer with machine commands injected', () => {
  it('installs an empty configuration home, records PG core schema and creates no database file', async () => {
    const kit = await world(); expect(await kit.run(), kit.lines.join('\n')).toBe(0);
    expect(await readConfig(kit.home)).toMatchObject({ ok: true, config: { storeUrlEnv: 'BRAIN_DATABASE_URL' } });
    const text = await readFile(join(kit.home, 'config.toml'), 'utf8');
    expect(text).not.toContain('brain.db'); expect(text).not.toContain('timezone');
    expect(await readdir(kit.home)).not.toContain('brain.db');
    expect((await stat(join(kit.home, '.env'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(kit.home, 'files'))).mode & 0o777).toBe(0o700);
    expect(await readInstalled(kit.home)).toMatchObject({ schema_version: 43, schema_versions: { core: 43 } });
  });
  it('reruns migrations and ownership idempotently and keeps stored settings', async () => {
    const kit = await world(); expect(await kit.run(), kit.lines.join('\n')).toBe(0);
    const db = new PgTestClient(pgDatabaseUrl(kit.home));
    try {
      const owners = await db.prepare('select * from users').all();
      const migrations = await db.prepare('select * from schema_migrations').all();
      await db.exec("update settings set value='Europe/Berlin' where key='timezone'");
      expect(await kit.run(), kit.lines.join('\n')).toBe(0);
      expect(await db.prepare('select * from users').all()).toEqual(owners);
      expect(await db.prepare('select * from schema_migrations').all()).toEqual(migrations);
      expect(await db.prepare("select value from settings where key='timezone'").get()).toEqual({ value: 'Europe/Berlin' });
    } finally { await db.close(); }
  });
  it('leaves an old file byte for byte and removes its config key on rewrite', async () => {
    const kit = await world(); const legacy = join(kit.home, 'old.db'); await writeFile(legacy, 'legacy bytes');
    await writeFile(join(kit.home, 'config.toml'), `schema_version=1\n[store]\npath=${JSON.stringify(legacy)}\n`);
    const result = await runInstallerWithFlags({ connect: [], yes: true, help: false }, kit.env, kit.deps);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, report: { postgres: { legacy_sqlite_path: legacy } } });
    expect(await readFile(legacy, 'utf8')).toBe('legacy bytes');
    expect(await readFile(join(kit.home, 'config.toml'), 'utf8')).not.toContain(legacy);
    expect(kit.lines).toContain(`옛 SQLite 파일 ${legacy}는 지우지 않았고 더 쓰지 않습니다`);
  });
  it.each(['--store-path', '--database-url', '--unknown'])('rejects %s as usage', async flag => {
    const kit = await world(); expect(await kit.run([flag, '/tmp/db', '--yes'])).toBe(2);
    expect(kit.lines.join('\n')).toContain('USAGE');
  });
  it('requires noninteractive consent before installation', async () => {
    const kit = await world(); expect(await kit.run([])).toBe(3);
    expect(await readdir(kit.home)).not.toContain('postgres');
  });
});
