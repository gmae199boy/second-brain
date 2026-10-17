import { createHash } from 'node:crypto';
import type {
  MessageRole,
  ParseResult,
  ParsedMessage,
  ParsedToolNote,
  Parser,
  ParserCursor,
  SessionStartSource,
} from '@second-brain/core';
import { toolTarget } from './tool-target.js';

/** The neutral harness name, and the first half of every session token (AD-8). */
export const CLAUDE_CODE_HARNESS = 'claude-code';

/**
 * The parser version, recorded on every session it writes (AD-4). It moves when
 * what this parser *produces* changes, so a reader can tell which rows came out
 * of which rules.
 *
 * `2` is this story: tool notes, the final reports of delegated runs, the
 * branch and cwd of every line, the session's start source, and the incremental
 * read. `1` produced message bodies and nothing else.
 */
export const CLAUDE_CODE_PARSER_VERSION = '2';

/** The four markers a tool's own output starts a user line with (Boundaries). */
const TOOL_OUTPUT_MARKERS = [
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<bash-stdout>',
  '<bash-stderr>',
] as const;

/** One `tool_use` waiting to find out whether it worked. */
interface PendingNote {
  harnessMessageId: string;
  ordinal: number;
  tool: string;
  target: string;
  /** The block's own id, which the `tool_result` names. */
  toolUseId: string;
  /** How many messages had been read when the call was made. */
  messagesBefore: number;
}

/** Where a parse starts, and whether the cursor it was given was any use. */
interface ParseStart {
  /** Offset of the first line to read. */
  offset: number;
  /** How many lines of the content come before it, for a line number. */
  linesBefore: number;
  reset: boolean;
}

/**
 * The Claude Code transcript parser.
 *
 * The file is JSON Lines, one object per line, appended as the session runs.
 * Most of those objects are not conversation: the editor writes its mode and
 * permission mode, snapshots of the file history, the prompt queue, the title
 * it guessed, hook output, rendered attachments, system notices. Of what is
 * left, a good half is still not something anybody said — a `thinking` block, a
 * `tool_use` block, the `tool_result` the editor feeds back as a user turn, the
 * notification that a background task finished.
 *
 * So this parser is a filter before it is anything else. It keeps a line as a
 * message when all of these hold:
 *
 *   * `type` is `user` or `assistant`;
 *   * it is not `isSidechain` (a subagent's own conversation), `isMeta` (the
 *     editor talking to the model on the user's behalf) or `isCompactSummary`
 *     (a summary of a conversation, not a turn of one);
 *   * it is not an assistant line marked `isApiErrorMessage` — the editor
 *     rendering a failure, not the model answering;
 *   * it is not a user line whose `origin.kind` is `task-notification` (the
 *     editor telling the model a delegated run moved on; the report exception
 *     is below) or `peer` (another agent's traffic);
 *   * it is not a user line whose body starts with a tool-output marker — the
 *     stdout of a `!` command or a background shell, which the editor hands to
 *     the model as a user turn;
 *   * and the body is not empty once the text is pulled out of it, which is
 *     what drops the thinking, the tool calls, the tool results and the pasted
 *     images: only `text` blocks are read, so no base64 can reach a body.
 *
 * Everything it does not keep it keeps *silently*, because none of it is a
 * failure: a transcript is mostly not conversation, and a parser that warned
 * about that would warn on every turn. Where the rule is a judgement call, the
 * line is dropped: a message that was stored cannot be taken back, while one
 * that was dropped arrives later when the parser version moves and the session
 * is read again.
 *
 * It says nothing about `seq`. The order of the array is the order of the file,
 * and the number is the store's (AD-8). Ordering is by position in the file and
 * never by timestamp: Claude Code writes in order, and sorting by a clock would
 * reorder two messages of the same millisecond differently on different runs —
 * and a transcript really does carry lines whose stamps go backwards.
 *
 * Lines are separated by `\n` alone. U+2028 and U+2029 are characters inside a
 * JSON string here, not line breaks, and a raw one in a body is read as part of
 * that body.
 */
