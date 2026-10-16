import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parserContract, type ParserSubject } from '@second-brain/core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_HARNESS,
  CLAUDE_CODE_PARSER_VERSION,
  claudeCodeParser,
} from '../src/parser.js';

/**
 * The Claude Code parser against a transcript with the real structure in it:
 * editor state with no uuid at all, hook output, a system notice, a meta turn
 * the editor wrote on the person's behalf, thinking, a tool call and its
 * result, a subagent's own conversation, an attachment, and a compact summary —
 * with two actual turns among them.
 *
 * The sentences are neutral because this repository is public (Conventions);
 * the shape around them is the editor's own.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/two-turns.jsonl', import.meta.url));

let transcript: string;

beforeAll(async () => {
  transcript = await readFile(FIXTURE, 'utf8');
});

/** The two turns the fixture holds, in the order the file holds them. */
const EXPECTED = [
  {
    harnessMessageId: '00000000-0000-4000-8000-000000000003',
    role: 'user',
    model: null,
    body: 'Where did we leave the import notes?',
    occurredAt: new Date('2026-01-02T03:04:05.000Z'),
  },
  {
    harnessMessageId: '00000000-0000-4000-8000-000000000008',
    role: 'assistant',
    model: 'demo-model',
    // Two `text` blocks of one answer, joined.
    body: 'They are in notes/import.md.\nI added the open question at the end.',
    occurredAt: new Date('2026-01-02T03:04:08.000Z'),
  },
  {
    harnessMessageId: '00000000-0000-4000-8000-000000000012',
    role: 'user',
    model: null,
    body: 'Good. Write that down as a decision.',
    occurredAt: new Date('2026-01-02T03:05:01.000Z'),
  },
  {
    harnessMessageId: '00000000-0000-4000-8000-000000000014',
    role: 'assistant',
    model: 'demo-model',
    body: "Written down, with today's date.",
    occurredAt: new Date('2026-01-02T03:05:03.000Z'),
  },
];

describe('the parser contract against the Claude Code parser', () => {
  for (const testCase of parserContract()) {
    it(testCase.name, async () => {
      const make = async (): Promise<ParserSubject> => ({
        parser: claudeCodeParser(),
        readable: [
          transcript,
          // A transcript with no conversation in it yet: the state of a
          // session's first seconds (research §1).
          '{"type":"mode","mode":"normal","sessionId":"s"}\n',
          '',
        ],
        unreadable: ['{"type":"user"}\nnot json at all {\n'],
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
  });

  it('keeps the two turns and nothing else the editor wrote', () => {
    const result = claudeCodeParser().parse(transcript);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toEqual(EXPECTED);
    // Tool notes are story 2.7's: the fixture holds a tool call and this
    // parser deliberately makes nothing of it yet (Boundaries).
    expect(result.toolNotes).toEqual([]);
    expect(result.parserVersion).toBe(CLAUDE_CODE_PARSER_VERSION);
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
  });

  it('skips a last line the harness is still writing', () => {
    // No trailing newline, and the tail is half an object: the one line that
    // is allowed to be incomplete, because the editor appends as it goes.
    const half = '{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"u-9"';

    const result = claudeCodeParser().parse(`${transcript}${half}`);

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
