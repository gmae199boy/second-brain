import { createTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { prepareDatabase, runMigrations, postgresStore } from 'second_brain/postgres';
import { sampleSelfUserInput } from 'second_brain/testing';
import { writeConfig } from '../src/config/codec.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One isolated database and home, shared by CLI integration fixtures. */
export async function pgHome(home: string, self = true): Promise<TestDatabase & { env: NodeJS.ProcessEnv }> {
  const db = await createTestDatabase();
  try {
    const prepared = await prepareDatabase({ databaseUrl: db.url, databaseName: new URL(db.url).pathname.slice(1), appPassword: 'brain-test-app', maintenancePassword: 'brain-test-maintenance' });
    if (!prepared.ok) throw new Error(prepared.message);
    const migrated = await runMigrations({ databaseUrl: db.url, clock: { now: () => new Date() } });
    if (!migrated.ok) throw new Error(migrated.message);
    if (self) {
      const store = postgresStore({ databaseUrl: db.appUrl });
      try { const result = await store.ensureSelfUser(sampleSelfUserInput()); if (!result.ok) throw new Error(result.message); }
      finally { await store.close(); }
    }
    const { writeShim } = await import('../src/install/shim.js');
    const { fileURLToPath } = await import('node:url');
    await writeShim(home, { bin: fileURLToPath(new URL('../dist/bin.js', import.meta.url)) });
    const written = await writeConfig(home, {});
    if (!written.ok) throw new Error(written.message);
    await writeFile(join(home, '.env'), `BRAIN_DATABASE_URL=${db.appUrl}\n`, { mode: 0o600 });
    return { ...db, env: { BRAIN_DATABASE_URL: db.appUrl } };
  } catch (error) { await db.drop(); throw error; }
}

const homes = new Map<string, TestDatabase>();
export async function preparePgHome(home: string, self = true): Promise<TestDatabase> {
  const current = homes.get(home);
  if (current) return current;
  const db = await pgHome(home, self);
  homes.set(home, db);
  return db;
}
export function pgDatabaseUrl(homeOrPath: string): string {
  if (homeOrPath.startsWith('postgres')) return homeOrPath;
  const home = homeOrPath.endsWith('/brain.db') ? homeOrPath.slice(0, -9) : homeOrPath;
  const db = homes.get(home);
  if (!db) return 'postgresql://unused@127.0.0.1:1/unavailable';
  return db.url;
}
export function pgAppUrl(homeOrPath: string): string {
  const url = new URL(pgDatabaseUrl(homeOrPath));
  url.username = 'brain_app'; url.password = 'brain-test-app'; return url.toString();
}
export async function dropPgHome(home: string): Promise<void> {
  const db = homes.get(home);
  if (db) { homes.delete(home); await db.drop(); }
}

/** Machine probes are deterministic; ordinary command tests never inspect this Mac's containers. */
export const pgRunner: import('../src/runtime/command-runner.js').CommandRunner = async request => {
  const good = (stdout = '') => ({ ok: true as const, stdout, stderr: '' });
  if (request.command === 'orb') return good('Running');
  if (request.args[0] === 'context') return good('orbstack');
  if (request.args[0] === 'version') return good('29');
  if (request.args[0] === 'volume') return { ok: false, stdout: '', stderr: 'no such volume', message: 'missing' };
  if (request.args[0] === 'ps') return good(JSON.stringify({ Labels: 'com.docker.compose.service=postgres', State: 'running', Status: 'Up (healthy)' }));
  return good();
};
export async function runPgCommand(args: readonly string[], env: NodeJS.ProcessEnv) {
  const { dispatch } = await import('../src/dispatch.js');
  const { commands } = await import('../src/commands/index.js');
  let stdout = '', stderr = '';
  const code = await dispatch(commands, args, { env, clock: { now: () => new Date() }, runner: pgRunner, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

export async function installerDeps(home: string, env: NodeJS.ProcessEnv) {
  const db = await preparePgHome(home);
  const { systemInstallDeps } = await import('../src/install.js');
  const deps = systemInstallDeps({ runner: pgRunner, secrets: { adminUrl: db.url, appPassword: 'brain-test-app' }, databaseName: new URL(db.url).pathname.slice(1) });
  deps.isTTY = false;
  const { writeShim } = await import('../src/install/shim.js');
  const { fileURLToPath } = await import('node:url');
  deps.shim.write = folder => writeShim(folder, { bin: fileURLToPath(new URL('../dist/bin.js', import.meta.url)) });
  return deps;
}
export async function runTestInstaller(home: string, env: NodeJS.ProcessEnv, args: readonly string[] = ['--yes']) {
  const deps = await installerDeps(home, env);
  let stdout = '';
  deps.log = line => { stdout += line + '\n'; };
  const { runInstaller } = await import('../src/install.js');
  const code = await runInstaller(args, env, deps);
  return { code, stdout, stderr: '' };
}
export async function runTestSetup(home: string, env: NodeJS.ProcessEnv) {
  const deps = await installerDeps(home, env); deps.log = () => {};
  const { runInstallerWithFlags } = await import('../src/install.js');
  const result = await runInstallerWithFlags({ yes: true, help: false, connect: [] }, env, deps);
  return result.ok ? { ok: true, warnings: result.warnings, data: result.report } : { ok: false, warnings: result.warnings, error: result.failure };
}
