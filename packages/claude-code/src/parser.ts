import { createHash, type Hash } from 'node:crypto';
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
 * `3` is this story: the report a subagent hands back with `SubagentHandback`,
 * which arrives on a peer user line and which `2` threw away, is read as a
 * report — and the one sentence the editor leaves in its place where the
 * `Agent` call's own result used to be is no longer stored as one. `2` added
 * tool notes, the final reports of delegated runs, the branch and cwd of every
 * line, the session's start source, and the incremental read. `1` produced
 * message bodies and nothing else.
 *
 * A session already stored under an older version is read again from the front
 * the next time it is ingested — `sessions.ingest` hands over no cursor when
 * the versions differ — so the reports `2` missed are added behind what it
 * stored, and nothing it stored is touched (AD-4, AD-11).
 */
export const CLAUDE_CODE_PARSER_VERSION = '3';

/** The four markers a tool's own output starts a user line with (Boundaries). */
const TOOL_OUTPUT_MARKERS = [
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<bash-stdout>',
  '<bash-stderr>',
] as const;

/**
 * The whole of what the editor leaves where a hand-back run's result would be.
 *
 * When a subagent ends by calling `SubagentHandback`, its report is delivered
 * on a peer line of its own (`readHandback`) and the `Agent` call's own result
 * — or the `<result>` of its task notification — says only that, naming the
 * sender. Reading it as the report would store a sentence nobody said *and*
 * leave two reports for the one run, now that the real one is read. The id
 * inside the quotes is the only free part: the match is on the whole trimmed
 * body, so a result that carries this sentence **and** something else is still
 * a report (Boundaries).
 */
const HANDBACK_NOTICE =
  /^This agent's report was delivered to you as a message from "[^"]*" \(its SubagentHandback call\)\. Read it there; it is not repeated here\.$/;

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

/**
 * Where a parse starts, whether the cursor it was given was any use, and the
 * two things the content in front of that point has already been read for.
 *
 * Both of those exist so that the prefix of a transcript is walked once per
 * parse rather than once per question asked of it. A 30 MB transcript is real
 * (follow-up review #20), and the incremental read exists precisely so that a
 * hook on a long session costs what the tail costs.
 */
interface ParseStart {
  /** Offset of the first line to read. */
  offset: number;
  reset: boolean;
  /**
   * SHA-256 of the content up to `hashedTo`, still open. The cursor this parse
   * produces continues from this state instead of hashing the same bytes again
   * (`cursorFor`), so the prefix a fingerprint covers goes through SHA-256 once.
   */
  prefix: Hash;
  /** How much of the content `prefix` has taken in. */
  hashedTo: number;
  /** Which agents the content in front of `offset` started (`agentIds`). */
  agents: AgentIds;
}

/**
 * Which agents the content in front of a line started, as the
 * task-notification rule asks it (`readReport`).
 *
 * The question is whether `"agentId":"<id>"` appears anywhere before the line,
 * and the answer has to be the same whether the parse began at the front of the
 * file or at a cursor in the middle of it (Design Notes). So the prefix in
 * front of the read is scanned once — lazily, because most reads never ask —
 * and the lines of the read itself join it as they go past.
 */
