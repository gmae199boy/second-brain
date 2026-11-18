import { createHash } from 'node:crypto';
import type { ParsedMessage, ParsedToolNote, Parser, ParserCursor, ParseResult } from '@second-brain/core';

export const CODEX_HARNESS = 'codex';
export const CODEX_PARSER_VERSION = 'codex-v1';

type Obj = Record<string, unknown>;
type Line = { text: string; end: number; value: Obj | null; json: boolean };
const object = (v: unknown): Obj | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null;
const str = (v: unknown): string | null => typeof v === 'string' ? v : null;
const hash = (v: string): string => createHash('sha256').update(v).digest('hex');

/** Only newline-terminated lines are stable, even if an unfinished tail parses as JSON. */
function completeLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const end = content.indexOf('\n', start);
    if (end < 0) break;
    const text = content.slice(start, end);
    let value: unknown;
    let json = false;
    try { value = JSON.parse(text); json = true; } catch { /* counted by the parser */ }
    lines.push({ text, end: end + 1, value: object(value), json });
    start = end + 1;
  }
  return lines;
}

/** The only trusted session key is the first complete session_meta's id. */
export function codexSessionId(content: string): string | null {
  let id: string | null = null;
  for (const line of completeLines(content)) {
    if (line.value?.['type'] !== 'session_meta') continue;
    const candidate = str(object(line.value['payload'])?.['id']);
    if (candidate === null || candidate.trim() === '' || (id !== null && candidate !== id)) return null;
    id = candidate;
  }
  return id;
}

type Call = { id: string; type: 'function_call' | 'custom_tool_call'; tool: string; target: string; message: string | null; ordinal: number };

/** An unrecognised output is not evidence of success. */
function outcome(value: unknown): boolean {
  const item = object(value);
  if (item) {
    if (typeof item['is_error'] === 'boolean') return !item['is_error'];
    if (typeof item['success'] === 'boolean') return item['success'];
    if (typeof item['exit_code'] === 'number') return item['exit_code'] === 0;
    if ('output' in item) return outcome(item['output']);
    return false;
  }
  if (typeof value !== 'string') return false;
  try { const parsed: unknown = JSON.parse(value); if (typeof parsed === 'object' && parsed !== null) return outcome(parsed); } catch { /* text output */ }
  // Status is trusted only in the header of the shell execution envelope,
  // never in the arbitrary command output following `Final output:`.
  const match = /^Chunk ID: [a-zA-Z0-9_-]+\r?\nWall time: \d+(?:\.\d+)? seconds\r?\nProcess exited with code (-?\d+)\r?\n(?:Original token count: \d+\r?\n)?Final output:\r?\n/u.exec(value);
  return match !== null && Number(match[1]) === 0;
}

