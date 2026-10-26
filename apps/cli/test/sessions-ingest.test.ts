import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  decodeSpoolLine,
  isoWithOffset,
  type SessionIngestSpoolRecord,
  type SpoolRecord,
} from 'second_brain';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOME_ENV, spoolPath } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';
import {
  FIXTURE_TOOL_TARGETS,
  KEPT_IN_FIXTURE,
  SECRETS,
  SECRETS_FIXTURE,
  TRUNCATED_HALF_KEY,
} from './secrets-fixture.js';
import { tempHomes } from './temp-home.js';

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
/** The hand-back fixture: the report a run delivered on a peer line (story 19). */
const HANDBACK_FIXTURE = fileURLToPath(
  new URL('../../../packages/claude-code/test/fixtures/peer-handback.jsonl', import.meta.url),
);
/** How many lines of it end with its fifth message. */
const SESSION_HALF_LINES = 25;
/** The markers the session fixture puts in every tool output and every image. */
const TOOL_OUTPUT = 'TOOL-OUTPUT-MUST-NOT-BE-STORED';
const BASE64 = 'QkFTRTY0TVVTVE5PVEJFU1RPUkVE';
/**
 * The marker the hand-back fixture puts in the editor's framing around every
 * report, and in the report text of every line that is not a hand-back.
 */
const FRAME = 'FRAME-MUST-NOT-BE-STORED';
/** The two reports `peer-handback.jsonl` carries, trimmed as they are stored. */
const HANDBACK_REPORTS = [
  'The notes folder holds four files, and import.md is the newest.',
  'Every link in notes/ still resolves. Two of them point at the same page.',
] as const;
/** The provenance fixture: which reports are this session's (story 22). */
const PROVENANCE_FIXTURE = fileURLToPath(
  new URL(
    '../../../packages/claude-code/test/fixtures/report-provenance.jsonl',
    import.meta.url,
  ),
);
/** The five reports it carries, in the order a reader walks them. */
const PROVENANCE_REPORTS = [
  'The first report, handed back before anybody typed.',
  'The prior report, handed back before its notification.',
  'The second report, which the notice said was still coming.',
  'Both checks passed and nothing else changed.',
  'The old report, read out of the framing.\n\nIt kept its second paragraph.',
] as const;
/** The folder its first line puts on the hand-back, which is a subagent's. */
const PROVENANCE_SUBAGENT_CWD = '/demo/elsewhere';
/**
 * What parser 3 produced from each of the three fixtures above, read by the
 * `baseline_revision` build and committed so this test can plant it
 * (`seedParserV3State`).
 */
const V3_STATE_FIXTURE = fileURLToPath(
  new URL('./fixtures/parser-v3-state.json', import.meta.url),
);

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
    spooled?: boolean;
    created?: boolean;
    inserted?: { messages: number; toolNotes: number };
    droppedLines?: Record<string, number> | null;
  };
  error?: { code: string; message: string; exit_code?: number; hint?: string };
}

const HARNESS_SESSION = '4f1e7a90-1c2b-4d3e-8f55-000000000000';

const temporary = tempHomes();

afterEach(() => temporary.cleanup());

/**
 * A child environment with nothing a Postgres install left behind, so no test
 * here can reach a real brain or a real database server.
 */
function childEnvironment(home: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = withoutHarnessFolders({
    ...process.env,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    [HOME_ENV]: home,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
  });
  delete childEnv['SECOND_BRAIN_DATABASE_URL'];
  delete childEnv['BRAIN_TEST_DATABASE_URL'];
  return childEnv;
}

/** The built `brain`, with `stdin` piped in rather than ignored. */
function runBrain(args: readonly string[], home: string, stdin: string, environment: NodeJS.ProcessEnv = {}): Promise<Run> {
  const child = spawn(process.execPath, [binPath, ...args], {
    cwd: repoRoot,
    env: { ...childEnvironment(home), ...environment },
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
  const home = await temporary.create('brain-ingest-');
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

/**
 * The same fixture with every line's `cwd` pointing at a real folder, under a
 * name of its own, so one home can hold a transcript per folder.
 *
 * The `cwd` of the lines is the only thing the tags are read from (AD-12); the
 * `cwd` of the hook payload is deliberately left alone, so a test that passes
 * cannot be passing because of it.
 */
async function transcriptForFolder(
  home: string,
  cwd: string,
  name = 'transcript',
): Promise<string> {
  const path = join(home, `${name}.jsonl`);
  const text = (await readFile(FIXTURE, 'utf8')).replaceAll(
    '"cwd": "/demo/repo"',
    `"cwd": ${JSON.stringify(cwd)}`,
  );
  await writeFile(path, text, 'utf8');
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

/**
 * Every row of every user table, for a test that has to say "this string is
 * nowhere in the database" rather than "not in the column I thought of".
 */
function rowDump(path: string): Record<string, unknown[]> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database
      .prepare(
        `select name from sqlite_master
          where type = 'table' and name not like 'sqlite_%'
          order by name`,
      )
      .all() as { name: string }[];
    const rows: Record<string, unknown[]> = {};
    for (const { name } of tables) {
      rows[name] = database.prepare(`select * from "${name}"`).all();
    }
    return rows;
  } finally {
    database.close();
  }
}

/**
 * The conversation as it is stored, in conversation order — which since
 * migration 0006 is `occurred_at` and there is no number to read.
 */
function storedMessages(path: string): { role: string; body: string }[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare('select role, body from messages order by occurred_at')
      .all() as {
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
          order by m.occurred_at is null, m.occurred_at, n.harness_message_id,
                   n.ordinal`,
      )
      .all() as { tool: string; target: string; ok: number }[];
  } finally {
    database.close();
  }
}

function databaseIn(home: string): string {
  return join(home, 'brain.db');
}

/** The parser version the one stored session records. */
function storedParserVersion(path: string): string | null {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      database.prepare('select parser_version from sessions').get() as {
        parser_version: string | null;
      }
    ).parser_version;
  } finally {
    database.close();
  }
}

/**
 * The deterministic ids the version-3 seed mints. They are outside the range
 * anything else in this file uses, so a case can name a seeded row.
 */
function seededRowId(serial: number): string {
  return `01940000-0000-7000-8000-${String(serial).padStart(12, '0')}`;
}

/** One fixture's worth of what parser 3 produced (`parser-v3-state.json`). */
interface ParserV3Fixture {
  messages: {
    harnessMessageId: string;
    role: string;
    model: string | null;
    body: string;
    occurredAt: string;
    gitBranch: string | null;
    isSubagentReport: boolean;
  }[];
  toolNotes: {
    harnessMessageId: string;
    ordinal: number;
    tool: string;
    target: string;
    ok: boolean;
  }[];
  cursor: { lastHarnessMessageId: string; fingerprint: string } | null;
}

/**
 * A session planted in the database exactly as the `baseline_revision` build
 * left it: the messages, the tool notes and the cursor parser 3 read out of one
 * of the connector's fixtures, with `parser_version` `3` and every
 * `tool_notes.call_id` null — because version 3 wrote none.
 *
 * It is planted rather than produced, because producing it would mean building
 * and running the old parser inside this test. The state itself *was* produced
 * by that build, by a script outside the repository, and committed as a fixture
 * — it is the output of a neutral fixture, so it is safe to publish
 * (Implementation Notes).
 *
 * This is what a parser version bump actually meets in the field, and the one
 * case `tool_notes.call_id` and `earlierPositions` exist for (#9).
 */
async function seedParserV3State(home: string, fixture: string): Promise<ParserV3Fixture> {
  const state = JSON.parse(await readFile(V3_STATE_FIXTURE, 'utf8')) as {
    parserVersion: string;
    fixtures: Record<string, ParserV3Fixture>;
  };
  const kept = state.fixtures[fixture];
  if (kept === undefined) {
    throw new Error(`the version-3 state carries nothing for ${fixture}`);
  }
  const first = kept.messages[0];
  if (first === undefined) throw new Error(`${fixture} has no version-3 messages to plant`);

  const database = new DatabaseSync(databaseIn(home));
  try {
    const owner = database.prepare('select id from users where is_self = 1').get() as {
      id: string;
    };
    const sessionId = seededRowId(300);
    database
      .prepare(
        `insert into sessions (id, harness, harness_session_id, user_id, machine,
                               started_at, ingest_source, last_harness_message_id,
                               cursor_fingerprint, parser_version, ingested_at,
                               start_source)
              values (?, 'claude-code', ?, ?, 'demo-machine', ?, 'live', ?, ?, ?, ?,
                      'startup')`,
      )
      .run(
        sessionId,
        HARNESS_SESSION,
        owner.id,
        first.occurredAt,
        kept.cursor?.lastHarnessMessageId ?? null,
        kept.cursor?.fingerprint ?? null,
        state.parserVersion,
        first.occurredAt,
      );
    const message = database.prepare(
      `insert into messages (id, session_id, harness_message_id, role, model, body,
                             occurred_at, git_branch, is_subagent_report)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [at, kind] of kept.messages.entries()) {
      message.run(
        seededRowId(200 + at),
        sessionId,
        kind.harnessMessageId,
        kind.role,
        kind.model,
        kind.body,
        kind.occurredAt,
        kind.gitBranch,
        kind.isSubagentReport ? 1 : 0,
      );
    }
    // No `call_id`: version 3 did not write one, which is the whole of why a
    // position has to be enough to recognise a call by.
    const note = database.prepare(
      `insert into tool_notes (id, session_id, harness_message_id, ordinal, tool,
                               target, ok, call_id)
            values (?, ?, ?, ?, ?, ?, ?, null)`,
    );
    for (const [at, kind] of kept.toolNotes.entries()) {
      note.run(
        seededRowId(400 + at),
        sessionId,
        kind.harnessMessageId,
        kind.ordinal,
        kind.tool,
        kind.target,
        kind.ok ? 1 : 0,
      );
    }
  } finally {
    database.close();
  }
  return kept;
}

/** The hand-back fixture in this test's own folder, so nothing writes to the repository. */
async function handbackTranscriptIn(home: string): Promise<string> {
  const path = join(home, 'handback.jsonl');
  await copyFile(HANDBACK_FIXTURE, path);
  return path;
}

/**
 * The provenance fixture in this test's own folder, optionally with the
 * conversation's own folder pointed at a real one.
 *
 * Only `/demo/workspace` is replaced. The hand-back line's
 * `PROVENANCE_SUBAGENT_CWD` is left exactly as it is — it stands for the other
 * worktree a subagent ran in, and the whole point of the tag case is that it
 * reaches nothing.
 */
async function provenanceTranscriptIn(
  home: string,
  cwd?: string,
  name = 'provenance',
): Promise<string> {
  const path = join(home, `${name}.jsonl`);
  const whole = await readFile(PROVENANCE_FIXTURE, 'utf8');
  await writeFile(
    path,
    cwd === undefined
      ? whole
      : whole.replaceAll('"cwd":"/demo/workspace"', `"cwd":${JSON.stringify(cwd)}`),
    'utf8',
  );
  return path;
}

/** The cursor the one stored session holds, both halves of it. */
function storedCursor(
  path: string,
): { last_harness_message_id: string | null; cursor_fingerprint: string | null } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare('select last_harness_message_id, cursor_fingerprint from sessions')
      .get() as { last_harness_message_id: string | null; cursor_fingerprint: string | null };
  } finally {
    database.close();
  }
}

