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
 * The Claude Code parser against four transcripts with the real structure in
 * them.
 *
 * `two-turns.jsonl` is the smallest one: editor state with no uuid at all, hook
 * output, a system notice, a meta turn the editor wrote on the person's behalf,
 * thinking, a tool call and its result, a subagent's own conversation, an
 * attachment, and a compact summary — with two actual turns among them.
 *
 * `full-session.jsonl` is story 2.7's: the delegated runs and what the editor
 * wrote about them, the lines that look like conversation and are not, a pasted
 * image, a branch that changes halfway, a compact, a raw U+2028, a stamp that
 * goes backwards, and a call nothing has answered yet.
 *
 * `peer-handback.jsonl` is story 19's and `report-provenance.jsonl` story 22's.
 * Both were built to pin down *which* subagent report a line carried, and since
 * story 23 stores none of them they are the strongest input this parser has for
 * the opposite rule: between them they hold every shape a report arrives in, and
 * not one word of any of them may reach a row. They still carry the `Agent`
 * calls, the editor's own traffic and the tool outputs, which are what the
 * remaining rules are measured on.
 *
 * The sentences are neutral because this repository is public (Conventions);
 * the shape around them is the editor's own.
 */

const TWO_TURNS = fileURLToPath(new URL('./fixtures/two-turns.jsonl', import.meta.url));
const FULL_SESSION = fileURLToPath(new URL('./fixtures/full-session.jsonl', import.meta.url));
const PEER_HANDBACK = fileURLToPath(new URL('./fixtures/peer-handback.jsonl', import.meta.url));
const PROVENANCE = fileURLToPath(
  new URL('./fixtures/report-provenance.jsonl', import.meta.url),
);

/** How many lines of `full-session.jsonl` end with its fourth message. */
const HALF_LINES = 25;

/** How many lines of `peer-handback.jsonl` end with its only early message. */
const HANDBACK_LINES = 18;

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
/**
 * The marker both report fixtures put in everything around a report: the
 * editor's framing in `message.content` and in `origin.body`, every notice, and
 * every report text.
 */
const FRAME = 'FRAME-MUST-NOT-BE-STORED';

let transcript: string;
let session: string;
let handbacks: string;
let provenance: string;

beforeAll(async () => {
  transcript = await readFile(TWO_TURNS, 'utf8');
  session = await readFile(FULL_SESSION, 'utf8');
  handbacks = await readFile(PEER_HANDBACK, 'utf8');
  provenance = await readFile(PROVENANCE, 'utf8');
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
    harnessMessageId: id(33),
    role: 'assistant',
    model: 'demo-model',
    body: 'Both reports are in; I am writing the summary now.',
    gitBranch: 'feature/notes',
    isSubagentReport: false,
  },
];

/**
 * The four tool notes it holds, without `earlierPositions`, which has a case of
 * its own. The fifth call has no answer yet.
 *
 * The two `Agent` calls both hang off the message the person wrote, and the
 * second one's position is where version 3 differs: version 3 kept the first
 * run's result line as a report, so its note for that call sat at `(that line,
 * 0)` — which is what `earlierPositions` carries.
 */
const SESSION_NOTES = [
  {
    harnessMessageId: id(3),
    ordinal: 0,
    tool: 'Read',
    target: 'notes/import.md',
    ok: true,
    callId: 'toolu_01',
  },
  {
    // The first line of a two-line command, and the result said `is_error`.
    harnessMessageId: id(3),
    ordinal: 1,
    tool: 'Bash',
    target: 'wc -l notes/import.md',
    ok: false,
    callId: 'toolu_02',
  },
  {
    harnessMessageId: id(16),
    ordinal: 0,
    tool: 'Agent',
    target: 'Summarise the notes folder',
    ok: true,
    callId: 'toolu_03',
  },
  {
    harnessMessageId: id(16),
    ordinal: 1,
    tool: 'Agent',
    target: 'Check the links in the notes',
    ok: true,
    callId: 'toolu_04',
  },
];

/** The fields `SESSION_NOTES` pins, so one case can leave the rest alone. */
function noteWithout(note: {
  harnessMessageId: string;
  ordinal: number;
  tool: string;
  target: string;
  ok: boolean;
  callId: string | null;
}): Record<string, unknown> {
  return {
    harnessMessageId: note.harnessMessageId,
    ordinal: note.ordinal,
    tool: note.tool,
    target: note.target,
    ok: note.ok,
    callId: note.callId,
  };
}

/**
 * Every line of `full-session.jsonl` that is not a message, by the reason that
 * caught it. Eight messages and thirty dropped lines is the whole file.
 */
const SESSION_DROPS = {
  unreadable: 0,
  duplicate: 0,
  // Editor state, snapshots, the prompt queue, the title, attachments, system
  // notices: eight lines that are not a turn of anything.
  not_conversation: 8,
  sidechain: 2,
  meta: 2,
  incomplete: 0,
  timestamp: 0,
  api_error: 1,
  // A peer's line and two task notifications.
  not_human: 3,
  // Thinking, four tool calls, four tool results, and the synchronous result of
  // a delegated run — which version 3 read as a report.
  empty: 10,
  tool_output: 4,
  orca_header: 0,
};

/** The first `HALF_LINES` lines of the session, as a complete file. */
function half(): string {
  return `${session.split('\n').slice(0, HALF_LINES).join('\n')}\n`;
}

