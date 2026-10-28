import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePgHome, pgRunner, runPgCommand, pgDatabaseUrl } from './pg-home.js';
import { PgTestClient } from './pg-client.js';
import { tempHomes } from './temp-home.js';
import { withoutHarnessFolders } from './environment.js';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';
import { assertKoreanLines } from './language.js';
import { writeShim } from '../src/install/shim.js';
const temporary = tempHomes();
afterEach(() => temporary.cleanup());
async function world() {
  const home = await temporary.create('brain-doctor-'); await preparePgHome(home);
  const env = withoutHarnessFolders({ ...process.env, SECOND_BRAIN_HOME: home }); delete env.BRAIN_DATABASE_URL; delete env.DOCKER_HOST;
  return { home, env, run: (args = ['doctor', 'run', '--json']) => runPgCommand(args, env) };
}
describe('PG doctor', () => {
  it('reports PG checks and no SQLite file checks when the store table is absent', async () => {
    const kit = await world();
    await writeFile(join(kit.home, 'config.toml'), 'schema_version=1\n');
    // world() removes the inherited process URL; the isolated home's .env supplies the test DB.
    expect(kit.env).not.toHaveProperty('BRAIN_DATABASE_URL');
    const result = await kit.run();
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    for (const id of ['orbstack', 'container', 'db', 'writable', 'pg_trgm', 'schema-version']) {
      expect(envelope.data.checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
    }
    const ids = envelope.data.checks.map((check: { id: string }) => check.id);
    for (const id of ['db-path', 'db-file', 'store-path', 'wal', 'fts5-trigram', 'foreign-keys']) {
      expect(ids).not.toContain(id);
    }
  });

  it('reports PG prerequisites and adapter checks, with no SQLite file checks', async () => {
    const kit = await world(); const result = await kit.run(); expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    for (const id of ['orbstack', 'container', 'db', 'writable', 'pg_trgm', 'schema-version']) expect(envelope.data.checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
    for (const id of ['wal', 'foreign-keys', 'fts5-trigram']) expect(envelope.data.checks.map((c: { id: string }) => c.id)).not.toContain(id);
    expect(envelope.data.checks).toContainEqual(expect.objectContaining({ id: 'daemon', status: 'warn' }));
    expect(envelope.data.summary.failed).toBe(0);
  });
  it('prints Korean checks and a summary in text mode', async () => {
    const result = await (await world()).run(['doctor', 'run']); expect(result.code).toBe(0); assertKoreanLines(result.stdout, { allow: ['Debian', 'pgdg13'] });
  });
  it('warns on unknown configuration keys without dropping healthy checks', async () => {
    const kit = await world(); await appendFile(join(kit.home, 'config.toml'), '\n[custom]\ncolour="blue"\n');
    const result = await kit.run(); expect(result.code).toBe(0); expect(JSON.parse(result.stdout).warnings).toContain('CONFIG_UNKNOWN_KEY');
  });
  it('warns on ignored file timezone in every PG home', async () => {
    const kit = await world(); await writeFile(join(kit.home, 'config.toml'), 'schema_version=1\ntimezone="Europe/Berlin"\n');
    const result = await kit.run(); expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.checks).toContainEqual(expect.objectContaining({ id: 'config-timezone', status: 'warn' }));
  });
  it('reports an unavailable database without creating a local file', async () => {
    const kit = await world(); kit.env.BRAIN_DATABASE_URL = 'postgresql://unused@127.0.0.1:1/unavailable';
    const result = await kit.run(); expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).data.checks).toContainEqual(expect.objectContaining({ id: 'db', status: 'fail', code: 'DB_UNAVAILABLE' }));
    for (const name of ['brain.db', 'brain.db-wal', 'brain.db-shm']) {
      expect(await readdir(kit.home)).not.toContain(name);
    }
  });
  it('reports owner-specific schema mismatch', async () => {
    const kit = await world(); const db = new PgTestClient(pgDatabaseUrl(kit.home));
    try { await db.exec("update schema_migrations set version=2 where owner='core'"); const result = await kit.run(); expect(result.code).toBe(1); expect(JSON.parse(result.stdout).data.checks).toContainEqual(expect.objectContaining({ id: 'schema-version', status: 'fail' })); }
    finally { await db.close(); }
  });
  it('skips DB checks when the fake OrbStack prerequisite fails and never calls compose', async () => {
    const kit = await world(); let stdout = ''; const calls: string[] = [];
    const code = await dispatch(commands, ['doctor', 'run', '--json'], { env: kit.env, clock: { now: () => new Date() }, stdout: s => { stdout += s; }, runner: async request => { calls.push(request.command); return { ok: true, stdout: 'Stopped', stderr: '' }; } });
    expect(code).toBe(1); expect(calls).toEqual(['orb']);
    expect(JSON.parse(stdout).data.checks).toContainEqual({ id: 'db', status: 'skip', detail: '앞선 점검 실패: orbstack' });
  });
  it('reports a spool entry and keeps healthy DB checks', async () => {
    const kit = await world(); await mkdir(join(kit.home, 'spool')); await writeFile(join(kit.home, 'spool', 'invalid.jsonl'), 'invalid\n');
    const result = await kit.run();
    expect(result.code).toBe(0);
    const checks = JSON.parse(result.stdout).data.checks;
    expect(checks).toContainEqual({ id: 'spool', status: 'warn', code: 'SPOOLED', detail: '1건' });
    for (const id of ['db', 'writable', 'pg_trgm', 'schema-version']) {
      expect(checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
    }
  });
});