/** Why the harness started the one stored session, as the row holds it. */
function startSourceIn(path: string): string | null {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      database.prepare('select start_source from sessions').get() as {
        start_source: string | null;
      }
    ).start_source;
  } finally {
    database.close();
  }
}

/**
 * A `started_at` the column's `glob` check accepts and no calendar has, which
 * is the shape of a row a human edited (follow-up review #19).
 */
function setStartedAt(path: string, value: string): void {
  const database = new DatabaseSync(path);
  try {
    database.prepare('update sessions set started_at = ?').run(value);
  } finally {
    database.close();
  }
}

/** The uuid these hand-written lines use for their nth line. */
function lineId(serial: number): string {
  return `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`;
}

/** One turn of conversation, in the shape the editor writes one. */
function userLine(serial: number, body: string, at: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    cwd: '/demo/repo',
    gitBranch: 'main',
    uuid: lineId(serial),
    timestamp: at,
    type: 'user',
    message: { role: 'user', content: body },
  });
}

/** A `SessionStart` hook attachment, which is where the start source comes from. */
function startLine(serial: number, source: string, at: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    cwd: '/demo/repo',
    uuid: lineId(serial),
    timestamp: at,
    type: 'attachment',
    attachment: { type: 'hook_success', hookName: `SessionStart:${source}` },
  });
}

/**
 * The editor handing back the result of an `Agent` call that is still running:
 * not a message — its only block is a `tool_result` — and the one line of this
 * transcript that carries an `"agentId"`.
 */
function agentStartLine(agentId: string, serial: number, at: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    cwd: '/demo/repo',
    gitBranch: 'main',
    uuid: lineId(serial),
    timestamp: at,
    type: 'user',
    toolUseResult: { agentId, status: 'running' },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `call-${agentId}`, content: 'Started.' }],
    },
  });
}

/** The line the editor writes when a delegated run reports back later. */
function notificationLine(taskId: string, serial: number, at: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    cwd: '/demo/repo',
    gitBranch: 'main',
    uuid: lineId(serial),
    timestamp: at,
    type: 'user',
    origin: { kind: 'task-notification', taskId },
    message: {
      role: 'user',
      content: `<task-notification><task-id>${taskId}</task-id><status>completed</status><result>The checks passed.</result></task-notification>`,
    },
  });
}

/**
 * How many task-notification lines `hugeTranscript` puts behind the cursor.
 *
 * Enough that the rule before this story goes over the budget rather than near
 * it: a copy of the prefix searched once per line costs about 1.2 ms of the
 * 30 MB each, so six thousand of them spend some seven seconds where the one
 * set this read collects spends about 150 ms. A fixture that only *touched* the
 * path would pass either way and guard nothing (attempt 1, review #4).
 */
const HUGE_NOTIFICATIONS = 6000;

/**
 * A transcript of about 30 MB, which is the size of the largest one on the
 * machine the follow-up review measured (#20).
 *
 * The size is in tool results, because that is where it comes from in a real
 * session — a `tool_result` block is not a message and not a tool note, so the
 * file is thirty megabytes the parser reads and three rows it stores.
 *
 * The shape behind that size is what makes it a measurement of #20 rather than
 * of the disk. Two things:
 *
 *   * the last *message* is the `That is all of them.` turn, which has the
 *     whole 30 MB in front of it and thousands of lines behind it. The cursor
 *     names that line, so an incremental read starts there and still has to
 *     answer every question about the stretch it is not reading;
 *   * behind that line sit thousands of `task-notification` lines naming runs
 *     this session never started. Each one asks "is this an agent of mine?",
 *     which is a question about that whole 30 MB prefix and is answered `no`
 *     only by looking at all of it. Asked once per line against a fresh copy of
 *     the prefix — the rule before this story — it is the squared cost of #20;
 *     asked against one set the read collects once, it is one scan. The `Agent`
 *     call near the front is there so the scan has something real to find, and
 *     the notification in front of the cursor is the same question answered
 *     `yes`, so a fixture that stopped answering it at all would show up as a
 *     missing row rather than as a faster run.
 */
function hugeTranscript(): string {
  const chunk = 'x'.repeat(1_000_000);
  const lines = [
    startLine(0, 'startup', '2026-02-03T10:00:00.000Z'),
    userLine(1, 'Index every file under notes/.', '2026-02-03T10:00:01.000Z'),
    agentStartLine('agent-f1', 3, '2026-02-03T10:00:01.500Z'),
  ];
  for (let serial = 0; serial < 30; serial += 1) {
    lines.push(
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        cwd: '/demo/repo',
        gitBranch: 'main',
        uuid: lineId(100 + serial),
        timestamp: '2026-02-03T10:00:02.000Z',
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: `call-${String(serial)}`, content: chunk },
          ],
        },
      }),
    );
  }
  // The run this session did start, reporting back: a message, and the one
  // place the prefix scan has to answer `yes`.
  lines.push(notificationLine('agent-f1', 4, '2026-02-03T10:00:20.000Z'));
  lines.push(userLine(2, 'That is all of them.', '2026-02-03T10:00:30.000Z'));
  for (let serial = 0; serial < HUGE_NOTIFICATIONS; serial += 1) {
    lines.push(
      notificationLine(
        `agent-elsewhere-${String(serial)}`,
        500 + serial,
        '2026-02-03T10:00:31.000Z',
      ),
    );
  }
  return `${lines.join('\n')}\n`;
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
    for (const path of [binPath, installPath, FIXTURE, SESSION_FIXTURE, SECRETS_FIXTURE]) {
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
      // Straight into the database, so nothing went to the spool (AD-9).
      spooled: false,
      created: true,
      // One `Read`, which the fixture's one tool call is, and nothing masked:
      // there is no secret anywhere in this transcript.
      inserted: { messages: 4, toolNotes: 1 },
      // Twelve of the sixteen lines are not conversation, and the envelope says
      // so by reason: a transcript is mostly editor state, hook output, tool
      // calls and tool results, which is the normal case and not a complaint
      // (story 23). `unreadable` is the only reason that also warns.
      droppedLines: {
        unreadable: 0,
        duplicate: 0,
        not_conversation: 5,
        sidechain: 2,
        meta: 2,
        incomplete: 0,
        timestamp: 0,
        api_error: 0,
        not_human: 0,
        empty: 3,
        tool_output: 0,
        orca_header: 0,
      },
    });
    expect(envelope.warnings).toEqual([]);

    const path = databaseIn(home);
    expect(storedMessages(path)).toEqual([
      { role: 'user', body: 'Where did we leave the import notes?' },
      {
        role: 'assistant',
        body: 'They are in notes/import.md.\nI added the open question at the end.',
      },
      { role: 'user', body: 'Good. Write that down as a decision.' },
      { role: 'assistant', body: "Written down, with today's date." },
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
    expect(storedMessages(databaseIn(home)).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(rowCounts(databaseIn(home))['sessions']).toBe(1);

    // Every table, not only the messages: the overlap leaves exactly what one
    // ingest of the same transcript leaves.
    const once = await installedHome();
    const single = stopPayload(await transcriptIn(once));
    expect((await runBrain(['sessions', 'ingest', 'claude-code'], once, single)).code).toBe(0);
    expect(rowCounts(databaseIn(home))).toEqual(rowCounts(databaseIn(once)));
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
    expect(stored).toHaveLength(5);
    // The turn that grew the file was uttered last, so it is read last.
    expect(stored.at(-1)?.body).toBe('One more thing.');
  });

  it('reads a message that arrived in front of the stored ones in front of them', async () => {
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
    // The newcomer was uttered at 03:03, before everything stored, so that is
    // where it is read — and the rows behind it are untouched and still in the
    // same order (migration 0006).
    expect(after).toEqual([
      { role: 'user', body: 'Something that came first.' },
      ...before,
    ]);
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
      inserted: { messages: 4, toolNotes: 3 },
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
      inserted: { messages: 4, toolNotes: 1 },
    });
    const whole = storedMessages(databaseIn(home));
    expect(whole).toHaveLength(8);
    // Everything the rest of the file added was uttered after everything the
    // first read stored, so the front of the conversation is unchanged.
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
    // Not one body and not one place moved: everything the reset read saw
    // again is already stored, and ingest is idempotent on the harness id
    // (AD-8).
    expect(storedMessages(databaseIn(home))).toEqual(whole);
    // The line the reset read with different words is still the one that was
    // stored: a message cannot be corrected, only added to (AD-11).
    expect(whole.map((message) => message.body)).toContain(
      'Can you check the import notes and summarise them?',
    );
    // And the order is when the lines were uttered, which this fixture puts
    // deliberately out of step with the file: the second line of one answer
    // carries a stamp a minute before the question, so it is read first
    // (migration 0006).
    expect(whole[0]?.body).toBe('The open question is still at the end.');
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

  it('stores no report of a delegated run and none of its conversation', async () => {
    const home = await installedHome();
    const transcript = await sessionTranscriptIn(home);

    expect(
      (await runBrain(['sessions', 'ingest', 'claude-code'], home, stopPayload(transcript)))
        .code,
    ).toBe(0);

    const database = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      // Not one row, and the column is still there: rows parser 2 and 3 wrote
      // are immutable and still say `1`, so a reader can tell them apart
      // (story 23, epic 2 Decision 2026-10-21).
      expect(
        database
          .prepare(`select count(*) as rows from messages where is_subagent_report = 1`)
          .get(),
      ).toEqual({ rows: 0 });
      // Neither the report the first run handed through its own result, nor the
      // one the second run's notification carried, nor the subagent's own turns.
      expect(
        database
          .prepare(`select count(*) as rows from messages where body like '%folder holds four%'`)
          .get(),
      ).toEqual({ rows: 0 });
      expect(
        database
          .prepare(`select count(*) as rows from messages where body like '%still resolves%'`)
          .get(),
      ).toEqual({ rows: 0 });
      expect(
        database
          .prepare(`select count(*) as rows from messages where body like '%read every file%'`)
          .get(),
      ).toEqual({ rows: 0 });
      // The `Agent` calls are still notes: that a run was delegated is a fact
      // about the turn.
      expect(
        database.prepare(`select count(*) as rows from tool_notes where tool = 'Agent'`).get(),
      ).toEqual({ rows: 2 });
      // And the session learned why the harness started it, from the *first*
      // `SessionStart` attachment in the file: the `compact` further down is
      // what happened to the session afterwards, not why it began (follow-up
      // review #18).
      expect(database.prepare('select start_source from sessions').get()).toEqual({
        start_source: 'startup',
      });
    } finally {
      database.close();
    }
  });

  it('warns once when the transcript is rewritten down to nothing, then stops', async () => {
    const home = await installedHome();
    const transcript = await sessionTranscriptIn(home);
    const payload = stopPayload(transcript);
    expect(
      (await runBrain(['sessions', 'ingest', 'claude-code'], home, payload)).code,
    ).toBe(0);
    const before = storedMessages(databaseIn(home));
    expect(before.length).toBeGreaterThan(0);

    // The same path, with no conversation in it any more. The cursor cannot be
    // found, so the parse resets — and then it finds no message, which is the
    // read that used to end before either the warning or the stale cursor was
    // dealt with (follow-up review #16).
    await writeFile(transcript, '{"type":"mode","mode":"normal","sessionId":"s"}\n', 'utf8');
    const reset = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );

    expect(reset.stderr).toBe('');
    expect(reset.code).toBe(0);
    const warned = JSON.parse(reset.stdout) as Envelope;
    expect(warned.ok).toBe(true);
    expect(warned.warnings).toEqual(['CURSOR_RESET']);
    expect(warned.data).toMatchObject({
      created: false,
      inserted: { messages: 0, toolNotes: 0 },
    });
    // Nothing stored moved, and the cursor is gone rather than left naming a
    // message of the file that was.
    expect(storedMessages(databaseIn(home))).toEqual(before);
    expect(storedCursor(databaseIn(home))).toEqual({
      last_harness_message_id: null,
      cursor_fingerprint: null,
    });

    // And the same read again is no longer a reset: there is no cursor left
    // for it to fail to match, so the warning is raised once and not for ever.
    const quiet = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );
    expect(quiet.code).toBe(0);
    expect((JSON.parse(quiet.stdout) as Envelope).warnings).toEqual([]);
  });

  it('keeps the start source it learned first, whatever a later read sees', async () => {
    const home = await installedHome();
    const transcript = join(home, 'restart.jsonl');
    const payload = stopPayload(transcript);

    // A session whose first read saw no `SessionStart` attachment at all: a
    // transcript from before the plugin was installed, or a session nobody
    // hooked. It knows nothing about the start and says so.
    await writeFile(
      transcript,
      `${userLine(1, 'Where did we leave the import notes?', '2026-02-03T10:00:01.000Z')}\n`,
      'utf8',
    );
    expect(
      (await runBrain(['sessions', 'ingest', 'claude-code'], home, payload)).code,
    ).toBe(0);
    expect(startSourceIn(databaseIn(home))).toBeNull();

    // Reopened: the editor's attachment lands in the same file, behind what is
    // already stored, so the session learns why it was started after the fact.
    await appendFile(
      transcript,
      `${startLine(2, 'resume', '2026-02-03T10:05:00.000Z')}\n${userLine(
        3,
        'Carry on where we stopped.',
        '2026-02-03T10:05:01.000Z',
      )}\n`,
      'utf8',
    );
    const second = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );
    expect(second.code).toBe(0);
    expect((JSON.parse(second.stdout) as Envelope).warnings).toEqual([]);
    expect(startSourceIn(databaseIn(home))).toBe('resume');

    // And then the front of the file is rewritten with a `startup` in front of
    // it, which is what a fork into the same path looks like. The read answers
    // `startup` — it is the first attachment the content now carries — and the
    // stored `resume` is still the one that says why this session began.
    await writeFile(
      transcript,
      `${startLine(4, 'startup', '2026-02-03T10:00:00.000Z')}\n${userLine(
        5,
        'Where were we?',
        '2026-02-03T10:10:00.000Z',
      )}\n`,
      'utf8',
    );
    const third = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );
    expect(third.code).toBe(0);
    expect((JSON.parse(third.stdout) as Envelope).warnings).toEqual(['CURSOR_RESET']);
    expect(startSourceIn(databaseIn(home))).toBe('resume');
  });

  it('ends with a code and no stack when a session row holds an impossible instant', async () => {
    const home = await installedHome();
    const transcript = await sessionTranscriptIn(home);
    const payload = stopPayload(transcript);
    expect(
      (await runBrain(['sessions', 'ingest', 'claude-code'], home, payload)).code,
    ).toBe(0);

    // A row a human edited. The column's own `glob` check is happy with it —
    // four digits, two, two — and there is no such date, so the row is only
    // wrong on the way back out (follow-up review #19).
    setStartedAt(databaseIn(home), '2026-13-45T00:00:00.000Z');

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );

    // A coded answer and not a stack: from the hook's side a row it cannot read
    // is a database it cannot reach, so the turn goes to the spool (AD-9).
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(['SPOOLED', 'DB_UNAVAILABLE']);
    expect(envelope.data).toMatchObject({ spooled: true });
  });

  it(
    'reads a 30 MB transcript again inside the Stop hook budget',
    async () => {
      const home = await installedHome();
      const transcript = join(home, 'huge.jsonl');
      await writeFile(transcript, hugeTranscript(), 'utf8');
      const payload = stopPayload(transcript);

      // The first read is the one that pays for the whole file, and nothing
      // budgets it: it happens once per session, off the hook path as often as
      // not. What a Stop hook does every turn is the second one.
      const first = await runBrain(
        ['sessions', 'ingest', 'claude-code', '--json'],
        home,
        payload,
      );
      expect(first.stderr).toBe('');
      expect(first.code).toBe(0);
      // Two: the two turns. Every `task-notification` in the file is the
      // editor's own traffic and none of them is a row, the one naming a run
      // this session started included (story 23).
      expect((JSON.parse(first.stdout) as Envelope).data).toMatchObject({
        created: true,
        inserted: { messages: 2, toolNotes: 0 },
      });
      expect(storedMessages(databaseIn(home)).map((message) => message.body)).toEqual([
        'Index every file under notes/.',
        'That is all of them.',
      ]);

      await appendFile(
        transcript,
        `${userLine(9, 'And now the summary.', '2026-02-03T11:00:00.000Z')}\n`,
        'utf8',
      );
      const started = performance.now();
      const again = await runBrain(
        ['sessions', 'ingest', 'claude-code', '--json'],
        home,
        payload,
      );
      const spent = performance.now() - started;

      expect(again.stderr).toBe('');
      expect(again.code).toBe(0);
      expect((JSON.parse(again.stdout) as Envelope).data).toMatchObject({
        created: false,
        inserted: { messages: 1, toolNotes: 0 },
      });
      // The whole command, because that is what the hook waits for: the
      // process, the file, the parse and the write. The budget is the Stop
      // hook's five seconds (AD-6).
      expect(
        spent,
        `the second ingest of a 30 MB transcript took ${String(Math.round(spent))}ms`,
      ).toBeLessThan(5000);
    },
    120_000,
  );
});

