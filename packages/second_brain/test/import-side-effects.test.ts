import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * AD-3: importing the bundle must connect to nothing. The child process is
 * started from `apps/cli`, the one workspace package that depends on the
 * bundle, so `import("second_brain")` resolves the same way a consumer's would.
 */
describe('importing second_brain has no side effects', () => {
  it('opens no connection even when DATABASE_URL points at a live listener', async () => {
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
      const result = await run(port);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('imported');
      expect(connections).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function run(port: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = 'await import("second_brain"); console.log("imported");';
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: join(repoRoot, 'apps', 'cli'),
    env: {
      ...process.env,
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
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
