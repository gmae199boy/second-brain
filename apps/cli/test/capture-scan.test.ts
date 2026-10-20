import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isoWithOffset } from 'second_brain';
import { HOME_ENV, spoolPath } from '../src/config/paths.js';
import { CAPTURE_ENV } from '../src/harnesses.js';
import { withoutHarnessFolders } from './environment.js';
import { assertKoreanLine, assertKoreanLines } from './language.js';

/**
 * The folder scan, the token-only collection, the spool replay, the failures
 * and doctor — end to end, through the built `brain`, against a real SQLite
 * file and a real transcript folder in temporary directories.
 *
 * Every test here sets `CLAUDE_CONFIG_DIR` to a folder it made itself, and the
 * capture switch only where it means to: nothing may read the machine's own
 * `~/.claude` (Boundaries).
 */

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const installPath = fileURLToPath(new URL('../dist/install.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const lockHolderPath = fileURLToPath(new URL('./fixtures/lock-holder.mjs', import.meta.url));

/** The two Claude Code fixtures, which are real transcripts with no company in them. */
const TWO_TURNS = fileURLToPath(
  new URL('../../../packages/claude-code/test/fixtures/two-turns.jsonl', import.meta.url),
);
const FULL_SESSION = fileURLToPath(
  new URL('../../../packages/claude-code/test/fixtures/full-session.jsonl', import.meta.url),
);

/** The session ids those fixtures carry, which a copy has to be rewritten from. */
const TWO_TURNS_SESSION = '4f1e7a90-1c2b-4d3e-8f55-000000000000';
const FULL_SESSION_SESSION = '9a2b3c4d-5e6f-4a7b-8c9d-7e8f00000000';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface DrainData {
  replayed: number;
  spool_failed: number;
  enqueued: number;
  claimed: number;
  completed: number;
  failed: number;
  stopped: string;
}

interface FailuresData {
  failures: {
    target_kind: string;
    target_id: string;
    stage: string;
    code: string;
    harness: string | null;
    session_id: string | null;
    occurred_at: string;
    resolved_at: string | null;
    /** When the cause was first met, and how often it has been met (0005). */
    first_occurred_at: string;
    occurrences: number;
  }[];
}

interface RetryData {
  added: number;
  already_open: number;
  skipped: { target_kind: string; count: number }[];
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  warnings: string[];
  meta?: { count?: number; has_more?: boolean };
  error?: { code: string; message: string };
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/**
 * A child environment with no database server to find, pointed at one
 * configuration folder and one harness folder.
 *
 * `capture` is off unless a test asks: real collection is turned on by default
 * in story 2.14, and until then every other test in this repository has to go
 * on seeing a brain that reads no folders (Decision 1, 2026-10-19).
 */
function environment(options: {
  home: string;
  configDir: string;
  capture?: boolean;
}): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...withoutHarnessFolders(process.env),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    [HOME_ENV]: options.home,
    CLAUDE_CONFIG_DIR: options.configDir,
  };
  delete childEnv['SECOND_BRAIN_DATABASE_URL'];
  delete childEnv['BRAIN_TEST_DATABASE_URL'];
  if (options.capture === true) childEnv[CAPTURE_ENV] = '1';
  return childEnv;
}

function spawned(args: readonly string[], env: NodeJS.ProcessEnv, script = binPath): Promise<Run> {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env,
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

/** One brain, installed, and one empty harness configuration folder beside it. */
async function installed(): Promise<{ home: string; configDir: string }> {
  const home = await scratch('brain-capture-');
  const configDir = await scratch('brain-claude-');
  const install = await spawned(['--yes'], environment({ home, configDir }), installPath);
  expect(install.code, install.stdout + install.stderr).toBe(0);
  return { home, configDir };
}

/**
 * One transcript in the harness folder, as the editor writes it: under
 * `projects/<folder>/<session id>.jsonl`, with the fixture's own session id
 * rewritten to match the file name so the two cannot disagree.
 */
async function transcript(
  configDir: string,
  options: { project: string; sessionId: string; fixture?: string; lines?: number },
): Promise<string> {
  const fixture = options.fixture ?? TWO_TURNS;
  const was = fixture === TWO_TURNS ? TWO_TURNS_SESSION : FULL_SESSION_SESSION;
  const folder = join(configDir, 'projects', options.project);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${options.sessionId}.jsonl`);
  const text = (await readFile(fixture, 'utf8')).replaceAll(was, options.sessionId);
  const lines = text.split('\n').filter((line) => line !== '');
  const kept = options.lines === undefined ? lines : lines.slice(0, options.lines);
  await writeFile(path, `${kept.join('\n')}\n`, 'utf8');
  return path;
}

/** Every user table and how many rows it holds, read without writing. */
function rowCounts(path: string): Record<string, number> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database
      .prepare(
        "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
      )
      .all() as { name: string }[];
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const row = database.prepare(`select count(*) as n from "${name}"`).get() as { n: number };
      counts[name] = row.n;
    }
    return counts;
  } finally {
    database.close();
  }
}

/** The rows of one table, for the columns a count cannot show. */
function rows(path: string, table: string): Record<string, unknown>[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(`select * from "${table}"`).all() as Record<string, unknown>[];
  } finally {
    database.close();
  }
}

function databaseIn(home: string): string {
  return join(home, 'brain.db');
}

/** One `--json` envelope, with the Korean of whatever it printed checked. */
function envelopeOf<T>(run: Run): Envelope<T> {
  assertKoreanLines(run.stderr, { label: 'stderr' });
  return JSON.parse(run.stdout) as Envelope<T>;
}

beforeAll(() => {
  for (const path of [binPath, installPath]) {
    if (!existsSync(path)) {
      throw new Error(`${path} does not exist. Run \`pnpm build\` before these tests.`);
    }
  }
});