export function claudeCodeParser(): Parser {
  return {
    harness: CLAUDE_CODE_HARNESS,
    version: CLAUDE_CODE_PARSER_VERSION,
    parse(content: string, cursor?: ParserCursor | null): ParseResult {
      // Where to start: the cursor's own line when the content still matches
      // it, the front of the file when it does not.
      const start = startFor(content, cursor ?? null);

      const messages: ParsedMessage[] = [];
      /** The uuid of every line already read, so a repeated one is skipped. */
      const seen = new Set<string>();
      /** `tool_use` blocks in file order, resolved once the file is read. */
      const pending: PendingNote[] = [];
      /** `tool_use_id` → whether the result it got was not an error. */
      const outcomes = new Map<string, boolean>();
      /** Harness message id → how many calls have been attached to it. */
      const ordinals = new Map<string, number>();
      /** The last message read, which is what a tool call attaches to. */
      let lastMessageId: string | null = null;
      /**
       * Where the last kept message's line ends, for the cursor fingerprint.
       * The separating newline is deliberately outside it: a file the harness
       * is still appending to has no newline after its last line yet, and a
       * fingerprint that counted one would change the moment the next line
       * landed -- for the same message, and so for the same cursor.
       */
      let fingerprintEnd = 0;

      const lines = content.slice(start.offset).split('\n');
      // A line is "the last one" only when the file does not end in a newline:
      // then the harness is mid-append and the tail may be half a line. With a
      // trailing newline every line is complete and the final empty piece is
      // not a line at all.
      const lastIndex = content.endsWith('\n') ? -1 : lines.length - 1;

      let offset = start.offset;
      for (const [index, line] of lines.entries()) {
        const lineStart = offset;
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
          const number = start.linesBefore + index + 1;
          return {
            ok: false,
            code: 'TRANSCRIPT_UNREADABLE',
            message: `${String(number)}번째 줄이 JSON이 아니어서 이 트랜스크립트를 Claude Code의 것으로 읽을 수 없습니다`,
          };
        }

        // The first copy of a line wins, and the rest of it is not read at all.
        // A uuid that repeats is the same line written twice — not a second
        // message, and not a second call either: a line with a `tool_use` in it
        // would otherwise leave two notes for the one call, under two ordinals,
        // and a note cannot be taken back (AD-11). Lines with no uuid are
        // editor state and never repeat each other.
        const uuid = asString(entry['uuid']);
        if (uuid !== undefined) {
          if (seen.has(uuid)) continue;
          seen.add(uuid);
        }

        // Before the message, because one user line can be both: the result of
        // an `Agent` call and the report that call came back with.
        readOutcomes(entry, outcomes);

        const message = readMessage(entry, content, lineStart);
        if (message !== undefined) {
          messages.push(message);
          lastMessageId = message.harnessMessageId;
          fingerprintEnd = lineStart + line.length;
        }

        readToolUses(entry, lastMessageId, messages.length, ordinals, pending);
      }

      return {
        ok: true,
        parserVersion: CLAUDE_CODE_PARSER_VERSION,
        messages,
        toolNotes: resolveNotes(pending, outcomes, messages.length),
        cursor: cursorFor(messages, content, fingerprintEnd),
        cursorReset: start.reset,
        // From the whole content and not from the part that was read, so an
        // incremental parse answers the same as a full one (port contract).
        startSource: readStartSource(content),
      };
    },
  };
}

/**
 * Where to start reading, given the cursor the store kept.
 *
 * The cursor names a message and fingerprints the content up to the end of that
 * message's line. So finding it is a string search for `"uuid":"<id>"` — the
 * quotes inside a body are written `\"`, so no body can be mistaken for the
 * key, and `parentUuid` and `leafUuid` carry a capital U and do not match
 * either. The line is still parsed and the id checked again before it is
 * believed, because a search is a search.
 *
 * A match must also still be a message: the result of an incremental read
 * starts at the cursor's own message, and a line the rules now drop could not
 * start anything.
 *
 * That check is not what makes a parser version bump safe, and must not be
 * mistaken for it: a cursor from an older version may well still match here.
 * Deciding that an old cursor is not this parser's is the caller's — it is
 * `sessions.ingest` that compares `sessions.parser_version` and hands over
 * `null` instead, so the whole session is read again under the new rules.
 */
