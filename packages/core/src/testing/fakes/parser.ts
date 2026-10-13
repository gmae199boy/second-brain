import type { ParsedMessage, ParsedToolNote } from '../../domain/ingest-batch.js';
import type { MessageRole } from '../../domain/message.js';
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
 * without any harness format in Core (AD-4). `seq` comes from the order of the
 * messages and the tool-note ordinal from the order inside a message, which
 * makes the result a pure function of the content (AD-4).
 *
 * ```json
 * { "messages": [ { "harnessMessageId": "m1", "role": "user",
 *                   "occurredAt": "2026-01-02T03:04:05.000Z", "body": "…",
 *                   "toolCalls": [ { "tool": "read", "target": "notes.md" } ] } ] }
 * ```
 */
export function memoryParser(options: MemoryParserOptions = {}): Parser {
  const { harness = 'demo', version = '1' } = options;

  return {
    harness,
    version,
    parse(content: string): ParseResult {
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
          seq: index,
          role,
          model: asString(record['model']) ?? null,
          body,
          occurredAt: new Date(occurredAt),
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

      const last = messages.at(-1);
      return {
        ok: true,
        parserVersion: version,
        messages,
        toolNotes,
        cursor:
          last === undefined
            ? null
            : {
                lastHarnessMessageId: last.harnessMessageId,
                fingerprint: smallHash(content),
              },
      };
    },
  };
}

/** A transcript `memoryParser` reads, with neutral names (repo hygiene). */
export const memoryTranscript = JSON.stringify({
  messages: [
    {
      harnessMessageId: 'msg-1',
      role: 'user',
      occurredAt: '2026-01-02T03:04:05.000Z',
      body: 'Where did we leave the import notes?',
    },
    {
      harnessMessageId: 'msg-2',
      role: 'assistant',
      model: 'demo-model',
      occurredAt: '2026-01-02T03:04:07.000Z',
      body: 'They are in notes/import.md; I added the open question at the end.',
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