describe('brain queue drain and the transcript folder', () => {
  it('collects every session on the disk as an import, and finds nothing the second time', async () => {
    const { home, configDir } = await installed();
    await transcript(configDir, { project: '-demo-a', sessionId: 'session-aaaa' });
    await transcript(configDir, {
      project: '-demo-b',
      sessionId: 'session-bbbb',
      fixture: FULL_SESSION,
    });
    // A delegated run and a tool result beside the first one: neither is a
    // session, so neither may become one (AD-4).
    const project = join(configDir, 'projects', '-demo-a');
    await mkdir(join(project, 'subagents'), { recursive: true });
    await writeFile(join(project, 'subagents', 'agent-x.jsonl'), '{"type":"mode"}\n', 'utf8');
    await mkdir(join(project, 'tool-results'), { recursive: true });
    await writeFile(join(project, 'tool-results', 'x.txt'), 'out', 'utf8');

    const first = await spawned(
      ['queue', 'drain', '--json'],
      environment({ home, configDir, capture: true }),
    );

    expect(first.code, first.stderr).toBe(0);
    const envelope = envelopeOf<DrainData>(first);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ enqueued: 2, claimed: 2, completed: 2, failed: 0 });

    const path = databaseIn(home);
    // Two sessions, which is the number of transcript files — the delegated run
    // and the tool result are not sessions (SM-5).
    expect(rowCounts(path)['sessions']).toBe(2);
    expect(rows(path, 'sessions').map((row) => row['ingest_source'])).toEqual(['import', 'import']);
    expect(rowCounts(path)['transcript_files']).toBe(2);
    const after = rowCounts(path);

    const second = await spawned(
      ['queue', 'drain', '--json'],
      environment({ home, configDir, capture: true }),
    );

    expect(second.code).toBe(0);
    expect(envelopeOf<DrainData>(second).data).toMatchObject({ enqueued: 0, claimed: 0 });
    // Every table holds exactly what it held: a second drain over the same
    // folder adds nothing (AD-8).
    expect(rowCounts(path)).toEqual(after);
  });

  it('reads only what grew, and leaves a file it may not read alone', async () => {
    const { home, configDir } = await installed();
    const grows = await transcript(configDir, {
      project: '-demo-a',
      sessionId: 'session-aaaa',
      fixture: FULL_SESSION,
      lines: 25,
    });
    const closed = await transcript(configDir, { project: '-demo-b', sessionId: 'session-bbbb' });
    const capture = environment({ home, configDir, capture: true });
    expect((await spawned(['queue', 'drain', '--json'], capture)).code).toBe(0);
    const path = databaseIn(home);
    const firstCounts = rowCounts(path);
    const scannedAt = rows(path, 'transcript_files').find(
      (row) => row['path'] === closed,
    )?.['scanned_at'];

    // A turn appended to the first, a third session added, and the second made
    // unreadable — which the listing can still see, because `stat` needs no
    // read permission.
    const rest = (await readFile(FULL_SESSION, 'utf8'))
      .replaceAll(FULL_SESSION_SESSION, 'session-aaaa')
      .split('\n')
      .filter((line) => line !== '')
      .slice(25);
    await appendFile(grows, `${rest.join('\n')}\n`, 'utf8');
    await transcript(configDir, { project: '-demo-c', sessionId: 'session-cccc' });
    await chmod(closed, 0o000);

    try {
      const second = await spawned(['queue', 'drain', '--json'], capture);

      expect(second.code).toBe(0);
      const data = envelopeOf<DrainData>(second).data;
      // Two changed files: the one that grew and the new one. The unreadable
      // one is the same size as the row says, so it is never opened.
      expect(data).toMatchObject({ enqueued: 2, claimed: 2 });
      expect(rowCounts(path)['sessions']).toBe(3);
      expect(rowCounts(path)['messages']).toBeGreaterThan(firstCounts['messages'] ?? 0);
      // Its history row did not move either: nothing read it.
      expect(
        rows(path, 'transcript_files').find((row) => row['path'] === closed)?.['scanned_at'],
      ).toBe(scannedAt);
      expect(rowCounts(path)['failures']).toBe(0);
    } finally {
      await chmod(closed, 0o600);
    }
  });

  it('does nothing without the capture switch, and says so in doctor', async () => {
    const { home, configDir } = await installed();
    await transcript(configDir, { project: '-demo-a', sessionId: 'session-aaaa' });
    const off = environment({ home, configDir });

    const drained = await spawned(['queue', 'drain', '--json'], off);
    const doctored = await spawned(['doctor', 'run', '--json'], off);

    expect(drained.code).toBe(0);
    expect(envelopeOf<DrainData>(drained).data).toMatchObject({ enqueued: 0, claimed: 0 });
    expect(rowCounts(databaseIn(home))['sessions']).toBe(0);

    expect(doctored.code).toBe(0);
    const checks = (
      JSON.parse(doctored.stdout) as { data?: { checks: { id: string; status: string }[] } }
    ).data?.checks;
    const transcripts = checks?.find((check) => check.id === 'transcripts');
    expect(transcripts).toMatchObject({ status: 'skip' });
  });

  // One install per case, because `doctor run` ends in the opportunistic drain
  // (AD-7): by the time a second report ran, the first one's drain would have
  // collected the very file the check is about.
  it.each([
    [20, 'ok'],
    [26, 'warn'],
  ])('reports an uncollected transcript %s days old as %s', async (days, status) => {
    const { home, configDir } = await installed();
    const path = await transcript(configDir, { project: '-demo-a', sessionId: 'session-aaaa' });
    // Past `TRANSCRIPT_RETENTION_DAYS` minus the warning window, waiting risks
    // losing the session for good — the harness deletes it at thirty days.
    const when = new Date(Date.now() - days * 86_400_000);
    await utimes(path, when, when);

    const run = await spawned(
      ['doctor', 'run', '--json'],
      environment({ home, configDir, capture: true }),
    );

    expect(run.code).toBe(0);
    const check = (
      JSON.parse(run.stdout) as {
        data?: { checks: { id: string; status: string; detail?: string }[] };
      }
    ).data?.checks?.find((item) => item.id === 'transcripts');
    expect(check).toMatchObject({ status });
    expect(check?.detail).toContain('미수집 1건');
    assertKoreanLine(check?.detail ?? '', { label: 'transcripts detail' });
  });
});

