import { spawn } from 'node:child_process';
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOME_ENV } from '../src/config/paths.js';

/**
 * `brain sessions ingest claude-code` end to end: the built `brain`, started
 * with a hook payload on stdin, against a real SQLite file in a temporary
 * configuration folder.
 *
 * It runs the binary rather than the dispatcher in process because what is
 * being checked is the hook path whole — stdin, the exit code, the empty
 * stdout, and two copies of the process racing for the one SQLite writer. None
 * of that exists in process.
 */

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const installPath = fileURLToPath(new URL('../dist/install.js', import.meta.url));
const FIXTURE = fileURLToPath(
  new URL('../../../packages/claude-code/test/fixtures/two-turns.jsonl', import.meta.url),
);
/** The whole-session fixture: reports, tool calls, a compact, a branch change. */
const SESSION_FIXTURE = fileURLToPath(
  new URL('../../../packages/claude-code/test/fixtures/full-session.jsonl', import.meta.url),
);
/** How many lines of it end with its fifth message. */
const SESSION_HALF_LINES = 25;
/** The markers the session fixture puts in every tool output and every image. */
const TOOL_OUTPUT = 'TOOL-OUTPUT-MUST-NOT-BE-STORED';
const BASE64 = 'QkFTRTY0TVVTVE5PVEJFU1RPUkVE';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Envelope {
  ok: boolean;
  warnings: string[];
  data?: {
    session?: string;
    created?: boolean;
    inserted?: { messages: number; toolNotes: number };
  };
  error?: { code: string; message: string; exit_code?: number; hint?: string };
}

const HARNESS_SESSION = '4f1e7a90-1c2b-4d3e-8f55-000000000000';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/**
 * A child environment with nothing a Postgres install left behind, so no test
 * here can reach a real brain or a real database server.
 */
function childEnvironment(home: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    [HOME_ENV]: home,
  };
  delete childEnv['SECOND_BRAIN_DATABASE_URL'];
  delete childEnv['BRAIN_TEST_DATABASE_URL'];
  return childEnv;
}

/** The built `brain`, with `stdin` piped in rather than ignored. */
function runBrain(args: readonly string[], home: string, stdin: string): Promise<Run> {
  const child = spawn(process.execPath, [binPath, ...args], {
    cwd: repoRoot,
    env: childEnvironment(home),
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
  child.stdin.end(stdin);

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** An installed brain: a configuration folder, a migrated database, an owner. */
async function installedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-ingest-'));
  homes.push(home);
  const install = await new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [installPath, '--yes'], {
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
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  expect(install.code, install.stdout + install.stderr).toBe(0);
  return home;
}

/** A copy of the Claude Code fixture inside this test's own folder. */
async function transcriptIn(home: string): Promise<string> {
  const path = join(home, 'transcript.jsonl');
  await copyFile(FIXTURE, path);
  return path;
}

/** The payload Claude Code's Stop hook writes on stdin. */
function stopPayload(transcriptPath: string, sessionId = HARNESS_SESSION): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: '/demo/repo',
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });
}

/** Every user table and how many rows it holds, read without writing. */
function rowCounts(path: string): Record<string, number> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database
      .prepare(
        `select name from sqlite_master
          where type = 'table' and name not like 'sqlite_%'
          order by name`,
      )
      .all() as { name: string }[];
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      counts[name] = (
        database.prepare(`select count(*) as rows from "${name}"`).get() as { rows: number }
      ).rows;
    }
    return counts;
  } finally {
    database.close();
  }
}

/** The conversation as it is stored, in `seq` order. */
function storedMessages(path: string): { seq: number; role: string; body: string }[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare('select seq, role, body from messages order by seq').all() as {
      seq: number;
      role: string;
      body: string;
    }[];
  } finally {
    database.close();
  }
}

/** Every tool note, in the order a reader walks the conversation. */
function storedToolNotes(
  path: string,
): { tool: string; target: string; ok: number }[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare(
        `select n.tool, n.target, n.ok
           from tool_notes n
           left join messages m
             on m.session_id = n.session_id
            and m.harness_message_id = n.harness_message_id
          order by m.seq is null, m.seq, n.ordinal`,
      )
      .all() as { tool: string; target: string; ok: number }[];
  } finally {
    database.close();
  }
}

function databaseIn(home: string): string {
  return join(home, 'brain.db');
}

/** The session fixture in this test's own folder, whole or only its front. */
async function sessionTranscriptIn(home: string, lines?: number): Promise<string> {
  const path = join(home, 'session.jsonl');
  const whole = await readFile(SESSION_FIXTURE, 'utf8');
  const text =
    lines === undefined ? whole : `${whole.split('\n').slice(0, lines).join('\n')}\n`;
  await writeFile(path, text, 'utf8');
  return path;
}

