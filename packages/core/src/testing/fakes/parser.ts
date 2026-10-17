import type { ParsedMessage, ParsedToolNote } from '../../domain/ingest-batch.js';
import type { MessageRole } from '../../domain/message.js';
import type { ParserCursor, SessionStartSource } from '../../domain/session.js';
import type { ParseResult, Parser } from '../../ports/parser.js';
import { smallHash } from '../hash.js';

export interface MemoryParserOptions {
  /** Neutral harness name. Defaults to `demo`. */
  harness?: string;
  /** Parser version recorded on the session. Defaults to `1`. */
  version?: string;
}

/**
 * A parser over a neutral JSON transcript, so the parser contract can run
 * without any harness format in Core (AD-4). The messages come out in the
 * order the file holds them and the tool-note ordinal from the order inside a
 * message, which makes the result a pure function of the content and the cursor
 * (AD-4). It says nothing about `seq`: that is the store's (AD-8).
 *
 * ```json
 * { "startSource": "startup",
 *   "messages": [ { "harnessMessageId": "m1", "role": "user",
 *                   "occurredAt": "2026-01-02T03:04:05.000Z", "body": "…",
 *                   "gitBranch": "main", "cwd": "/demo/repo",
 *                   "toolCalls": [ { "tool": "read", "target": "notes.md" } ] } ] }
 * ```
 *
 * The cursor works the way a real one does, in the one shape this format
 * allows: the fingerprint covers the messages up to and including the one the
 * cursor names, so appending to the transcript leaves it alone and rewriting
 * anything in front of that message does not. A cursor that still matches is
 * read from, and one that does not is a `cursorReset` and a read from the
 * front.
 */
export function memoryParser(options: MemoryParserOptions = {}): Parser {
  const { harness = 'demo', version = '1' } = options;

  return {
    harness,
    version,
    parse(content: string, cursor?: ParserCursor | null): ParseResult {
      const raw = readJson(content);
      if (raw === undefined) {
        return {
          ok: false,
          code: 'TRANSCRIPT_UNREADABLE',
          message: 'the transcript is not the JSON this parser reads',
        };
      }

      const entries = raw['messages'];
      if (!Array.isArray(entries)) {
        return {
          ok: false,
          code: 'TRANSCRIPT_UNREADABLE',
          message: 'the transcript carries no `messages` array',
        };
      }

      const messages: ParsedMessage[] = [];
      const toolNotes: ParsedToolNote[] = [];

      for (const [index, entry] of entries.entries()) {
        const record = asRecord(entry);
        if (record === undefined) {
          return {
            ok: false,
            code: 'TRANSCRIPT_UNREADABLE',
            message: `message ${String(index)} is not an object`,
          };
        }

        const harnessMessageId = asString(record['harnessMessageId']);
        const body = asString(record['body']);
        const occurredAt = asString(record['occurredAt']);
        const role = asRole(record['role']);
        if (
          harnessMessageId === undefined ||
          body === undefined ||
          occurredAt === undefined ||
          role === undefined
        ) {
          return {
            ok: false,
            code: 'TRANSCRIPT_UNREADABLE',
            message: `message ${String(index)} is missing a required field`,
          };
        }

        messages.push({
          harnessMessageId,
          role,
          model: asString(record['model']) ?? null,
          body,
          occurredAt: new Date(occurredAt),
          gitBranch: asString(record['gitBranch']) ?? null,
          cwd: asString(record['cwd']) ?? null,
          isSubagentReport: record['isSubagentReport'] === true,
        });

        const calls = record['toolCalls'];
        if (calls === undefined) continue;
        if (!Array.isArray(calls)) {
          return {
            ok: false,
            code: 'TRANSCRIPT_UNREADABLE',
            message: `message ${String(index)} has a non-array \`toolCalls\``,
          };
        }
        for (const [ordinal, call] of calls.entries()) {
          const callRecord = asRecord(call);
          const tool = callRecord === undefined ? undefined : asString(callRecord['tool']);
          const target =
            callRecord === undefined ? undefined : asString(callRecord['target']);
          if (callRecord === undefined || tool === undefined || target === undefined) {
            return {
              ok: false,
              code: 'TRANSCRIPT_UNREADABLE',
              message: `tool call ${String(ordinal)} of message ${String(index)} is incomplete`,
            };
          }
          toolNotes.push({
            harnessMessageId,
            ordinal,
            tool,
            target,
            ok: callRecord['ok'] !== false,
          });
        }
      }

      // Where to start. A cursor that still matches the content names the first
      // message of the result; one that does not is a read from the front.
      const from = cursorStart(messages, cursor);
      const kept = messages.slice(from.index);
      const keptIds = new Set(kept.map((message) => message.harnessMessageId));
      const keptNotes = toolNotes.filter((note) => keptIds.has(note.harnessMessageId));

      const last = kept.at(-1);
      return {
        ok: true,
        parserVersion: version,
        messages: kept,
        toolNotes: keptNotes,
        cursor:
          last === undefined
            ? null
            : {
                lastHarnessMessageId: last.harnessMessageId,
                fingerprint: fingerprintUpTo(messages, messages.length - 1),
              },
        cursorReset: from.reset,
        // Answered from the whole content, never from the part that was read,
        // so a cursor cannot change it (port contract).
        startSource: asStartSource(raw['startSource']),
      };
    },
  };
}

