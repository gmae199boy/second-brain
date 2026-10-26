import type { Parser } from '../../ports/parser.js';
import {
  assertEqual,
  assertInteger,
  assertNonEmptyString,
  assertNotOk,
  assertOk,
  assertTrue,
  assertValidDate,
  fail,
} from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

/**
 * What a parser contract needs besides the parser: only the connector knows
 * what its harness writes, so it brings its own transcripts (AD-4).
 */
export interface ParserSubject {
  parser: Parser;
  /** At least one transcript this parser reads. Real, de-identified fixtures. */
  readable: readonly string[];
  /** Content it must refuse. May be empty. */
  unreadable: readonly string[];
  /**
   * A transcript and the same transcript with more of the session appended:
   * what a second hook on a longer file hands over. `before`'s cursor must
   * still fit `after`, so the incremental read of `after` is the tail of its
   * whole read. May be empty for a parser with no incremental read.
   */
  grown: readonly ParserPair[];
  /**
   * A transcript and the same session with something in front of the part the
   * cursor named changed — a compact, a fork, a file rewritten underneath us.
   * `before`'s cursor must *not* fit `after`.
   */
  rewritten: readonly ParserPair[];
}

/** Two states of one transcript, the second read with the first one's cursor. */
export interface ParserPair {
  before: string;
  after: string;
}

/** A cursor no content can match, for the "somebody else's cursor" case. */
const FOREIGN_CURSOR = {
  lastHarnessMessageId: 'no-message-carries-this-id',
  fingerprint: '0000000000000000000000000000000000000000000000000000000000000000',
};

/**
 * The parser contract. The heart of it is determinism: the output is a pure
 * function of the content and the parser version, so the same transcript always
 * produces the same messages, in the same order, with the same tool-note
 * ordinals (AD-4). A parser assigns no message number at all (AD-8).
 */