describe('brain sessions ingest with no transcript path', () => {
  it('finds the transcript by session id and appends what is new', async () => {
    const { home, configDir } = await installed();
    const path = await transcript(configDir, {
      project: '-demo-a',
      sessionId: 'session-aaaa',
      fixture: FULL_SESSION,
      lines: 25,
    });
    const capture = environment({ home, configDir, capture: true });
    expect((await spawned(['queue', 'drain', '--json'], capture)).code).toBe(0);
    const before = rowCounts(databaseIn(home))['messages'] ?? 0;

    const rest = (await readFile(FULL_SESSION, 'utf8'))
      .replaceAll(FULL_SESSION_SESSION, 'session-aaaa')
      .split('\n')
      .filter((line) => line !== '')
      .slice(25);
    await appendFile(path, `${rest.join('\n')}\n`, 'utf8');

    // A payload with only `session_id`: the ingest looks the file up in the
    // harness's folder, which is what makes a hook that reported no path
    // worth acting on.
    const run = await ingest(capture, JSON.stringify({ session_id: 'session-aaaa' }));

    expect(run.code).toBe(0);
    expect(rowCounts(databaseIn(home))['messages']).toBeGreaterThan(before);
    expect(rowCounts(databaseIn(home))['sessions']).toBe(1);
  });

  it('says it cannot find the transcript when the switch is off', async () => {
    const { home, configDir } = await installed();
    await transcript(configDir, { project: '-demo-a', sessionId: 'session-aaaa' });

    const run = await ingest(
      environment({ home, configDir }),
      JSON.stringify({ session_id: 'session-aaaa' }),
    );

    // Exit 0 whatever happened: this is a hook path (AD-6).
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('TRANSCRIPT_UNREADABLE');
    assertKoreanLines(run.stderr, { label: 'stderr' });
    expect(rowCounts(databaseIn(home))['sessions']).toBe(0);
  });
});

