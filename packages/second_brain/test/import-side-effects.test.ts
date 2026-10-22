import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runSqliteMigrations } from 'second_brain';

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
  await writeFile(join(home, '.env'), `SECOND_BRAIN_DATABASE_URL="${databaseUrl}"\n`, 'utf8');
  return home;
}

/**
 * AD-3: importing the bundle must connect to nothing. The child process is
 * started from `apps/cli`, the one workspace package that depends on the
 * bundle, so `import("second_brain")` resolves the same way a consumer's would.
 */
describe('importing second_brain has no side effects', () => {
  it('opens no connection even with a configuration folder pointing at a live listener', async () => {
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
      const result = await run(port, await configuredHome(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`));
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('imported');
      expect(connections).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /**
   * The local source is a file, not a socket, so the Postgres test above says
   * nothing about it: a `DatabaseSync` opened at import time would show up as
   * an open file descriptor and as nothing else. So this one looks at the file
   * descriptors the child holds.
   *
   * The control is the point of the test. "The database is not in `lsof`" is
   * worth nothing on its own — a path spelled slightly differently would also
   * not be in there — so a second child opens the very same file through
   * `sqliteStore` and has to be found. One assertion proves the behaviour, the
   * other proves the assertion can fail.
   */
  it('holds the database file open only once something asks the store a question', async () => {
    const home = await mkdtemp(join(tmpdir(), 'brain-import-sqlite-'));
    homes.push(home);
    const path = join(home, 'brain.db');
    expect((await runSqliteMigrations({ path })).ok).toBe(true);
    // As `lsof` spells it: on a Mac the temporary folder is reached through a
    // symlink, and a comparison against the unresolved path would pass by
    // accident.
    const real = realpathSync(path);

    const imported = await held(home, 'await import("second_brain");');
    expect(imported).not.toContain(real);

    const asked = await held(
      home,
      `const { sqliteStore } = await import("second_brain");
       const store = sqliteStore({ path: ${JSON.stringify(path)} });
       const health = await store.checkHealth();
       if (!health.ok) throw new Error(health.message);`,
    );
    expect(asked).toContain(real);
  });
});

/**
 * The open files of a child that ran `body` and is now waiting. It waits rather
 * than exits because a process that has finished holds nothing open.
 */
async function held(home: string, body: string): Promise<string> {
  const script = [
    body,
    'console.log("ready");',
    // Wait for the parent, which is looking at this process's open files.
    'process.stdin.resume();',
    'process.stdin.once("data", () => { process.exit(0); });',
  ].join('\n');

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: join(repoRoot, 'apps', 'cli'),
    env: { ...process.env, SECOND_BRAIN_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the child never became ready: ${stderr}`));
    }, 20_000);
    child.once('error', reject);
    child.once('close', () => {
      clearTimeout(timer);
      reject(new Error(`the child exited before it was ready: ${stderr}`));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const open = await lsof(child.pid ?? 0);
  child.stdin.write('go\n');
  expect(stderr).toBe('');
  // Proof the reading itself works: whatever else it found, it found the
  // process's own executable.
  expect(open).not.toBe('');
  return open;
}

/** The open files of one process, as text. */
async function lsof(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // `-F n` would be terser, but the plain listing is what a person debugging
    // a failure here would run by hand.
    execFile('lsof', ['-p', String(pid)], (error, stdout) => {
      // `lsof` exits non-zero when it could not ask about every file
      // descriptor, which is the normal case for a process it does not own, so
      // the output is what counts and an empty one is the only failure.
      if (stdout !== '') {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `lsof produced nothing for pid ${String(pid)}: ${error === null ? 'no error' : error.message}`,
        ),
      );
    });
  });
}

function run(
  port: number,
  home: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = 'await import("second_brain"); console.log("imported");';
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: join(repoRoot, 'apps', 'cli'),
    env: {
      ...process.env,
      SECOND_BRAIN_HOME: home,
      SECOND_BRAIN_DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
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

  it.each(['root', 'help', 'hook'])('%s does not load pg', async (entry) => {
    const home = await configuredHome('postgres://unused');
    const body = entry === 'root' ? 'await import("second_brain");' : `
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
