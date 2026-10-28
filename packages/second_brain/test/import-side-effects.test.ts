import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const homes: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/**
 * A complete configuration folder, written by hand: this package may not reach
 * into the Runtime's codec (AD-1), and the point is only that a folder exists
 * for an import to read if it were going to.
 */
async function configuredHome(databaseUrl: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-import-'));
  homes.push(home);
  await writeFile(join(home, 'config.toml'), 'schema_version = 1\n', 'utf8');
  await writeFile(join(home, '.env'), `BRAIN_DATABASE_URL="${databaseUrl}"\n`, 'utf8');
  return home;
}

/**
 * AD-3: importing the bundle must connect to nothing. The child process is
 * started from `apps/cli`, the one workspace package that depends on the
 * bundle, so `import("second_brain")` resolves the same way a consumer's would.
 */
describe('importing second_brain has no side effects', () => {
  it.each(['second_brain', 'cli'])('%s module import opens no connection with a live listener configured', async entry => {
    const connections: Socket[] = [];
    const server = createServer((socket) => {
      connections.push(socket);
      socket.destroy();
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('could not determine the listening port'));
          return;
        }
        resolve(address.port);
      });
    });

    try {
      const result = await run(port, await configuredHome(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`), entry);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('imported');
      expect(connections).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


});

function run(
  port: number,
  home: string,
  entry: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const module = entry === 'cli' ? join(repoRoot, 'apps/cli/dist/dispatch.js') : 'second_brain';
  const script = `await import(${JSON.stringify(module)}); console.log("imported");`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: join(repoRoot, 'apps', 'cli'),
    env: {
      ...process.env,
      SECOND_BRAIN_HOME: home,
      BRAIN_DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('Postgres is an explicit bundle subpath', () => {
  const cacheProbe = `
    const { createRequire } = await import('node:module');
    const cache = createRequire(import.meta.url).cache;
    if (Object.keys(cache).some((path) => /[/\\\\]pg[/\\\\]/.test(path))) {
      throw new Error('pg was loaded');
    }
  `;

  it.each(['root', 'help', 'hook preflight'])('%s does not load pg', async (entry) => {
    const home = await configuredHome('postgres://unused');
    const body = entry === 'root' ? 'await import("second_brain");' : entry === 'hook preflight' ? `
      const { dispatch } = await import(${JSON.stringify(join(repoRoot, 'apps/cli/dist/dispatch.js'))});
      await dispatch([{ ns: 'fake', verb: 'hook', usedFor: '시험 hook', required: [], examples: ['brain fake hook'], output: '시험 결과', risk: 'write', hook: true, dryRun: false, preflight: () => ({ code: 'USAGE', message: '잘못된 hook입니다' }), run: async () => { throw new Error('unexpected run'); } }], ['fake', 'hook'], { clock: { now: () => new Date() }, stdout: () => {}, stderr: () => {} });
    ` : `
      process.argv = [process.execPath, ${JSON.stringify(join(repoRoot, 'apps/cli/dist/bin.js'))},
        ...( ${JSON.stringify(entry)} === 'help' ? ['--help'] : ['sessions', 'ingest', 'claude-code'])];
      await import(${JSON.stringify(join(repoRoot, 'apps/cli/dist/bin.js'))});
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', body + cacheProbe], {
      cwd: join(repoRoot, 'apps/cli'), env: { ...process.env, SECOND_BRAIN_HOME: home },
      input: '{}', stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('exports the same Postgres adapter values', () => {
    const script = `
      const surface = await import('second_brain/postgres');
      const adapter = await import(${JSON.stringify(join(repoRoot, 'packages/postgres/dist/index.js'))});
      for (const name of ['postgresStore', 'runMigrations', 'SCHEMA_VERSION']) {
        if (surface[name] === undefined || surface[name] !== adapter[name]) throw new Error(name);
      }
      // Positive control: importing this surface really loads pg.
      const { createRequire } = await import('node:module');
      if (!Object.keys(createRequire(import.meta.url).cache).some((path) => /[/\\\\]pg[/\\\\]/.test(path))) {
        throw new Error('pg control did not load');
      }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: join(repoRoot, 'apps/cli'), stdio: 'pipe',
    });
  });
});

it('spools a normal hook and exits zero when the default URL is unavailable', async () => {
  const home = await configuredHome('postgresql://unused@127.0.0.1:1/unavailable');
  const payload = { session_id: 'import-no-db', hook_event_name: 'Stop', transcript_path: join(repoRoot, 'packages/claude-code/test/fixtures/two-turns.jsonl') };
  const result = execFileSync(process.execPath, [join(repoRoot, 'apps/cli/dist/bin.js'), 'sessions', 'ingest', 'claude-code', '--json'], {
    cwd: join(repoRoot, 'apps/cli'), env: { ...process.env, SECOND_BRAIN_HOME: home, BRAIN_DATABASE_URL: '' }, input: JSON.stringify(payload), encoding: 'utf8',
  });
  expect(JSON.parse(result)).toMatchObject({ ok: true, data: { spooled: true } });
});