describe('a mark the hook left in the spool', () => {
  it('goes in as a live session once the lock is gone, and empties the spool', async () => {
    const { home, configDir } = await installed();
    const path = await transcript(configDir, { project: '-demo-a', sessionId: 'session-aaaa' });
    const capture = environment({ home, configDir, capture: true });

    // A second process holding the one SQLite writer for longer than the turn
    // budget, so the hook spools rather than waits (AD-7, AD-9).
    const release = await holdTheLock(databaseIn(home), 20_000);
    let marks: string[];
    try {
      const hook = await ingest(
        capture,
        JSON.stringify({ session_id: 'session-aaaa', transcript_path: path }),
      );
      // Exit 0 and a warning rather than a failure: the turn worked, and the
      // code is how it says the write has not landed yet (NFR-2, NFR-3).
      expect(hook.code).toBe(0);
      expect(hook.stderr.trim()).toBe('경고: SPOOLED');
      marks = await spoolFiles(home);
      expect(marks).toHaveLength(1);
    } finally {
      await release();
    }

    const drained = await spawned(['queue', 'drain', '--json'], capture);

    expect(drained.code).toBe(0);
    expect(envelopeOf<DrainData>(drained).data).toMatchObject({ replayed: 1, spool_failed: 0 });
    // A mark written by a hook is about a session happening now, so the row it
    // creates is `live` and not an import (Table Contract).
    expect(rows(databaseIn(home), 'sessions').map((row) => row['ingest_source'])).toEqual([
      'live',
    ]);
    expect(await spoolFiles(home)).toEqual([]);
  });
});

