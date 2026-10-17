import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parserContract, type ParserSubject } from '@second-brain/core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_HARNESS,
  CLAUDE_CODE_PARSER_VERSION,
  claudeCodeParser,
} from '../src/parser.js';
import { TOOL_TARGET_LIMIT, toolTarget } from '../src/tool-target.js';

/**
 * The Claude Code parser against two transcripts with the real structure in
 * them.
 *
 * `two-turns.jsonl` is the smaller one: editor state with no uuid at all, hook
 * output, a system notice, a meta turn the editor wrote on the person's behalf,
 * thinking, a tool call and its result, a subagent's own conversation, an
 * attachment, and a compact summary — with two actual turns among them.
 *
 * `full-session.jsonl` is this story's: the delegated runs and their reports,
 * the lines that look like conversation and are not, a pasted image, a branch
 * that changes halfway, a compact, a raw U+2028, a stamp that goes backwards,
 * and a call nothing has answered yet.
 *
 * The sentences are neutral because this repository is public (Conventions);
 * the shape around them is the editor's own.
 */

const TWO_TURNS = fileURLToPath(new URL('./fixtures/two-turns.jsonl', import.meta.url));
const FULL_SESSION = fileURLToPath(new URL('./fixtures/full-session.jsonl', import.meta.url));

/** How many lines of `full-session.jsonl` end with its fifth message. */
const HALF_LINES = 25;

/**
 * The two separators that are characters inside a JSON string and not line
 * breaks. Spelled by code point, because a raw one in this file would be an
 * invisible character in an expected value.
 */
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);

/** The markers the fixture puts in every tool output and every image. */
const TOOL_OUTPUT = 'TOOL-OUTPUT-MUST-NOT-BE-STORED';
const BASE64 = 'QkFTRTY0TVVTVE5PVEJFU1RPUkVE';

let transcript: string;
let session: string;

beforeAll(async () => {
  transcript = await readFile(TWO_TURNS, 'utf8');
  session = await readFile(FULL_SESSION, 'utf8');
});

/** The uuid the fixture gives its nth conversation line. */
function id(serial: number): string {
  return `11111111-2222-4333-8444-${String(serial).padStart(12, '0')}`;
}

/** The two turns `two-turns.jsonl` holds, in the order the file holds them. */
const EXPECTED = [
  {
    harnessMessageId: '00000000-0000-4000-8000-000000000003',
    role: 'user',
    model: null,
    body: 'Where did we leave the import notes?',
    occurredAt: new Date('2026-01-02T03:04:05.000Z'),
    gitBranch: 'main',
    cwd: '/demo/repo',
    isSubagentReport: false,
  },
  {
    harnessMessageId: '00000000-0000-4000-8000-000000000008',
    role: 'assistant',
    model: 'demo-model',
    // Two `text` blocks of one answer, joined.
    body: 'They are in notes/import.md.\nI added the open question at the end.',
    occurredAt: new Date('2026-01-02T03:04:08.000Z'),
    gitBranch: 'main',
    cwd: '/demo/repo',
    isSubagentReport: false,
  },
  {
    harnessMessageId: '00000000-0000-4000-8000-000000000012',
    role: 'user',
    model: null,
    body: 'Good. Write that down as a decision.',
    occurredAt: new Date('2026-01-02T03:05:01.000Z'),
    gitBranch: 'main',
    cwd: '/demo/repo',
    isSubagentReport: false,
  },
  {
    harnessMessageId: '00000000-0000-4000-8000-000000000014',
    role: 'assistant',
    model: 'demo-model',
    body: "Written down, with today's date.",
    occurredAt: new Date('2026-01-02T03:05:03.000Z'),
    gitBranch: 'main',
    cwd: '/demo/repo',
    isSubagentReport: false,
  },
];

