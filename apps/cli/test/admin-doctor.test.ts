import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@second-brain/test-db';

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Envelope {
  ok: boolean;
  now: string;
  data?: { checks: { id: string; status: string; detail?: string; code?: string }[] };
  warnings: string[];
  error?: { code: string; message: string };
}

function runBrain(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }

  const child = spawn(process.execPath, [binPath, ...args], {
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

describe('brain admin doctor', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    if (!existsSync(binPath)) {
      throw new Error(`${binPath} does not exist. Run \`pnpm build\` before these tests.`);
    }
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('reports every check as ok against a live database', async () => {
    const run = await runBrain(['admin', 'doctor', '--json'], { DATABASE_URL: database.url });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);

    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);
    expect(envelope.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);

    const checks = envelope.data?.checks ?? [];
    expect(checks.map((check) => check.id)).toEqual(['db', 'pgvector']);
    expect(checks.every((check) => check.status === 'ok')).toBe(true);
    expect(checks[0]?.detail).toMatch(/^\d+/);
    expect(checks[1]?.detail).toMatch(/^\d+\./);
  });

  it('prints one line per check in text mode, with the same exit code', async () => {
    const run = await runBrain(['admin', 'doctor'], { DATABASE_URL: database.url });

    expect(run.code).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^db: ok /);
    expect(lines[1]).toMatch(/^pgvector: ok /);
  });

  it('fails the pgvector check and exits 1 when the extension is not installed', async () => {
    const bare = await createTestDatabase({ installVector: false });
    try {
      const run = await runBrain(['admin', 'doctor', '--json'], { DATABASE_URL: bare.url });

      expect(run.code).toBe(1);
      const envelope = JSON.parse(run.stdout) as Envelope;
      expect(envelope.ok).toBe(true);
      expect(envelope.warnings).toEqual([]);

      const checks = envelope.data?.checks ?? [];
      expect(checks[0]).toMatchObject({ id: 'db', status: 'ok' });
      expect(checks[1]).toMatchObject({ id: 'pgvector', status: 'fail' });
      expect(checks[1]?.code).toBeUndefined();
      expect(checks[1]?.detail).toMatch(/available: \d+\./);
    } finally {
      await bare.drop();
    }
  });

  it('reports DB_UNAVAILABLE as a warning and exits 1 when the database is down', async () => {
    const port = await closedPort();
    const startedAt = Date.now();
    const run = await runBrain(['admin', 'doctor', '--json'], {
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    });
    const elapsed = Date.now() - startedAt;

    expect(run.stderr).toBe('');
    expect(run.code).toBe(1);
    expect(elapsed).toBeLessThan(5000);

    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(['DB_UNAVAILABLE']);

    const checks = envelope.data?.checks ?? [];
    expect(checks[0]).toMatchObject({ id: 'db', status: 'fail', code: 'DB_UNAVAILABLE' });
    expect(checks[0]?.detail).toBeTruthy();
    expect(checks[1]).toEqual({ id: 'pgvector', status: 'skip' });
  });

  it('exits 2 with CONFIG_MISSING when DATABASE_URL is not set', async () => {
    const run = await runBrain(['admin', 'doctor', '--json'], { DATABASE_URL: undefined });

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('CONFIG_MISSING');
    expect(envelope.data).toBeUndefined();
    expect(envelope.warnings).toEqual([]);
  });

  it('uses the same exit code in text mode when configuration is missing', async () => {
    const run = await runBrain(['admin', 'doctor'], { DATABASE_URL: undefined });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('CONFIG_MISSING');
  });
});