describe('a session the drain could not collect', () => {
  it('is recorded once, left alone by the next scan, and done again on retry', async () => {
    const { home, configDir } = await installed();
    const path = await transcript(configDir, { project: '-demo-a', sessionId: 'session-aaaa' });
    await chmod(path, 0o000);
    const capture = environment({ home, configDir, capture: true });
    const db = databaseIn(home);

    try {
      const first = await spawned(['queue', 'drain', '--json'], capture);

      expect(first.code).toBe(0);
      // Recorded on the first failure: a transcript this user cannot read is
      // not fixed by waiting (AD-21).
      expect(envelopeOf<DrainData>(first).data).toMatchObject({ enqueued: 1, failed: 1 });
      const failures = rows(db, 'failures');
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        target_kind: 'session',
        target_id: 'claude-code:session-aaaa',
        stage: 'session_ingest',
        code: 'TRANSCRIPT_UNREADABLE',
        harness: 'claude-code',
        session_id: null,
        resolved_at: null,
      });

      // And the next scan leaves it alone: re-enqueueing it every five minutes
      // would retry a broken transcript for ever (Decision 4, 2026-10-19).
      const second = await spawned(['queue', 'drain', '--json'], capture);
      expect(envelopeOf<DrainData>(second).data).toMatchObject({ enqueued: 0, claimed: 0 });
      expect(rows(db, 'failures')).toHaveLength(1);

      const listed = await spawned(['failures', 'list', '--json'], capture);
      expect(listed.code).toBe(0);
      const list = envelopeOf<FailuresData>(listed);
      expect(list.meta).toMatchObject({ count: 1, has_more: false });
      // The first record of this cause, so the first instant is the stored
      // `occurred_at` — in the offset form every `--json` instant carries,
      // which is what tells it from the database's own spelling (Conventions,
      // 시각).
      const stored = String(failures[0]?.['occurred_at']);
      expect(list.data?.failures[0]).toMatchObject({
        target_kind: 'session',
        code: 'TRANSCRIPT_UNREADABLE',
        occurred_at: isoWithOffset(new Date(stored)),
        first_occurred_at: isoWithOffset(new Date(stored)),
        occurrences: 1,
      });
    } finally {
      await chmod(path, 0o600);
    }

    // Permission back, and one deliberate ask: the opportunistic drain at the
    // end of the retry command is what does the work (AD-7).
    const retried = await spawned(
      ['failures', 'retry', '--target-kind', 'session', '--json'],
      capture,
    );

    expect(retried.code).toBe(0);
    expect(envelopeOf<RetryData>(retried).data).toMatchObject({
      added: 1,
      already_open: 0,
      skipped: [],
    });
    expect(rowCounts(db)['sessions']).toBe(1);
    // The row the retry was about is resolved, so the list is empty again.
    expect(rows(db, 'failures')[0]?.['resolved_at']).not.toBe(null);
    const empty = await spawned(['failures', 'list', '--json'], capture);
    expect(envelopeOf<FailuresData>(empty).data?.failures).toEqual([]);
    const all = await spawned(['failures', 'list', '--all', '--json'], capture);
    expect(envelopeOf<FailuresData>(all).data?.failures).toHaveLength(1);
  });

  it('is a warn in doctor while it is unresolved', async () => {
    const { home, configDir } = await installed();
    const path = await transcript(configDir, { project: '-demo-a', sessionId: 'session-aaaa' });
    await chmod(path, 0o000);
    const capture = environment({ home, configDir, capture: true });
    try {
      expect((await spawned(['queue', 'drain', '--json'], capture)).code).toBe(0);

      const run = await spawned(['doctor', 'run', '--json'], capture);

      // A recorded failure is the mechanism working, so it is a `warn` and not
      // a `fail`: only `fail` makes the command exit 1 (Conventions).
      expect(run.code).toBe(0);
      const check = (
        JSON.parse(run.stdout) as { data?: { checks: { id: string; status: string; detail?: string }[] } }
      ).data?.checks?.find((item) => item.id === 'failures');
      expect(check).toMatchObject({ status: 'warn' });
      expect(check?.detail).toContain('session');
      assertKoreanLine(check?.detail ?? '', { label: 'failures detail' });
    } finally {
      await chmod(path, 0o600);
    }
  });
});