function startFor(content: string, cursor: ParserCursor | null): ParseStart {
  if (cursor === null) return { offset: 0, linesBefore: 0, reset: false };

  const pattern = new RegExp(`"uuid"\\s*:\\s*"${escapeForRegExp(cursor.lastHarnessMessageId)}"`, 'g');
  for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
    const lineStart = content.lastIndexOf('\n', match.index) + 1;
    const newline = content.indexOf('\n', match.index);
    const lineEnd = newline < 0 ? content.length : newline;

    const entry = readJson(content.slice(lineStart, lineEnd));
    if (entry === undefined) continue;
    if (asString(entry['uuid']) !== cursor.lastHarnessMessageId) continue;
    if (readMessage(entry, content, lineStart) === undefined) continue;
    const fingerprint = createHash('sha256')
      .update(content.slice(0, lineEnd), 'utf8')
      .digest('hex');
    if (fingerprint !== cursor.fingerprint) continue;

    return {
      offset: lineStart,
      linesBefore: countLines(content, lineStart),
      reset: false,
    };
  }

  // Gone, or the content in front of it is not what it was: a compact, a fork,
  // a transcript rewritten underneath us. Reading it all again inserts nothing
  // that is already stored, so this is a warning and not a failure (AD-4).
  return { offset: 0, linesBefore: 0, reset: true };
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
function readMessage(
  entry: Record<string, unknown>,
  content: string,
  lineStart: number,
): ParsedMessage | undefined {
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

  // Tracking, taken exactly as the line carried it (migration 0004). The cwd
  // is reported and not stored: story 2.8 tags the session with the first
  // message's one.
  const gitBranch = asTracking(entry['gitBranch']);
  const cwd = asTracking(entry['cwd']);

  // A delegated run's final report comes in on a user line, and it is the one
  // thing worth recalling out of a whole subagent run. It is read as an
  // assistant message with no model of its own.
  const report = readReport(entry, message, content, lineStart);
  if (report !== undefined) {
    return {
      harnessMessageId,
      role: 'assistant',
      model: null,
      body: report,
      occurredAt,
      gitBranch,
      cwd,
      isSubagentReport: true,
    };
  }

  // The editor rendering a failure, not the model answering.
  if (role === 'assistant' && entry['isApiErrorMessage'] === true) return undefined;
  // Traffic the editor routed through the conversation: the notification that a
  // delegated run moved on, and another agent's messages.
  if (role === 'user' && isForeignOrigin(entry['origin'])) return undefined;

  const body = readBody(message['content']);
  // Empty once the text is out of it: a thinking block, a tool call, a tool
  // result, a pasted image.
  if (body === '') return undefined;
  // A tool's own output, handed to the model as a user turn.
  if (role === 'user' && isToolOutput(body)) return undefined;

  return {
    harnessMessageId,
    role,
    // Only the assistant has one, and it is recorded rather than acted on
    // (AD-4). The user side has no model and says so with null.
    model: role === 'assistant' ? (asString(message['model']) ?? null) : null,
    body,
    occurredAt,
    gitBranch,
    cwd,
    isSubagentReport: false,
  };
}

/**
 * The final report of a delegated run, read from the *main* transcript, or
 * `undefined` when this line is not one.
 *
 * It is read here and not from `subagents/agent-<id>.jsonl` on purpose. Those
 * files mostly do not end in the subagent's answer, one answer is split over
 * several lines, and reading another file would put the cursor and the
 * incremental read of this one out of reach. The main transcript carries the
 * report either way, in one of two shapes:
 *
 *   * a run the model waited for: the `Agent` call's own result, where
 *     `toolUseResult` carries the `agentId` and `status: "completed"`, and the
 *     report is the text of its `content`;
 *   * a run that reported back later: a `task-notification` line whose body
 *     says `<status>completed</status>`, whose `<task-id>` is an agent this
 *     session actually started — the id appears as `"agentId":"…"` somewhere
 *     before this line — and whose report is the inside of `<result>`.
 *
 * The id is checked by searching the content in front of the line in both the
 * full and the incremental case, so the two read the same thing (Design Notes).
 */
function readReport(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  content: string,
  lineStart: number,
): string | undefined {
  if (entry['type'] !== 'user') return undefined;

  const result = asRecord(entry['toolUseResult']);
  if (
    result !== undefined &&
    asString(result['agentId']) !== undefined &&
    result['status'] === 'completed'
  ) {
    const body = readBody(result['content']);
    if (body !== '') return body;
  }

  const origin = asRecord(entry['origin']);
  if (origin === undefined || origin['kind'] !== 'task-notification') return undefined;
  const notice = readBody(message['content']);
  if (!notice.includes('<status>completed</status>')) return undefined;

  // The id ends at the *first* closing tag: a report that itself mentions
  // `</task-id>` must not swallow the id, and an id is one token anyway.
  const taskId = between(notice, '<task-id>', '</task-id>', 'first')?.trim();
  if (taskId === undefined || taskId === '') return undefined;
  if (!carriesAgentId(content.slice(0, lineStart), taskId)) return undefined;

  // The report ends at the last one, so a report that carries the closing tag
  // inside it still comes out whole.
  const body = between(notice, '<result>', '</result>', 'last')?.trim();
  return body === undefined || body === '' ? undefined : body;
}