export function parserContract(): ContractCase<ParserSubject>[] {
  return [
    contractCase<ParserSubject>('첨부는 같은 결과의 메시지와 유일한 자리를 가리킨다', async make => withSubject(make, async ({parser, readable}) => {
      for (const content of readable) {
        const parsed = parser.parse(content); assertOk(parsed, '파싱');
        const positions = new Set<string>();
        for (const a of parsed.attachments) {
          assertTrue(parsed.messages.some(m => m.harnessMessageId === a.harnessMessageId), '첨부 메시지');
          const key = `${a.harnessMessageId}:${a.ordinal}`;
          assertTrue(!positions.has(key), '첨부 자리 중복'); positions.add(key);
          assertTrue(Number.isInteger(a.ordinal) && a.ordinal >= 0, '첨부 자리');
          assertTrue(a.bytes !== null || a.sourcePath !== null, '원본 바이트가 없으면 원본 경로');
        }
      }
    })),
    contractCase<ParserSubject>('the parser names its harness and version', async (make) => {
      await withSubject(make, async ({ parser }) => {
        assertNonEmptyString(parser.harness, 'a parser must name its harness');
        assertNonEmptyString(parser.version, 'a parser must name its version');
      });
    }),

    contractCase<ParserSubject>('parsing the same transcript twice is identical', async (make) => {
      await withSubject(make, async ({ parser, readable }) => {
        assertTrue(readable.length > 0, 'the parser contract needs a readable transcript');
        for (const content of readable) {
          const first = parser.parse(content);
          const second = parser.parse(content);
          assertOk(first, 'a readable transcript did not parse');
          assertEqual(second, first, 'parsing the same transcript twice gave two results');
        }
      });
    }),

    contractCase<ParserSubject>(
      'the harness message ids of one parse do not repeat',
      async (make) => {
        await withSubject(make, async ({ parser, readable }) => {
          for (const content of readable) {
            const result = parser.parse(content);
            assertOk(result, 'a readable transcript did not parse');
            // A message carries no number, so `(session, harness message id)`
            // is the whole of what identifies it (AD-8, migration 0006).
            // Two messages of one parse sharing one would make
            // the second a replay of the first: idempotency would silently drop
            // it, and nobody would be told (AD-4, NFR-2).
            const seen = new Set<string>();
            for (const message of result.messages) {
              assertTrue(
                !seen.has(message.harnessMessageId),
                `two messages of one parse share the harness id ${message.harnessMessageId}`,
              );
              seen.add(message.harnessMessageId);
            }
          }
        });
      },
    ),

    contractCase<ParserSubject>('every message is well formed', async (make) => {
      await withSubject(make, async ({ parser, readable }) => {
        for (const content of readable) {
          const result = parser.parse(content);
          assertOk(result, 'a readable transcript did not parse');
          for (const message of result.messages) {
            assertNonEmptyString(
              message.harnessMessageId,
              'a message must carry the harness message id',
            );
            assertTrue(
              message.role === 'user' || message.role === 'assistant',
              `a message role must be user or assistant, got ${message.role}`,
            );
            assertValidDate(message.occurredAt, 'a message must carry when it was uttered');
            assertNonEmptyString(message.body, 'a message must carry a body');
            // The tracking of migration 0004, as a shape: the branch and the
            // cwd are whatever the line carried or `null`, never missing, and
            // the report mark is a decision the parser has already made.
            assertTrue(
              message.gitBranch === null || typeof message.gitBranch === 'string',
              'a message must carry the branch of its line, or null',
            );
            assertTrue(
              message.cwd === null || typeof message.cwd === 'string',
              'a message must carry the cwd of its line, or null',
            );
            assertTrue(
              typeof message.isSubagentReport === 'boolean',
              'a message must say whether it is a subagent report',
            );
          }
        }
      });
    }),

    contractCase<ParserSubject>(
      'tool notes are unique per message and ordinal, and point at a parsed message',
      async (make) => {
        await withSubject(make, async ({ parser, readable }) => {
          for (const content of readable) {
            const result = parser.parse(content);
            assertOk(result, 'a readable transcript did not parse');
            const messageIds = new Set(
              result.messages.map((message) => message.harnessMessageId),
            );
            const firstId = result.messages[0]?.harnessMessageId;
            const seen = new Set<string>();
            const callIds = new Set<string>();
            for (const note of result.toolNotes) {
              assertInteger(note.ordinal, 'a tool note ordinal must be an integer');
              // A negative ordinal means "a call made in front of this
              // message's own line", and only the first message of the content
              // can have anything in front of it. Anywhere else it would be a
              // position two notes could collide on
              // (`domain/ingest-batch.ts`, story 23).
              if (note.ordinal < 0) {
                assertEqual(
                  note.harnessMessageId,
                  firstId,
                  'only the first message of the content may carry a negative-ordinal note',
                );
              }
              const key = `${note.harnessMessageId}#${String(note.ordinal)}`;
              assertTrue(!seen.has(key), `two tool notes share (message, ordinal) ${key}`);
              seen.add(key);
              assertTrue(
                messageIds.has(note.harnessMessageId),
                `tool note ${key} points at a message the batch does not carry`,
              );
              assertNonEmptyString(note.tool, 'a tool note must name the tool');
              // The call id is what a store recognises the same call by across
              // parser versions, so two notes of one parse must not share one.
              if (note.callId !== null) {
                assertNonEmptyString(note.callId, 'a tool note call id must not be empty');
                assertTrue(
                  !callIds.has(note.callId),
                  `two tool notes of one parse share the call id ${note.callId}`,
                );
                callIds.add(note.callId);
              }
              for (const earlier of note.earlierPositions) {
                assertNonEmptyString(
                  earlier.harnessMessageId,
                  'an earlier position must name a message',
                );
                assertInteger(
                  earlier.ordinal,
                  'an earlier position ordinal must be an integer',
                );
              }
            }
          }
        });
      },
    ),

    contractCase<ParserSubject>(
      'the cursor names the last message the content carried',
      async (make) => {
        await withSubject(make, async ({ parser, readable }) => {
          for (const content of readable) {
            const result = parser.parse(content);
            assertOk(result, 'a readable transcript did not parse');
            const last = result.messages.at(-1);
            if (last === undefined) {
              assertEqual(result.cursor, null, 'an empty transcript has no cursor');
              continue;
            }
            const { cursor } = result;
            if (cursor === null) {
              fail('a transcript with messages must come back with a cursor (AD-4)');
            }
            assertEqual(
              cursor.lastHarnessMessageId,
              last.harnessMessageId,
              'the cursor must name the last message of the content',
            );
            assertNonEmptyString(cursor.fingerprint, 'the cursor must carry a fingerprint');
          }
        });
      },
    ),

    contractCase<ParserSubject>(
      'content the parser cannot read fails as a value',
      async (make) => {
        await withSubject(make, async ({ parser, unreadable }) => {
          for (const content of unreadable) {
            const result = parser.parse(content);
            assertNotOk(result, 'unreadable content parsed anyway');
            assertEqual(
              result.code,
              'TRANSCRIPT_UNREADABLE',
              'a parser must refuse content with TRANSCRIPT_UNREADABLE',
            );
            assertNonEmptyString(result.message, 'a refusing parser must say why');
          }
        });
      },
    ),

    contractCase<ParserSubject>(
      'the reported parser version is the parser version',
      async (make) => {
        await withSubject(make, async ({ parser, readable }) => {
          for (const content of readable) {
            const result = parser.parse(content);
            assertOk(result, 'a readable transcript did not parse');
            assertEqual(
              result.parserVersion,
              parser.version,
              'the result must carry the version of the parser that produced it',
            );
          }
        });
      },
    ),

    contractCase<ParserSubject>(
      'the dropped-line counts are non-negative integers under their own reasons',
      async (make) => {
        await withSubject(make, async ({ parser, readable, grown }) => {
          const contents = [...readable, ...grown.map((pair) => pair.after)];
          for (const content of contents) {
            const result = parser.parse(content);
            assertOk(result, 'a readable transcript did not parse');
            for (const [reason, count] of Object.entries(result.droppedLines)) {
              // A reason is a code, not a sentence: it goes into an envelope
              // and a person reads it there (`ports/parser.ts`).
              assertTrue(
                /^[a-z][a-z0-9_]*$/u.test(reason),
                `a dropped-line reason must be snake_case, got ${reason}`,
              );
              assertInteger(count, `the count of ${reason} must be an integer`);
              assertTrue(count >= 0, `the count of ${reason} must not be negative`);
            }
            // The one reason Core reads has to be there whatever the file said,
            // because `sessions.ingest` turns it into a warning and a missing
            // key would read as "nothing was skipped" either way.
            assertTrue(
              Object.hasOwn(result.droppedLines, 'unreadable'),
              'a parser must report the reserved `unreadable` count, zero included',
            );
          }
        });
      },
    ),

    contractCase<ParserSubject>(
      'a parse with no cursor reads from the front and calls it no reset',
      async (make) => {
        await withSubject(make, async ({ parser, readable }) => {
          for (const content of readable) {
            const result = parser.parse(content);
            assertOk(result, 'a readable transcript did not parse');
            // Reading a transcript from the start is the normal first read of
            // a session. Calling it a reset would make `CURSOR_RESET` a warning
            // on every new session, and so a warning that means nothing (AD-4).
            assertEqual(
              result.cursorReset,
              false,
              'a parse that was given no cursor cannot have reset one',
            );
            assertEqual(
              parser.parse(content, null),
              result,
              'a null cursor must read exactly what no cursor reads',
            );
            assertTrue(
              result.startCwd === null || (typeof result.startCwd === 'string' && result.startCwd.trim() !== ''),
              'the start cwd must be a non-empty string or null',
            );
            assertTrue(
              result.startSource === null ||
                result.startSource === 'startup' ||
                result.startSource === 'resume' ||
                result.startSource === 'clear' ||
                result.startSource === 'compact' ||
                result.startSource === 'fork',
              `the start source must be one the domain names, or null, got ${String(result.startSource)}`,
            );
          }
        });
      },
    ),

    contractCase<ParserSubject>(
      'a cursor the content still fits is read from, and nothing before it',
      async (make) => {
        await withSubject(make, async ({ parser, grown }) => {
          for (const { before, after } of grown) {
            const first = parser.parse(before);
            assertOk(first, 'the shorter transcript did not parse');
            const { cursor } = first;
            if (cursor === null) {
              fail('the `before` of a grown pair must carry a cursor to read from');
            }

            const whole = parser.parse(after);
            assertOk(whole, 'the longer transcript did not parse');
            const incremental = parser.parse(after, cursor);
            assertOk(incremental, 'the longer transcript did not parse with a cursor');

            assertEqual(
              incremental.cursorReset,
              false,
              'a cursor the content still carries is not a reset',
            );
            const from = whole.messages.findIndex(
              (message) => message.harnessMessageId === cursor.lastHarnessMessageId,
            );
            assertTrue(
              from >= 0,
              'the whole read must still carry the message the cursor named',
            );
            // The point of the incremental read: what it reports is exactly the
            // tail of the whole read, from the cursor's own message on. Nothing
            // is skipped and nothing is read twice differently, so a store that
            // gets either lands in the same place (AD-4).
            assertEqual(
              incremental.messages,
              whole.messages.slice(from),
              'an incremental read must report the whole read from the cursor message on',
            );
            const ids = new Set(
              incremental.messages.map((message) => message.harnessMessageId),
            );
            assertEqual(
              incremental.toolNotes,
              whole.toolNotes.filter(
                (note) =>
                  ids.has(note.harnessMessageId) &&
                  // Except the calls in *front* of the cursor's own message:
                  // an incremental read starts at that message's line, so the
                  // lines before it are not read again — and their notes are
                  // already stored from the read that produced the cursor
                  // (story 23, Design Notes).
                  !(note.harnessMessageId === cursor.lastHarnessMessageId && note.ordinal < 0),
              ),
              'an incremental read must report the notes of the messages it carried',
            );
            assertEqual(
              incremental.cursor,
              whole.cursor,
              'both reads of one content end at the same place',
            );
            assertEqual(
              incremental.startCwd,
              whole.startCwd,
              'the start cwd answers for the whole content regardless of cursor',
            );
            assertEqual(
              incremental.startSource,
              whole.startSource,
              'the start source answers for the content, so a cursor cannot change it',
            );
          }
        });
      },
    ),

    contractCase<ParserSubject>(
      'a cursor the content does not fit reads from the front and says so',
      async (make) => {
        await withSubject(make, async ({ parser, readable, rewritten }) => {
          const pairs = [
            ...rewritten.map(({ before, after }) => {
              const first = parser.parse(before);
              if (!first.ok || first.cursor === null) {
                fail('the `before` of a rewritten pair must parse and carry a cursor');
              }
              return { content: after, cursor: first.cursor };
            }),
            // Somebody else's cursor: a message this content never carried,
            // which is what a compact or a fork leaves behind.
            ...readable.map((content) => ({ content, cursor: FOREIGN_CURSOR })),
          ];

          for (const { content, cursor } of pairs) {
            const whole = parser.parse(content);
            assertOk(whole, 'a readable transcript did not parse');
            const result = parser.parse(content, cursor);
            assertOk(result, 'a readable transcript did not parse with a stale cursor');

            assertEqual(
              result.cursorReset,
              true,
              'a cursor the content does not fit must be reported as a reset',
            );
            // And the read is the whole content, because that is the only
            // answer left: the store is idempotent, so re-reading what it
            // already holds inserts nothing (AD-4).
            assertEqual(
              { ...result, cursorReset: false },
              whole,
              'a reset parse must report what a parse from the front reports',
            );
          }
        });
      },
    ),

    contractCase<ParserSubject>(
      'the same content and cursor parse to the same result twice',
      async (make) => {
        await withSubject(make, async ({ parser, grown, rewritten }) => {
          for (const { before, after } of [...grown, ...rewritten]) {
            const first = parser.parse(before);
            assertOk(first, 'the `before` of a pair did not parse');
            const { cursor } = first;
            if (cursor === null) fail('the `before` of a pair must carry a cursor');
            assertEqual(
              parser.parse(after, cursor),
              parser.parse(after, cursor),
              'parsing the same content with the same cursor gave two results',
            );
          }
        });
      },
    ),
  ];
}