describe('brain failures list and retry in text mode', () => {
  it('print Korean lines and a count, with nothing recorded', async () => {
    const { home, configDir } = await installed();
    const capture = environment({ home, configDir });

    const listed = await spawned(['failures', 'list'], capture);
    const retried = await spawned(['failures', 'retry'], capture);

    expect(listed.code).toBe(0);
    expect(listed.stdout.trimEnd()).toBe('실패 0건.');
    assertKoreanLines(listed.stdout, { label: 'failures list' });

    expect(retried.code).toBe(0);
    expect(retried.stdout.trimEnd()).toBe('새 일감 0건, 이미 열려 있던 것 0건.');
    assertKoreanLines(retried.stdout, { label: 'failures retry' });
  });

  it('prints a recorded failure as one Korean line, and the count under it', async () => {
    const { home, configDir } = await installed();
    // Recorded by hand, with a sentence of its own: what this checks is the
    // line this command writes, and a driver's own English message inside
    // `failures.message` is stored text rather than authored prose (AD-11).
    recordFailureRow(databaseIn(home));

    const run = await spawned(['failures', 'list'], environment({ home, configDir }));

    expect(run.code).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('대상 session claude-code:session-aaaa');
    expect(lines[0]).toContain('단계 session_ingest');
    expect(lines[0]).toContain('코드 TRANSCRIPT_UNREADABLE');
    // How often the cause has been met, which the row counts since 0005.
    expect(lines[0]).toContain('횟수 1');
    expect(lines[0]).toContain('읽을 수 없습니다');
    expect(lines[1]).toBe('실패 1건.');
    // Every clause carries Korean, the identifiers included (Conventions,
    // 출력 언어): `session` on its own would be a clause with no Korean in it.
    assertKoreanLines(run.stdout, { label: 'failures list' });
  });

  it('refuses a limit outside the range as a USAGE', async () => {
    const { home, configDir } = await installed();

    const run = await spawned(
      ['failures', 'list', '--limit', '0', '--json'],
      environment({ home, configDir }),
    );

    expect(run.code).toBe(2);
    expect(envelopeOf<FailuresData>(run).error?.code).toBe('USAGE');
  });

  it('reports a target kind nothing can retry as skipped', async () => {
    const { home, configDir } = await installed();
    // A failure about something that is not a session: there is no kind of
    // work for it in this build, so it is counted and left alone.
    const database = new DatabaseSync(databaseIn(home));
    try {
      database
        .prepare(
          `insert into failures (id, target_kind, target_id, stage, fingerprint, harness,
                                 session_id, code, message, occurred_at,
                                 first_occurred_at, occurrences)
           values (?, 'file', 'sha256:demo', 'extract', 'sha256:one', null, null,
                   'DEMO_FAILED', '안 됩니다', '2026-03-04T05:06:07.000Z',
                   '2026-03-04T05:06:07.000Z', 1)`,
        )
        .run('01940000-0000-7000-8000-0000000000aa');
    } finally {
      database.close();
    }

    const run = await spawned(
      ['failures', 'retry', '--json'],
      environment({ home, configDir }),
    );

    expect(run.code).toBe(0);
    expect(envelopeOf<RetryData>(run).data).toMatchObject({
      added: 0,
      skipped: [{ target_kind: 'file', count: 1 }],
    });
  });
});

/**
 * One unresolved `session_ingest` failure, written straight into the table.
 *
 * By hand rather than by making a collection fail, so the message is a sentence
 * this repository wrote: a driver's own English — `EACCES: permission denied` —
 * is stored text and not prose the output-language check is about.
 */
function recordFailureRow(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database
      .prepare(
        `insert into failures (id, target_kind, target_id, stage, fingerprint, harness,
                               session_id, code, message, occurred_at,
                               first_occurred_at, occurrences)
         values (?, 'session', 'claude-code:session-aaaa', 'session_ingest', 'sha256:one',
                 'claude-code', null, 'TRANSCRIPT_UNREADABLE', '읽을 수 없습니다',
                 '2026-03-04T05:06:07.000Z', '2026-03-04T05:06:07.000Z', 1)`,
      )
      .run('01940000-0000-7000-8000-0000000000ab');
  } finally {
    database.close();
  }
}

/** Every `.jsonl` waiting in a home's spool, oldest first. */
async function spoolFiles(home: string): Promise<string[]> {
  try {
    return (await readdir(spoolPath(home))).filter((name) => name.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
}

/**
 * A second process holding the one SQLite writer, and when to let go.
 *
 * It has to be another process: two connections inside one would wait on a lock
 * nothing can release, because `node:sqlite` is synchronous and the waiting
 * blocks the event loop the holder would need to let go (AD-7).
 */
async function holdTheLock(path: string, holdMs: number): Promise<() => Promise<void>> {
  const child = spawn(process.execPath, [lockHolderPath, path, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('held')) resolve();
    });
    child.once('error', reject);
    child.once('close', () => reject(new Error(`the lock holder stopped: ${errors}`)));
  });
  return async () => {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve());
    });
  };
}

/** `brain sessions ingest claude-code`, with a payload on standard input. */
function ingest(env: NodeJS.ProcessEnv, payload: string): Promise<Run> {
  const child = spawn(process.execPath, [binPath, 'sessions', 'ingest', 'claude-code'], {
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.end(payload);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