describe('brain sessions ingest claude-code', () => {
  beforeAll(async () => {
    // The binary and the installer are what these tests run, so a stale build
    // would make every one of them lie.
    for (const path of [binPath, installPath, FIXTURE, SESSION_FIXTURE]) {
      await readFile(path);
    }
  });

  it('stores the conversation of a transcript and says so in the envelope', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({
      session: `claude-code:${HARNESS_SESSION}`,
      created: true,
      // One `Read`, which the fixture's one tool call is.
      inserted: { messages: 4, toolNotes: 1 },
    });
    expect(envelope.warnings).toEqual([]);

    const path = databaseIn(home);
    expect(storedMessages(path)).toEqual([
      { seq: 0, role: 'user', body: 'Where did we leave the import notes?' },
      {
        seq: 1,
        role: 'assistant',
        body: 'They are in notes/import.md.\nI added the open question at the end.',
      },
      { seq: 2, role: 'user', body: 'Good. Write that down as a decision.' },
      { seq: 3, role: 'assistant', body: "Written down, with today's date." },
    ]);
    // One session, attributed to the owner the install recorded (AD-12).
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        database
          .prepare(
            `select s.harness, s.ingest_source, s.machine is not null as has_machine,
                    u.is_self
               from sessions s join users u on u.id = s.user_id`,
          )
          .all(),
      ).toEqual([
        { harness: 'claude-code', ingest_source: 'live', has_machine: 1, is_self: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  it('prints nothing on stdout in text mode, because it runs after every turn', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code'],
      home,
      stopPayload(transcript),
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
  });

  it('adds nothing the second time the same payload arrives', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    const payload = stopPayload(transcript);
    expect(
      (await runBrain(['sessions', 'ingest', 'claude-code'], home, payload)).code,
    ).toBe(0);
    const before = rowCounts(databaseIn(home));

    const again = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );

    expect(again.code).toBe(0);
    const envelope = JSON.parse(again.stdout) as Envelope;
    expect(envelope.data).toMatchObject({
      created: false,
      inserted: { messages: 0, toolNotes: 0 },
    });
    expect(rowCounts(databaseIn(home))).toEqual(before);
  });

  it('inserts each message once when two processes ingest at the same moment', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    const payload = stopPayload(transcript);

    // Two copies of the real binary at once. SQLite has one writer per
    // database, so the later one waits out the turn budget and then commits
    // nothing new (AD-7).
    const [first, second] = await Promise.all([
      runBrain(['sessions', 'ingest', 'claude-code', '--json'], home, payload),
      runBrain(['sessions', 'ingest', 'claude-code', '--json'], home, payload),
    ]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const inserted = [first, second]
      .map((run) => (JSON.parse(run.stdout) as Envelope).data?.inserted?.messages ?? 0)
      .reduce((total, count) => total + count, 0);
    // Between them they inserted the conversation exactly once, however the
    // two happened to interleave.
    expect(inserted).toBe(4);
    expect(storedMessages(databaseIn(home)).map((message) => message.seq)).toEqual([0, 1, 2, 3]);
    expect(rowCounts(databaseIn(home))['sessions']).toBe(1);
  });

  it('appends only what grew when the transcript has one more turn', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    const payload = stopPayload(transcript);
    expect((await runBrain(['sessions', 'ingest', 'claude-code'], home, payload)).code).toBe(0);

    await appendFile(
      transcript,
      `${JSON.stringify({
        type: 'user',
        isSidechain: false,
        uuid: '00000000-0000-4000-8000-000000000020',
        timestamp: '2026-01-02T03:06:00.000Z',
        message: { role: 'user', content: 'One more thing.' },
      })}\n`,
      'utf8',
    );
    const again = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );

    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as Envelope).data).toMatchObject({
      created: false,
      inserted: { messages: 1, toolNotes: 0 },
    });
    const stored = storedMessages(databaseIn(home));
    expect(stored.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(stored.at(-1)?.body).toBe('One more thing.');
  });

  it('gives a message that arrived in front of the stored ones the last number', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    const payload = stopPayload(transcript);
    expect((await runBrain(['sessions', 'ingest', 'claude-code'], home, payload)).code).toBe(0);
    const before = storedMessages(databaseIn(home));

    // What a compact or a fork does to the front of a transcript.
    const grown = `${JSON.stringify({
      type: 'user',
      isSidechain: false,
      uuid: '00000000-0000-4000-8000-000000000030',
      timestamp: '2026-01-02T03:03:00.000Z',
      message: { role: 'user', content: 'Something that came first.' },
    })}\n${await readFile(transcript, 'utf8')}`;
    await writeFile(transcript, grown, 'utf8');
    const again = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );

    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as Envelope).data).toMatchObject({
      inserted: { messages: 1, toolNotes: 0 },
    });
    const after = storedMessages(databaseIn(home));
    // Nothing already stored moved; the newcomer took the next free number.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toEqual({
      seq: before.length,
      role: 'user',
      body: 'Something that came first.',
    });
  });

  it('creates no session for a transcript with no conversation in it', async () => {
    const home = await installedHome();
    const transcript = join(home, 'empty.jsonl');
    await writeFile(transcript, '{"type":"mode","mode":"normal","sessionId":"s"}\n', 'utf8');

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as Envelope).data).toMatchObject({
      created: false,
      inserted: { messages: 0, toolNotes: 0 },
    });
    expect(rowCounts(databaseIn(home))['sessions']).toBe(0);
  });
});