interface AgentIds {
  /** Whether anything before the line being judged carried this id. */
  has(agentId: string): boolean;
  /** Take in one line, once the line after it is the one being judged. */
  note(line: string): void;
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
 *   * it is not `isSidechain` — a subagent's own conversation, whatever else
 *     the line carries;
 *   * it is not `isMeta` (the editor talking to the model on the user's behalf)
 *     or `isCompactSummary` (a summary of a conversation, not a turn of one),
 *     unless it is a peer's hand-back report: that line is `isMeta` precisely
 *     because nobody typed it, and it is read as a report (below);
 *   * it is not an assistant line marked `isApiErrorMessage` — the editor
 *     rendering a failure, not the model answering;
 *   * it is not a user line whose `origin.kind` is `task-notification` (the
 *     editor telling the model a delegated run moved on) or `peer` (another
 *     agent's traffic) — both have a report exception, below;
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
 * It numbers nothing and sorts nothing. The array comes out in the order of the
 * file and never in the order of a clock: Claude Code writes in order, and
 * sorting by a timestamp would reorder two lines of the same millisecond
 * differently on different runs — and a transcript really does carry lines
 * whose stamps go backwards. What a stored message is read back in order *by*
 * is its own `occurredAt`, and that is the store's business, not this one's
 * (AD-8, migration 0006).
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
      /** The line before the one being read, for `AgentIds.note`. */
      let behind = '';
      for (const [index, line] of lines.entries()) {
        const lineStart = offset;
        // `+ 1` for the newline that separated it. On the final piece of a file
        // with no trailing newline there is none, and nothing reads this.
        offset += line.length + 1;
        // Before anything may skip this line: the line before it is now in
        // front of the one being judged, whatever happens to this one, and the
        // task-notification rule asks what the content in front of a line said.
        start.agents.note(behind);
        behind = line;
        if (line.trim() === '') continue;

        const entry = readJson(line);
        if (entry === undefined) {
          // The tail of a file the harness is still appending to: the only
          // line that is allowed to be half written, and skipped rather than
          // refused (research §1).
          if (index === lastIndex) continue;
          // Counted only here, where a sentence needs it: every read would
          // otherwise walk the prefix for a number nobody asks for (#20).
          const number = countLines(content, start.offset) + index + 1;
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

        const message = readMessage(entry, start.agents);
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
        cursor: cursorFor(messages, content, fingerprintEnd, start),
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
  const fromTheFront = (reset: boolean): ParseStart => ({
    offset: 0,
    reset,
    prefix: createHash('sha256'),
    hashedTo: 0,
    agents: agentIds(content, 0),
  });
  if (cursor === null) return fromTheFront(false);

  // Backwards, because the cursor names a message near the end of the file it
  // came out of: `lastIndexOf` reaches it after a few hundred bytes, where a
  // forward scan reads the whole transcript to get there (#20). The key is
  // searched for rather than the id alone, so `parentUuid` and `leafUuid` — a
  // capital U, and the quote in front rules out both — do not have to be parsed
  // to be rejected; `at > 0` is the end of the walk, because a JSON line opens
  // with `{` and `"uuid"` can never sit at offset 0.
  for (
    let at = content.lastIndexOf(UUID_KEY);
    at > 0;
    at = content.lastIndexOf(UUID_KEY, at - 1)
  ) {
    if (!holdsValue(content, at + UUID_KEY.length, cursor.lastHarnessMessageId)) continue;
    const lineStart = content.lastIndexOf('\n', at) + 1;
    const newline = content.indexOf('\n', at);
    const lineEnd = newline < 0 ? content.length : newline;

    // The line is still parsed and the id checked again before any of it is
    // believed, because a search is a search.
    const entry = readJson(content.slice(lineStart, lineEnd));
    if (entry === undefined) continue;
    if (asString(entry['uuid']) !== cursor.lastHarnessMessageId) continue;
    const agents = agentIds(content, lineStart);
    if (readMessage(entry, agents) === undefined) continue;

    // The prefix the fingerprint covers, hashed once and kept open: the cursor
    // this parse ends with carries on from here (`cursorFor`). In practice this
    // runs for one candidate — a fingerprint pins the whole prefix, so no two
    // lines of one file can match the same one.
    const prefix = createHash('sha256').update(content.slice(0, lineEnd), 'utf8');
    if (prefix.copy().digest('hex') !== cursor.fingerprint) continue;

    return { offset: lineStart, reset: false, prefix, hashedTo: lineEnd, agents };
  }

  // Gone, or the content in front of it is not what it was: a compact, a fork,
  // a transcript rewritten underneath us. Reading it all again inserts nothing
  // that is already stored, so this is a warning and not a failure (AD-4).
  return fromTheFront(true);
}

/** The key a cursor's message is found by, as the harness writes it. */
const UUID_KEY = '"uuid"';

/**
 * Whether the JSON text at `from` is `: "<value>"` — the one value this key may
 * have for the line to be the cursor's.
 *
 * Spelled out rather than left to a pattern per candidate: it reads the few
 * characters after the key and nothing else, and it takes the whitespace a
 * pretty-printed line puts around the colon.
 */
function holdsValue(content: string, from: number, value: string): boolean {
  let at = skipSpace(content, from);
  if (content[at] !== ':') return false;
  at = skipSpace(content, at + 1);
  if (content[at] !== '"') return false;
  at += 1;
  return content.startsWith(value, at) && content[at + value.length] === '"';
}

function skipSpace(content: string, from: number): number {
  let at = from;
  while (content[at] === ' ' || content[at] === '\t') at += 1;
  return at;
}

/** The `"agentId"` values of a stretch of content, as `AgentIds` collects them. */
const AGENT_ID_PATTERN = /"agentId"\s*:\s*"([^"]*)"/;

/**
 * The agents a read has seen started, up to `boundary` and then line by line.
 *
 * The prefix scan is deferred until something asks, because only a
 * task-notification line does and most reads carry none. It is also run over
 * the content itself with the boundary as a stop, never over a copy of the
 * prefix: slicing 30 MB to search it costs 30 MB (#20). The ids of the read's
 * own lines may well arrive before the prefix is scanned — the result is one
 * set either way, so the order they join in cannot change an answer.
 */
function agentIds(content: string, boundary: number): AgentIds {
  const seen = new Set<string>();
  let scanned = false;

  const collect = (text: string, stop: number): void => {
    // Nothing is in front of offset 0, which is every read from the front: the
    // scan would walk the whole file to find a match it then throws away.
    if (stop <= 0) return;
    const pattern = new RegExp(AGENT_ID_PATTERN, 'g');
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      if (match.index >= stop) return;
      const found = match[1];
      if (found !== undefined) seen.add(found);
    }
  };

  return {
    has(agentId: string): boolean {
      if (!scanned) {
        scanned = true;
        collect(content, boundary);
      }
      return seen.has(agentId);
    },
    note(line: string): void {
      // The cheap test first: almost no line carries one.
      if (!line.includes('"agentId"')) return;
      collect(line, line.length);
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
  start: ParseStart,
): ParserCursor | null {
  const last = messages.at(-1);
  if (last === undefined) return null;
  return {
    lastHarnessMessageId: last.harnessMessageId,
    // Carried on from the state the start left, so the prefix a cursor read
    // already hashed is not hashed a second time (#20). A `digest` on the
    // state itself would close it, so the copy is what is finished.
    fingerprint:
      end < start.hashedTo
        ? // Not reachable from a cursor read, whose first message is the
          // cursor's own line and so never ends before it: here because a
          // negative continuation would silently hash the wrong bytes.
          createHash('sha256').update(content.slice(0, end), 'utf8').digest('hex')
        : start.prefix
            .copy()
            .update(content.slice(start.hashedTo, end), 'utf8')
            .digest('hex'),
  };
}

/** One transcript line as a message, or `undefined` when it is not one. */
function readMessage(
  entry: Record<string, unknown>,
  agents: AgentIds,
): ParsedMessage | undefined {
  const role = asRole(entry['type']);
  if (role === undefined) return undefined;
  // A subagent's own conversation, and nothing else gets a say: a hand-back
  // written inside a sidechain is a report that run made to *its* caller, not
  // to this one (Boundaries).
  if (entry['isSidechain'] === true) return undefined;

  // The report a peer handed back, judged *before* the two flags below. The
  // editor delivers that line on the person's behalf and so marks it `isMeta`
  // — every one of them does, measured — so a filter that ran first would drop
  // the one thing a delegated run leaves behind.
  const handback = readHandback(entry);
  // Two flags that both mean "not a turn of this conversation".
  if (
    handback === undefined &&
    (entry['isMeta'] === true || entry['isCompactSummary'] === true)
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
  const report = handback ?? readReport(entry, message, agents);
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
 *
 * A run that ended with `SubagentHandback` reports through neither of those: it
 * leaves `HANDBACK_NOTICE` in both places, and `readHandback` reads the report
 * off the peer line the editor delivered it on.
 */
function readReport(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  agents: AgentIds,
): string | undefined {
  if (entry['type'] !== 'user') return undefined;

  const result = asRecord(entry['toolUseResult']);
  if (
    result !== undefined &&
    asString(result['agentId']) !== undefined &&
    result['status'] === 'completed'
  ) {
    const body = readBody(result['content']);
    if (body !== '' && !HANDBACK_NOTICE.test(body)) return body;
  }

  const origin = asRecord(entry['origin']);
  if (origin === undefined || origin['kind'] !== 'task-notification') return undefined;
  const notice = readBody(message['content']);
  if (!notice.includes('<status>completed</status>')) return undefined;

  // The id ends at the *first* closing tag: a report that itself mentions
  // `</task-id>` must not swallow the id, and an id is one token anyway.
  const taskId = between(notice, '<task-id>', '</task-id>', 'first')?.trim();
  if (taskId === undefined || taskId === '') return undefined;
  if (!agents.has(taskId)) return undefined;

  // The report ends at the last one, so a report that carries the closing tag
  // inside it still comes out whole.
  const body = between(notice, '<result>', '</result>', 'last')?.trim();
  if (body === undefined || body === '' || HANDBACK_NOTICE.test(body)) return undefined;
  return body;
}

/**
 * The report a subagent handed back, read off this line's `origin`, or
 * `undefined` when the line is not one.
 *
 * A run that ends by calling `SubagentHandback` does not answer through its
 * `Agent` call at all. The editor delivers the report as a user line from a
 * peer — `origin.kind` `peer`, `origin.handback` `true` — and because nobody
 * typed that line it is marked `isMeta`, which is why `readMessage` asks this
 * question first.
 *
 * The body is `origin.handbackReportText` and nothing else. `message.content`
 * and `origin.body` carry the editor's own framing wrapped around the report —
 * who sent it, that it is model output and carries no user authority, the
 * report indented inside it — and a body cut back out of that framing would be
 * text this parser invented, in a row that can never be corrected (AD-11).
 *
 * `handback` must be the boolean: a string `"true"` is a shape this parser has
 * not seen and will not guess at. A hand-back from before the harness wrote
 * `handbackReportText` (Claude Code up to 2.1.296) carries the report only
 * inside that framing and is dropped — a message that was stored cannot be
 * taken back, while one that was dropped arrives later when the parser version
 * moves (Decision 2026-10-19).
 */
function readHandback(entry: Record<string, unknown>): string | undefined {
  if (entry['type'] !== 'user') return undefined;
  const origin = asRecord(entry['origin']);
  if (origin === undefined) return undefined;
  if (origin['kind'] !== 'peer' || origin['handback'] !== true) return undefined;

  const text = origin['handbackReportText'];
  if (typeof text !== 'string') return undefined;
  const body = text.trim();
  return body === '' ? undefined : body;
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
 * Why the harness started this session, from the *first* `SessionStart` hook
 * attachment in the content, or `null` when it carries none.
 *
 * The transcript says so because a hook ran: Claude Code renders the output of
 * every hook as an attachment, and a `SessionStart` one names its source in
 * `hookName` — `SessionStart:resume`, `SessionStart:compact`. Brain's own
 * plugin registers a `SessionStart` hook, so a session this brain collects
 * carries one; a transcript from before that, or from a session nobody hooked,
 * says nothing and gets `null` rather than a guess.
 *
 * The first one, because a resume or a compact writes another attachment onto
 * the same transcript and this column answers why the session *began*. Measured
 * on this machine: 37 of 211 sessions carry more than one, 34 of them a
 * `startup` followed by a `resume` — so taking the last turned a third of the
 * column into "what happened to it most recently" (follow-up review #18). The
 * store keeps the same rule from the other side: it writes the value only into
 * a row that has none (`ports/store.ts`).
 *
 * It searches the content and then parses only the lines that matched, and it
 * stops at the first answer, so an ordinary transcript costs a scan of its
 * front rather than of the whole file: `hookName` cannot be mistaken for text
 * in a body, because a `"` inside a JSON string is written `\"`. Judged by
 * `hookName` alone — the attachment carries `hookEvent` too, but not in every
 * version that wrote a transcript this may read.
 */
function readStartSource(content: string): SessionStartSource | null {
  const pattern = /"hookName"\s*:\s*"SessionStart:(startup|resume|clear|compact|fork)"/g;

  for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
    const lineStart = content.lastIndexOf('\n', match.index) + 1;
    const newline = content.indexOf('\n', match.index);
    const entry = readJson(content.slice(lineStart, newline < 0 ? content.length : newline));
    if (entry === undefined) continue;
    const attachment = asRecord(entry['attachment']);
    if (attachment === undefined) continue;
    const source = startSourceOf(asString(attachment['hookName']) ?? '');
    if (source !== null) return source;
  }

  return null;
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
 * reporting on a delegated run, or another agent. A report never reaches here:
 * a `task-notification` that carries a finished run's answer has been taken by
 * `readReport`, and a peer's hand-back by `readHandback`. What is left of
 * `peer` is another agent's own traffic — and the hand-backs `readHandback`
 * would not read either, those carrying no usable `handbackReportText`, which
 * are dropped: by the `isMeta` filter when the line has it, and here when it
 * does not.
 */
function isForeignOrigin(value: unknown): boolean {
  const origin = asRecord(value);
  if (origin === undefined) return false;
  const kind = origin['kind'];
  return kind === 'task-notification' || kind === 'peer';
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