/** The eight messages `full-session.jsonl` holds. */
const SESSION_MESSAGES = [
  {
    harnessMessageId: id(3),
    role: 'user',
    model: null,
    body: 'Can you check the import notes and summarise them?',
    gitBranch: 'main',
    isSubagentReport: false,
  },
  {
    harnessMessageId: id(9),
    role: 'assistant',
    model: 'demo-model',
    body: 'The notes are in notes/import.md.',
    gitBranch: 'main',
    isSubagentReport: false,
  },
  {
    // The second line of one answer, under the same `message.id` as the line
    // above and stamped a minute *before* it. Order is the file's.
    harnessMessageId: id(10),
    role: 'assistant',
    model: 'demo-model',
    body: 'The open question is still at the end.',
    gitBranch: 'main',
    isSubagentReport: false,
  },
  {
    // The pasted image is gone and the text is not.
    harnessMessageId: id(16),
    role: 'user',
    model: null,
    body: 'Here is the screenshot of the folder.',
    gitBranch: 'main',
    isSubagentReport: false,
  },
  {
    // A delegated run the model waited for: an assistant message with no model.
    harnessMessageId: id(21),
    role: 'assistant',
    model: null,
    body: 'The folder holds four files. import.md is the newest and ends with one open question.',
    gitBranch: 'main',
    isSubagentReport: true,
  },
  {
    // A slash command the person typed. The editor renders it into the
    // conversation, tags and all, and it is still something they said.
    harnessMessageId: id(26),
    role: 'user',
    model: null,
    body:
      '<command-name>/demo-notes</command-name><command-message>demo-notes is running</command-message><command-args>import</command-args>',
    gitBranch: 'feature/notes',
    isSubagentReport: false,
  },
  {
    // And a `!` command they typed, for the same reason: what a tool answered
    // is dropped, what the person asked for is not.
    harnessMessageId: id(28),
    role: 'user',
    model: null,
    body: '<bash-input>ls notes</bash-input>',
    gitBranch: 'feature/notes',
    isSubagentReport: false,
  },
  {
    // A raw U+2028 and a raw U+2029 inside one body: both are characters in a
    // string, and the line was read as one line.
    harnessMessageId: id(31),
    role: 'user',
    model: null,
    body: `Two things while that runs.${LINE_SEPARATOR}Keep the summary short.${PARAGRAPH_SEPARATOR}And say which links are dead.`,
    gitBranch: 'feature/notes',
    isSubagentReport: false,
  },
  {
    // The report of a run that came back later, out of its notification.
    harnessMessageId: id(32),
    role: 'assistant',
    model: null,
    body: 'Every link in notes/ still resolves. Two of them point at the same page.',
    gitBranch: 'feature/notes',
    isSubagentReport: true,
  },
  {
    harnessMessageId: id(33),
    role: 'assistant',
    model: 'demo-model',
    body: 'Both reports are in; I am writing the summary now.',
    gitBranch: 'feature/notes',
    isSubagentReport: false,
  },
];

/** The four tool notes it holds. The fifth call has no answer yet. */
const SESSION_NOTES = [
  { harnessMessageId: id(3), ordinal: 0, tool: 'Read', target: 'notes/import.md', ok: true },
  {
    // The first line of a two-line command, and the result said `is_error`.
    harnessMessageId: id(3),
    ordinal: 1,
    tool: 'Bash',
    target: 'wc -l notes/import.md',
    ok: false,
  },
  {
    harnessMessageId: id(16),
    ordinal: 0,
    tool: 'Agent',
    target: 'Summarise the notes folder',
    ok: true,
  },
  {
    harnessMessageId: id(21),
    ordinal: 0,
    tool: 'Agent',
    target: 'Check the links in the notes',
    ok: true,
  },
];

/** The two of its messages that are a delegated run's final report. */
const SESSION_REPORTS = [id(21), id(32)];

/** The first `HALF_LINES` lines of the session, as a complete file. */
function half(): string {
  return `${session.split('\n').slice(0, HALF_LINES).join('\n')}\n`;
}

/** The same session with a line in front of the cursor's changed. */
function rewrittenSession(): string {
  return session.replace(
    'Can you check the import notes and summarise them?',
    'Can you check the import notes, please?',
  );
}

