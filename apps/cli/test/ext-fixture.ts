import { spawn, execFileSync, type SpawnOptions, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHomes } from './temp-home.js';
import { dropPgHome, hasPgHome, pgHome } from './pg-home.js';
import { withoutHarnessFolders } from './environment.js';
import { acquireTestDatabase } from '@second-brain/test-db';
export async function extHome(options: { realGarminAuth?: boolean; self?: boolean; spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessByStdio<null, Readable, Readable> } = {}) {
  const homes = tempHomes(), home = await homes.create('brain-ext-');
  let db: Awaited<ReturnType<typeof pgHome>>;
  try { db = await pgHome(home, options.self ?? true, acquireTestDatabase); }
  catch (error) {
    try { await homes.cleanup({ skip: hasPgHome(home) ? new Set([home]) : undefined }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'fixture setup and cleanup failed'); }
    throw error;
  }
  try {
  const { readBuildIdentity } = await import('../src/install/installed.js');
  const build = await readBuildIdentity(); if (!build?.commit) throw new Error('시험 build 신원이 없습니다');
  await writeFile(join(home, 'installed.json'), JSON.stringify({ commit: build.commit, schema_version: build.schema_version, schema_versions: build.schema_versions, node: process.execPath, plugin_root: null, installed_at: new Date(0).toISOString() }));
  // Production setup creates the database with brain_owner ownership. The
  // shared test helper precreates it as postgres, so reproduce that ownership.
  const databaseName = new URL(db.url).pathname.slice(1);
  if (!/^[a-z][a-z0-9_]*$/.test(databaseName)) throw new Error('잘못된 시험 데이터베이스 이름');
  await db.query(`alter database "${databaseName}" owner to brain_owner`);
  const password = decodeURIComponent(new URL(db.url).password);
  await appendFile(join(home, '.env'), `BRAIN_POSTGRES_PASSWORD=${password}\n`);
  const env: NodeJS.ProcessEnv & { SECOND_BRAIN_HOME: string; SECOND_BRAIN_TEST_EXTENSIONS: string; BRAIN_DATABASE_URL: string } = { ...withoutHarnessFolders(process.env), SECOND_BRAIN_HOME: home, SECOND_BRAIN_TEST_EXTENSIONS: fileURLToPath(new URL('./fixtures/extensions/', import.meta.url)), BRAIN_DATABASE_URL: db.appUrl };
  // Never let an inherited Python startup hook shadow the owned venv guard.
  for (const key of Object.keys(env)) if (key.startsWith('PYTHON')) delete env[key];
  let syntheticUvReady = false;
  // The wrapper only modifies the test-owned venv after uv installs it. The
  // sitecustomize fixture intercepts Garmin auth.py only; other workers keep
  // their real libraries and ordinary extension supervision.
  async function ensureSyntheticGarmin() {
    if (syntheticUvReady) return;
    const originalUv = execFileSync('which', ['uv'], { encoding: 'utf8', env }).trim();
    const bin = join(home, 'synthetic-garmin-bin');
    await mkdir(bin, { recursive: true });
    const stub = await readFile(fileURLToPath(new URL('../python-test/fixtures/garmin-official-auth/sitecustomize.py', import.meta.url)), 'utf8');
    const wrapper = `#!/usr/bin/env python3
import glob, os, pathlib, subprocess, sys
result = subprocess.run([${JSON.stringify(originalUv)}, *sys.argv[1:]])
if result.returncode == 0 and len(sys.argv) > 1 and sys.argv[1] == 'sync':
    root = os.environ.get('UV_PROJECT_ENVIRONMENT', '')
    sites = glob.glob(os.path.join(root, 'lib', 'python*', 'site-packages'))
    if len(sites) != 1:
        sys.exit(97)
    pathlib.Path(sites[0], 'sitecustomize.py').write_text(${JSON.stringify(stub)})
sys.exit(result.returncode)
`;
    await writeFile(join(bin, 'uv'), wrapper, { mode: 0o700 });
    env.PATH = `${bin}:${env.PATH ?? ''}`;
    syntheticUvReady = true;
  }
  async function runRaw(args: readonly string[]) {
    if (args[0] === 'ext' && args[1] === 'install' && (args[2] === 'garmin' || (args[2] === '--package' && args[3]?.endsWith('/plugins/garmin/package')))) await ensureSyntheticGarmin();
    return new Promise<{ code: number | null; stdout: string; stderr: string; body: any }>((resolve, reject) => {
      const command = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
      const child = options.spawn ? options.spawn(process.execPath, [command, ...args], { env }) : spawn(process.execPath, [command, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => { let body; try { body = JSON.parse(stdout); } catch { body = undefined; } resolve({ code, stdout, stderr, body }); });
    });
  }
  async function withScheduler(args: readonly string[]) {
    const { runDaemon } = await import('../src/daemon/run.js');
    const { postgresStore } = await import('second_brain/postgres');
    const { systemClock } = await import('../src/runtime/clock.js');
    const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
    const controller = new AbortController();
    const running = runDaemon({ home, env, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25 }, createStore: options => Object.assign(postgresStore(options), { imports: undefined }) });
    try {
      const ready = join(home, 'run', 'supervisor-ready.json'), deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (await readFile(ready, 'utf8').then(() => true).catch(() => false)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return await runRaw(args);
    } finally { controller.abort(); await running; }
  }
  let cleaned = false;
  let rolesCleaned = false;
  let homeCleaned = false;
  let cleaning: Promise<void> | undefined;
  return {
    home, db, env, runDirect: runRaw,
    async run(args: readonly string[]) {
      const result = await runRaw(args);
      const garminInstall = args[0] === 'ext' && args[1] === 'install' && (args[2] === 'garmin' || (args[2] === '--package' && args[3]?.endsWith('/plugins/garmin/package')));
      if (garminInstall && result.body?.error?.code === 'EXTENSION_SCHEDULER_UNAVAILABLE' && !options.realGarminAuth) return withScheduler(args);
      if (options.realGarminAuth || !garminInstall || result.body?.error?.code !== 'EXTENSION_LOGIN_REQUIRED') return result;
      const tokenstore = join(home, 'extensions/garmin/tokenstore');
      await mkdir(tokenstore, { recursive: true, mode: 0o700 });
      await writeFile(join(tokenstore, 'garmin_tokens.json'), JSON.stringify({ di_token: 'synthetic-token', di_refresh_token: 'synthetic-refresh', di_client_id: 'synthetic-client' }), { mode: 0o600 });
      const retry = await runRaw(args);
      if (retry.body?.error?.code !== 'EXTENSION_SCHEDULER_UNAVAILABLE') return retry;
      return withScheduler(args);
    },
    ledger(owner: string) {
      if (!/^[a-z][a-z0-9_]*$/.test(owner)) throw new Error('잘못된 소유자');
      return db.rows(`select owner,version from brain.schema_migrations where owner='${owner}' order by version`);
    },
    cleanup() {
      if (cleaned) return Promise.resolve();
      if (cleaning) return cleaning;
      cleaning = (async () => {
        const errors: unknown[] = [];
        if (!rolesCleaned && !db.fixtureContainerRemoved && !db.fixtureDatabaseDropped) {
          try {
            for (const name of ['garmin', 'extdisable', 'testext', 'pyfixture', 'otherext', 'resumext', 'pyresume']) {
              const role = `brain_ext_${name}`;
              const owned = await db.rows(`select 1 from pg_roles where rolname='${role}' and shobj_description(oid, 'pg_authid')='second-brain extension:' || current_database()`);
              if (owned.length) await db.query(`drop owned by "${role}"; drop role "${role}"`);
            }
            rolesCleaned = true;
          } catch (error) { rolesCleaned = true; errors.push(error); }
        }
        let dropFailed = false;
        try { await dropPgHome(home); } catch (error) { dropFailed = true; errors.push(error); }
        if (!homeCleaned) {
          try { await homes.cleanup({ skip: dropFailed ? new Set([home]) : undefined }); if (!dropFailed) homeCleaned = true; } catch (error) { errors.push(error); }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'fixture cleanup failed');
        cleaned = true;
      })().finally(() => { cleaning = undefined; });
      return cleaning;
    },
  };
  } catch (error) {
    const errors: unknown[] = [error];
    let dropFailed = false;
    try { await dropPgHome(home); } catch (cleanupError) { dropFailed = true; errors.push(cleanupError); }
    try { await homes.cleanup({ skip: dropFailed ? new Set([home]) : undefined }); } catch (cleanupError) { errors.push(cleanupError); }
    if (errors.length > 1) throw new AggregateError(errors, 'fixture setup and cleanup failed');
    throw error;
  }
}
