import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHomes } from './temp-home.js';
import { pgHome } from './pg-home.js';
import { withoutHarnessFolders } from './environment.js';
import { createIsolatedTestDatabase } from '@second-brain/test-db';
export async function extHome(options: { realGarminAuth?: boolean; self?: boolean } = {}) {
  const homes = tempHomes(), home = await homes.create('brain-ext-');
  let db: Awaited<ReturnType<typeof pgHome>>;
  try { db = await pgHome(home, options.self ?? true, createIsolatedTestDatabase); }
  catch (error) { await homes.cleanup(); throw error; }
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
  const env = { ...withoutHarnessFolders(process.env), SECOND_BRAIN_HOME: home, SECOND_BRAIN_TEST_EXTENSIONS: fileURLToPath(new URL('./fixtures/extensions/', import.meta.url)), BRAIN_DATABASE_URL: db.appUrl };
  async function runRaw(args: readonly string[]) {
    return new Promise<{ code: number | null; stdout: string; stderr: string; body: any }>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      const directory = join(home, 'extensions/garmin'), manifestPath = join(directory, 'manifest.json');
      const original = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(original);
      manifest.auth.entry = 'fake_auth_fixture.py';
      await writeFile(join(directory, 'fake_auth_fixture.py'), "import json\nprint(json.dumps({'abi': 1, 'type': 'result', 'summary': 'fixture'}))\n");
      await writeFile(manifestPath, JSON.stringify(manifest));
      const { startDaemonSupervisor } = await import('../src/daemon/supervisor.js');
      const { readConfig } = await import('../src/config/codec.js');
      const { systemClock } = await import('../src/runtime/clock.js');
      const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
      const controller = new AbortController();
      const daemon = startDaemonSupervisor({ home, env, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, supervisor: { pollMs: 25 } }, await readConfig(home), { async write() {} });
      try {
        const id = result.body.data.install.auth_work_id;
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const outcome = (await db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome;
          if (outcome === 'succeeded') break;
          if (outcome === 'failed') throw new Error('fake auth failed');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if ((await db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome !== 'succeeded') throw new Error('fake auth timed out');
      } finally {
        controller.abort(); await daemon.stop();
        await writeFile(manifestPath, original); await unlink(join(directory, 'fake_auth_fixture.py'));
      }
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
          } catch (error) { errors.push(error); }
        }
        if (!db.fixtureContainerRemoved) {
          try { await db.drop(); } catch (error) { errors.push(error); }
        }
        if (!homeCleaned) {
          try { await homes.cleanup(); homeCleaned = true; } catch (error) { errors.push(error); }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'fixture cleanup failed');
        cleaned = true;
      })().finally(() => { cleaning = undefined; });
      return cleaning;
    },
  };
  } catch (error) { try { await db.drop(); } finally { await homes.cleanup(); } throw error; }
}
