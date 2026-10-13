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
}

/**
 * The parser contract. The heart of it is determinism: the output is a pure
 * function of the content and the parser version, so the same transcript always
 * produces the same `seq` and the same tool-note ordinals (AD-4).
 */
export function parserContract(): ContractCase<ParserSubject>[] {
  return [
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

    contractCase<ParserSubject>('seq starts at 0 and grows by one', async (make) => {
      await withSubject(make, async ({ parser, readable }) => {
        for (const content of readable) {
          const result = parser.parse(content);
          assertOk(result, 'a readable transcript did not parse');
          assertEqual(
            result.messages.map((message) => message.seq),
            result.messages.map((_message, index) => index),
            'message seq must run 0, 1, 2, … with no gaps (AD-4)',
          );
        }
      });
    }),

    contractCase<ParserSubject>('every message is well formed', async (make) => {
      await withSubject(make, async ({ parser, readable }) => {
        for (const content of readable) {
          const result = parser.parse(content);
          assertOk(result, 'a readable transcript did not parse');
          const seen = new Set<string>();
          for (const message of result.messages) {
            assertNonEmptyString(
              message.harnessMessageId,
              'a message must carry the harness message id',
            );
            assertTrue(
              !seen.has(message.harnessMessageId),
              `two messages share the harness id ${message.harnessMessageId}`,
            );
            seen.add(message.harnessMessageId);
            assertTrue(
              message.role === 'user' || message.role === 'assistant',
              `a message role must be user or assistant, got ${message.role}`,
            );
            assertValidDate(message.occurredAt, 'a message must carry when it was uttered');
            assertInteger(message.seq, 'a message seq must be an integer');
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
            const seen = new Set<string>();
            for (const note of result.toolNotes) {
              assertInteger(note.ordinal, 'a tool note ordinal must be an integer');
              assertTrue(note.ordinal >= 0, 'a tool note ordinal must not be negative');
              const key = `${note.harnessMessageId}#${String(note.ordinal)}`;
              assertTrue(!seen.has(key), `two tool notes share (message, ordinal) ${key}`);
              seen.add(key);
              assertTrue(
                messageIds.has(note.harnessMessageId),
                `tool note ${key} points at a message the batch does not carry`,
              );
              assertNonEmptyString(note.tool, 'a tool note must name the tool');
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
  ];
}
