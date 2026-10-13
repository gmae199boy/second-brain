import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const homes: string[] = [];

afterEach(async () => {
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
});

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