export function codexParser(): Parser {
  const parser: Parser = {
    harness: CODEX_HARNESS,
    version: CODEX_PARSER_VERSION,
    validateSessionId: (content, harnessSessionId) => codexSessionId(content) === harnessSessionId,
    parse(content: string, cursor?: ParserCursor | null): ParseResult {
      const lines = completeLines(content);
      if (codexSessionId(content) === null) return { ok: false, code: 'TRANSCRIPT_UNREADABLE', message: 'Codex 세션 메타데이터의 id가 없거나 일치하지 않습니다' };
      const allMessages: { message: ParsedMessage; lineIndex: number; end: number }[] = [];
      const calls: Call[] = [];
      const seenCalls = new Map<string, 'function_call' | 'custom_tool_call'>();
      const outputs = new Map<string, { type: string; ok: boolean }>();
      const ordinals = new Map<string, number>();
      let lastMessage: string | null = null;
      let startCwd: string | null = null;
      let seenMeta = false;
      let model: string | null = null;
      let branch: string | null = null;
      let cwd: string | null = null;
      for (const [index, line] of lines.entries()) {
        const entry = line.value;
        if (!entry) continue;
        const payload = object(entry['payload']);
        if (entry['type'] === 'session_meta' && !seenMeta) {
          const initial = str(payload?.['cwd']);
          startCwd = initial && initial.trim() !== '' ? initial : null;
          seenMeta = true;
        }
        if (entry['type'] === 'session_meta' && payload) {
          if (cwd === null) cwd = str(payload['cwd']);
          if (branch === null) branch = str(object(payload['git'])?.['branch']);
        }
        if (entry['type'] === 'turn_context' && payload) {
          model = str(payload['model']) ?? model;
          cwd = str(payload['cwd']) ?? cwd;
        }
        if (entry['type'] !== 'response_item' || !payload) continue;
        const type = payload['type'];
        if (type === 'message') {
          const role = payload['role'];
          const at = str(entry['timestamp']);
          const date = at === null ? new Date(NaN) : new Date(at);
          const parts = Array.isArray(payload['content']) ? payload['content'] : [];
          const body = parts.map(object).filter((p): p is Obj => p !== null && (p['type'] === 'input_text' || p['type'] === 'output_text') && typeof p['text'] === 'string').map(p => p['text'] as string).join('');
          if ((role !== 'user' && role !== 'assistant') || !body || !Number.isFinite(date.getTime())) continue;
          // A line's ordinal and bytes distinguish repeated identical messages while remaining stable on append.
          const id = `codex:${index}:${hash(line.text)}`;
          const message: ParsedMessage = { harnessMessageId: id, role, model: role === 'assistant' ? model : null, body, occurredAt: date, gitBranch: branch, cwd, isSubagentReport: false };
          allMessages.push({ message, lineIndex: index, end: line.end });
          lastMessage = id;
        } else if (type === 'function_call' || type === 'custom_tool_call') {
          const id = str(payload['call_id']);
          const tool = str(payload['name']);
          if (!id || !tool || seenCalls.has(id)) continue;
          seenCalls.set(id, type);
          const raw = type === 'function_call' ? payload['arguments'] : payload['input'];
          const target = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw);
          const ordinal = lastMessage === null ? 0 : (ordinals.get(lastMessage) ?? 0);
          if (lastMessage !== null) ordinals.set(lastMessage, ordinal + 1);
          calls.push({ id, type, tool, target, message: lastMessage, ordinal });
        } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
          const id = str(payload['call_id']);
          if (id && `${seenCalls.get(id)}_output` === type && !outputs.has(id)) outputs.set(id, { type, ok: outcome(payload['output']) });
        }
      }
      const first = allMessages[0]?.message.harnessMessageId;
      const early = calls.filter(call => call.message === null);
      const toolNotes: ParsedToolNote[] = [];
      for (const call of calls) {
        const result = outputs.get(call.id);
        const message = call.message ?? first;
        if (!result || !message || result.type !== `${call.type}_output`) continue;
        toolNotes.push({ harnessMessageId: message, ordinal: call.message === null ? early.indexOf(call) - early.length : call.ordinal, tool: call.tool, target: call.target, ok: result.ok, callId: call.id, earlierPositions: [] });
      }
      let from = 0;
      let cursorReset = false;
      if (cursor) {
        const found = allMessages.findIndex(item => item.message.harnessMessageId === cursor.lastHarnessMessageId && hash(content.slice(0, item.end)) === cursor.fingerprint);
        if (found < 0) cursorReset = true;
        else from = found;
      }
      const readFrom = cursor && !cursorReset ? (allMessages[from]?.lineIndex ?? 0) : 0;
      const droppedLines: Record<string, number> = { unreadable: 0, non_conversation: 0 };
      const keptLines = new Set(allMessages.map(item => item.lineIndex));
      for (let i = readFrom; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.text.trim()) continue;
        if (!line.json) droppedLines['unreadable']! += 1;
        else if (!keptLines.has(i)) droppedLines['non_conversation']! += 1;
      }
      const last = allMessages.at(-1);
      return {
        ok: true, parserVersion: CODEX_PARSER_VERSION,
        messages: allMessages.slice(from).map(item => item.message), attachments: [], toolNotes,
        cursor: last ? { lastHarnessMessageId: last.message.harnessMessageId, fingerprint: hash(content.slice(0, last.end)) } : null,
        cursorReset, startSource: null, startCwd, droppedLines,
      };
    },
  };
  parser.reconcile = (content, cursor, storedIds) => {
    const full = parser.parse(content, null);
    const ids = new Map<string, string>();
    if (!full.ok) return { result: full, messageIds: ids };
    const groups = new Map<string, string[]>();
    for (const message of full.messages) {
      const digest = message.harnessMessageId.split(':')[2]!;
      const group = groups.get(digest) ?? [];
      group.push(message.harnessMessageId); groups.set(digest, group);
    }
    for (const [digest, incoming] of groups) {
      const assigned = new Set<number>();
      // Reserve existing canonical positions first, then map legacy IDs by file order.
      for (const id of storedIds) {
        const match = /^codex:v2:([a-f0-9]{64}):(\d+)$/.exec(id);
        if (!match || match[1] !== digest) continue;
        const n = Number(match[2]);
        if (Number.isSafeInteger(n) && n < incoming.length && !assigned.has(n)) { ids.set(incoming[n]!, id); assigned.add(n); }
      }
      const legacy = storedIds.map(id => ({ id, match: /^codex:(\d+):([a-f0-9]{64})$/.exec(id) }))
        .filter(item => item.match?.[2] === digest)
        .sort((a, b) => Number(a.match![1]) - Number(b.match![1]));
      for (const item of legacy) {
        const n = incoming.findIndex((_, index) => !assigned.has(index));
        if (n < 0) break;
        ids.set(incoming[n]!, item.id); assigned.add(n);
      }
      incoming.forEach((id, n) => { if (!ids.has(id)) ids.set(id, `codex:v2:${digest}:${n}`); });
    }
    const mapId = (id: string) => ids.get(id) ?? id;
    const lines = completeLines(content);
    // The persisted cursor names a stored ID; recover its current raw ID only
    // when both identity and the exact prefix fingerprint agree.
    const raw = cursor && full.messages.find(message => {
      const index = Number(message.harnessMessageId.split(':')[1]);
      const line = lines[index];
      return mapId(message.harnessMessageId) === cursor.lastHarnessMessageId && line !== undefined && hash(content.slice(0, line.end)) === cursor.fingerprint;
    });
    const parsed = parser.parse(content, raw && cursor ? { lastHarnessMessageId: raw.harnessMessageId, fingerprint: cursor.fingerprint } : null);
    if (!parsed.ok) return { result: parsed, messageIds: ids };
    return { messageIds: ids, result: {
      ...parsed,
      cursorReset: cursor !== null && !raw ? true : parsed.cursorReset,
      messages: parsed.messages.map(message => ({ ...message, harnessMessageId: mapId(message.harnessMessageId) })),
      attachments: parsed.attachments.map(attachment => ({ ...attachment, harnessMessageId: mapId(attachment.harnessMessageId) })),
      toolNotes: parsed.toolNotes.map(note => ({ ...note, harnessMessageId: mapId(note.harnessMessageId), earlierPositions: note.earlierPositions.map(position => ({ ...position, harnessMessageId: mapId(position.harnessMessageId) })) })),
      cursor: parsed.cursor ? { ...parsed.cursor, lastHarnessMessageId: mapId(parsed.cursor.lastHarnessMessageId) } : null,
    } };
  };
  return parser;
}