describe('brain sessions ingest claude-code on a whole session', () => {
  it('reads what is new, then says CURSOR_RESET, over one session in order', async () => {
    // The acceptance sequence, in one brain and one session: the transcript as
    // it stood halfway through, then the whole of it, then the same file with a
    // line in front of the cursor's own changed.
    const home = await installedHome();
    const transcript = await sessionTranscriptIn(home, SESSION_HALF_LINES);
    const payload = stopPayload(transcript);

    const first = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );
    expect(first.code).toBe(0);
    expect((JSON.parse(first.stdout) as Envelope).data).toMatchObject({
      created: true,
      inserted: { messages: 5, toolNotes: 3 },
    });
    const half = storedMessages(databaseIn(home));

    await sessionTranscriptIn(home);
    const second = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );

    expect(second.code).toBe(0);
    const grown = JSON.parse(second.stdout) as Envelope;
    expect(grown.warnings).toEqual([]);
    expect(grown.data).toMatchObject({
      created: false,
      // Only what the rest of the file added: the read started at the message
      // the first one stopped at.
      inserted: { messages: 5, toolNotes: 1 },
    });
    const whole = storedMessages(databaseIn(home));
    expect(whole.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(whole.slice(0, half.length)).toEqual(half);
    expect(storedToolNotes(databaseIn(home))).toEqual([
      { tool: 'Read', target: 'notes/import.md', ok: 1 },
      { tool: 'Bash', target: 'wc -l notes/import.md', ok: 0 },
      { tool: 'Agent', target: 'Summarise the notes folder', ok: 1 },
      { tool: 'Agent', target: 'Check the links in the notes', ok: 1 },
    ]);

    // A compact, a fork, a transcript rewritten underneath us: the part the
    // cursor fingerprinted is not what it was, so the parse starts at the front.
    await writeFile(
      transcript,
      (await readFile(SESSION_FIXTURE, 'utf8')).replace(
        'Can you check the import notes and summarise them?',
        'Can you check the import notes, please?',
      ),
      'utf8',
    );
    const third = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );

    expect(third.code).toBe(0);
    const reset = JSON.parse(third.stdout) as Envelope;
    // Degraded but successful, and never silent (Conventions).
    expect(reset.ok).toBe(true);
    expect(reset.warnings).toEqual(['CURSOR_RESET']);
    expect(reset.data).toMatchObject({ inserted: { messages: 0, toolNotes: 0 } });
    // Not one number and not one body moved: everything the reset read saw
    // again is already stored, and ingest is idempotent on the harness id
    // (AD-8).
    expect(storedMessages(databaseIn(home))).toEqual(whole);
    expect(whole[0]?.body).toBe('Can you check the import notes and summarise them?');
  });

  it('keeps no tool output and no pasted image anywhere in the database', async () => {
    const home = await installedHome();
    const transcript = await sessionTranscriptIn(home);

    expect(
      (await runBrain(['sessions', 'ingest', 'claude-code'], home, stopPayload(transcript)))
        .code,
    ).toBe(0);

    const text = [
      ...storedMessages(databaseIn(home)).map((message) => message.body),
      ...storedToolNotes(databaseIn(home)).map((note) => `${note.tool} ${note.target}`),
    ].join('\n');
    expect(await readFile(transcript, 'utf8')).toContain(TOOL_OUTPUT);
    expect(text).not.toContain(TOOL_OUTPUT);
    expect(text).not.toContain(BASE64);
    expect(text).not.toContain('<local-command-stdout>');
    expect(text).not.toContain('<bash-stdout>');
  });

  it('marks the two reports of delegated runs and stores none of their conversation', async () => {
    const home = await installedHome();
    const transcript = await sessionTranscriptIn(home);

    expect(
      (await runBrain(['sessions', 'ingest', 'claude-code'], home, stopPayload(transcript)))
        .code,
    ).toBe(0);

    const database = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      expect(
        database
          .prepare(
            `select seq, role, model, git_branch from messages
              where is_subagent_report = 1 order by seq`,
          )
          .all(),
      ).toEqual([
        { seq: 4, role: 'assistant', model: null, git_branch: 'main' },
        { seq: 8, role: 'assistant', model: null, git_branch: 'feature/notes' },
      ]);
      // The subagent's own turns are a sidechain and never messages of this
      // session: the final report is the whole of what a delegated run leaves.
      expect(
        database
          .prepare(`select count(*) as rows from messages where body like '%folder holds four%'`)
          .get(),
      ).toEqual({ rows: 1 });
      expect(
        database
          .prepare(`select count(*) as rows from messages where body like '%read every file%'`)
          .get(),
      ).toEqual({ rows: 0 });
      // And the session learned why the harness started it, from the last
      // `SessionStart` attachment in the file.
      expect(database.prepare('select start_source from sessions').get()).toEqual({
        start_source: 'compact',
      });
    } finally {
      database.close();
    }
  });
});

