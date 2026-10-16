import { createHash } from 'node:crypto';
import type {
  MessageRole,
  ParseResult,
  ParsedMessage,
  Parser,
  ParserCursor,
} from '@second-brain/core';

/** The neutral harness name, and the first half of every session token (AD-8). */
export const CLAUDE_CODE_HARNESS = 'claude-code';

/**
 * The parser version, recorded on every session it writes (AD-4). It moves when
 * what this parser *produces* changes, so a reader can tell which rows came out
 * of which rules.
 */
export const CLAUDE_CODE_PARSER_VERSION = '1';

/**
 * The Claude Code transcript parser.
 *
 * The file is JSON Lines, one object per line, appended as the session runs.
 * Most of those objects are not conversation: the editor writes its mode and
 * permission mode, snapshots of the file history, hook output, rendered
 * attachments, system notices. Of what is left, a good half is still not
 * something anybody said — a `thinking` block, a `tool_use` block, the
 * `tool_result` the editor feeds back as a user turn.
 *
 * So this parser is a filter before it is anything else. It keeps a line when
 * all of these hold:
 *
 *   * `type` is `user` or `assistant`;
 *   * it is not `isSidechain` (a subagent's own conversation, story 2.7),
 *     `isMeta` (the editor talking to the model on the user's behalf) or
 *     `isCompactSummary` (a summary of a conversation, not a turn of one);
 *   * and the body is not empty once the text is pulled out of it, which is
 *     what drops the thinking, the tool calls and the tool results.
 *
 * Everything it does not keep it keeps *silently*, because none of it is a
 * failure: a transcript is mostly not conversation, and a parser that warned
 * about that would warn on every turn.
 *
 * It says nothing about `seq`. The order of the array is the order of the file,
 * and the number is the store's (AD-8). Ordering is by position in the file and
 * never by timestamp: Claude Code writes in order, and sorting by a clock would
 * reorder two messages of the same millisecond differently on different runs.
 */
export function claudeCodeParser(): Parser {
  return {
    harness: CLAUDE_CODE_HARNESS,
    version: CLAUDE_CODE_PARSER_VERSION,
    parse(content: string): ParseResult {
      const messages: ParsedMessage[] = [];
      const seen = new Set<string>();
      /**
       * Where the last kept message's line ends, for the cursor fingerprint.
       * The separating newline is deliberately outside it: a file the harness
       * is still appending to has no newline after its last line yet, and a
       * fingerprint that counted one would change the moment the next line
       * landed -- for the same message, and so for the same cursor.
       */
      let fingerprintEnd = 0;

      const lines = content.split('\n');
      // A line is "the last one" only when the file does not end in a newline:
      // then the harness is mid-append and the tail may be half a line. With a
      // trailing newline every line is complete and the final empty piece is
      // not a line at all.
      const lastIndex = content.endsWith('\n') ? -1 : lines.length - 1;

      let offset = 0;
      for (const [index, line] of lines.entries()) {
        const start = offset;
        // `+ 1` for the newline that separated it. On the final piece of a file
        // with no trailing newline there is none, and nothing reads this.
        offset += line.length + 1;
        if (line.trim() === '') continue;

        const entry = readJson(line);
        if (entry === undefined) {
          // The tail of a file the harness is still appending to: the only
          // line that is allowed to be half written, and skipped rather than
          // refused (research §1).
          if (index === lastIndex) continue;
          return {
            ok: false,
            code: 'TRANSCRIPT_UNREADABLE',
            message: `line ${String(index + 1)} is not JSON, so the transcript cannot be read as Claude Code's`,
          };
        }

        const message = readMessage(entry);
        if (message === undefined) continue;
        // The first line wins: an id that repeats is the same message written
        // twice, and the second copy must not become a message of its own.
        if (seen.has(message.harnessMessageId)) continue;
        seen.add(message.harnessMessageId);
        messages.push(message);
        fingerprintEnd = start + line.length;
      }

      return {
        ok: true,
        parserVersion: CLAUDE_CODE_PARSER_VERSION,
        messages,
        toolNotes: [],
        cursor: cursorFor(messages, content, fingerprintEnd),
      };
    },
  };
}

/**
 * Where this content ends: the last message it carried, plus the SHA-256 of
 * everything up to the end of that message's line, its separating newline
 * excluded (AD-4).
 *
 * The fingerprint stops at that line rather than covering the whole file on
 * purpose. A transcript grows by appending, so a fingerprint of the whole file
 * changes every turn and would never match; one taken up to the message the
 * cursor names is stable for as long as the front of the file is, which is
 * exactly the question the cursor has to answer — "is this still the same
 * conversation, or was it compacted?"
 *
 * The newline is left out for the same reason, one line smaller: a Stop hook
 * can read the file while the harness has written the cursor's own line and
 * not yet the newline after it. Counting that byte would give one message two
 * fingerprints — one mid-append, one once the next line landed — and the
 * second read would call the conversation compacted.
 */
function cursorFor(
  messages: readonly ParsedMessage[],
  content: string,
  end: number,
): ParserCursor | null {
  const last = messages.at(-1);
  if (last === undefined) return null;
  return {
    lastHarnessMessageId: last.harnessMessageId,
    fingerprint: createHash('sha256').update(content.slice(0, end), 'utf8').digest('hex'),
  };
}

/** One transcript line as a message, or `undefined` when it is not one. */
function readMessage(entry: Record<string, unknown>): ParsedMessage | undefined {
  const role = asRole(entry['type']);
  if (role === undefined) return undefined;
  // Three flags, all of which mean "not a turn of this conversation".
  if (
    entry['isSidechain'] === true ||
    entry['isMeta'] === true ||
    entry['isCompactSummary'] === true
  ) {
    return undefined;
  }

  const harnessMessageId = asString(entry['uuid']);
  const timestamp = asString(entry['timestamp']);
  if (harnessMessageId === undefined || timestamp === undefined) return undefined;
  const occurredAt = new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime())) return undefined;

  const message = asRecord(entry['message']);
  if (message === undefined) return undefined;
  const body = readBody(message['content']);
  // Empty once the text is out of it: a thinking block, a tool call, a tool
  // result. Nothing was said, so there is nothing to store.
  if (body === '') return undefined;

  return {
    harnessMessageId,
    role,
    // Only the assistant has one, and it is recorded rather than acted on
    // (AD-4). The user side has no model and says so with null.
    model: role === 'assistant' ? (asString(message['model']) ?? null) : null,
    body,
    occurredAt,
  };
}

/**
 * The text of a message. Claude Code writes a user turn as a bare string and an
 * assistant turn as a list of blocks, of which only `text` holds anything
 * anybody said.
 */
function readBody(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === undefined || record['type'] !== 'text') continue;
    const text = asString(record['text']);
    if (text !== undefined && text !== '') parts.push(text);
  }
  return parts.join('\n').trim();
}

function readJson(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asRole(value: unknown): MessageRole | undefined {
  return value === 'user' || value === 'assistant' ? value : undefined;
}