/**
 * The `tool_use` blocks of one line, as notes waiting for their results.
 *
 * A note belongs to the last message before it in the file, and `ordinal`
 * counts the calls after that message from 0. That is a choice this story made:
 * an assistant line carrying only a `tool_use` is not a message, and the parser
 * contract requires a note to point at a message the batch carries — so the
 * alternatives were an empty message to hang the calls on, or a weaker
 * contract. A call before the first message of the read has nothing to attach
 * to and is dropped; after a cursor read that is only ever a call whose note is
 * already stored.
 *
 * `isSidechain` lines are skipped: those are a subagent's own calls, and this
 * parser reads delegated runs only through their final report.
 */
function readToolUses(
  entry: Record<string, unknown>,
  lastMessageId: string | null,
  messagesBefore: number,
  ordinals: Map<string, number>,
  pending: PendingNote[],
): void {
  if (entry['type'] !== 'assistant' || entry['isSidechain'] === true) return;
  const message = asRecord(entry['message']);
  if (message === undefined) return;
  const blocks = message['content'];
  if (!Array.isArray(blocks)) return;

  for (const block of blocks) {
    const record = asRecord(block);
    if (record === undefined || record['type'] !== 'tool_use') continue;
    const tool = asString(record['name']);
    const toolUseId = asString(record['id']);
    if (tool === undefined || toolUseId === undefined) continue;
    if (lastMessageId === null) continue;

    const ordinal = ordinals.get(lastMessageId) ?? 0;
    ordinals.set(lastMessageId, ordinal + 1);
    pending.push({
      harnessMessageId: lastMessageId,
      ordinal,
      tool,
      // One value of the input and nothing else: never the output, never the
      // content a write carried.
      target: toolTarget(tool, record['input']),
      toolUseId,
      messagesBefore,
    });
  }
}

/** Whether each `tool_use_id` this line answers came back without an error. */
function readOutcomes(
  entry: Record<string, unknown>,
  outcomes: Map<string, boolean>,
): void {
  if (entry['isSidechain'] === true) return;
  const message = asRecord(entry['message']);
  if (message === undefined) return;
  const blocks = message['content'];
  if (!Array.isArray(blocks)) return;

  for (const block of blocks) {
    const record = asRecord(block);
    if (record === undefined || record['type'] !== 'tool_result') continue;
    const toolUseId = asString(record['tool_use_id']);
    if (toolUseId === undefined) continue;
    // The first answer wins, the way the first copy of a repeated line does.
    if (!outcomes.has(toolUseId)) outcomes.set(toolUseId, record['is_error'] !== true);
  }
}

/**
 * The notes, once the whole read is in: a call is `ok` unless its result said
 * `is_error`.
 *
 * A call whose result has not arrived is the interesting case. If the
 * conversation went on afterwards, the result is never coming — the turn moved
 * past it — so the note is written with `ok: false`. If the call is the last
 * thing in the file, the harness is simply still working: no note is written,
 * the cursor does not pass it, and the next read sees the call again with its
 * answer. A note, once stored, cannot be corrected (AD-11).
 */
function resolveNotes(
  pending: readonly PendingNote[],
  outcomes: ReadonlyMap<string, boolean>,
  messages: number,
): ParsedToolNote[] {
  const notes: ParsedToolNote[] = [];
  for (const note of pending) {
    const outcome = outcomes.get(note.toolUseId);
    if (outcome === undefined && messages <= note.messagesBefore) continue;
    notes.push({
      harnessMessageId: note.harnessMessageId,
      ordinal: note.ordinal,
      tool: note.tool,
      target: note.target,
      ok: outcome ?? false,
    });
  }
  return notes;
}