describe('brain sessions ingest on the hook path', () => {
  /** What every failing row of the matrix has in common (AD-6). */
  async function expectQuietFailure(
    run: Run,
    code: string,
    home: string,
  ): Promise<void> {
    // Exit 0 whatever happened: a brain that is broken must not break a turn.
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(code);
    expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(rowCounts(databaseIn(home))['sessions']).toBe(0);
    expect(rowCounts(databaseIn(home))['messages']).toBe(0);
  }

  it('says TRANSCRIPT_UNREADABLE for a path with no file at it', async () => {
    const home = await installedHome();

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code'],
      home,
      stopPayload(join(home, 'not-there.jsonl')),
    );

    await expectQuietFailure(run, 'TRANSCRIPT_UNREADABLE', home);
  });

  it('says TRANSCRIPT_UNREADABLE for a broken line in the middle', async () => {
    const home = await installedHome();
    const transcript = join(home, 'broken.jsonl');
    const lines = (await readFile(FIXTURE, 'utf8')).split('\n');
    lines.splice(6, 0, '{"type":"user", this is not json');
    await writeFile(transcript, lines.join('\n'), 'utf8');

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code'],
      home,
      stopPayload(transcript),
    );

    await expectQuietFailure(run, 'TRANSCRIPT_UNREADABLE', home);
  });

  it.each([
    ['nothing at all', ''],
    ['text that is not JSON', 'Stop'],
    ['an object with no session id', JSON.stringify({ transcript_path: '/demo/t.jsonl' })],
    ['an object with no transcript path', JSON.stringify({ session_id: 'abc' })],
  ])('says USAGE for a payload that is %s', async (_name, payload) => {
    const home = await installedHome();

    const run = await runBrain(['sessions', 'ingest', 'claude-code'], home, payload);

    await expectQuietFailure(run, 'USAGE', home);
  });

  it('says USAGE for a harness this build cannot read', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);

    const run = await runBrain(
      ['sessions', 'ingest', 'other'],
      home,
      stopPayload(transcript),
    );

    await expectQuietFailure(run, 'USAGE', home);
    expect(run.stderr).toContain('claude-code');
  });

  it('says USER_MISSING when nobody owns the brain, and writes nothing', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    // The one state the install step is there to prevent: a database at the
    // current version whose owner row is gone.
    const database = new DatabaseSync(databaseIn(home));
    try {
      database.exec('delete from users');
    } finally {
      database.close();
    }

    // `--json` as well, because a hook swallows the envelope too: a failure on
    // this path is one line on stderr and an exit 0, whichever output mode was
    // asked for (AD-6).
    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    expect(run.stdout).toBe('');
    await expectQuietFailure(run, 'USER_MISSING', home);
  });

  it('says SCHEMA_MISMATCH rather than writing into a database at another version', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    const database = new DatabaseSync(databaseIn(home));
    try {
      database.exec('update schema_version set version = 2');
    } finally {
      database.close();
    }

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code'],
      home,
      stopPayload(transcript),
    );

    // The write guard of AD-20, in the dispatcher: this command declares
    // `writes`, so it never reaches the store.
    await expectQuietFailure(run, 'SCHEMA_MISMATCH', home);
  });

  it('says CONFIG_MISSING in one line when no brain is installed here', async () => {
    const home = await mkdtemp(join(tmpdir(), 'brain-ingest-bare-'));
    homes.push(home);

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code'],
      home,
      stopPayload(join(home, 'transcript.jsonl')),
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('CONFIG_MISSING');
    expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
  });
});