describe('brain doctor run without a configuration it can read', () => {
  async function emptyHome() {
    const home = await temporary.create('brain-doctor-no-config-');
    const env = withoutHarnessFolders({ ...process.env, SECOND_BRAIN_HOME: home });
    delete env.DOCKER_HOST;
    return { home, run: (args = ['doctor', 'run', '--json']) => runPgCommand(args, env) };
  }

  it('exits 1, not 2, and reports config and db as failures when there is no file', async () => {
    const kit = await emptyHome();
    await writeShim(kit.home, { bin: fileURLToPath(new URL('../dist/bin.js', import.meta.url)) });

    const run = await kit.run();

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeUndefined();
    const checks = envelope.data.checks;
    expect(checks).toContainEqual(expect.objectContaining({ id: 'config', status: 'fail', code: 'CONFIG_MISSING' }));
    expect(checks).toContainEqual(expect.objectContaining({ id: 'db', status: 'fail', code: 'DB_UNAVAILABLE', detail: expect.stringContaining('설정을 읽을 수 없어서') }));
    for (const id of ['orbstack', 'container', 'shim', 'node-path', 'node-version']) {
      expect(checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
    }
    expect(checks.map((check: { id: string }) => check.id)).toEqual([
      'orbstack', 'container', 'db', 'schema-version', 'failures', 'untagged', 'transcripts',
      'config', 'config-timezone', 'shim', 'node-path', 'node-version', 'plugin', 'last-hook', 'spool', 'daemon',
    ]);
    expect(checks).toContainEqual({ id: 'schema-version', status: 'skip', detail: '앞선 점검 실패: db' });
    expect(envelope.warnings).toEqual(['DB_UNAVAILABLE']);
  });

  it('reports CONFIG_INVALID the same way for a file it cannot understand', async () => {
    const kit = await emptyHome();
    await writeShim(kit.home, { bin: fileURLToPath(new URL('../dist/bin.js', import.meta.url)) });
    // store.path is retired; a relative files.path still makes the configuration invalid.
    await writeFile(join(kit.home, 'config.toml'), 'schema_version=1\n[files]\npath="relative/files"\n');

    const run = await kit.run();

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeUndefined();
    const checks = envelope.data.checks;
    expect(checks).toContainEqual(expect.objectContaining({ id: 'config', status: 'fail', code: 'CONFIG_INVALID' }));
    expect(checks).toContainEqual(expect.objectContaining({ id: 'db', status: 'fail', code: 'DB_UNAVAILABLE' }));
    for (const id of ['orbstack', 'container', 'shim']) {
      expect(checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
    }
  });

  it('prints the failing checks, and no error line, in text mode', async () => {
    const kit = await emptyHome();

    const run = await kit.run(['doctor', 'run']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('orbstack: ok');
    expect(run.stdout).toContain('container: ok');
    expect(run.stdout).toContain('config: fail [CONFIG_MISSING]');
    expect(run.stdout).toContain('db: fail [DB_UNAVAILABLE]');
    expect(run.stdout).toContain('shim: fail');
    expect(run.stdout).toContain('schema-version: skip 앞선 점검 실패: db');
    expect(run.stdout).toContain('node-path: skip 앞선 점검 실패: shim');
    expect(run.stdout).toContain('spool: ok 0건');
    expect(run.stdout.trimEnd().split('\n').at(-1)).toBe('요약: 통과 7, 경고 1, 실패 3, 건너뜀 5');
    expect(run.stderr).not.toContain('CONFIG_MISSING');
    assertKoreanLines(run.stdout);
  });
});