/**
 * Why the harness started this session, from the last `SessionStart` hook
 * attachment in the content, or `null` when it carries none.
 *
 * The transcript says so because a hook ran: Claude Code renders the output of
 * every hook as an attachment, and a `SessionStart` one names its source in
 * `hookName` — `SessionStart:resume`, `SessionStart:compact`. Brain's own
 * plugin registers a `SessionStart` hook, so a session this brain collects
 * carries one; a transcript from before that, or from a session nobody hooked,
 * says nothing and gets `null` rather than a guess.
 *
 * The *last* one, because a compact writes a new attachment onto the same
 * transcript and the newest is why the session is running now.
 *
 * It searches the content and then parses only the lines that matched, so it
 * costs one scan rather than a parse of every line: `hookName` cannot be
 * mistaken for text in a body, because a `"` inside a JSON string is written
 * `\"`. Judged by `hookName` alone — the attachment carries `hookEvent` too,
 * but not in every version that wrote a transcript this may read.
 */
function readStartSource(content: string): SessionStartSource | null {
  const pattern = /"hookName"\s*:\s*"SessionStart:(startup|resume|clear|compact|fork)"/g;
  let found: SessionStartSource | null = null;

  for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
    const lineStart = content.lastIndexOf('\n', match.index) + 1;
    const newline = content.indexOf('\n', match.index);
    const entry = readJson(content.slice(lineStart, newline < 0 ? content.length : newline));
    if (entry === undefined) continue;
    const attachment = asRecord(entry['attachment']);
    if (attachment === undefined) continue;
    const source = startSourceOf(asString(attachment['hookName']) ?? '');
    if (source !== null) found = source;
  }

  return found;
}

/** `SessionStart:<source>` as the source, or `null` for anything else. */
function startSourceOf(hookName: string): SessionStartSource | null {
  const [event, source] = hookName.split(':');
  if (event !== 'SessionStart') return null;
  return source === 'startup' ||
    source === 'resume' ||
    source === 'clear' ||
    source === 'compact' ||
    source === 'fork'
    ? source
    : null;
}

/**
 * The text of a message. Claude Code writes a user turn as a bare string and an
 * assistant turn as a list of blocks, of which only `text` holds anything
 * anybody said — so an `image` block's base64 and a `tool_result`'s output
 * cannot reach a body by construction, rather than by being stripped out.
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

/** Whether this user line is a tool's output rather than something said. */
function isToolOutput(body: string): boolean {
  return TOOL_OUTPUT_MARKERS.some((marker) => body.startsWith(marker));
}

/**
 * Whether this user line came from somewhere other than the person: the editor
 * reporting on a delegated run, or another agent. A `task-notification` that is
 * a finished run's report never reaches here — `readReport` has taken it.
 */
function isForeignOrigin(value: unknown): boolean {
  const origin = asRecord(value);
  if (origin === undefined) return false;
  const kind = origin['kind'];
  return kind === 'task-notification' || kind === 'peer';
}

/**
 * Whether the content in front of a notification started the agent it names.
 *
 * A plain search, which is the point: the same search over the same prefix
 * gives the same answer whether the parse started at the front of the file or
 * at a cursor in the middle of it (Design Notes).
 */
function carriesAgentId(before: string, agentId: string): boolean {
  return new RegExp(`"agentId"\\s*:\\s*"${escapeForRegExp(agentId)}"`).test(before);
}

/**
 * What one pair of tags holds, from the first opening tag to the first or the
 * last closing one. Which of the two is the caller's: a value that may contain
 * the closing tag has to run to the last, and one that may not must stop at the
 * first or a later tag could swallow it.
 */
function between(
  text: string,
  open: string,
  close: string,
  closes: 'first' | 'last',
): string | undefined {
  const from = text.indexOf(open);
  if (from < 0) return undefined;
  const to =
    closes === 'first' ? text.indexOf(close, from + open.length) : text.lastIndexOf(close);
  if (to < from + open.length) return undefined;
  return text.slice(from + open.length, to);
}

/** How many lines of the content come before this offset. */
function countLines(content: string, offset: number): number {
  let lines = 0;
  let index = content.indexOf('\n');
  while (index >= 0 && index < offset) {
    lines += 1;
    index = content.indexOf('\n', index + 1);
  }
  return lines;
}

/** One literal, safe to put in a pattern. Ids are hex and dashes, but still. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/**
 * One tracking value, exactly as the line carried it, or `null` when the line
 * carried none. An empty string is kept as an empty string: a detached HEAD has
 * no branch name, and that is a fact about the line and not a missing value.
 */
function asTracking(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRole(value: unknown): MessageRole | undefined {
  return value === 'user' || value === 'assistant' ? value : undefined;
}