/**
 * The report a run hands back with `SubagentHandback`, through the real binary
 * and a real SQLite file (story 19), read for the one thing it now has to
 * prove: that none of it reaches a row.
 *
 * It arrives on a peer line the editor marked `isMeta` and wrapped in framing
 * of its own, and it leaves one sentence where the `Agent` call's result used
 * to be. Parser `2` stored that sentence, `3` stored the report in its place,
 * and `4` stores neither: a report is long, model-written text that nobody
 * said, and the main agent's own turn carries the conclusion a person would
 * recall (epic 2 Decision, 2026-10-21).
 */
describe('brain sessions ingest claude-code and a report handed back', () => {
  it('stores neither report, and neither the notice nor the framing', async () => {
    const home = await installedHome();
    const transcript = await handbackTranscriptIn(home);

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);
    // The question and the answer — and the two `Agent` calls, because that a
    // run was delegated is a fact about the turn.
    expect(envelope.data?.inserted).toEqual({ messages: 2, toolNotes: 2 });

    const database = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      // The column stays and no row uses it: the rows parser 2 and 3 wrote are
      // immutable and still say `1`, so a reader can tell them apart (AD-4).
      expect(
        database
          .prepare('select count(*) as rows from messages where is_subagent_report = 1')
          .get(),
      ).toEqual({ rows: 0 });
    } finally {
      database.close();
    }

    // Nowhere in the database, rather than nowhere in a column somebody thought
    // of: the two reports themselves, the editor's framing, and the sentence it
    // left where the two results would be.
    const dump = JSON.stringify(rowDump(databaseIn(home)));
    expect(await readFile(transcript, 'utf8')).toContain(FRAME);
    for (const report of HANDBACK_REPORTS) expect(dump).not.toContain(report);
    expect(dump).not.toContain(FRAME);
    expect(dump).not.toContain('SubagentHandback');
    expect(dump).not.toContain('<agent-message');
  });

  it.each([
    // The interesting one: version 3 read the first run's synchronous result as
    // a report, so the *second* `Agent` call's note hung off that line. Version
    // 4 drops the line and the call moves back onto the message the person
    // wrote, which is one call at two positions unless the store is told where
    // to look (#9).
    ['full-session.jsonl', SESSION_FIXTURE, 4],
    ['peer-handback.jsonl', HANDBACK_FIXTURE, 2],
    ['report-provenance.jsonl', PROVENANCE_FIXTURE, 1],
  ])(
    'leaves one note per call when it re-reads %s over what version 3 stored',
    async (name, fixture, calls) => {
      const home = await installedHome();
      const transcript = join(home, 'v3.jsonl');
      await copyFile(fixture, transcript);
      // The session exactly as the `baseline_revision` build left it: the
      // messages, the notes and the cursor that parser 3 produced from this
      // same file, read by that build's parser and committed as a fixture
      // (`parser-v3-state.json`, Implementation Notes).
      const seeded = await seedParserV3State(home, name);

      const run = await runBrain(
        ['sessions', 'ingest', 'claude-code', '--json'],
        home,
        stopPayload(transcript),
      );

      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      const envelope = JSON.parse(run.stdout) as Envelope;
      expect(envelope.ok).toBe(true);
      // The versions differ, so no cursor was handed over and the whole file
      // was read again — which is idempotent, and never a reset (AD-4).
      expect(envelope.warnings).toEqual([]);
      expect(envelope.data?.inserted).toEqual({ messages: 0, toolNotes: 0 });

      // One row per call that gets a note, which is what version 3 left: not
      // one call is stored twice, under two positions nobody could tell apart.
      const database = new DatabaseSync(databaseIn(home), { readOnly: true });
      try {
        expect(database.prepare('select count(*) as rows from tool_notes').get()).toEqual({
          rows: calls,
        });
        expect(seeded.toolNotes).toHaveLength(calls);
        // And every stored row is still the one version 3 wrote, call id and
        // all: a note cannot be corrected, only added (AD-11).
        expect(
          database
            .prepare('select id, call_id from tool_notes order by id')
            .all(),
        ).toEqual(
          seeded.toolNotes
            .map((_note, at) => ({ id: seededRowId(400 + at), call_id: null }))
            .sort((left, right) => (left.id < right.id ? -1 : 1)),
        );
      } finally {
        database.close();
      }
      expect(storedParserVersion(databaseIn(home))).toBe('6');
    },
  );

  it('stores no report when it re-reads over what version 3 stored', async () => {
    // Version 3's own report rows stay: a message cannot be taken back, and
    // `is_subagent_report` is what tells them from anything version 4 writes
    // (AD-11, AD-4).
    const home = await installedHome();
    const transcript = join(home, 'v3.jsonl');
    await copyFile(HANDBACK_FIXTURE, transcript);
    const seeded = await seedParserV3State(home, 'peer-handback.jsonl');
    expect(seeded.messages.filter((message) => message.isSubagentReport)).toHaveLength(2);

    expect(
      (await runBrain(['sessions', 'ingest', 'claude-code'], home, stopPayload(transcript)))
        .code,
    ).toBe(0);

    const database = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      expect(
        database
          .prepare('select count(*) as rows from messages where is_subagent_report = 1')
          .get(),
      ).toEqual({ rows: 2 });
      expect(database.prepare('select count(*) as rows from messages').get()).toEqual({
        rows: seeded.messages.length,
      });
    } finally {
      database.close();
    }
  });
});

/**
 * The fixture story 22 built to pin down *which* report was this session's,
 * through the real binary and a real SQLite file — read now for the opposite
 * rule: none of them is.
 *
 * It is one line per row of that story's matrix, so between its reports, its
 * notices, its rewordings, its framing, the hand-back nobody here asked for and
 * the origins no person typed, it carries every shape a report arrives in. The
 * fixture marks all of it with `FRAME`, so one assertion covers the lot.
 */
