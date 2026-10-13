import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { writeConfig } from '../src/config/codec.js';
import { HOME_ENV, configFilePath, envFilePath } from '../src/config/paths.js';

/**
 * The installer end to end, against a real database, through the built entry
 * point — the same file `tooling/bootstrap` starts. Piped stdio makes the child
 * non-interactive, which is why it runs on flags and never asks anything.
 *
 * The test database deliberately starts without the vector extension: the
 * installer is what has to install it (AD-15), and doctor going green is how
 * that is checked.
 */

const installerPath = fileURLToPath(new URL('../dist/install.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const homes: string[] = [];

async function emptyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-install-'));
  homes.push(home);
  return home;
}

function runInstaller(args: readonly string[], home: string): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, [HOME_ENV]: home };
  delete childEnv.SECOND_BRAIN_DATABASE_URL;

  const child = spawn(process.execPath, [installerPath, ...args], {
    cwd: repoRoot,
    env: childEnv,
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

async function closedPort(): Promise<number> {
  const server = createServer();
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('the installer against a real database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    if (!existsSync(installerPath)) {
      throw new Error(`${installerPath} does not exist. Run \`pnpm build\` before these tests.`);
    }
    // No vector extension: installing it is the installer's job.
    database = await createTestDatabase({ installVector: false });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('writes the configuration, migrates, installs vector, seeds the index config', async () => {
    const home = await emptyHome();

    const run = await runInstaller(['--database-url', database.url, '--yes'], home);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('db: ok');
    expect(run.stdout).toContain('pgvector: ok');

    const config = await readFile(configFilePath(home), 'utf8');
    expect(config).toContain('schema_version = 1');
    expect(config).toContain('url_env = "SECOND_BRAIN_DATABASE_URL"');
    // The URL is a key: it belongs in `.env` and nowhere else (AD-18).
    expect(config).not.toContain(database.url);

    const dotenv = await readFile(envFilePath(home), 'utf8');
    expect(dotenv).toContain(`SECOND_BRAIN_DATABASE_URL="${database.url}"`);
    const mode = (await stat(envFilePath(home))).mode & 0o777;
    expect(mode.toString(8)).toBe('600');

    expect(await database.rows('select version from schema_version')).toEqual([{ version: 1 }]);

    const vector = await database.rows<{ extversion: string }>(
      `select extversion from pg_extension where extname = 'vector'`,
    );
    expect(vector[0]?.extversion).toMatch(/^\d+\./);

    expect(
      await database.rows('select kind, model, dimensions, chunk_params from index_configs'),
    ).toEqual([
      {
        kind: 'chunk',
        model: null,
        dimensions: null,
        chunk_params: {
          targetChars: 1200,
          overlapMessages: 1,
          splitMessagesOverChars: 2400,
        },
      },
    ]);
  });

  it('is idempotent: a second run changes nothing and still exits 0', async () => {
    const home = await emptyHome();
    const first = await runInstaller(['--database-url', database.url, '--yes'], home);
    expect(first.code).toBe(0);
    const configBefore = await readFile(configFilePath(home), 'utf8');
    const envBefore = await readFile(envFilePath(home), 'utf8');

    const again = await runInstaller(['--database-url', database.url, '--yes'], home);

    expect(again.code).toBe(0);
    expect(again.stdout).toContain('the schema is already at version 1');
    expect(again.stdout).toContain('already there');
    expect(await readFile(configFilePath(home), 'utf8')).toBe(configBefore);
    expect(await readFile(envFilePath(home), 'utf8')).toBe(envBefore);

    expect(await database.rows('select id from index_configs')).toHaveLength(1);
  });

  it('keeps a time zone and a url_env the folder already chose', async () => {
    const home = await emptyHome();
    // A folder somebody configured by hand, or an earlier story's install.
    await writeConfig(home, {
      timezone: 'Europe/Berlin',
      databaseUrlEnv: 'MY_BRAIN_URL',
      databaseUrl: database.url,
    });

    const run = await runInstaller(['--database-url', database.url, '--yes'], home);

    expect(run.code).toBe(0);
    const config = await readFile(configFilePath(home), 'utf8');
    expect(config).toContain('timezone = "Europe/Berlin"');
    expect(config).toContain('url_env = "MY_BRAIN_URL"');
    // The key stays under the one name the folder names; a second name would
    // leave `readConfig` reading one and the installer writing the other.
    const dotenv = await readFile(envFilePath(home), 'utf8');
    expect(dotenv).toContain(`MY_BRAIN_URL="${database.url}"`);
    expect(dotenv).not.toContain('SECOND_BRAIN_DATABASE_URL');
  });

  it('refuses to write anything when the URL it was given does not answer', async () => {
    const home = await emptyHome();
    const port = await closedPort();

    const run = await runInstaller(
      ['--database-url', `postgres://postgres:postgres@127.0.0.1:${String(port)}/postgres`, '--yes'],
      home,
    );

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('DB_UNAVAILABLE');
    expect(existsSync(configFilePath(home))).toBe(false);
    expect(existsSync(envFilePath(home))).toBe(false);
  });

  it('names the flags it needs and exits 2 with no terminal and no flags', async () => {
    const home = await emptyHome();

    const run = await runInstaller([], home);

    expect(run.code).toBe(2);
    expect(run.stdout).toContain('--docker --yes');
    expect(existsSync(configFilePath(home))).toBe(false);
  });

  it('says where it will write, before it writes anything', async () => {
    const home = await emptyHome();

    const run = await runInstaller([], home);

    expect(run.stdout).toContain(`Configuration folder: ${home}`);
  });
});