/** One line of a transcript, in the shape every fixture here writes. */
function line(serial: number, extra: Record<string, unknown>): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    cwd: '/demo/workspace',
    gitBranch: 'main',
    uuid: id(serial),
    timestamp: `2026-02-03T11:00:${String(serial % 60).padStart(2, '0')}.000Z`,
    ...extra,
  });
}

/** A turn the person typed. */
function said(serial: number, body: string): string {
  return line(serial, { type: 'user', message: { role: 'user', content: body } });
}

/** An assistant line that is nothing but tool calls. */
function called(
  serial: number,
  calls: readonly { id: string; name: string; input: Record<string, unknown> }[],
): string {
  return line(serial, {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'demo-model',
      content: calls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    },
  });
}

/** The editor feeding a call's result back as a user turn. */
function answered(serial: number, callId: string, isError = false): string {
  return line(serial, {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: callId,
          content: 'done',
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  });
}

/**
 * One `SessionStart` hook attachment, in the shape the editor renders it: the
 * source is in `hookName`, which is the only thing the parser reads it by.
 */
function startAttachment(source: string, serial: number): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'attachment',
    uuid: id(serial),
    timestamp: '2026-02-03T10:00:00.000Z',
    attachment: { type: 'hook_success', hookName: `SessionStart:${source}` },
  });
}

/** The same session with a line in front of the cursor's changed. */
function rewrittenSession(): string {
  return session.replace(
    'Can you check the import notes and summarise them?',
    'Can you check the import notes, please?',
  );
}

/** The uuid the hand-back fixture gives its nth line. */
function handbackId(serial: number): string {
  return `22222222-3333-4444-8555-${String(serial).padStart(12, '0')}`;
}

/** The two messages `peer-handback.jsonl` holds, now that no report is one. */
const HANDBACK_MESSAGES = [
  {
    harnessMessageId: handbackId(2),
    role: 'user',
    model: null,
    body: 'Can you line up what the two subagents reported?',
    gitBranch: 'main',
    isSubagentReport: false,
  },
  {
    harnessMessageId: handbackId(17),
    role: 'assistant',
    model: 'demo-model',
    body: 'Both reports are in; here is the comparison.',
    gitBranch: 'feature/notes',
    isSubagentReport: false,
  },
];

/** The first `HANDBACK_LINES` lines of it, as a complete file. */
function handbackHalf(): string {
  return `${handbacks.split('\n').slice(0, HANDBACK_LINES).join('\n')}\n`;
}

/** The same file with the cursor's own line changed. */
function rewrittenHandbacks(): string {
  return handbacks.replace(
    'Can you line up what the two subagents reported?',
    'Can you line up what they reported?',
  );
}

/** The uuid `report-provenance.jsonl` gives its nth line. */
function provenanceId(serial: number): string {
  return `33333333-4444-4555-8666-${String(serial).padStart(12, '0')}`;
}

/** The three messages `report-provenance.jsonl` holds. */
const PROVENANCE_MESSAGES = [
  {
    harnessMessageId: provenanceId(4),
    role: 'user',
    model: null,
    body: 'Line up what every run reported.',
    gitBranch: 'main',
    cwd: '/demo/workspace',
    isSubagentReport: false,
  },
  {
    harnessMessageId: provenanceId(5),
    role: 'user',
    model: null,
    body: 'And say which of them is still running.',
    gitBranch: 'main',
    cwd: '/demo/workspace',
    isSubagentReport: false,
  },
  {
    harnessMessageId: provenanceId(36),
    role: 'assistant',
    model: 'demo-model',
    body: 'That is every report accounted for.',
    gitBranch: 'main',
    cwd: '/demo/workspace',
    isSubagentReport: false,
  },
] as const;

/** The first `lines` lines of it, as a complete file. */
function provenanceUpTo(lines: number): string {
  return `${provenance.split('\n').slice(0, lines).join('\n')}\n`;
}