describe('brain sessions ingest claude-code and where a report came from', () => {
  it('stores the three turns and nothing the rules threw away', async () => {
    const home = await installedHome();
    const transcript = await provenanceTranscriptIn(home);

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);
    // Three messages — two the person typed, one answer — and the one `Agent`
    // call. Every report the fixture carries is gone.
    expect(envelope.data?.inserted).toEqual({ messages: 3, toolNotes: 1 });

    const database = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      expect(
        database
          .prepare('select count(*) as rows from messages where is_subagent_report = 1')
          .get(),
      ).toEqual({ rows: 0 });
    } finally {
      database.close();
    }

    // Nowhere in the database, rather than nowhere in a column somebody
    // thought of.
    const dump = JSON.stringify(rowDump(databaseIn(home)));
    expect(await readFile(transcript, 'utf8')).toContain(FRAME);
    for (const report of PROVENANCE_REPORTS) expect(dump).not.toContain(report);
    expect(dump).not.toContain(FRAME);
    expect(dump).not.toContain('has not reported yet');
    expect(dump).not.toContain('<agent-message');
    expect(dump).not.toContain('<task-notification');
    expect(dump).not.toContain('[Subagent hand-back]');
  });
});

/**
 * The two things a read says about the lines it did *not* keep: the counts, and
 * the one warning among them (story 23).
 *
 * A transcript is mostly not conversation, so `droppedLines` is the normal
 * shape of a successful ingest. `unreadable` is the exception — content the
 * parser could not read at all — and it is never silent (NFR-2).
 */
describe('brain sessions ingest claude-code on the lines it did not keep', () => {
  it('collects the rest of a transcript with a broken line and warns about it', async () => {
    const home = await installedHome();
    const transcript = join(home, 'broken.jsonl');
    const lines = (await readFile(FIXTURE, 'utf8')).trimEnd().split('\n');
    lines.splice(6, 0, '{"type":"user", this is not json');
    lines.splice(9, 0, '{"type":"user", nor is this one');
    await writeFile(transcript, `${lines.join('\n')}\n`, 'utf8');

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    // Refusing the file would cost this session every message around the broken
    // line, for good — but the warning says part of it was skipped (#11).
    expect(envelope.warnings).toEqual(['TRANSCRIPT_LINES_SKIPPED']);
    expect(envelope.data?.droppedLines?.['unreadable']).toBe(2);
    expect(envelope.data?.inserted).toEqual({ messages: 4, toolNotes: 1 });
    expect(storedMessages(databaseIn(home))).toHaveLength(4);
  });

  it('drops a user line that opens with one of orca orchestration headings', async () => {
    const home = await installedHome();
    const transcript = join(home, 'orca.jsonl');
    const at = (serial: number): string =>
      `2026-02-03T12:00:${String(serial).padStart(2, '0')}.000Z`;
    await writeFile(
      transcript,
      `${[
        startLine(0, 'startup', at(0)),
        userLine(1, 'You are working inside Orca, a coordinator.\n\nDo the thing.', at(1)),
        userLine(2, 'Please carry out this task from my Orca coordinator:\n\nRead it.', at(2)),
        userLine(3, 'You have 2 orchestration messages waiting.', at(3)),
        userLine(4, 'I think you are working inside Orca, are you not?', at(4)),
      ].join('\n')}\n`,
      'utf8',
    );

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.warnings).toEqual([]);
    // orca writes its prompt into the worker's session as if it had been typed,
    // so nothing on the line says otherwise: the words are the coordinator's.
    // The same words inside a sentence are a message like any other.
    expect(envelope.data?.droppedLines?.['orca_header']).toBe(3);
    expect(storedMessages(databaseIn(home))).toEqual([
      { role: 'user', body: 'I think you are working inside Orca, are you not?' },
    ]);
  });
});

/**
 * The storage half of the story's matrix, through the real binary and a real
 * SQLite file: everything the fixture's conversation pasted is in the database
 * character for character, and no `redactions` row was written at all.
 *
 * This is 마스킹 B. Capture does not mask, because a stored message is never
 * rewritten and a pattern that masked one word too many would be a deletion
 * nobody could undo. The other half — that none of these values survives a
 * trip through an output codec — is `output-codecs.test.ts`.
 *
 * The secrets in the fixture are invented. They have the shape of the real
 * thing and none of them is valid anywhere.
 */
describe('brain sessions ingest claude-code stores the secrets it reads, unmasked', () => {
  /** The fixture in this test's own folder, so nothing writes to the repository. */
  async function secretsTranscriptIn(home: string): Promise<string> {
    const path = join(home, 'secrets.jsonl');
    await copyFile(SECRETS_FIXTURE, path);
    return path;
  }

  /**
   * The message bodies of the transcript, as the harness wrote them. The two
   * targets are `FIXTURE_TOOL_TARGETS`, written out rather than worked out: an
   * expectation that applied the parser's own cut would follow a changed cut
   * instead of failing on it (follow-up review).
   */
  async function fixtureBodies(transcript: string): Promise<string[]> {
    const bodies: string[] = [];
    for (const line of (await readFile(transcript, 'utf8')).trimEnd().split('\n')) {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { content?: unknown };
      };
      const content = entry.message?.content;
      if (entry.type === 'user' && typeof content === 'string') bodies.push(content);
      if (entry.type === 'assistant' && Array.isArray(content)) {
        for (const block of content as { type?: string; text?: string }[]) {
          if (block.type === 'text' && typeof block.text === 'string') bodies.push(block.text);
        }
      }
    }
    return bodies;
  }

  it('stores every body and every target exactly as the transcript holds it', async () => {
    const home = await installedHome();
    const transcript = await secretsTranscriptIn(home);

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    // Two keys and no third: ingest writes no masking record, so there is
    // nothing to count (AD-11).
    expect(envelope.data?.inserted).toEqual({ messages: 2, toolNotes: 2 });

    const path = databaseIn(home);
    expect(storedMessages(path).map((message) => message.body)).toEqual(
      await fixtureBodies(transcript),
    );
    expect(storedToolNotes(path).map((note) => note.target)).toEqual([...FIXTURE_TOOL_TARGETS]);
    // Character for character, which is what "no marker anywhere" says in one
    // line: a masked body would carry one.
    expect(JSON.stringify(rowDump(path))).not.toContain('[REDACTED:');
  });

  it('keeps every pasted secret in the database, and writes no redaction row', async () => {
    const home = await installedHome();
    const transcript = await secretsTranscriptIn(home);

    expect(
      (await runBrain(['sessions', 'ingest', 'claude-code'], home, stopPayload(transcript)))
        .code,
    ).toBe(0);

    const path = databaseIn(home);
    const stored = [
      ...storedMessages(path).map((message) => message.body),
      ...storedToolNotes(path).map((note) => `${note.tool} ${note.target}`),
    ].join('\n');
    const file = await readFile(transcript, 'utf8');
    for (const secret of SECRETS) {
      expect(file, `${secret} is not in the fixture any more`).toContain(secret);
      expect(stored, `${secret} did not reach the database`).toContain(secret);
    }
    // The one table that could hold a trace of a masking stays empty until
    // somebody runs `messages redact` (story 2.13).
    expect(rowCounts(path)['redactions']).toBe(0);
  });

  it('stores the tool note target the parser cut, key and all', async () => {
    // The long `Bash` command: the cut lands inside an `sk-` key, so what is
    // stored ends in the front half of one. The truncated-tail rule is what
    // takes that half out of the output, and it is not this test's business.
    const home = await installedHome();
    const transcript = await secretsTranscriptIn(home);

    expect(
      (await runBrain(['sessions', 'ingest', 'claude-code'], home, stopPayload(transcript)))
        .code,
    ).toBe(0);

    const targets = storedToolNotes(databaseIn(home)).map((note) => note.target);
    expect(targets).toEqual([...FIXTURE_TOOL_TARGETS]);
    expect(targets[1]).toHaveLength(500);
    expect(targets[1]?.endsWith(TRUNCATED_HALF_KEY)).toBe(true);
  });

  it('leaves ordinary code and prose exactly where they were', async () => {
    // The regression table, in a real conversation: a commit, a path, a name,
    // an address, a private host, an epoch, a Korean sentence about a
    // password, and the three lines version 1 used to mask (inputs A3, D4).
    const home = await installedHome();
    const transcript = await secretsTranscriptIn(home);

    expect(
      (await runBrain(['sessions', 'ingest', 'claude-code'], home, stopPayload(transcript)))
        .code,
    ).toBe(0);

    const bodies = storedMessages(databaseIn(home))
      .map((message) => message.body)
      .join('\n');
    for (const kept of KEPT_IN_FIXTURE) {
      expect(bodies, `${kept} is not in the stored conversation`).toContain(kept);
    }
  });

  it('adds nothing the second time the same transcript arrives', async () => {
    const home = await installedHome();
    const transcript = await secretsTranscriptIn(home);
    const payload = stopPayload(transcript);
    expect((await runBrain(['sessions', 'ingest', 'claude-code'], home, payload)).code).toBe(0);
    const before = rowCounts(databaseIn(home));

    const again = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );

    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as Envelope).data?.inserted).toEqual({
      messages: 0,
      toolNotes: 0,
    });
    // Every table, not only the two this story touches.
    expect(rowCounts(databaseIn(home))).toEqual(before);
    expect(before['redactions']).toBe(0);
  });
});

/**
 * The identity rows of the story's matrix, through the real binary and real
 * git repositories in a temporary folder: two worktrees of one clone, an ssh
 * clone and an https clone of one repository, a folder that is no repository,
 * and an ingest that runs again after the remote changed and the folder went.
 *
 * Nothing here reads or writes a git setting of this machine: every repository
 * is made with its identity on the command line.
 */
