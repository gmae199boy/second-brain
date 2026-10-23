import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOME_ENV } from '../src/config/paths.js';
import { assertKoreanLines } from './language.js';
import { withoutHarnessFolders } from './environment.js';
import { tempHomes } from './temp-home.js';

/**
 * `brain queue drain` end to end: the built `brain`, against a real SQLite file
 * in a temporary configuration folder.
 *
 * It runs the binary rather than the dispatcher in process because what is
 * being checked is the command whole — the flag, the envelope, the exit code,
 * and the write guard in front of it. This build has no kinds of work (AD-21),
 * so a successful run is an empty one; that the loop does something when there
 * is something to do is `packages/core/test/queue-drain.test.ts`'s question and
 * `packages/sqlite/test/work-store.test.ts`'s.
 */

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const installPath = fileURLToPath(new URL('../dist/install.js', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Envelope {
  ok: boolean;
  warnings: string[];
  data?: {
    claimed?: number;
    completed?: number;
    retried?: number;
    failed?: number;
    released?: number;
    lost?: number;
    spooled?: number;
    stopped?: string;
  };
  error?: { code: string; message: string; exit_code?: number; hint?: string };
}

const temporary = tempHomes();

afterEach(() => temporary.cleanup());

beforeAll(() => {
  if (!existsSync(binPath)) {
    throw new Error(`${binPath} does not exist. Run \`pnpm build\` before these tests.`);
  }
});

/**
 * A child environment with nothing a Postgres install left behind, so no test
 * here can reach a real brain or a real database server.
 */
function childEnvironment(home: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = withoutHarnessFolders({
    ...process.env,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    [HOME_ENV]: home,
  });
  delete childEnv['SECOND_BRAIN_DATABASE_URL'];
  delete childEnv['BRAIN_TEST_DATABASE_URL'];
  return childEnv;
}

function spawned(args: readonly string[], home: string, script = binPath): Promise<Run> {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: childEnvironment(home),
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

/** An installed brain: a configuration folder, a migrated database, an owner. */
async function installedHome(): Promise<string> {
  const home = await temporary.create('brain-drain-');
  const install = await spawned(['--yes'], home, installPath);
  expect(install.code, install.stdout + install.stderr).toBe(0);
  return home;
}

function databaseIn(home: string): string {
  return join(home, 'brain.db');
}

describe('brain queue drain', () => {
  it('answers an empty queue with exit 0 and stopped: empty', async () => {
    const home = await installedHome();

    const run = await spawned(['queue', 'drain', '--json'], home);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);
    expect(envelope.data).toEqual({
      // Nothing in the spool, no transcript folder to scan — the capture
      // switch is off in these tests — and nothing on the queue.
      replayed: 0,
      spool_failed: 0,
      enqueued: 0,
      reread_missing: 0,
      claimed: 0,
      completed: 0,
      retried: 0,
      failed: 0,
      released: 0,
      lost: 0,
      spooled: 0,
      stopped: 'empty',
    });
  });

  it('prints one Korean line in text mode', async () => {
    const home = await installedHome();

    const run = await spawned(['queue', 'drain'], home);

    expect(run.code).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    // Every clause carries `건`, the three new ones included: the drain's own
    // three steps are one answer (Design Notes).
    expect(lines[0]).toContain('되넣음 0건');
    expect(lines[0]).toContain('실패로 옮김 0건');
    expect(lines[0]).toContain('새 일감 0건');
    expect(lines[0]).toContain('다시 못 읽음 0건');
    expect(lines[0]).toContain('청구 0건');
    expect(lines[0]).toContain('할 일이 없습니다');
    // Clause by clause, not line by line: a count with no Korean beside it is
    // what this catches (Conventions, 출력 언어).
    assertKoreanLines(run.stdout, { label: 'queue drain stdout' });
    assertKoreanLines(run.stderr, { label: 'queue drain stderr' });
  });

  it('takes a budget in seconds', async () => {
    const home = await installedHome();

    const run = await spawned(['queue', 'drain', '--budget', '5', '--json'], home);

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as Envelope).data?.stopped).toBe('empty');
  });

  it.each([['0'], ['3601'], ['abc'], ['-1'], ['1.5']])(
    'refuses the budget %j with USAGE and exit 2',
    async (budget) => {
      const home = await installedHome();

      const run = await spawned(['queue', 'drain', '--budget', budget, '--json'], home);

      expect(run.code).toBe(2);
      const envelope = JSON.parse(run.stdout) as Envelope;
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('USAGE');
      expect(envelope.error?.exit_code).toBe(2);
      // The flag is named, so the reader knows which of its arguments to fix.
      expect(envelope.error?.message).toContain('--budget');
    },
  );

  it('is refused with SCHEMA_MISMATCH and exit 1 on a database at another version', async () => {
    const home = await installedHome();
    const database = new DatabaseSync(databaseIn(home));
    try {
      database.exec('update schema_version set version = 2');
    } finally {
      database.close();
    }

    const run = await spawned(['queue', 'drain', '--json'], home);

    // The write guard of AD-20, and no spool branch: there is nothing to defer
    // here, because the work is already deferred.
    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('SCHEMA_MISMATCH');
    expect(envelope.warnings).toContain('SCHEMA_MISMATCH');
  });

  it('is refused with DB_UNAVAILABLE and exit 2 when the file is not there', async () => {
    const home = await installedHome();
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${databaseIn(home)}${suffix}`, { force: true });
    }

    const run = await spawned(['queue', 'drain', '--json'], home);

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('DB_UNAVAILABLE');
    expect(envelope.error?.exit_code).toBe(2);
    // A runtime command opens the store and never creates it (AD-10).
    expect(existsSync(databaseIn(home))).toBe(false);
  });

  it('answers CONFIG_MISSING and exit 2 where nothing is installed', async () => {
    const home = await temporary.create('brain-drain-bare-');

    const run = await spawned(['queue', 'drain', '--json'], home);

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('CONFIG_MISSING');
  });

  it('is described by guide schema with the seven meta fields', async () => {
    const home = await installedHome();

    const run = await spawned(['guide', 'schema', 'queue', 'drain', '--json'], home);

    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as {
      data?: { commands?: Record<string, unknown>[] };
    };
    const schema = envelope.data?.commands?.[0];
    expect(schema).toMatchObject({
      ns: 'queue',
      verb: 'drain',
      risk: 'write',
      hook: false,
      dry_run: false,
      required: [],
    });
    // The seven mandatory fields, in the envelope's spelling (Conventions).
    for (const field of ['used_for', 'required', 'examples', 'output', 'risk', 'hook', 'dry_run']) {
      expect(schema, field).toHaveProperty(field);
    }
  });
});