/** Where a parse starts, and whether the cursor it was given was any use. */
function cursorStart(
  messages: readonly ParsedMessage[],
  cursor: ParserCursor | null | undefined,
): { index: number; reset: boolean } {
  if (cursor === undefined || cursor === null) return { index: 0, reset: false };
  const index = messages.findIndex(
    (message) => message.harnessMessageId === cursor.lastHarnessMessageId,
  );
  if (index < 0) return { index: 0, reset: true };
  return fingerprintUpTo(messages, index) === cursor.fingerprint
    ? { index, reset: false }
    : { index: 0, reset: true };
}

/**
 * The fingerprint of everything up to and including message `index`. It stops
 * there rather than covering the whole transcript for the same reason the real
 * parsers' does: a transcript grows, and a fingerprint of the whole of it would
 * change every turn and never match again (AD-4).
 */
function fingerprintUpTo(messages: readonly ParsedMessage[], index: number): string {
  const upTo = messages.slice(0, index + 1).map((message) => ({
    id: message.harnessMessageId,
    role: message.role,
    body: message.body,
  }));
  return smallHash(JSON.stringify(upTo));
}

/** A transcript `memoryParser` reads, with neutral names (repo hygiene). */
export const memoryTranscript = JSON.stringify({
  startSource: 'startup',
  messages: [
    {
      harnessMessageId: 'msg-1',
      role: 'user',
      occurredAt: '2026-01-02T03:04:05.000Z',
      body: 'Where did we leave the import notes?',
      gitBranch: 'main',
      cwd: '/demo/repo',
    },
    {
      harnessMessageId: 'msg-2',
      role: 'assistant',
      model: 'demo-model',
      occurredAt: '2026-01-02T03:04:07.000Z',
      body: 'They are in notes/import.md; I added the open question at the end.',
      gitBranch: 'main',
      cwd: '/demo/repo',
      toolCalls: [
        { tool: 'read', target: 'notes/import.md' },
        { tool: 'write', target: 'notes/import.md', ok: true },
      ],
    },
    {
      harnessMessageId: 'msg-3',
      role: 'user',
      occurredAt: '2026-01-02T03:05:01.000Z',
      body: 'Good. Write that down as a decision.',
      gitBranch: 'topic/notes',
      cwd: '/demo/repo',
    },
    {
      // A delegated run's final report: role assistant, no model of its own,
      // and marked, so the two columns of migration 0004 are both exercised by
      // the fixtures every store is measured against.
      harnessMessageId: 'msg-4',
      role: 'assistant',
      occurredAt: '2026-01-02T03:05:20.000Z',
      body: 'The folder holds four files; the newest is import.md.',
      gitBranch: 'topic/notes',
      cwd: '/demo/repo',
      isSubagentReport: true,
    },
  ],
});

/** Content `memoryParser` must refuse as a value, not an exception. */
export const unreadableTranscript = 'not json at all {';

function readJson(content: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRole(value: unknown): MessageRole | undefined {
  return value === 'user' || value === 'assistant' ? value : undefined;
}

function asStartSource(value: unknown): SessionStartSource | null {
  return value === 'startup' ||
    value === 'resume' ||
    value === 'clear' ||
    value === 'compact' ||
    value === 'fork'
    ? value
    : null;
}