describe('brain sessions ingest claude-code and the project it tags', () => {
  const runGit = promisify(execFile);
  const IDENTITY = [
    '-c',
    'user.name=brain-owner',
    '-c',
    'user.email=brain-owner@demo.example',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'init.defaultBranch=main',
  ];

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await runGit('git', ['-C', cwd, ...IDENTITY, ...args], {
      env: { ...childEnvironment(cwd), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    return stdout;
  }

  /** A repository with one commit, inside this test's own home. */
  async function repositoryIn(
    home: string,
    name: string,
    remote: string | null,
  ): Promise<string> {
    const path = join(await realpath(home), name);
    await mkdir(path, { recursive: true });
    await git(path, 'init', '-q');
    await writeFile(join(path, 'notes.md'), 'the import notes\n', 'utf8');
    await git(path, 'add', 'notes.md');
    await git(path, 'commit', '-q', '-m', 'the first note');
    if (remote !== null) await git(path, 'remote', 'add', 'origin', remote);
    return path;
  }

  /** Every project, worktree and session tag, read without writing. */
  function tags(path: string): {
    projects: { remote_identity: string }[];
    worktrees: { path: string; removed_at: string | null }[];
    sessions: { harness_session_id: string; identity: string | null; path: string | null }[];
  } {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        projects: database
          .prepare('select remote_identity from projects order by remote_identity')
          .all() as { remote_identity: string }[],
        worktrees: database
          .prepare('select path, removed_at from worktrees order by path')
          .all() as { path: string; removed_at: string | null }[],
        sessions: database
          .prepare(
            `select s.harness_session_id, p.remote_identity as identity, w.path as path
               from sessions s
               left join projects p on p.id = s.project_id
               left join worktrees w on w.id = s.worktree_id
              order by s.harness_session_id`,
          )
          .all() as {
          harness_session_id: string;
          identity: string | null;
          path: string | null;
        }[],
      };
    } finally {
      database.close();
    }
  }

  /** One session per folder, so every ingest here creates a row of its own. */
  function sessionIdFor(ordinal: number): string {
    return `4f1e7a90-1c2b-4d3e-8f55-00000000000${String(ordinal)}`;
  }

  it.each(['sibling', 'ancestor', 'ambiguous', 'start-folder'] as const)('지워진 근거 폴더를 %s 규칙으로 수집한다', async (mode) => {
    const home = await installedHome();
    const parent = join(await realpath(home), 'checkouts');
    await mkdir(parent);
    const main = await repositoryIn(parent, 'a', 'https://demo.example/brain-owner/notes.git');
    const second = join(parent, 'b');
    await git(main, 'worktree', 'add', '-q', second, '-b', 'second');
    const gone = mode === 'ancestor' ? join(main, 'sub', 'gone') : join(parent, 'gone');
    if (mode === 'ancestor') await mkdir(gone, { recursive: true });
    else await git(main, 'worktree', 'add', '-q', gone, '-b', 'gone');
    await rm(gone, { recursive: true });
    if (mode === 'ambiguous') await repositoryIn(parent, 'other', 'https://demo.example/brain-owner/other.git');
    for (const [ordinal, cwd] of [main, gone].entries()) {
      const transcript = await transcriptForFolder(home, mode === 'start-folder' && ordinal === 1 ? join(cwd, 'sub') : cwd, `estimate-${ordinal}`);
      if (mode === 'start-folder' && ordinal === 1) {
        await writeFile(transcript, `${JSON.stringify({ type: 'attachment', cwd })}\n${await readFile(transcript, 'utf8')}`);
      }
      const run = await runBrain(['sessions', 'ingest', 'claude-code', '--json'], home,
        stopPayload(transcript, sessionIdFor(ordinal)));
      expect(run.code, run.stderr).toBe(0);
    }
    const db = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      const rows = db.prepare('select project_id,tag_source,first_cwd from sessions order by harness_session_id').all();
      expect(rows[0]?.['tag_source']).toBe('cwd');
      expect(rows[1]?.['first_cwd']).toBe(gone);
      expect(rows[1]?.['tag_source']).toBe(mode === 'ambiguous' ? null : mode === 'start-folder' ? 'sibling' : mode);
      expect(rows[1]?.['project_id']).toBe(mode === 'ambiguous' ? null : rows[0]?.['project_id']);
      if (mode !== 'ambiguous') expect(db.prepare('select path from worktrees where path=?').get(gone)).toEqual({ path: gone });
    } finally { db.close(); }
  });

  it('drain은 과거 세션을 한 번 다시 판단하고 doctor는 꼬리표 없는 수를 보인다', async () => {
    const home = await installedHome();
    const cwd = await repositoryIn(home, 'repo', 'https://demo.example/brain-owner/notes.git');
    const transcript = await transcriptForFolder(home, cwd);
    const config = join(home, 'claude-config');
    const folder = join(config, 'projects', 'demo-repo');
    await mkdir(folder, { recursive: true });
    await copyFile(transcript, join(folder, `${sessionIdFor(1)}.jsonl`));
    const db = new DatabaseSync(databaseIn(home));
    try {
      const user = db.prepare('select id from users where is_self=1').get()?.['id'];
      db.prepare(`insert into sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source)
        values(?, 'claude-code', ?, ?, 'demo-machine', '2026-01-01T00:00:00.000Z', 'import')`)
        .run('01940000-0000-7000-8000-000000000991', sessionIdFor(1), user as string);
    } finally { db.close(); }
    const environment = { CLAUDE_CONFIG_DIR: config };
    const first = await runBrain(['queue', 'drain', '--json'], home, '', environment);
    expect(first.code, first.stderr).toBe(0);
    let read = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      expect(read.prepare('select first_cwd,tag_source from sessions').get()).toEqual({ first_cwd: cwd, tag_source: 'cwd' });
      expect(read.prepare("select count(*) n from work_items where kind='session_identity'").get()?.['n']).toBe(1);
    } finally { read.close(); }
    const second = await runBrain(['queue', 'drain', '--json'], home, '', environment);
    expect(second.code, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, data: { claimed: 0 } });
    read = new DatabaseSync(databaseIn(home));
    try {
      const user = read.prepare('select id from users where is_self=1').get()?.['id'];
      for (let ordinal = 1; ordinal <= 2; ordinal++) read.prepare(`insert into sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source,first_cwd)
        values(?, 'demo', ?, ?, 'demo-machine', '2026-01-01T00:00:00.000Z', 'import', '/demo/outside')`)
        .run(`01940000-0000-7000-8000-00000000099${ordinal + 1}`, `outside-${ordinal}`, user as string);
      expect(read.prepare("select count(*) n from work_items where kind='session_identity'").get()?.['n']).toBe(1);
    } finally { read.close(); }
    const doctor = await runBrain(['doctor', 'run', '--json'], home, '', environment);
    expect(JSON.parse(doctor.stdout).data.checks).toContainEqual({ id: 'untagged', status: 'ok', detail: '2건' });
  });

  it.each([
    ['github.com', 1], ['bitbucket.org', 1], ['demo.example', 2],
  ])('compares clone identity paths for %s (projects: %s)', async (host, count) => {
    const home = await installedHome();
    const folders = [
      await repositoryIn(home, 'upper', `https://${host}/Brain-Owner/Notes.git`),
      await repositoryIn(home, 'lower', `git@${host}:brain-owner/notes.git`),
    ];
    for (const [ordinal, cwd] of folders.entries()) {
      const transcript = await transcriptForFolder(home, cwd, `case-${ordinal}`);
      const ran = await runBrain(['sessions', 'ingest', 'claude-code', '--json'], home,
        stopPayload(transcript, sessionIdFor(ordinal + 1)));
      expect(ran.code, ran.stderr).toBe(0);
    }
    const db = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      const projects = db.prepare('select remote_identity, identity_key from projects order by remote_identity').all();
      expect(projects).toHaveLength(count);
      if (count === 1) {
        expect(projects[0]).toEqual({ remote_identity: `${host}/Brain-Owner/Notes`, identity_key: `${host}/brain-owner/notes` });
        const sessions = db.prepare('select distinct project_id from sessions').all();
        expect(sessions).toHaveLength(1);
      }
    } finally { db.close(); }
  });

  it('defers unknown identity without git and restores tags through queue drain', async () => {
    const home = await installedHome();
    const cwd = await repositoryIn(home, 'repo', 'git@github.com:brain-owner/notes.git');
    const transcript = await transcriptForFolder(home, cwd);
    const bin = join(home, 'node-only-bin');
    await mkdir(bin);
    await symlink(process.execPath, join(bin, 'node'));
    const payload = stopPayload(transcript, sessionIdFor(1));
    // Both initial captures can observe unknown, but only one creates the session and its work.
    for (const run of await Promise.all([1, 2].map(() => runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'], home, payload, { PATH: bin },
    )))) expect(run.code, run.stderr).toBe(0);
    let db = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      expect(db.prepare('select project_id, worktree_id from sessions').all())
        .toEqual([{ project_id: null, worktree_id: null }]);
      expect(db.prepare('select kind, completed_at from work_items').all())
        .toEqual([{ kind: 'session_identity', completed_at: null }]);
    } finally { db.close(); }
    const config = join(home, 'claude-config');
    const folder = join(config, 'projects', 'demo-repo');
    await mkdir(folder, { recursive: true });
    await copyFile(transcript, join(folder, `${sessionIdFor(1)}.jsonl`));
    const ran = await runBrain(['queue', 'drain', '--json'], home, '', {
      CLAUDE_CONFIG_DIR: config,
    });
    expect(ran.code, ran.stderr).toBe(0);
    const stored = tags(databaseIn(home));
    expect(stored.sessions).toEqual([{
      harness_session_id: sessionIdFor(1), identity: 'github.com/brain-owner/notes', path: cwd,
    }]);
    db = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      expect(db.prepare("select completed_at from work_items where kind = 'session_identity'").get()?.['completed_at']).not.toBeNull();
    } finally { db.close(); }
    const failures = await runBrain(['failures', 'list', '--json'], home, '');
    expect(JSON.parse(failures.stdout)).toMatchObject({ ok: true, data: { failures: [] } });
  });

  it('closes identity work for tagged sessions without changing tags or checkout rows', async () => {
    const home = await installedHome();
    const cwd = await repositoryIn(home, 'repo', 'git@demo.example:brain-owner/notes.git');
    const transcript = await transcriptForFolder(home, cwd);
    expect((await runBrain(['sessions', 'ingest', 'claude-code', '--json'], home,
      stopPayload(transcript, sessionIdFor(1)))).code).toBe(0);
    const before = tags(databaseIn(home));
    const db = new DatabaseSync(databaseIn(home));
    try {
      db.prepare(`insert into work_items(id, kind, target_kind, target_id, created_at, attempts, next_attempt_at)
        values (?, 'session_identity', 'session', ?, ?, 0, ?)`).run(
          '01940000-0000-7000-8000-000000000810', `claude-code:${sessionIdFor(1)}`,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    } finally { db.close(); }
    expect((await runBrain(['queue', 'drain', '--json'], home, '')).code).toBe(0);
    expect(tags(databaseIn(home))).toEqual(before);
    const read = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      expect(read.prepare("select completed_at from work_items where kind = 'session_identity'").get()?.['completed_at']).not.toBeNull();
    } finally { read.close(); }
  });

  it('puts two worktrees of one clone under one project', async () => {
    const home = await installedHome();
    const main = await repositoryIn(home, 'repo', 'git@demo.example:brain-owner/notes.git');
    const review = join(await realpath(home), 'review');
    await git(main, 'worktree', 'add', '-q', review, '-b', 'review');

    for (const [ordinal, cwd] of [main, review].entries()) {
      const transcript = await transcriptForFolder(home, cwd, `t${String(ordinal)}`);
      const ran = await runBrain(
        ['sessions', 'ingest', 'claude-code', '--json'],
        home,
        stopPayload(transcript, sessionIdFor(ordinal + 1)),
      );
      expect(ran.stderr, ran.stderr).toBe('');
      expect(ran.code).toBe(0);
    }

    const stored = tags(databaseIn(home));
    // One identity, two folders, and the two sessions on different worktrees
    // of the same project (AD-12).
    expect(stored.projects).toEqual([{ remote_identity: 'demo.example/brain-owner/notes' }]);
    expect(stored.worktrees).toEqual([
      { path: main, removed_at: null },
      { path: review, removed_at: null },
    ]);
    expect(stored.sessions.map((session) => session.identity)).toEqual([
      'demo.example/brain-owner/notes',
      'demo.example/brain-owner/notes',
    ]);
    expect(new Set(stored.sessions.map((session) => session.path)).size).toBe(2);
  });

  it('tags a session whose first message is a hand-back from the next message', async () => {
    // The shape this story is here for: the conversation opens with a report
    // handed back by a subagent that ran in another worktree, and that line
    // carries the subagent's folder. Taken as the session's, it would tag the
    // whole conversation with somebody else's checkout — for ever, because the
    // tags are worked out once (AD-12, follow-up review #3). The parser
    // reports no folder for that line, so the evidence is the next message's.
    const home = await installedHome();
    const main = await repositoryIn(home, 'repo', 'git@demo.example:brain-owner/notes.git');
    const transcript = await provenanceTranscriptIn(home, main);
    // The subagent's folder is still in the file, and it is not a repository
    // of this home: if anything asked git about it the answer would be null
    // and the session would come out untagged.
    expect(await readFile(transcript, 'utf8')).toContain(PROVENANCE_SUBAGENT_CWD);

    const ran = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript, sessionIdFor(1)),
    );

    expect(ran.stderr, ran.stderr).toBe('');
    expect(ran.code).toBe(0);
    const stored = tags(databaseIn(home));
    expect(stored.projects).toEqual([{ remote_identity: 'demo.example/brain-owner/notes' }]);
    expect(stored.worktrees).toEqual([{ path: main, removed_at: null }]);
    expect(stored.sessions).toEqual([
      {
        harness_session_id: sessionIdFor(1),
        identity: 'demo.example/brain-owner/notes',
        path: main,
      },
    ]);
  });

  it('makes one session, one project and one worktree when two first ingests overlap', async () => {
    const home = await installedHome();
    const main = await repositoryIn(home, 'repo', 'git@demo.example:brain-owner/notes.git');
    const transcript = await transcriptForFolder(home, main, 't0');
    const payload = stopPayload(transcript, sessionIdFor(1));

    // Both processes find no session and inspect the folder; the one SQLite
    // writer lines them up, and the second finds the row the first made.
    const runs = await Promise.all([
      runBrain(['sessions', 'ingest', 'claude-code', '--json'], home, payload),
      runBrain(['sessions', 'ingest', 'claude-code', '--json'], home, payload),
    ]);
    for (const run of runs) expect(run.code, run.stderr).toBe(0);

    const stored = tags(databaseIn(home));
    expect(stored.projects).toEqual([{ remote_identity: 'demo.example/brain-owner/notes' }]);
    expect(stored.worktrees).toEqual([{ path: main, removed_at: null }]);
    expect(stored.sessions).toEqual([
      {
        harness_session_id: sessionIdFor(1),
        identity: 'demo.example/brain-owner/notes',
        path: main,
      },
    ]);
  });

  it('puts an ssh clone and an https clone of one repository under one project', async () => {
    const home = await installedHome();
    const overSsh = await repositoryIn(home, 'ssh', 'git@DEMO.example:brain-owner/notes.git');
    const overHttps = await repositoryIn(
      home,
      'https',
      'https://brain-owner:s3cr3t-token@demo.example/brain-owner/notes.git',
    );

    for (const [ordinal, cwd] of [overSsh, overHttps].entries()) {
      const transcript = await transcriptForFolder(home, cwd, `t${String(ordinal)}`);
      expect(
        (
          await runBrain(
            ['sessions', 'ingest', 'claude-code'],
            home,
            stopPayload(transcript, sessionIdFor(ordinal + 1)),
          )
        ).code,
      ).toBe(0);
    }

    const stored = tags(databaseIn(home));
    expect(stored.projects).toEqual([{ remote_identity: 'demo.example/brain-owner/notes' }]);
    // And the token of the https remote reached no column anywhere (NFR-1).
    const everything = await readFile(databaseIn(home));
    expect(everything.includes(Buffer.from('s3cr3t-token'))).toBe(false);
  });

  it('ingests a session opened outside a repository with no project at all', async () => {
    const home = await installedHome();
    const plain = join(await realpath(home), 'not-a-repo');
    await mkdir(plain, { recursive: true });

    // Two folders git can say nothing about: one that is there and is no
    // repository, and one the transcript names that does not exist any more.
    for (const [ordinal, cwd] of [plain, '/demo/repo'].entries()) {
      const transcript = await transcriptForFolder(home, cwd, `t${String(ordinal)}`);
      const ran = await runBrain(
        ['sessions', 'ingest', 'claude-code', '--json'],
        home,
        stopPayload(transcript, sessionIdFor(ordinal + 1)),
      );
      expect(ran.code).toBe(0);
      // Not a failure and not a warning: capture comes before the tags
      // (Decision 2026-10-18).
      expect((JSON.parse(ran.stdout) as Envelope).warnings).toEqual([]);
      expect((JSON.parse(ran.stdout) as Envelope).data).toMatchObject({ created: true });
    }

    const stored = tags(databaseIn(home));
    expect(stored.projects).toEqual([]);
    expect(stored.worktrees).toEqual([]);
    expect(stored.sessions.map((session) => [session.identity, session.path])).toEqual([
      [null, null],
      [null, null],
    ]);
    const database = new DatabaseSync(databaseIn(home), { readOnly: true });
    try {
      expect(database.prepare('select count(*) as count from work_items').get()).toEqual({ count: 0 });
    } finally { database.close(); }
  });

  it('leaves the tags alone when the same session is ingested after the repository moved', async () => {
    const home = await installedHome();
    const path = await repositoryIn(home, 'repo', 'git@demo.example:brain-owner/notes.git');
    const transcript = await transcriptForFolder(home, path);
    const payload = stopPayload(transcript);
    expect((await runBrain(['sessions', 'ingest', 'claude-code'], home, payload)).code).toBe(0);
    const before = tags(databaseIn(home));

    // The remote changed and the folder went: the one thing the tags may never
    // do is follow (AD-12). The transcript still names the old folder.
    await git(path, 'remote', 'set-url', 'origin', 'git@demo.example:brain-owner/other.git');
    await rm(path, { recursive: true, force: true });
    const again = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      payload,
    );

    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as Envelope).data).toMatchObject({
      created: false,
      inserted: { messages: 0, toolNotes: 0 },
    });
    // Not one row and not one tag moved, and `removed_at` is still empty:
    // marking a folder that is gone is drain's, not this verb's.
    expect(tags(databaseIn(home))).toEqual(before);
    expect(before.projects).toEqual([{ remote_identity: 'demo.example/brain-owner/notes' }]);
    expect(before.worktrees).toEqual([{ path, removed_at: null }]);
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

  it('says TRANSCRIPT_UNREADABLE for a file with no readable line in it', async () => {
    // One broken line in a readable file is a crash, and the rest of the
    // session is collected with a warning (#11). A file where *nothing* parses
    // is not a Claude Code transcript at all, and there is nothing to ingest.
    const home = await installedHome();
    const transcript = join(home, 'broken.jsonl');
    await writeFile(transcript, 'not json at all {\nnor is this one {\n', 'utf8');

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
  ])('says USAGE for a payload that is %s', async (_name, payload) => {
    const home = await installedHome();

    const run = await runBrain(['sessions', 'ingest', 'claude-code'], home, payload);

    await expectQuietFailure(run, 'USAGE', home);
  });

  it('looks the transcript up by session id when the payload named no path', async () => {
    // A payload with only `session_id` is still one worth acting on: the ingest
    // asks that harness's transcript folder for the file (story 12). With no
    // folder — the capture switch is off here — there is nowhere to look, and
    // the answer is the same code as a file that cannot be read.
    const home = await installedHome();

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code'],
      home,
      JSON.stringify({ session_id: 'abc' }),
    );

    await expectQuietFailure(run, 'TRANSCRIPT_UNREADABLE', home);
    expect(run.stderr).toContain('트랜스크립트를 찾을 수 없습니다');
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

  it('says CONFIG_MISSING in one line when no brain is installed here', async () => {
    const home = await temporary.create('brain-ingest-bare-');

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

/**
 * The spool rows of the story's matrix, through the real binary and a real
 * SQLite file: a turn whose write the database would not take ends as a
 * success with a mark in `<home>/spool/`, and nothing reaches the database
 * (AD-9).
 *
 * Every row here is one a person actually meets. A held lock is two hooks of
 * the same session overlapping; a schema mismatch is a build that moved ahead
 * of its database; a missing file is a database somebody moved or removed.
 */
describe('brain sessions ingest claude-code when the database will not take the turn', () => {
  const lockHolderPath = fileURLToPath(new URL('./fixtures/lock-holder.mjs', import.meta.url));

  /**
   * Every "ingest this session again" mark of a home, oldest first.
   *
   * It narrows to the one kind on purpose: a record of another kind in here
   * would be a different fact about a different thing, and a helper that handed
   * back the union would let a test about an ingest mark pass on a failure
   * record (AD-9).
   */
  async function spooled(home: string): Promise<SessionIngestSpoolRecord[]> {
    return (await spooledRecords(home)).filter(
      (record): record is SessionIngestSpoolRecord => record.kind === 'session_ingest',
    );
  }

  /** Every spool file of a home, oldest first, with the records it holds. */
  async function spooledRecords(home: string): Promise<SpoolRecord[]> {
    const folder = spoolPath(home);
    let names: string[];
    try {
      names = (await readdir(folder)).sort();
    } catch {
      return [];
    }
    const records: SpoolRecord[] = [];
    for (const name of names) {
      // Nothing half-written may be read, and nothing is claimed here: a
      // waiting file is a `.jsonl` and nothing else (AD-9).
      expect(name.endsWith('.jsonl'), `${name} is not a finished spool file`).toBe(true);
      const text = await readFile(join(folder, name), 'utf8');
      for (const line of text.split('\n').filter((candidate) => candidate !== '')) {
        const decoded = decodeSpoolLine(line);
        expect(decoded.ok, decoded.ok ? '' : decoded.message).toBe(true);
        if (decoded.ok) records.push(decoded.record);
      }
    }
    return records;
  }

  /** What every spooled row of the matrix has in common. */
  function expectSpooledTurn(run: Run, warnings: readonly string[]): Envelope {
    // Exit 0 and a result, not a failure: the turn worked, and the warning
    // codes are how it says the write has not landed yet (NFR-2, NFR-3).
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(warnings);
    expect(envelope.data).toMatchObject({
      session: `claude-code:${HARNESS_SESSION}`,
      spooled: true,
      created: false,
      inserted: { messages: 0, toolNotes: 0 },
    });
    return envelope;
  }

  /** A second process holding the one SQLite writer, and when to let go. */
  async function holdTheLock(home: string, holdMs: number): Promise<() => Promise<void>> {
    const child = spawn(process.execPath, [lockHolderPath, databaseIn(home), String(holdMs)], {
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

  it('@파일은 시점 내용과 홈 상대 원본 위치를 남기고 잠금 재주입도 같은 행을 만든다', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQcEj4DwADBAHAgChw2gAAAABJRU5ErkJggg==', 'base64');
    const pdf = Buffer.from('%PDF-neutral');
    const args = ['sessions', 'ingest', 'claude-code', '--json'];
    async function fixture(home: string) {
      const sourceHome = join(home, 'source-home');
      const project = join(sourceHome, 'project');
      await mkdir(project, { recursive: true });
      const outside = join(await temporary.create('brain-outside-'), 'outside.txt');
      const note = join(project, 'note.md'); const pic = join(project, 'pic.png');
      const doc = join(project, 'doc.pdf'); const long = join(project, 'long.txt');
      await writeFile(note, 'changed on disk'); await writeFile(pic, png); await writeFile(doc, pdf);
      await writeFile(long, 'one\ntwo\nthree'); await writeFile(outside, 'outside text');
      const text = (content: string, totalLines = 1) => ({ type: 'text', file: { content, numLines: 1, startLine: 1, totalLines } });
      const paths = [note, pic, doc, long, outside];
      const contents = [text('at attachment time'), { type: 'image', file: { base64: png.toString('base64'), originalSize: png.length } }, { type: 'pdf', file: { base64: '', originalSize: pdf.length } }, text('one', 3), text('outside text')];
      const lines: unknown[] = [{ type: 'user', uuid: 'attached-user', timestamp: '2026-10-26T00:00:00.000Z', message: { content: [{ type: 'text', text: '파일 읽기' }, { type: 'image', source: { type: 'base64', data: png.toString('base64') } }] } }];
      for (let i = 0; i < paths.length; i++) lines.push({ type: 'attachment', uuid: `attachment-${i}`, parentUuid: i === 0 ? 'attached-user' : `attachment-${i - 1}`, attachment: { type: 'file', filename: paths[i], content: contents[i], ...(i === 3 ? { truncated: true } : {}) } });
      await rm(long);
      const transcript = join(home, 'at-files.jsonl'); await writeFile(transcript, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
      const remaining = [note, pic, doc, outside];
      const originals = await Promise.all(remaining.map(async path => ({ path, bytes: await readFile(path), mtime: (await stat(path)).mtimeMs })));
      return { sourceHome, payload: stopPayload(transcript), originals };
    }
    async function verify(home: string, source: Awaited<ReturnType<typeof fixture>>) {
      const db = new DatabaseSync(databaseIn(home), { readOnly: true });
      try {
        const attachments = db.prepare('select a.ordinal, a.source_kind, a.source_ref, a.display_name, a.status, f.content_hash, l.locator from message_attachments a left join files f on f.id=a.file_id left join file_locations l on l.id=f.home_location_id order by a.ordinal').all() as { ordinal: number; status: string; content_hash: string | null; locator: string | null }[];
        expect(attachments.map(a => a.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(attachments.map(a => a.status)).toEqual(['stored', 'stored', 'stored', 'stored', 'missing_at_ingest', 'stored']);
        expect(attachments[0]?.content_hash).toBe(attachments[2]?.content_hash);
        expect(db.prepare('select count(*) as n from files').get()?.n).toBe(4);
        expect(db.prepare("select locator from file_locations where ownership='external' order by locator").all()).toEqual([{ locator: '~/project/doc.pdf' }, { locator: '~/project/note.md' }, { locator: '~/project/pic.png' }]);
        expect(db.prepare('select count(*) as n from file_locations').get()?.n).toBe(7);
        expect(await readFile(join(home, 'files', attachments[1]!.locator!), 'utf8')).toBe('at attachment time');
        expect(await readFile(join(home, 'files', attachments[3]!.locator!))).toEqual(pdf);
        for (const original of source.originals) {
          expect(await readFile(original.path)).toEqual(original.bytes);
          expect((await stat(original.path)).mtimeMs).toBe(original.mtime);
        }
        return attachments;
      } finally { db.close(); }
    }
    async function drainAndNames(home: string, sourceHome: string) {
      expect((await runBrain(['queue', 'drain', '--json'], home, '', { HOME: sourceHome })).code).toBe(0);
      const db = new DatabaseSync(databaseIn(home), { readOnly: true });
      try {
        const names = db.prepare('select name_source, text from file_names order by name_source, text').all();
        expect(names).toHaveLength(7);
        for (const name of ['note.md', 'pic.png']) {
          expect(db.prepare('select count(*) as n from file_names_fts where file_names_fts match ?').get(`"${name}"`)?.n).toBe(2);
          expect(db.prepare('select count(*) as n from file_names_fts where file_names_fts match ?').get(`"~/project/${name}"`)?.n).toBe(1);
        }
        return names;
      } finally { db.close(); }
    }
    const direct = await installedHome(); const directSource = await fixture(direct);
    expect((await runBrain(args, direct, directSource.payload, { HOME: directSource.sourceHome })).code).toBe(0);
    const expected = await verify(direct, directSource);
    const names = await drainAndNames(direct, directSource.sourceHome);
    expect((await runBrain(args, direct, directSource.payload, { HOME: directSource.sourceHome })).code).toBe(0);
    expect(await verify(direct, directSource)).toEqual(expected);
    expect(await drainAndNames(direct, directSource.sourceHome)).toEqual(names);
    const locked = await installedHome(); const lockedSource = await fixture(locked);
    const release = await holdTheLock(locked, 20_000);
    try {
      const run = await runBrain(args, locked, lockedSource.payload, { HOME: lockedSource.sourceHome });
      expect(run.code).toBe(0); expect(JSON.parse(run.stdout)).toMatchObject({ warnings: ['SPOOLED'], data: { spooled: true } });
      const pending = (await readdir(spoolPath(locked))).filter(name => name.endsWith('.jsonl'));
      expect(pending).toHaveLength(1);
      const text = await readFile(join(spoolPath(locked), pending[0]!), 'utf8');
      const records = text.trim().split('\n').map(line => JSON.parse(line) as { kind: string; payload: { status?: string } });
      expect(records.map(r => r.kind)).toEqual(['session_ingest', ...Array<string>(6).fill('attachment_link')]);
      expect(records.filter(r => r.payload.status === 'missing_at_ingest')).toHaveLength(1);
      expect(text).not.toContain(lockedSource.sourceHome);
    } finally { await release(); }
    expect(await drainAndNames(locked, lockedSource.sourceHome)).toEqual(names);
    expect(await verify(locked, lockedSource)).toEqual(expected);
    expect((await readdir(spoolPath(locked))).filter(name => name.endsWith('.jsonl'))).toEqual([]);
  }, 30_000);

  it('drain은 붙인 텍스트 문서를 조각으로 만들고 이름만 txt인 그림은 unsupported로 닫는다', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQcEj4DwADBAHAgChw2gAAAABJRU5ErkJggg==', 'base64');
    const home = await installedHome();
    const sourceHome = join(home, 'source-home');
    const project = join(sourceHome, 'project');
    await mkdir(project, { recursive: true });
    const note = join(project, 'note.md');
    const plain = join(project, 'plain.txt');
    // A PNG under a name that says text, which is the whole point: the format
    // is decided from the bytes and the name is never consulted.
    const trap = join(project, 'trap.txt');
    const noteText = '# 제목\n\nneedlebody 첫 줄입니다.\n';
    const plainText = 'plainneedle 둘째 문서입니다.\n';
    await writeFile(note, noteText);
    await writeFile(plain, plainText);
    await writeFile(trap, png);
    const text = (content: string) => ({ type: 'text', file: { content, numLines: 1, startLine: 1, totalLines: 1 } });
    const lines: unknown[] = [
      { type: 'user', uuid: 'extract-user', timestamp: '2026-10-26T00:00:00.000Z', message: { content: [{ type: 'text', text: '파일 읽기' }] } },
      { type: 'attachment', uuid: 'extract-0', parentUuid: 'extract-user', attachment: { type: 'file', filename: note, content: text(noteText) } },
      { type: 'attachment', uuid: 'extract-1', parentUuid: 'extract-0', attachment: { type: 'file', filename: plain, content: text(plainText) } },
      { type: 'attachment', uuid: 'extract-2', parentUuid: 'extract-1', attachment: { type: 'file', filename: trap, content: { type: 'image', file: { base64: png.toString('base64'), originalSize: png.length } } } },
    ];
    const transcript = join(home, 'extract-files.jsonl');
    await writeFile(transcript, lines.map(line => JSON.stringify(line)).join('\n') + '\n');

    expect((await runBrain(['sessions', 'ingest', 'claude-code', '--json'], home, stopPayload(transcript), { HOME: sourceHome })).code).toBe(0);
    expect((await runBrain(['queue', 'drain', '--json'], home, '', { HOME: sourceHome })).code).toBe(0);

    function read(path: string) {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const generations = db.prepare(`select n.text as name, e.status, e.media_type, e.extractor_version, e.index_config_id, e.attempt,
            case when f.current_extraction_id is e.id then 1 else 0 end as current
          from document_extractions e join files f on f.id = e.file_id
          join file_names n on n.file_id = f.id and n.name_source = 'attachment_name'
          order by n.text`).all() as Record<string, unknown>[];
        const chunks = db.prepare('select body, chunk_locator, page from document_chunks order by ordinal').all() as { body: string; chunk_locator: string; page: number | null }[];
        const found = (needle: string) => (db.prepare('select count(*) as n from document_chunks_fts where document_chunks_fts match ?').get(`"${needle}"`) as { n: number }).n;
        return {
          generations,
          chunks,
          needles: { needlebody: found('needlebody'), plainneedle: found('plainneedle') },
          // Scoped to the file: this transcript lives outside the harness
          // folder, so `session_identity` records one of its own and that is
          // not what this case is about.
          failures: db.prepare("select stage, code from failures where target_kind = 'file'").all(),
        };
      } finally { db.close(); }
    }

    const after = read(databaseIn(home));
    expect(after.failures).toEqual([]);
    expect(after.generations).toEqual([
      { name: 'note.md', status: 'ok', media_type: 'text/plain', extractor_version: 'doc/1', index_config_id: '019a0000-0000-7000-8000-000000000002', attempt: 1, current: 1 },
      { name: 'plain.txt', status: 'ok', media_type: 'text/plain', extractor_version: 'doc/1', index_config_id: '019a0000-0000-7000-8000-000000000002', attempt: 1, current: 1 },
      // The trap: read, answered, and no failure row for it (Design Notes).
      { name: 'trap.txt', status: 'unsupported', media_type: null, extractor_version: 'doc/1', index_config_id: null, attempt: 1, current: 0 },
    ]);
    expect(after.chunks.map(chunk => chunk.body).sort()).toEqual([noteText, plainText].sort());
    for (const chunk of after.chunks) {
      expect(chunk.page).toBe(null);
      expect(JSON.parse(chunk.chunk_locator)).toMatchObject({ type: 'text', start: 0 });
    }
    expect(after.needles).toEqual({ needlebody: 1, plainneedle: 1 });

    // A second drain finds nothing to do: the generation rows are what keep the
    // three files out of the queueing step's read.
    expect((await runBrain(['queue', 'drain', '--json'], home, '', { HOME: sourceHome })).code).toBe(0);
    expect(read(databaseIn(home))).toEqual(after);
  }, 30_000);

  it('이미지 원본은 한 번 남고 이미지뿐인 메시지와 재수집과 잠금 뒤 재주입도 같은 연결을 만든다', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQcEj4DwADBAHAgChw2gAAAABJRU5ErkJggg==', 'base64');
    const image = {type:'image',source:{type:'base64',media_type:'image/png',data:png.toString('base64')}};
    const lines = [
      {type:'user',uuid:'image-text',timestamp:'2026-10-23T00:00:00.000Z',imagePasteIds:[1],message:{content:[{type:'text',text:'그림'},image]}},
      {type:'user',uuid:'image-only',timestamp:'2026-10-23T00:00:01.000Z',imagePasteIds:[2],message:{content:[image]}},
      {type:'user',uuid:'tool-image',timestamp:'2026-10-23T00:00:02.000Z',message:{content:[{type:'tool_result',tool_use_id:'x',content:[image]}]}},
    ].map(x=>JSON.stringify(x)).join('\n')+'\n';
    async function input(home: string) { const path=join(home,'images.jsonl'); await writeFile(path,lines); return stopPayload(path); }
    async function verify(home: string) {
      const counts=rowCounts(databaseIn(home)); expect(counts['files']).toBe(1); expect(counts['file_locations']).toBe(1); expect(counts['message_attachments']).toBe(2); expect(counts['messages']).toBe(2);
      const db=new DatabaseSync(databaseIn(home),{readOnly:true});
      try {
        const rows=db.prepare(`select m.harness_message_id, m.body, a.ordinal, a.source_kind, a.source_ref, a.status, f.content_hash, f.size_bytes, l.store_kind, l.locator, l.ownership
          from messages m join message_attachments a on a.message_id=m.id join files f on f.id=a.file_id join file_locations l on l.id=f.home_location_id order by m.harness_message_id`).all() as {harness_message_id:string;body:string;ordinal:number;source_kind:string;source_ref:string;status:string;locator:string}[];
        expect(rows).toHaveLength(2); expect(rows[0]?.body).toBe('');
        for(const row of rows) {
          expect(row).toMatchObject({ordinal:0,source_kind:'image',status:'stored',store_kind:'local',ownership:'brain',size_bytes:png.length});
          const path=join(home,'files',row.locator); expect(await readFile(path)).toEqual(png); expect((await stat(path)).mode & 0o777).toBe(0o600);
          for(const folder of [join(home,'files'),dirname(dirname(path)),dirname(path)]) expect((await stat(folder)).mode & 0o777).toBe(0o700);
        }
        const files=await readdir(join(home,'files'),{recursive:true,withFileTypes:true}); expect(files.filter(x=>x.isFile())).toHaveLength(1);
        return rows;
      } finally {db.close();}
    }
    const direct=await installedHome(); const directPayload=await input(direct);
    const args=['sessions','ingest','claude-code','--json'];
    expect((await runBrain(args,direct,directPayload)).code).toBe(0);
    const expected=await verify(direct);
    expect((await runBrain(args,direct,directPayload)).code).toBe(0); expect(await verify(direct)).toEqual(expected);
    const locked=await installedHome(); const lockedPayload=await input(locked);
    const release=await holdTheLock(locked,20_000);
    try {
      const run=await runBrain(args,locked,lockedPayload); expect(run.code).toBe(0); expect(JSON.parse(run.stdout)).toMatchObject({warnings:['SPOOLED'],data:{spooled:true}});
      const files=await readdir(spoolPath(locked)); const pending=files.filter(x=>x.endsWith('.jsonl')); expect(pending).toHaveLength(1);
      const text=await readFile(join(spoolPath(locked),pending[0]!), 'utf8');
      expect(text.trim().split('\n').map(line=>(JSON.parse(line) as {kind:string}).kind)).toEqual(['session_ingest','attachment_link','attachment_link']);
      expect(text).not.toContain(png.toString('base64'));
    } finally {await release();}
    expect((await runBrain(['queue','drain','--json'],locked,'')).code).toBe(0);
    expect(await verify(locked)).toEqual(expected);
    expect((await readdir(spoolPath(locked))).filter(x=>x.endsWith('.jsonl'))).toEqual([]);
  },30_000);

  it('spools the turn, after waiting out its budget once, while another process holds the lock', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    const before = rowCounts(databaseIn(home));
    // Longer than the turn budget, so the lock is still held when the ingest
    // gives up: what is measured is the hook's own three seconds (AD-7).
    const release = await holdTheLock(home, 20_000);

    const startedAt = Date.now();
    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );
    const elapsed = Date.now() - startedAt;

    try {
      // `DB_LOCKED` is not a warning code, so a lock leaves `SPOOLED` alone.
      expectSpooledTurn(run, ['SPOOLED']);
      const records = await spooled(home);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        schemaVersion: 1,
        kind: 'session_ingest',
        payload: {
          session: `claude-code:${HARNESS_SESSION}`,
          transcriptPath: transcript,
          cause: 'DB_LOCKED',
        },
      });
      // The transcript is not copied into the record: the replay reads the
      // file again (story 12).
      expect(JSON.stringify(records)).not.toContain('import notes');
      // Not one row: the one write it tried never went in.
      expect(rowCounts(databaseIn(home))).toEqual(before);

      // The budget once, and not once per store step: a turn that waited three
      // seconds four times would be twelve seconds of somebody's attention
      // (Boundaries). The lock was still held when it gave up.
      expect(elapsed).toBeGreaterThanOrEqual(2_500);
      expect(elapsed).toBeLessThan(9_000);
    } finally {
      await release();
    }
  }, 30_000);

  it('spools the turn, without calling run, when the database is at another version', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    const database = new DatabaseSync(databaseIn(home));
    try {
      database.exec('update schema_version set version = 2');
    } finally {
      database.close();
    }
    const before = rowCounts(databaseIn(home));

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    // The write guard of AD-20: `run` is never called, so the mismatched
    // database is unreachable by construction and not by care.
    expectSpooledTurn(run, ['SPOOLED', 'SCHEMA_MISMATCH']);
    expect((await spooled(home))[0]?.payload.cause).toBe('SCHEMA_MISMATCH');
    // Every table, not only the three this command writes to.
    expect(rowCounts(databaseIn(home))).toEqual(before);
  });

  it('spools the turn, and makes no database, when the file has been removed', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${databaseIn(home)}${suffix}`, { force: true });
    }

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    expectSpooledTurn(run, ['SPOOLED', 'DB_UNAVAILABLE']);
    expect((await spooled(home))[0]?.payload.cause).toBe('DB_UNAVAILABLE');
    // A runtime command opens the store and never creates it (AD-10): a brain
    // that made an empty database here would report itself healthy to
    // somebody who has not installed one.
    expect(existsSync(databaseIn(home))).toBe(false);
  });

  it('says nothing on stdout in text mode when it spools, as when it stores', async () => {
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

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    // The warning line still goes to stderr, as a degraded result's does.
    expect(run.stderr).toContain('SPOOLED');
    expect(await spooled(home)).toHaveLength(1);
  });

  it('reports the original failure, in one line, when the spool cannot be written either', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    const database = new DatabaseSync(databaseIn(home));
    try {
      database.exec('update schema_version set version = 2');
    } finally {
      database.close();
    }
    // A plain file where the spool folder belongs, which is the one state that
    // takes the last place a write could go away.
    await writeFile(spoolPath(home), 'not a folder\n', 'utf8');

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    // The code of what stopped the write, one line on stderr, exit 0: a hook
    // never fails a turn, whatever happened (AD-6).
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(run.stderr).toContain('SCHEMA_MISMATCH');
    // And the message says the fallback failed too, which is the whole reason
    // there is nothing else to report (NFR-2).
    expect(run.stderr).toContain('spool');
    expect(rowCounts(databaseIn(home))['sessions']).toBe(0);
  });

  it('leaves no spool file behind on an ordinary ingest', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);

    const run = await runBrain(
      ['sessions', 'ingest', 'claude-code', '--json'],
      home,
      stopPayload(transcript),
    );

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as Envelope).data).toMatchObject({ spooled: false });
    // Not even the folder: it is made by the first write that needs it.
    expect(existsSync(spoolPath(home))).toBe(false);
    expect(await spooled(home)).toEqual([]);
  });

  it('shows the spooled turn in the doctor report, and still exits 0', async () => {
    // The acceptance criterion, whole: a mark left by a lock timeout, read
    // back through the command a person actually runs. The lock is what makes
    // it a brain with nothing else wrong with it — a schema mismatch would
    // leave a mark too, and a failing check with it, so the exit code would
    // say nothing about the spool.
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    const release = await holdTheLock(home, 20_000);
    try {
      expect(
        (await runBrain(['sessions', 'ingest', 'claude-code'], home, stopPayload(transcript)))
          .code,
      ).toBe(0);
    } finally {
      await release();
    }
    const [record] = await spooled(home);
    expect(record).toBeDefined();

    const doctor = await runBrain(['doctor', 'run', '--json'], home, '');

    // Exit 0: `warn` is a check that ran and settled nothing, and only `fail`
    // fails the command (Conventions, doctor 상태).
    expect(doctor.code).toBe(0);
    const envelope = JSON.parse(doctor.stdout) as {
      warnings: string[];
      data?: {
        checks: { id: string; status: string; code?: string; detail?: string }[];
        summary: { failed: number };
      };
    };
    const spool = envelope.data?.checks.find((check) => check.id === 'spool');
    expect(spool).toMatchObject({ status: 'warn', code: 'SPOOLED' });
    expect(spool?.detail).toContain('1건');
    expect(spool?.detail).toContain(isoWithOffset(record?.occurredAt ?? new Date(0)));
    // A shared code, so the degraded result travels in `warnings[]` too, and
    // nothing else about this brain is wrong.
    expect(envelope.warnings).toContain('SPOOLED');
    expect(envelope.data?.summary.failed).toBe(0);
  }, 30_000);

  it('is ok in the doctor report of a brain with an empty spool', async () => {
    const home = await installedHome();

    const doctor = await runBrain(['doctor', 'run', '--json'], home, '');

    expect(doctor.code).toBe(0);
    const envelope = JSON.parse(doctor.stdout) as {
      warnings: string[];
      data?: { checks: { id: string; status: string; detail?: string }[] };
    };
    expect(envelope.data?.checks.find((check) => check.id === 'spool')).toEqual({
      id: 'spool',
      status: 'ok',
      detail: '0건',
    });
    expect(envelope.warnings).toEqual([]);
  });
});

describe('hook arrival evidence', () => {
  it.each([false, true])('records plugin root before collection, spool=%s', async (spooled) => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    if (spooled) {
      const db = new DatabaseSync(databaseIn(home));
      try { db.exec('update schema_version set version = 2'); } finally { db.close(); }
    }
    const run = await runBrain(['sessions', 'ingest', 'claude-code', '--json'], home, stopPayload(transcript), { SECOND_BRAIN_PLUGIN_ROOT: '/demo/plugin' });
    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as Envelope).data?.spooled).toBe(spooled);
    expect(await readFile(join(home, 'run', 'last-hook-claude-code'), 'utf8')).toBe('/demo/plugin\n');
  });
  it('records an empty file without a plugin root', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    expect((await runBrain(['sessions', 'ingest', 'claude-code'], home, stopPayload(transcript), { SECOND_BRAIN_PLUGIN_ROOT: '' })).code).toBe(0);
    expect(await readFile(join(home, 'run', 'last-hook-claude-code'), 'utf8')).toBe('');
  });
  it('continues collecting when the diagnostic record cannot be written', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    await mkdir(join(home, 'run'), { recursive: true });
    await mkdir(join(home, 'run', 'last-hook-claude-code'));
    const run = await runBrain(['sessions', 'ingest', 'claude-code', '--json'], home, stopPayload(transcript));
    expect((JSON.parse(run.stdout) as Envelope).data?.inserted?.messages).toBeGreaterThan(0);
    expect(run.code).toBe(0);
  });
});

describe('duplicate plugin diagnosis through the CLI', () => {
  it('raises PLUGIN_DUPLICATE in the doctor envelope warnings', async () => {
    const home = await installedHome();
    const transcript = await transcriptIn(home);
    await runBrain(['sessions', 'ingest', 'claude-code'], home, stopPayload(transcript), { SECOND_BRAIN_PLUGIN_ROOT: '/plugins/old' });
    await writeFile(join(home, 'run', 'plugin.json'), JSON.stringify({ plugin_root: '/plugins/current', app_ref: 'a'.repeat(40), seen_at: new Date().toISOString() }));
    const run = await runBrain(['doctor', 'run', '--json'], home, '');
    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as Envelope).warnings).toContain('PLUGIN_DUPLICATE');
  });
});