describe('the parser contract against the Claude Code parser', () => {
  for (const testCase of parserContract()) {
    it(testCase.name, async () => {
      const make = async (): Promise<ParserSubject> => ({
        parser: claudeCodeParser(),
        readable: [
          transcript,
          session,
          // A transcript with no conversation in it yet: the state of a
          // session's first seconds (research §1).
          '{"type":"mode","mode":"normal","sessionId":"s"}\n',
          '',
        ],
        unreadable: ['{"type":"user"}\nnot json at all {\n'],
        grown: [
          { before: half(), after: session },
          // The same thing one turn at a time, on the smaller fixture.
          {
            before: `${transcript.trimEnd().split('\n').slice(0, 10).join('\n')}\n`,
            after: transcript,
          },
        ],
        rewritten: [
          { before: half(), after: rewrittenSession() },
          // A compact: the cursor's own message is not in the file any more.
          {
            before: half(),
            after: `${session.split('\n').slice(HALF_LINES).join('\n')}`,
          },
        ],
      });
      await testCase.run(make);
    });
  }
});

describe('the Claude Code parser', () => {
  it('names its harness and the version it records on a session', () => {
    const parser = claudeCodeParser();
    expect(parser.harness).toBe(CLAUDE_CODE_HARNESS);
    expect(parser.harness).toBe('claude-code');
    expect(parser.version).toBe(CLAUDE_CODE_PARSER_VERSION);
    // The version moves when what the parser produces changes, and this story
    // changed all of it: notes, reports, tracking, the incremental read (AD-4).
    expect(parser.version).toBe('2');
  });

  it('keeps the two turns and nothing else the editor wrote', () => {
    const result = claudeCodeParser().parse(transcript);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual(EXPECTED);
    expect(result.toolNotes).toEqual([
      {
        harnessMessageId: '00000000-0000-4000-8000-000000000003',
        ordinal: 0,
        tool: 'Read',
        target: 'notes/import.md',
        ok: true,
      },
    ]);
    expect(result.parserVersion).toBe(CLAUDE_CODE_PARSER_VERSION);
    expect(result.startSource).toBe('startup');
    expect(result.cursorReset).toBe(false);
  });

  it('says nothing about seq: the order of the array is all it claims', () => {
    const result = claudeCodeParser().parse(transcript);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const message of result.messages) {
      expect(message).not.toHaveProperty('seq');
    }
  });

  it('points the cursor at the last turn, fingerprinting only up to it', () => {
    const result = claudeCodeParser().parse(transcript);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cursor?.lastHarnessMessageId).toBe(EXPECTED.at(-1)?.harnessMessageId);
    expect(result.cursor?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // The fingerprint stops at the line the cursor names, so appending to the
    // transcript does not change it: a fingerprint of the whole file would
    // change every turn and never match (AD-4).
    const grown = claudeCodeParser().parse(
      `${transcript}{"type":"mode","mode":"plan","sessionId":"s"}\n`,
    );
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    expect(grown.cursor).toEqual(result.cursor);
  });

  it('fingerprints the same cursor the same way, newline or not', () => {
    // The Stop hook can read the file in either state: with the cursor's own
    // line just written and no newline after it yet, and again once the next
    // line has landed. Both name the same last message, so both have to
    // fingerprint to the same thing or the second read would take the
    // conversation for a compacted one.
    const midAppend = claudeCodeParser().parse(transcript.trimEnd());
    const afterMore = claudeCodeParser().parse(
      `${transcript.trimEnd()}\n{"type":"mode","mode":"plan","sessionId":"s"}\n`,
    );

    expect(midAppend.ok).toBe(true);
    expect(afterMore.ok).toBe(true);
    if (!midAppend.ok || !afterMore.ok) return;
    expect(midAppend.cursor?.lastHarnessMessageId).toBe(EXPECTED.at(-1)?.harnessMessageId);
    expect(afterMore.cursor).toEqual(midAppend.cursor);
  });

  it('has no cursor for a transcript with no conversation in it', () => {
    const result = claudeCodeParser().parse(
      '{"type":"mode","mode":"normal","sessionId":"s"}\n',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual([]);
    expect(result.cursor).toBeNull();
    expect(result.startSource).toBeNull();
  });

  it('skips a last line the harness is still writing', () => {
    // No trailing newline, and the tail is half an object: the one line that
    // is allowed to be incomplete, because the editor appends as it goes.
    const halfLine = '{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"u-9"';

    const result = claudeCodeParser().parse(`${transcript}${halfLine}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual(EXPECTED);
  });

  it('refuses a broken line in the middle, because that is not a half write', () => {
    const lines = transcript.split('\n');
    lines.splice(6, 0, '{"type":"user", this is not json');

    const result = claudeCodeParser().parse(lines.join('\n'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TRANSCRIPT_UNREADABLE');
    expect(result.message).toContain('7번째 줄');
  });

  it('numbers a broken line by its place in the file, not in the part it read', () => {
    // After a cursor read the parse starts in the middle of the file, and a
    // line number counted from there would send a reader to the wrong line.
    const first = claudeCodeParser().parse(half());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lines = session.split('\n');
    lines.splice(HALF_LINES + 2, 0, '{"type":"user", this is not json');

    const result = claudeCodeParser().parse(lines.join('\n'), first.cursor);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`${String(HALF_LINES + 3)}번째 줄`);
  });

  it('keeps only the first of two lines carrying the same uuid', () => {
    const lines = transcript.trimEnd().split('\n');
    const first = lines.find((line) => line.includes('000000000003'));
    expect(first).toBeDefined();
    const second = (first ?? '').replace(
      'Where did we leave the import notes?',
      'a second copy of the same message',
    );

    const result = claudeCodeParser().parse(`${lines.join('\n')}\n${second}\n`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.map((message) => message.harnessMessageId)).toEqual(
      EXPECTED.map((message) => message.harnessMessageId),
    );
    expect(result.messages[0]?.body).toBe('Where did we leave the import notes?');
  });

  it('skips a line whose timestamp is not a date, rather than storing an invalid one', () => {
    const line = JSON.stringify({
      type: 'user',
      isSidechain: false,
      uuid: '00000000-0000-4000-8000-0000000000ff',
      timestamp: 'the day before yesterday',
      message: { role: 'user', content: 'a message with no usable instant' },
    });

    const result = claudeCodeParser().parse(`${transcript}${line}\n`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual(EXPECTED);
  });

  it.each([
    ['blank lines anywhere', `\n${'\n'}`],
    ['an empty file', ''],
  ])('reads %s as a transcript with nothing in it', (_name, content) => {
    const result = claudeCodeParser().parse(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual([]);
  });
});

describe('the Claude Code parser on a whole session', () => {
  it('keeps the ten messages, with the branch, the cwd and the report mark', () => {
    const result = claudeCodeParser().parse(session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.messages.map((message) => ({
        harnessMessageId: message.harnessMessageId,
        role: message.role,
        model: message.model,
        body: message.body,
        gitBranch: message.gitBranch,
        isSubagentReport: message.isSubagentReport,
      })),
    ).toEqual(SESSION_MESSAGES);
    // The cwd travels on every message so story 2.8 can tag the session with
    // the first one's; no message row keeps it (migration 0004).
    for (const message of result.messages) expect(message.cwd).toBe('/demo/workspace');
    // The stamps are not sorted: the third message was written a minute before
    // the second, and the order of the file is the order of the conversation.
    expect(result.messages[1]?.occurredAt.getTime()).toBeGreaterThan(
      result.messages[2]?.occurredAt.getTime() ?? 0,
    );
  });

  it('reads the two reports of delegated runs and none of their conversation', () => {
    const result = claudeCodeParser().parse(session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reports = result.messages.filter((message) => message.isSubagentReport);
    expect(reports.map((message) => message.harnessMessageId)).toEqual(SESSION_REPORTS);
    // A report is an answer, so it is read as the assistant's, and no model of
    // this session produced it.
    for (const report of reports) {
      expect(report.role).toBe('assistant');
      expect(report.model).toBeNull();
    }
    // The subagent's own turns are `isSidechain` and never messages of this
    // session: the final report is the whole of what a delegated run leaves.
    const bodies = result.messages.map((message) => message.body).join('\n');
    expect(bodies).not.toContain('the folder holds four files');
    expect(bodies).not.toContain('read every file in notes/');
  });

  it('writes one note per tool call, and none for a call with no answer yet', () => {
    const result = claudeCodeParser().parse(session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolNotes).toEqual(SESSION_NOTES);
    // The last line of the fixture is a `Write` whose result has not arrived
    // and that nothing was said after: the harness is still working, so the
    // note waits for the next read rather than going in as a failure.
    expect(result.toolNotes.some((note) => note.tool === 'Write')).toBe(false);
    // And the cursor does not pass it either, so the next read sees it again.
    expect(result.cursor?.lastHarnessMessageId).toBe(id(33));
  });

  it('writes ok: false for a call the conversation moved past unanswered', () => {
    // The same `Write` call, with one more turn behind it: the result is never
    // coming now, and a note that said nothing would be a call nobody can see.
    const andOneMore = `${session}${JSON.stringify({
      type: 'user',
      isSidechain: false,
      cwd: '/demo/workspace',
      gitBranch: 'feature/notes',
      uuid: id(99),
      timestamp: '2026-02-03T10:02:00.000Z',
      message: { role: 'user', content: 'Never mind the summary.' },
    })}\n`;

    const result = claudeCodeParser().parse(andOneMore);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolNotes.at(-1)).toEqual({
      harnessMessageId: id(33),
      ordinal: 0,
      tool: 'Write',
      target: 'notes/summary.md',
      ok: false,
    });
  });

  it('never lets a tool output or a pasted image into a body or a target', () => {
    const result = claudeCodeParser().parse(session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fixture puts the same marker in every tool result, every local
    // command's stdout and the `Write` it never finished; the image carries a
    // base64 marker. None of it is anybody's words, so none of it is stored.
    const stored = [
      ...result.messages.map((message) => message.body),
      ...result.toolNotes.map((note) => note.target),
    ].join('\n');
    expect(session).toContain(TOOL_OUTPUT);
    expect(session).toContain(BASE64);
    expect(stored).not.toContain(TOOL_OUTPUT);
    expect(stored).not.toContain(BASE64);
    for (const marker of [
      '<local-command-stdout>',
      '<local-command-caveat>',
      '<bash-stdout>',
      '<bash-stderr>',
    ]) {
      expect(stored).not.toContain(marker);
    }
  });

  it('drops every line that looks like conversation and is not', () => {
    const result = claudeCodeParser().parse(session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bodies = result.messages.map((message) => message.body).join('\n');
    for (const absent of [
      // An API error the editor rendered, another agent's traffic, a reminder
      // nobody typed, a compact summary and a system notice.
      'API Error',
      'another agent said something',
      'a reminder nobody typed',
      'a summary of everything that came before',
      'the editor announced something',
      // And the notification of a run that had only started.
      'the run started in the background',
      // A tool's own output, whichever marker the editor wrapped it in.
      '<local-command-stdout>',
      '<local-command-caveat>',
      '<bash-stdout>',
      '<bash-stderr>',
    ]) {
      expect(bodies).not.toContain(absent);
    }
    // A background shell reporting in is a task notification with no report in
    // it, and its task is a command and not an agent this session started: not
    // a message, and not a subagent report either.
    expect(bodies).not.toContain('bash-1');
    expect(result.messages).toHaveLength(SESSION_MESSAGES.length);
  });

  it('keeps the commands the person typed, tags and all', () => {
    const result = claudeCodeParser().parse(session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bodies = result.messages.map((message) => message.body);
    // The editor renders a slash command and a `!` command into the
    // conversation. What a tool *answered* is dropped; what the person asked
    // for is something they said (Boundaries).
    expect(bodies.some((body) => body.startsWith('<command-name>/demo-notes'))).toBe(true);
    expect(bodies).toContain('<bash-input>ls notes</bash-input>');
  });

  it('writes one note per call even when the harness wrote the line twice', () => {
    // The same assistant line again, byte for byte: a repeat, not a second
    // call. Two notes for one call would be two notes nobody can tell apart,
    // and a note cannot be taken back (AD-11).
    const lines = session.trimEnd().split('\n');
    const index = lines.findIndex((line) => line.includes('toolu_01'));
    expect(index).toBeGreaterThanOrEqual(0);
    const repeated = [...lines];
    repeated.splice(index + 1, 0, lines[index] ?? '');

    const result = claudeCodeParser().parse(`${repeated.join('\n')}\n`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolNotes).toEqual(SESSION_NOTES);
    expect(result.messages).toHaveLength(SESSION_MESSAGES.length);
  });

  it('reads a task id up to its first closing tag, and a report up to its last', () => {
    // A report that mentions the tags itself. The id is one token and must stop
    // at the first `</task-id>`, or a later tag would swallow it and the report
    // would be lost; the report runs to the last `</result>` so it comes out
    // whole.
    const report = 'The agent printed </task-id> and </result> in its own answer.';
    const notice = `<task-notification><task-id>agent-9c2</task-id><status>completed</status><result>${report}</result></task-notification>`;
    const lines = session.trimEnd().split('\n');
    const index = lines.findIndex((line) => line.includes('<task-id>agent-9c2</task-id>'));
    expect(index).toBeGreaterThanOrEqual(0);
    const patched = lines.map((line, at) => {
      if (at !== index) return line;
      const entry = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify({ ...entry, message: { role: 'user', content: notice } });
    });

    const result = claudeCodeParser().parse(`${patched.join('\n')}\n`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const read = result.messages.find((message) => message.harnessMessageId === id(32));
    expect(read?.isSubagentReport).toBe(true);
    expect(read?.body).toBe(report);
  });

  it('takes the start source from the last SessionStart attachment', () => {
    const result = claudeCodeParser().parse(session);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The file carries `startup` and then, after the compact, `compact`. The
    // newest is why the session is running now.
    expect(result.startSource).toBe('compact');

    const beforeTheCompact = claudeCodeParser().parse(half());
    expect(beforeTheCompact.ok).toBe(true);
    if (!beforeTheCompact.ok) return;
    expect(beforeTheCompact.startSource).toBe('startup');
  });

  it('answers for the whole content even when it read only the tail', () => {
    const first = claudeCodeParser().parse(half());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const incremental = claudeCodeParser().parse(session, first.cursor);
    const whole = claudeCodeParser().parse(session);

    expect(incremental.ok).toBe(true);
    expect(whole.ok).toBe(true);
    if (!incremental.ok || !whole.ok) return;
    expect(incremental.cursorReset).toBe(false);
    // It starts at the cursor's own message and reports the rest of the file.
    expect(incremental.messages).toEqual(whole.messages.slice(4));
    expect(incremental.toolNotes).toEqual([SESSION_NOTES[3]]);
    expect(incremental.cursor).toEqual(whole.cursor);
    // The start source is a fact about the content, not about the part read.
    expect(incremental.startSource).toBe('compact');
  });

  it('reads from the front and says so when the front of the file changed', () => {
    const first = claudeCodeParser().parse(half());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const result = claudeCodeParser().parse(rewrittenSession(), first.cursor);
    const whole = claudeCodeParser().parse(rewrittenSession());

    expect(result.ok).toBe(true);
    expect(whole.ok).toBe(true);
    if (!result.ok || !whole.ok) return;
    expect(result.cursorReset).toBe(true);
    expect(result.messages).toEqual(whole.messages);
    expect(result.messages[0]?.body).toBe('Can you check the import notes, please?');
  });

  it('reads from the front when the cursor names a message the file has lost', () => {
    // What a compact or a fork leaves behind: the message the cursor named is
    // simply not in the file any more.
    const result = claudeCodeParser().parse(session, {
      lastHarnessMessageId: id(5000),
      fingerprint: '0'.repeat(64),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cursorReset).toBe(true);
    expect(result.messages).toHaveLength(SESSION_MESSAGES.length);
  });

  it('refuses a cursor that names a line which is not a message', () => {
    // A cursor whose fingerprint is right to the byte, pointed at the hook
    // attachment of the second line. An incremental read has to begin at the
    // cursor's own message, so a line the rules do not keep cannot start one —
    // which is what makes a parser version bump safe: the old cursor stops
    // matching and the session is read again from the front.
    const lines = session.split('\n');
    const index = lines.findIndex((line) => line.includes('SessionStart:startup'));
    expect(index).toBeGreaterThanOrEqual(0);
    const entry = JSON.parse(lines[index] ?? '{}') as { uuid: string };
    const cursor = {
      lastHarnessMessageId: entry.uuid,
      fingerprint: createHash('sha256')
        .update(session.slice(0, lines.slice(0, index + 1).join('\n').length), 'utf8')
        .digest('hex'),
    };

    const result = claudeCodeParser().parse(session, cursor);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cursorReset).toBe(true);
    expect(result.messages).toHaveLength(SESSION_MESSAGES.length);
  });
});

describe('what a tool note says the call acted on', () => {
  it.each([
    ['Bash', { command: 'git status', timeout: 1000 }, 'git status'],
    ['Read', { file_path: 'notes/import.md', offset: 10 }, 'notes/import.md'],
    ['Write', { file_path: 'notes/summary.md', content: 'a whole file' }, 'notes/summary.md'],
    ['Edit', { file_path: 'notes/import.md', old_string: 'a', new_string: 'b' }, 'notes/import.md'],
    ['MultiEdit', { file_path: 'notes/import.md', edits: [] }, 'notes/import.md'],
    ['NotebookEdit', { notebook_path: 'notes/run.ipynb', cell_id: 'c1' }, 'notes/run.ipynb'],
    // Both of these carry a `path` as well, and the pattern is what the call
    // was looking for.
    ['Grep', { pattern: 'open question', path: 'notes' }, 'open question'],
    ['Glob', { pattern: 'notes/**/*.md', path: '.' }, 'notes/**/*.md'],
    ['WebFetch', { url: 'https://example.invalid/notes', prompt: 'read it' }, 'https://example.invalid/notes'],
    ['WebSearch', { query: 'import notes format' }, 'import notes format'],
    ['ToolSearch', { query: 'select:Read' }, 'select:Read'],
    ['Agent', { description: 'Summarise the notes', prompt: 'a long brief' }, 'Summarise the notes'],
    ['Task', { description: 'Check the links', prompt: 'a long brief' }, 'Check the links'],
    ['Skill', { skill: 'demo-skill', args: '--all' }, 'demo-skill'],
    // A tool nobody listed: the first of the fallback keys it carries, from the
    // most specific thing a call can name to the least.
    ['mcp__demo__read_page', { url: 'https://example.invalid/page' }, 'https://example.invalid/page'],
    ['mcp__demo__run', { name: 'a plugin verb' }, 'a plugin verb'],
    ['mcp__demo__find', { query: 'notes', description: 'ignored' }, 'notes'],
    // Nothing that describes the call, which is a value and not a failure.
    ['mcp__demo__ping', { flag: true }, ''],
    ['Bash', {}, ''],
    ['Read', 'not an object at all', ''],
  ])('describes a %s call by one value of its input', (tool, input, expected) => {
    expect(toolTarget(tool, input)).toBe(expected);
  });

  it('keeps the first line only, cut to the limit', () => {
    const long = `${'x'.repeat(TOOL_TARGET_LIMIT + 40)}\nthe second line`;

    const target = toolTarget('Bash', { command: long });

    expect(target).toBe('x'.repeat(TOOL_TARGET_LIMIT));
    expect(target).not.toContain('the second line');
  });

  it('splits on the newline alone, so U+2028 stays in the target', () => {
    const query = `notes${LINE_SEPARATOR}and more`;
    expect(toolTarget('WebSearch', { query })).toBe(query);
  });
});