/** The same file with a line in front of the cursor changed. */
function rewrittenProvenance(): string {
  return provenance.replace(
    'Line up what every run reported.',
    'Line up what each of them reported.',
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
          handbacks,
          provenance,
          // A transcript with no conversation in it yet: the state of a
          // session's first seconds (research §1).
          '{"type":"mode","mode":"normal","sessionId":"s"}\n',
          '',
          // One broken line among readable ones: skipped and counted, never a
          // refusal, so this is `readable` and not `unreadable` (#11).
          `${said(700, 'Keep going.')}\nnot json at all {\n${said(701, 'That is all.')}\n`,
        ],
        // Nothing readable in it at all, which is the only content left that a
        // parser may refuse: a file whose every line is broken is not a Claude
        // Code transcript, where one broken line in a readable file is a crash.
        unreadable: ['not json at all {\nnor is this one {\n'],
        grown: [
          { before: half(), after: session },
          // The same thing one turn at a time, on the smaller fixture.
          {
            before: `${transcript.trimEnd().split('\n').slice(0, 10).join('\n')}\n`,
            after: transcript,
          },
          { before: handbackHalf(), after: handbacks },
          // A cursor standing on each message of the provenance fixture in
          // turn, so the stretch of editor traffic behind it is read both ways.
          ...[5, 10, 20].map((at) => ({
            before: provenanceUpTo(at),
            after: provenance,
          })),
          // A cursor on the one message a call was made in front of: the
          // incremental read must not report that call's note again, because
          // its line is in front of the cursor (`earlierPositions`, story 23).
          {
            before: `${[
              called(710, [{ id: 'toolu_e1', name: 'Read', input: { file_path: 'a.md' } }]),
              answered(711, 'toolu_e1'),
              said(712, 'Carry on.'),
            ].join('\n')}\n`,
            after: `${[
              called(710, [{ id: 'toolu_e1', name: 'Read', input: { file_path: 'a.md' } }]),
              answered(711, 'toolu_e1'),
              said(712, 'Carry on.'),
              called(713, [{ id: 'toolu_e2', name: 'Read', input: { file_path: 'b.md' } }]),
              answered(714, 'toolu_e2'),
              said(715, 'Thank you.'),
            ].join('\n')}\n`,
          },
        ],
        rewritten: [
          { before: half(), after: rewrittenSession() },
          // A compact: the cursor's own message is not in the file any more.
          {
            before: half(),
            after: `${session.split('\n').slice(HALF_LINES).join('\n')}`,
          },
          { before: handbackHalf(), after: rewrittenHandbacks() },
          { before: provenanceUpTo(20), after: rewrittenProvenance() },
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
    // The version moves when what the parser produces changes. `4` stores no
    // subagent report at all, names every tool note by its call id, keeps the
    // calls in front of the first message, counts the lines it walked past, and
    // drops orca's own prompt headings — so a session stored by `3` is read
    // again from the front under the new rules (AD-4).
    expect(parser.version).toBe('4');
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
        callId: 'toolu_01',
        earlierPositions: [],
      },
    ]);
    expect(result.parserVersion).toBe(CLAUDE_CODE_PARSER_VERSION);
    expect(result.startSource).toBe('startup');
    expect(result.cursorReset).toBe(false);
  });

  it('numbers nothing: the order of the array is all it claims', () => {
    // A message has no number anywhere, the parser's included (migration
    // 0006): the harness id is its identity and its instant is its place in
    // the conversation, both of which the lines above already check.
    const result = claudeCodeParser().parse(transcript);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const positional = ['seq', 'index', 'ordinal', 'position'];
    for (const message of result.messages) {
      for (const field of positional) {
        expect(message).not.toHaveProperty(field);
      }
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
    // The mode line is not conversation, and that is a count and not a warning.
    expect(result.droppedLines).toMatchObject({ not_conversation: 1, unreadable: 0 });
  });

  it('skips a last line the harness is still writing, and does not count it', () => {
    // No trailing newline, and the tail is half an object: the one line that
    // is allowed to be incomplete, because the editor appends as it goes — so
    // it is not a line yet and nothing is said about it.
    const halfLine = '{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"u-9"';

    const result = claudeCodeParser().parse(`${transcript}${halfLine}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual(EXPECTED);
    expect(result.droppedLines['unreadable']).toBe(0);
  });

  it('skips a broken line in the middle and counts it, keeping the rest', () => {
    const lines = transcript.split('\n');
    lines.splice(6, 0, '{"type":"user", this is not json');

    const result = claudeCodeParser().parse(lines.join('\n'));

    // A crash or a truncated write left that line behind. Refusing the file
    // over it would cost this session every message around it, for good (#11).
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual(EXPECTED);
    expect(result.droppedLines['unreadable']).toBe(1);
  });

  it('reads a line that is JSON and not an object, rather than calling it broken', () => {
    // `null`, a list, a number: shapes the harness has never written, but the
    // line itself read perfectly well. Counting them `unreadable` would warn
    // that part of the file could not be read when all of it could.
    const result = claudeCodeParser().parse(
      `null\n${said(820, 'And this one is a real turn.')}\n[]\n`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.map((message) => message.body)).toEqual([
      'And this one is a real turn.',
    ]);
    expect(result.droppedLines['unreadable']).toBe(0);
    expect(result.droppedLines['not_conversation']).toBe(2);
  });

  it('does not refuse a file whose every line is JSON and not an object', () => {
    // Nothing here is a Claude Code line, and nothing here is unreadable
    // either: the answer is a transcript with no conversation in it.
    const result = claudeCodeParser().parse('[]\n42\n"a string"\nnull\n');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual([]);
    expect(result.cursor).toBeNull();
    expect(result.droppedLines['unreadable']).toBe(0);
    expect(result.droppedLines['not_conversation']).toBe(4);
  });

  it('refuses content with no readable line in it at all', () => {
    const result = claudeCodeParser().parse('not json at all {\nnor is this one {\n');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TRANSCRIPT_UNREADABLE');
    expect(result.message).toContain('JSON');
  });

  it('counts a broken line of the part it read, not of the whole file', () => {
    // Two broken lines, one on either side of where the cursor will stand, and
    // the cursor taken from this same content so its fingerprint fits.
    const lines = session.split('\n');
    lines.splice(2, 0, '{"type":"user", this is not json');
    lines.splice(HALF_LINES + 4, 0, '{"type":"user", nor is this');
    const patched = lines.join('\n');
    const first = claudeCodeParser().parse(
      `${patched.split('\n').slice(0, HALF_LINES + 1).join('\n')}\n`,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.cursor?.lastHarnessMessageId).toBe(id(16));
    expect(first.droppedLines['unreadable']).toBe(1);

    const whole = claudeCodeParser().parse(patched);
    const result = claudeCodeParser().parse(patched, first.cursor);

    expect(whole.ok).toBe(true);
    expect(result.ok).toBe(true);
    if (!whole.ok || !result.ok) return;
    expect(result.cursorReset).toBe(false);
    expect(whole.droppedLines['unreadable']).toBe(2);
    // Only the one behind the cursor: the broken line near the front is in the
    // stretch this read never looks at.
    expect(result.droppedLines['unreadable']).toBe(1);
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
    expect(result.droppedLines['duplicate']).toBe(1);
  });

  it.each([
    ['a sentence', 'the day before yesterday'],
    ['no milliseconds', '2026-02-03T11:00:05Z'],
    ['a space for the T and no zone', '2026-02-03 11:00:05.000'],
    ['an expanded year', '+010000-02-03T11:00:05.000Z'],
    ['a day the calendar has not got', '2026-02-30T11:00:05.000Z'],
  ])('reads no instant from %s, so that line is not a message', (_name, timestamp) => {
    // `new Date(s)` takes every one of these and answers something. Stored, it
    // would be an instant the harness never wrote in the column that orders
    // the whole conversation, and no row can be corrected (#12, AD-11).
    const content = `${JSON.stringify({
      type: 'user',
      isSidechain: false,
      uuid: id(800),
      timestamp,
      message: { role: 'user', content: 'a message with no usable instant' },
    })}\n`;

    const result = claudeCodeParser().parse(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual([]);
    expect(result.droppedLines['timestamp']).toBe(1);
  });

  it('keeps an instant written exactly the way the harness writes it', () => {
    const result = claudeCodeParser().parse(
      `${said(801, 'And this one has a real stamp.')}\n`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages[0]?.occurredAt).toEqual(new Date('2026-02-03T11:00:21.000Z'));
    expect(result.droppedLines['timestamp']).toBe(0);
  });

  it.each([
    ['You are working inside Orca', 'You are working inside Orca, a coordinator.\n\nDo this.'],
    [
      'Please carry out this task from my Orca coordinator',
      'Please carry out this task from my Orca coordinator:\n\nRead the notes.',
    ],
    ['You have N orchestration messages', 'You have 3 orchestration messages waiting.'],
  ])('drops a user line that opens with the orca heading %s', (_name, body) => {
    const result = claudeCodeParser().parse(`${said(810, body)}\n`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // orca writes its prompt into the worker's session as if it had been typed,
    // so no `origin` says otherwise: the words are the coordinator's (story 23).
    expect(result.messages).toEqual([]);
    expect(result.droppedLines['orca_header']).toBe(1);
  });

  it.each([
    'I think you are working inside Orca right now, are you not?',
    'Say that you have 3 orchestration messages and see what happens.',
  ])('keeps a line that only mentions the same words mid-sentence', (body) => {
    const result = claudeCodeParser().parse(`${said(811, body)}\n`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.map((message) => message.body)).toEqual([body]);
    expect(result.droppedLines['orca_header']).toBe(0);
  });

  it.each([
    ['blank lines anywhere', `\n${'\n'}`],
    ['an empty file', ''],
  ])('reads %s as a transcript with nothing in it', (_name, content) => {
    const result = claudeCodeParser().parse(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual([]);
    // A blank line is not a line, so it is neither a message nor a drop.
    expect(Object.values(result.droppedLines).every((count) => count === 0)).toBe(true);
  });
});

describe('the Claude Code parser on a whole session', () => {
  it('keeps the eight messages, with the branch and the cwd', () => {
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

  it('stores no subagent report, in either shape the editor writes one', () => {
    const result = claudeCodeParser().parse(session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A report is long, model-written text that nobody said, and the main
    // agent's own turn — which *is* stored — carries the conclusion a person
    // would recall (epic 2 Decision, 2026-10-21).
    expect(result.messages.some((message) => message.isSubagentReport)).toBe(false);
    const bodies = result.messages.map((message) => message.body).join('\n');
    // The synchronous result of the first run, the notification of the second,
    // and the subagent's own conversation: none of it is anybody's words.
    expect(bodies).not.toContain('import.md is the newest and ends with one open question');
    expect(bodies).not.toContain('Every link in notes/ still resolves');
    expect(bodies).not.toContain('the folder holds four files');
    expect(bodies).not.toContain('read every file in notes/');
    // And the `Agent` calls are still there: that a run was delegated is a
    // fact about the turn.
    expect(result.toolNotes.filter((note) => note.tool === 'Agent')).toHaveLength(2);
  });

  it('writes one note per tool call, and none for a call with no answer yet', () => {
    const result = claudeCodeParser().parse(session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolNotes.map(noteWithout)).toEqual(SESSION_NOTES.map(noteWithout));
    // The last line of the fixture is a `Write` whose result has not arrived
    // and that nothing was said after: the harness is still working, so the
    // note waits for the next read rather than going in as a failure.
    expect(result.toolNotes.some((note) => note.tool === 'Write')).toBe(false);
    // And the cursor does not pass it either, so the next read sees it again.
    expect(result.cursor?.lastHarnessMessageId).toBe(id(33));
  });

  it('names the position version 3 may have stored the same call under', () => {
    const result = claudeCodeParser().parse(session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Version 3 read the first run's synchronous result as a report, so that
    // line was a message to it and the second `Agent` call's note hung off it
    // at ordinal 0. Version 4 drops the line, and the call moves back onto the
    // message the person wrote — which is one call at two positions unless the
    // store is told where to look (#9).
    const second = result.toolNotes.find((note) => note.callId === 'toolu_04');
    expect(second?.harnessMessageId).toBe(id(16));
    expect(second?.ordinal).toBe(1);
    expect(second?.earlierPositions).toEqual([{ harnessMessageId: id(21), ordinal: 0 }]);
    // Every other call has the same position it always had.
    for (const callId of ['toolu_01', 'toolu_02', 'toolu_03']) {
      expect(
        result.toolNotes.find((note) => note.callId === callId)?.earlierPositions,
      ).toEqual([]);
    }
  });

  it('counts every line it walked past, under the reason that caught it', () => {
    const result = claudeCodeParser().parse(session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedLines).toEqual(SESSION_DROPS);
    // The counts add up: the messages plus the drops are the whole file, which
    // is what makes a filter that quietly stops keeping something visible.
    const lines = session.trimEnd().split('\n').filter((text) => text.trim() !== '');
    expect(
      result.messages.length + Object.values(result.droppedLines).reduce((a, b) => a + b, 0),
    ).toBe(lines.length);
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
      callId: 'toolu_05',
      earlierPositions: [],
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
      // Every task notification, now that none of them is read as a report.
      '<task-notification',
    ]) {
      expect(bodies).not.toContain(absent);
    }
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
    expect(result.toolNotes.map(noteWithout)).toEqual(SESSION_NOTES.map(noteWithout));
    expect(result.messages).toHaveLength(SESSION_MESSAGES.length);
  });

  it('takes the start source from the first SessionStart attachment', () => {
    const result = claudeCodeParser().parse(session);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The file carries `startup` and then, after the compact, `compact`. The
    // first is why the session began, which is what this column answers; the
    // compact is what happened to it afterwards (follow-up review #18).
    expect(result.startSource).toBe('startup');

    const beforeTheCompact = claudeCodeParser().parse(half());
    expect(beforeTheCompact.ok).toBe(true);
    if (!beforeTheCompact.ok) return;
    expect(beforeTheCompact.startSource).toBe('startup');
  });

  it('reads each of the five sources the harness names, and none of anything else', () => {
    for (const source of ['startup', 'resume', 'clear', 'compact', 'fork'] as const) {
      const result = claudeCodeParser().parse(`${startAttachment(source, 100)}\n`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.startSource).toBe(source);
    }

    // A session reopened: 34 of the 37 transcripts on this machine that carry
    // more than one attachment are a `startup` followed by a `resume`, and the
    // session still began with the `startup`.
    const reopened = claudeCodeParser().parse(
      `${startAttachment('startup', 100)}\n${startAttachment('resume', 101)}\n`,
    );
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.startSource).toBe('startup');

    // Another hook's attachment says nothing about the start, and neither does
    // a `SessionStart` whose source this parser does not know.
    for (const hookName of ['Stop', 'SessionStart:somethingElse']) {
      const result = claudeCodeParser().parse(
        `${JSON.stringify({
          type: 'attachment',
          uuid: id(102),
          timestamp: '2026-02-03T10:00:00.000Z',
          attachment: { type: 'hook_success', hookName },
        })}\n`,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.startSource).toBeNull();
    }
  });

  it('answers for the whole content even when it read only the tail', () => {
    const first = claudeCodeParser().parse(half());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.cursor?.lastHarnessMessageId).toBe(id(16));

    const incremental = claudeCodeParser().parse(session, first.cursor);
    const whole = claudeCodeParser().parse(session);

    expect(incremental.ok).toBe(true);
    expect(whole.ok).toBe(true);
    if (!incremental.ok || !whole.ok) return;
    expect(incremental.cursorReset).toBe(false);
    // It starts at the cursor's own message and reports the rest of the file.
    expect(incremental.messages).toEqual(whole.messages.slice(3));
    // Both `Agent` calls hang off that message, `earlierPositions` and all: the
    // judgement looks at the line and the lines in front of it inside this
    // read, never at the stretch it skipped (port contract).
    expect(incremental.toolNotes).toEqual(whole.toolNotes.slice(2));
    expect(incremental.cursor).toEqual(whole.cursor);
    // The start source is a fact about the content, not about the part read.
    expect(incremental.startSource).toBe('startup');
  });

  it('answers with the first start source even when a resume is behind the cursor', () => {
    // A session the person reopened: the `resume` attachment is in the stretch
    // only the incremental read sees, and the answer is still the `startup` at
    // the front of the file — which is what makes the incremental read and the
    // full one agree (port contract).
    const first = claudeCodeParser().parse(half());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const reopened = `${session}${startAttachment('resume', 200)}\n`;
    const incremental = claudeCodeParser().parse(reopened, first.cursor);
    const whole = claudeCodeParser().parse(reopened);

    expect(incremental.ok).toBe(true);
    expect(whole.ok).toBe(true);
    if (!incremental.ok || !whole.ok) return;
    expect(incremental.cursorReset).toBe(false);
    expect(incremental.startSource).toBe('startup');
    expect(whole.startSource).toBe('startup');
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

/**
 * The two report fixtures, read for the one thing they now have to prove: that
 * no shape of a subagent report reaches a row.
 *
 * Between them they carry every shape one arrives in — a hand-back on a peer
 * line, a synchronous `Agent` result, a task notification, the old framing, the
 * notices the editor leaves in a report's place — and story 23 stores none of
 * them (epic 2 Decision, 2026-10-21).
 */
describe('the Claude Code parser on the two report fixtures', () => {
  it('keeps the two turns of the hand-back fixture and neither report', () => {
    const result = claudeCodeParser().parse(handbacks);

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
    ).toEqual(HANDBACK_MESSAGES);
    expect(result.startSource).toBe('startup');
    // Every hand-back line is `isMeta`, which is the rule that drops it now
    // that nothing looks at `origin.handback` at all.
    expect(result.droppedLines['meta']).toBeGreaterThan(0);
  });

  it('keeps the three turns of the provenance fixture and none of its reports', () => {
    const result = claudeCodeParser().parse(provenance);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.messages.map((message) => ({
        harnessMessageId: message.harnessMessageId,
        role: message.role,
        model: message.model,
        body: message.body,
        gitBranch: message.gitBranch,
        cwd: message.cwd,
        isSubagentReport: message.isSubagentReport,
      })),
    ).toEqual([...PROVENANCE_MESSAGES]);
  });

  it.each([
    ['the hand-back fixture', (): string => handbacks],
    ['the provenance fixture', (): string => provenance],
  ])('stores nothing of a report or of the framing around one, in %s', (_name, content) => {
    const result = claudeCodeParser().parse(content());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = [
      ...result.messages.map((message) => message.body),
      ...result.toolNotes.map((note) => note.target),
    ].join('\n');
    // The fixtures mark every report, every notice and every framing with the
    // same string, so one assertion covers all of them.
    expect(content()).toContain(FRAME);
    expect(stored).not.toContain(FRAME);
    expect(stored).not.toContain('<agent-message');
    expect(stored).not.toContain('<task-notification');
    expect(stored).not.toContain('SubagentHandback');
    expect(stored).not.toContain('delivered to you as a message');
    expect(stored).not.toContain('has not reported yet');
    expect(stored).not.toContain('[Subagent hand-back]');
    expect(result.messages.some((message) => message.isSubagentReport)).toBe(false);
  });

  it('keeps one note per Agent call of the hand-back fixture', () => {
    const result = claudeCodeParser().parse(handbacks);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both calls were made before any report landed, so both hang off the one
    // message in front of them. Version 3 had the first run's result lines as
    // reports, so the second call's note may be stored at one of those.
    expect(result.toolNotes.map(noteWithout)).toEqual([
      {
        harnessMessageId: handbackId(2),
        ordinal: 0,
        tool: 'Agent',
        target: 'Summarise the notes folder',
        ok: true,
        callId: 'toolu_h1',
      },
      {
        harnessMessageId: handbackId(2),
        ordinal: 1,
        tool: 'Agent',
        target: 'Check the links in the notes',
        ok: true,
        callId: 'toolu_h2',
      },
    ]);
    expect(result.toolNotes[0]?.earlierPositions).toEqual([]);
    expect(result.toolNotes[1]?.earlierPositions).toEqual([
      { harnessMessageId: handbackId(4), ordinal: 0 },
      { harnessMessageId: handbackId(101), ordinal: 0 },
    ]);
  });

  it('keeps the one Agent call of the provenance fixture', () => {
    const result = claudeCodeParser().parse(provenance);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolNotes).toEqual([
      {
        harnessMessageId: provenanceId(5),
        ordinal: 0,
        tool: 'Agent',
        target: 'Run the sync check',
        ok: true,
        callId: 'toolu_p1',
        earlierPositions: [],
      },
    ]);
  });

  it('keeps a user line only when its origin says a person typed it', () => {
    const result = claudeCodeParser().parse(provenance);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No origin and `human` are kept; a kind nobody has looked at, an origin
    // that is not a record, and one with no kind are not. An allow list, so a
    // kind the editor invents next is not stored as something said (#5).
    const bodies = result.messages.map((message) => message.body);
    expect(bodies).toContain('Line up what every run reported.');
    expect(bodies).toContain('And say which of them is still running.');
    for (const absent of [
      'the editor announced something',
      'an origin that is a string',
      'an origin with no kind in it',
    ]) {
      expect(bodies.join('\n')).not.toContain(absent);
    }
  });

  it('drops the two tool outputs story 22 added to the markers', () => {
    const result = claudeCodeParser().parse(provenance);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A `!` command's stderr and a hook the editor ran on the way in: both
    // arrive as a user turn and neither is something anybody said (#6).
    const bodies = result.messages.map((message) => message.body).join('\n');
    expect(bodies).not.toContain('<local-command-stderr>');
    expect(bodies).not.toContain('<user-prompt-submit-hook>');
    expect(result.droppedLines['tool_output']).toBe(2);
  });
});

describe('the Claude Code parser on what decides a call worked', () => {
  it('reads an outcome only from a line of the conversation', () => {
    // The editor writes `tool_result` blocks onto lines of its own too — 457 of
    // them on this machine, every one an `api-request-blob`. Read as outcomes
    // they would mark a call that worked as failed (#7).
    const content = `${[
      said(500, 'Count the notes, please.'),
      called(501, [{ id: 'toolu_x', name: 'Bash', input: { command: 'wc -l notes/*' } }]),
      JSON.stringify({
        type: 'api-request-blob',
        isSidechain: false,
        uuid: id(502),
        timestamp: '2026-02-03T11:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: true }],
        },
      }),
      answered(503, 'toolu_x'),
      said(504, 'Thank you.'),
    ].join('\n')}\n`;

    const result = claudeCodeParser().parse(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolNotes).toHaveLength(1);
    expect(result.toolNotes[0]?.ok).toBe(true);
  });

  it('leaves a delegated call without a result for the next read', () => {
    // An `Agent` is expected to answer after the conversation has moved on, so
    // "a message came after it" says nothing about whether it failed: writing
    // `ok: false` would freeze a run that is still going as a failure (#7).
    const content = `${[
      said(510, 'Start the check and carry on.'),
      called(511, [
        { id: 'toolu_a', name: 'Agent', input: { description: 'Check the links' } },
        { id: 'toolu_b', name: 'Bash', input: { command: 'ls notes' } },
      ]),
      said(512, 'Anything yet?'),
    ].join('\n')}\n`;

    const result = claudeCodeParser().parse(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The `Bash` call on the same line *is* written as a failure, because an
    // ordinary tool's result either came with the turn or is never coming.
    expect(result.toolNotes).toEqual([
      {
        harnessMessageId: id(510),
        ordinal: 1,
        tool: 'Bash',
        target: 'ls notes',
        ok: false,
        callId: 'toolu_b',
        earlierPositions: [],
      },
    ]);
  });

  it('writes a delegated call once its result lands', () => {
    const content = `${[
      said(520, 'Start the check and carry on.'),
      called(521, [
        { id: 'toolu_a', name: 'Agent', input: { description: 'Check the links' } },
      ]),
      said(522, 'Anything yet?'),
      answered(523, 'toolu_a'),
      said(524, 'Good.'),
    ].join('\n')}\n`;

    const result = claudeCodeParser().parse(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolNotes.map((note) => [note.callId, note.ok])).toEqual([
      ['toolu_a', true],
    ]);
  });
});

describe('the Claude Code parser on a call made before the first message', () => {
  /** Two calls, their results, and then the first thing anybody said. */
  const content = `${[
    called(600, [
      { id: 'toolu_f1', name: 'Read', input: { file_path: 'notes/import.md' } },
      { id: 'toolu_f2', name: 'Grep', input: { pattern: 'open question' } },
    ]),
    answered(601, 'toolu_f1'),
    answered(602, 'toolu_f2', true),
    said(603, 'What did you find?'),
  ].join('\n')}\n`;

  it('hangs it on the next message at a negative ordinal, in file order', () => {
    const result = claudeCodeParser().parse(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Version 3 dropped these calls: there was no message to point a note at,
    // and the contract requires one. A negative ordinal says "in front of this
    // message's own line", which leaves every call *after* a message at the
    // 0-based position it has always had (#8, Design Notes).
    expect(result.messages.map((message) => message.harnessMessageId)).toEqual([id(603)]);
    expect(result.toolNotes).toEqual([
      {
        harnessMessageId: id(603),
        ordinal: -2,
        tool: 'Read',
        target: 'notes/import.md',
        ok: true,
        callId: 'toolu_f1',
        earlierPositions: [],
      },
      {
        harnessMessageId: id(603),
        ordinal: -1,
        tool: 'Grep',
        target: 'open question',
        ok: false,
        callId: 'toolu_f2',
        earlierPositions: [],
      },
    ]);
  });

  it('drops it when the read never reaches a message at all', () => {
    const result = claudeCodeParser().parse(
      content.split('\n').slice(0, 3).join('\n') + '\n',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nothing to hang them on, and nothing is lost: the next read of the file
    // sees the same lines again, and the cursor never passed them.
    expect(result.messages).toEqual([]);
    expect(result.toolNotes).toEqual([]);
    expect(result.cursor).toBeNull();
  });

  it('does not report it again once the cursor stands on that message', () => {
    const first = claudeCodeParser().parse(content);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const grown = `${content}${said(604, 'Anything else?')}\n`;
    const incremental = claudeCodeParser().parse(grown, first.cursor);

    expect(incremental.ok).toBe(true);
    if (!incremental.ok) return;
    expect(incremental.cursorReset).toBe(false);
    // The incremental read begins *at* that message's line, so the two calls in
    // front of it are not read again — and their notes are already stored from
    // the read that produced the cursor.
    expect(incremental.messages.map((message) => message.harnessMessageId)).toEqual([
      id(603),
      id(604),
    ]);
    expect(incremental.toolNotes).toEqual([]);
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
    // The two largest groups of empty targets measured, now named: a recipient,
    // and the first of a list of questions (#13).
    ['SendMessage', { to: 'worker-2', message: 'a long brief' }, 'worker-2'],
    [
      'AskUserQuestion',
      { questions: [{ question: 'Which folder?', options: ['notes', 'docs'] }] },
      'Which folder?',
    ],
    ['AskUserQuestion', { questions: [] }, ''],
    // A tool nobody listed: the first of the fallback keys it carries, from the
    // most specific thing a call can name to the least.
    ['mcp__demo__read_page', { url: 'https://example.invalid/page' }, 'https://example.invalid/page'],
    ['mcp__demo__run', { name: 'a plugin verb' }, 'a plugin verb'],
    ['mcp__demo__find', { query: 'notes', description: 'ignored' }, 'notes'],
    // The identifying keys this story added, each one a group of empty targets
    // that had nothing else to be described by.
    ['mcp__demo__upload', { filename: 'notes.pdf', content: 'a whole file' }, 'notes.pdf'],
    ['mcp__atlassian__page', { pageId: '12345' }, '12345'],
    ['mcp__atlassian__search', { cql: 'type = page' }, 'type = page'],
    ['TaskStop', { task_id: 'task-9' }, 'task-9'],
    ['mcp__demo__notify', { recipient: 'worker-3' }, 'worker-3'],
    ['mcp__demo__fetch', { id: 'row-7' }, 'row-7'],
    // Nothing that describes the call, which is a value and not a failure.
    ['mcp__demo__ping', { flag: true }, ''],
    ['ListAgents', {}, ''],
    ['Bash', {}, ''],
    ['Read', 'not an object at all', ''],
  ])('describes a %s call by one value of its input', (tool, input, expected) => {
    expect(toolTarget(tool, input)).toBe(expected);
  });

  it.each(['content', 'message', 'code', 'script', 'payload', 'new_string', 'old_string'])(
    'never describes a call by its %s',
    (key) => {
      // A note built out of one of those would be a copy of the change, which
      // the transcript already is — and the place a secret in a call would end
      // up in a row nobody can rewrite (AD-11).
      expect(toolTarget('mcp__demo__write', { [key]: 'the whole payload' })).toBe('');
    },
  );

  it('looks the tool up by its own key alone', () => {
    // A tool named after a member of `Object.prototype` found that member on
    // the table and read the input under a key that is a function (#14).
    expect(toolTarget('toString', { path: 'a' })).toBe('a');
    expect(toolTarget('constructor', { path: 'a' })).toBe('a');
    // And the fallback keys are own keys too.
    expect(toolTarget('mcp__demo__x', Object.create({ path: 'inherited' }))).toBe('');
  });

  it('keeps the first line only, cut to the limit', () => {
    const long = `${'x'.repeat(TOOL_TARGET_LIMIT + 40)}\nthe second line`;

    const target = toolTarget('Bash', { command: long });

    expect(target).toBe('x'.repeat(TOOL_TARGET_LIMIT));
    expect(target).not.toContain('the second line');
  });

  it('cuts on a character boundary, never through a surrogate pair', () => {
    // The limit falls between the two halves of one code point. Cutting there
    // leaves a lone surrogate — half a character, which is not text at all and
    // then travels through a column, a search index and JSON (#14).
    const pair = String.fromCodePoint(0x1f600);
    const command = `${'x'.repeat(TOOL_TARGET_LIMIT - 1)}${pair}tail`;
    expect(command.charCodeAt(TOOL_TARGET_LIMIT - 1)).toBeGreaterThanOrEqual(0xd800);

    const target = toolTarget('Bash', { command });

    expect(target).toHaveLength(TOOL_TARGET_LIMIT - 1);
    expect(target).toBe('x'.repeat(TOOL_TARGET_LIMIT - 1));
    // And nothing in it is half a character: `[...text]` walks code points, so
    // a lone surrogate would come out as one of its own.
    expect([...target].some((point) => /^[\uD800-\uDFFF]$/u.test(point))).toBe(false);

    // A pair that ends *at* the limit is kept whole.
    const fitting = `${'x'.repeat(TOOL_TARGET_LIMIT - 2)}${pair}tail`;
    expect(toolTarget('Bash', { command: fitting })).toBe(
      `${'x'.repeat(TOOL_TARGET_LIMIT - 2)}${pair}`,
    );
  });

  it('splits on the newline alone, so U+2028 stays in the target', () => {
    const query = `notes${LINE_SEPARATOR}and more`;
    expect(toolTarget('WebSearch', { query })).toBe(query);
  });
});


describe('세션을 시작한 폴더', () => {
  const turn = (uuid: string, cwd?: string) => JSON.stringify({
    type: 'user', uuid, timestamp: '2026-01-02T03:04:05.000Z',
    message: { role: 'user', content: '메모를 읽어 줘' }, ...(cwd === undefined ? {} : { cwd }),
  });

  it('서브에이전트와 빈 cwd를 건너뛰고 메시지 앞의 첫 줄을 보존한다', () => {
    const content = [
      JSON.stringify({ type: 'attachment', isSidechain: true, cwd: '/demo/other' }),
      ...[null, '', '  ', 12].map((cwd) => JSON.stringify({ type: 'hook', cwd })),
      JSON.stringify({ type: 'attachment', cwd: '/demo/gone' }),
      turn('first', '/demo/gone/sub'), turn('second', '/demo/later'),
    ].join('\n');
    const parser = claudeCodeParser();
    const whole = parser.parse(content);
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(whole.startCwd).toBe('/demo/gone');
    expect(whole.messages[0]?.cwd).toBe('/demo/gone/sub');
    const tail = parser.parse(content, whole.cursor);
    expect(tail.ok).toBe(true);
    if (!tail.ok) return;
    expect(tail.cursorReset).toBe(false);
    expect(tail.messages).toHaveLength(1);
    expect(tail.startCwd).toBe('/demo/gone');
    expect(tail.parserVersion).toBe('4');
  });

  it('메시지만 cwd를 가지면 첫 메시지의 값을 쓰고 없으면 null이다', () => {
    for (const cwd of ['/demo/repo', undefined]) {
      const result = claudeCodeParser().parse(turn('first', cwd));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.startCwd).toBe(cwd ?? null);
    }
  });
});
