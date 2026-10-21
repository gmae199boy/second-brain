import { createHash, type Hash } from 'node:crypto';
import type {
  MessageRole,
  ParseResult,
  ParsedMessage,
  ParsedToolNote,
  Parser,
  ParserCursor,
  SessionStartSource,
  ToolNotePosition,
} from '@second-brain/core';
import { toolTarget } from './tool-target.js';

/** The neutral harness name, and the first half of every session token (AD-8). */
export const CLAUDE_CODE_HARNESS = 'claude-code';

/**
 * The parser version, recorded on every session it writes (AD-4). It moves when
 * what this parser *produces* changes, so a reader can tell which rows came out
 * of which rules.
 *
 * `4` stores no subagent report at all, and that is the largest of its changes.
 * A report is long, agent-written text that nobody said; the main agent relays
 * its conclusion in a turn of its own, and that turn *is* stored — so keeping
 * the report as well put words into a conversation that never carried them
 * (epic 2 Decision, 2026-10-21). Everything the editor leaves in a report's
 * place — the two notices, the framing of an old hand-back — goes with it, and
 * `isSubagentReport` is now always false. The `Agent` call's own tool note
 * stays: that a run was delegated is a fact about the turn.
 *
 * `4` also changes seven smaller things, each of which the version has to move
 * for because each changes a row:
 *
 *   * a tool note carries the harness's own id for the call, and the positions
 *     an older version may have stored the same call under, so a version bump
 *     cannot leave one call as two notes (#9);
 *   * a call made before the first message of the content is kept, hung on that
 *     message with a negative ordinal, where `3` dropped it (#8);
 *   * only a `tool_result` on a line of the conversation decides whether a call
 *     worked — `api-request-blob` lines carry them too — and an `Agent` or
 *     `Task` call with no result yet is left for the next read rather than
 *     written as a failure (#7);
 *   * a broken line that is not the last one is skipped and counted instead of
 *     refusing the whole file (#11);
 *   * a `timestamp` is believed only in the one shape the harness writes it in
 *     (#12);
 *   * a tool note's target is found under more keys, by own key only, and cut
 *     on a code point (#13, #14);
 *   * every line the read walked past is counted by reason, as
 *     `droppedLines` (#15).
 *
 * And a user line whose body starts with one of orca's three fixed prompt
 * headings is not a message: the coordinator wrote those words, not the person
 * (story 23).
 *
 * `3` read a subagent's hand-back report as a message, which `4` undoes. `2`
 * added tool notes, the final reports of delegated runs, the branch and cwd of
 * every line, the session's start source, and the incremental read. `1`
 * produced message bodies and nothing else.
 *
 * A session already stored under an older version is read again from the front
 * the next time it is ingested — `sessions.ingest` hands over no cursor when
 * the versions differ — so nothing an older version stored is touched and the
 * rows it never wrote arrive behind them (AD-4, AD-11).
 */
export const CLAUDE_CODE_PARSER_VERSION = '4';

/** The six markers a tool's own output starts a user line with (Boundaries). */
const TOOL_OUTPUT_MARKERS = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<user-prompt-submit-hook>',
] as const;

/**
 * The two headings orca puts at the front of a prompt it sends a worker, and
 * the one it puts in front of a batch of coordinator messages.
 *
 * A user line that starts with one of these is the coordinator talking, not the
 * person: orca writes the prompt into the worker's session as if it had been
 * typed there, so the line carries no `origin` and the `human` rule cannot tell
 * it apart. It is matched at the *front* of the trimmed body alone — the same
 * words in the middle of a sentence are somebody writing about orca, which is a
 * message like any other (story 23, 30 such lines measured).
 *
 * Dropping them costs nothing that cannot come back: a line dropped arrives the
 * next time the parser version moves, where a line stored cannot be taken back
 * (AD-11).
 */
const ORCA_PROMPT_HEADINGS = [
  'You are working inside Orca',
  'Please carry out this task from my Orca coordinator',
] as const;

/** The third heading, whose count is the only part that varies. */
const ORCA_MESSAGE_BATCH = /^You have \d+ orchestration message/;

/**
 * The one shape a `timestamp` is believed in: the ISO instant with exactly
 * three decimal places and a `Z`, which is what `Date.prototype.toISOString`
 * writes and what every line of a Claude Code transcript carries.
 *
 * `new Date(s)` on its own is far too willing. It takes `2026-10-20T11:00:05Z`
 * (no milliseconds), a space instead of the `T`, a local time with no zone at
 * all, and an expanded year — and each of those would be stored as an instant
 * the harness never wrote, in a column that orders the whole conversation and
 * can never be corrected (#12, AD-8). So the string is matched, parsed, and
 * then written back out and compared: the round trip is what rules out a date
 * the pattern allows and the calendar does not, such as a 30th of February.
 *
 * Measured on this machine (2026-10-21): 113,026 timestamps on 256 main
 * transcripts, 0 that disagree with this rule.
 */
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Why a line of the read was not kept, as the code `droppedLines` counts it
 * under (`ports/parser.ts`).
 *
 * They are tried in the order they are listed, and a line is counted under the
 * first one that catches it, so the counts add up: the messages kept plus every
 * one of these equals the non-empty, complete lines of the part that was read.
 *
 *   * `unreadable` — not JSON. Core reads this one and warns about it;
 *   * `duplicate` — a uuid a line already in this read carried;
 *   * `not_conversation` — a `type` that is neither `user` nor `assistant`:
 *     editor state, file-history snapshots, hook output, attachments. A line
 *     that is valid JSON and not an object at all is counted here too: it was
 *     read, so it is not `unreadable`, and it is not a turn of anything;
 *   * `sidechain` — a subagent's own conversation;
 *   * `meta` — `isMeta`, the editor talking to the model on the person's
 *     behalf, or `isCompactSummary`, a summary of a conversation;
 *   * `incomplete` — no uuid, no timestamp, or no `message` object;
 *   * `timestamp` — a timestamp in a shape this parser will not believe;
 *   * `api_error` — an assistant line that is the editor rendering a failure;
 *   * `not_human` — a user line carrying an `origin` that does not say a person
 *     typed it: a peer's traffic, a task notification, a kind nobody has looked
 *     at yet;
 *   * `empty` — nothing left once the text is pulled out: a thinking block, a
 *     tool call, a tool result, a pasted image;
 *   * `tool_output` — a user line that is a tool's own stdout or stderr;
 *   * `orca_header` — a user line that starts with one of orca's fixed prompt
 *     headings.
 */
type DropReason =
  | 'unreadable'
  | 'duplicate'
  | 'not_conversation'
  | 'sidechain'
  | 'meta'
  | 'incomplete'
  | 'timestamp'
  | 'api_error'
  | 'not_human'
  | 'empty'
  | 'tool_output'
  | 'orca_header';

/** Every reason at zero, so the keys of the record never depend on the file. */
function noDrops(): Record<DropReason, number> {
  return {
    unreadable: 0,
    duplicate: 0,
    not_conversation: 0,
    sidechain: 0,
    meta: 0,
    incomplete: 0,
    timestamp: 0,
    api_error: 0,
    not_human: 0,
    empty: 0,
    tool_output: 0,
    orca_header: 0,
  };
}

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
  /** Where version 3 may have put this same call (`earlierPositions`). */
  earlierPositions: readonly ToolNotePosition[];
}

/**
 * A call read before the first message of this read, which has nothing to hang
 * on yet. It takes a negative ordinal on that message once it arrives.
 */
type EarlyCall = Omit<PendingNote, 'harnessMessageId' | 'ordinal'>;

/**
 * A line this version drops that version 3 may have kept as a message, with
 * the number of calls the read had made when it was reached.
 *
 * It is the whole of what `earlierPositions` is worked out from: version 3's
 * position for a call is `(the last line *it* kept, the calls since)`, and the
 * calls since are a subtraction of two running totals.
 */
interface EarlierAnchor {
  harnessMessageId: string;
  /** Calls read before this line's own, so `calls - this` is the ordinal. */
  calls: number;
}

/**
 * Where a parse starts, whether the cursor it was given was any use, and how
 * much of the content in front of that point has already been hashed.
 *
 * The prefix exists so that it is walked once per parse rather than once per
 * question asked of it. A 30 MB transcript is real (follow-up review #20), and
 * the incremental read exists precisely so that a hook on a long session costs
 * what the tail costs.
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
 * notification that a background task finished, the report a delegated run
 * handed back.
 *
 * So this parser is a filter before it is anything else. It keeps a line as a
 * message when all of these hold:
 *
 *   * `type` is `user` or `assistant`;
 *   * it is not `isSidechain` — a subagent's own conversation;
 *   * it is not `isMeta` (the editor talking to the model on the user's behalf)
 *     or `isCompactSummary` (a summary of a conversation, not a turn of one);
 *   * it carries a uuid, a `timestamp` and a `message`, and the timestamp is in
 *     the one shape the harness writes (`INSTANT_PATTERN`);
 *   * it is not an assistant line marked `isApiErrorMessage` — the editor
 *     rendering a failure, not the model answering;
 *   * a user line carries an `origin` only when nobody typed it, so one is kept
 *     only when it has none at all or its `kind` is `human`. Everything else —
 *     `task-notification`, `peer`, a kind this parser has never seen — is the
 *     editor's own traffic and is dropped. It is an allow list on purpose: a
 *     new kind the harness invents is something nobody said until somebody has
 *     looked at it (follow-up review #5);
 *   * the body is not empty once the text is pulled out of it, which is what
 *     drops the thinking, the tool calls, the tool results and the pasted
 *     images: only `text` blocks are read, so no base64 can reach a body;
 *   * it is not a user line whose body starts with a tool-output marker — the
 *     stdout or stderr of a `!` command, a background shell, or a hook the
 *     editor ran on the way in, all of which arrive as a user turn;
 *   * and it is not a user line whose body starts with one of orca's fixed
 *     prompt headings (`ORCA_PROMPT_HEADINGS`), which the coordinator wrote.
 *
 * A subagent's final report is not among them, and that is a decision and not
 * an omission: it is long, model-written text that nobody said, and the main
 * agent's own turn — which is stored — carries the conclusion a person would
 * recall (epic 2 Decision, 2026-10-21). Nothing about a delegated run is read
 * from `subagents/`, and the only trace of one that is stored is the `Agent`
 * call's tool note.
 *
 * Everything it does not keep it keeps *silently*, because none of it is a
 * failure: a transcript is mostly not conversation, and a parser that warned
 * about that would warn on every turn. It is not kept in secret either — every
 * such line is counted under the reason that caught it, and the result carries
 * those counts (`droppedLines`). Where the rule is a judgement call, the line
 * is dropped: a message that was stored cannot be taken back, while one that
 * was dropped arrives later when the parser version moves and the session is
 * read again.
 *
 * A line that is not JSON at all is skipped rather than refused, unless the
 * whole read found nothing readable: a transcript is appended to while it is
 * being read, and one broken line left by a crash must not cost a session every
 * message behind it (#11).
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
      /** Why each line that was not kept was not kept (`DropReason`). */
      const dropped = noDrops();
      /** Whether any line of the read was JSON at all (`TRANSCRIPT_UNREADABLE`). */
      let anyJson = false;
      /** The uuid of every line already read, so a repeated one is skipped. */
      const seen = new Set<string>();
      /** `tool_use` blocks in file order, resolved once the file is read. */
      const pending: PendingNote[] = [];
      /** Calls read before the first message, waiting for it to arrive. */
      const beforeFirst: EarlyCall[] = [];
      /** `tool_use_id` → whether the result it got was not an error. */
      const outcomes = new Map<string, boolean>();
      /** Harness message id → how many calls have been attached to it. */
      const ordinals = new Map<string, number>();
      /** How many calls have taken a number, which is all `calls` counts. */
      let calls = 0;
      /** Lines since the last message that version 3 may have kept. */
      let anchors: EarlierAnchor[] = [];
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

        const held = readEntry(line);
        if (held.entry === null) {
          if (held.json) {
            // Read, and not an object: `null`, a list, a number. A shape the
            // harness has never written, but the line *was* readable — so it is
            // simply not conversation, and must neither warn about unreadable
            // content nor let a file of such lines be refused.
            anyJson = true;
            dropped.not_conversation += 1;
            continue;
          }
          // The tail of a file the harness is still appending to: the only
          // line that is allowed to be half written, and not counted either —
          // it is not a line yet (research §1).
          if (index === lastIndex) continue;
          // Anything else is a line a crash or a truncated write left behind.
          // It is skipped and counted, not refused: every message behind it is
          // conversation this session would otherwise lose for good (#11).
          dropped.unreadable += 1;
          continue;
        }
        const entry = held.entry;
        anyJson = true;

        // The first copy of a line wins, and the rest of it is not read at all.
        // A uuid that repeats is the same line written twice — not a second
        // message, and not a second call either: a line with a `tool_use` in it
        // would otherwise leave two notes for the one call, under two ordinals,
        // and a note cannot be taken back (AD-11). Lines with no uuid are
        // editor state and never repeat each other.
        const uuid = asString(entry['uuid']);
        if (uuid !== undefined) {
          if (seen.has(uuid)) {
            dropped.duplicate += 1;
            continue;
          }
          seen.add(uuid);
        }

        // Before the message, because one line can be both: the result of a
        // call and a turn of the conversation.
        readOutcomes(entry, outcomes);

        const read = readMessage(entry);
        if (typeof read === 'string') {
          dropped[read] += 1;
          // A line version 3 may have kept where this version does not, which
          // is where it may have put the notes of the calls that follow.
          if (uuid !== undefined && keptByVersion3(entry, read)) {
            anchors.push({ harnessMessageId: uuid, calls });
          }
        } else {
          messages.push(read);
          lastMessageId = read.harnessMessageId;
          fingerprintEnd = lineStart + line.length;
          // The calls that were waiting for a message to hang on: this one, at
          // the negative ordinals that mean "in front of this line" — in file
          // order, so the last of them is -1 and the position of every call
          // *after* a message is the 0-based one version 3 used (Design Notes).
          for (const [at, early] of beforeFirst.entries()) {
            pending.push({
              ...early,
              harnessMessageId: read.harnessMessageId,
              ordinal: at - beforeFirst.length,
            });
          }
          beforeFirst.length = 0;
          // A new message is a new place for the calls behind it to hang, so
          // nothing in front of it can be where version 3 put one of them.
          anchors = [];
        }

        calls = readToolUses(entry, {
          lastMessageId,
          messagesBefore: messages.length,
          calls,
          anchors,
          ordinals,
          pending,
          beforeFirst,
        });
      }

      // Not one readable line, and at least one that should have been: there is
      // nothing here this parser can call a Claude Code transcript. An empty
      // file is not that — it is a session whose first line is still to come.
      if (!anyJson && dropped.unreadable > 0) {
        return {
          ok: false,
          code: 'TRANSCRIPT_UNREADABLE',
          message:
            '이 트랜스크립트에는 JSON으로 읽히는 줄이 하나도 없어 Claude Code의 것으로 읽을 수 없습니다',
        };
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
        droppedLines: dropped,
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
    if (typeof readMessage(entry) === 'string') continue;

    // The prefix the fingerprint covers, hashed once and kept open: the cursor
    // this parse ends with carries on from here (`cursorFor`). In practice this
    // runs for one candidate — a fingerprint pins the whole prefix, so no two
    // lines of one file can match the same one.
    const prefix = createHash('sha256').update(content.slice(0, lineEnd), 'utf8');
    if (prefix.copy().digest('hex') !== cursor.fingerprint) continue;

    return { offset: lineStart, reset: false, prefix, hashedTo: lineEnd };
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

/**
 * One transcript line as a message, or the reason it is not one.
 *
 * The reason is returned rather than reported, because two callers need it for
 * two different things: the parse loop counts it (`droppedLines`), and
 * `keptByVersion3` asks which of the reasons are the ones version 3 did not
 * have. The order of the tests is the order of the reasons, and that order is
 * what makes a count add up — a line is only ever counted once.
 *
 * It looks at this line and at nothing else. Nothing here asks a question about
 * the content in front of the line or behind it, which is what makes an
 * incremental read beginning in the middle of a file answer exactly as a read
 * from the front does (port contract).
 */
function readMessage(entry: Record<string, unknown>): ParsedMessage | DropReason {
  const role = asRole(entry['type']);
  if (role === undefined) return 'not_conversation';
  // A subagent's own conversation, whatever else the line carries.
  if (entry['isSidechain'] === true) return 'sidechain';
  // Two flags that both mean "not a turn of this conversation".
  if (entry['isMeta'] === true || entry['isCompactSummary'] === true) return 'meta';

  const harnessMessageId = asString(entry['uuid']);
  const timestamp = asString(entry['timestamp']);
  const message = asRecord(entry['message']);
  if (harnessMessageId === undefined || timestamp === undefined || message === undefined) {
    return 'incomplete';
  }
  const occurredAt = readInstant(timestamp);
  if (occurredAt === undefined) return 'timestamp';

  // The editor rendering a failure, not the model answering.
  if (role === 'assistant' && entry['isApiErrorMessage'] === true) return 'api_error';
  // Everything on a user line that a person did not type.
  if (role === 'user' && !isHumanOrigin(entry['origin'])) return 'not_human';

  const body = readBody(message['content']);
  // Empty once the text is out of it: a thinking block, a tool call, a tool
  // result, a pasted image.
  if (body === '') return 'empty';
  if (role === 'user') {
    // A tool's own output, handed to the model as a user turn.
    if (isToolOutput(body)) return 'tool_output';
    // orca's own prompt, written into the session as if it had been typed.
    if (isOrcaHeader(body)) return 'orca_header';
  }

  return {
    harnessMessageId,
    role,
    // Only the assistant has one, and it is recorded rather than acted on
    // (AD-4). The user side has no model and says so with null.
    model: role === 'assistant' ? (asString(message['model']) ?? null) : null,
    body,
    occurredAt,
    // Tracking, taken exactly as the line carried it (migration 0004). The cwd
    // is reported and not stored: story 2.8 tags the session with the cwd of
    // the first message that carries one.
    gitBranch: asTracking(entry['gitBranch']),
    cwd: asTracking(entry['cwd']),
    // Always false since story 23: a subagent's report is not stored at all, so
    // no line this parser keeps is one. The field stays because the column does
    // — rows version 2 and 3 wrote still say `1` and are immutable (AD-4).
    isSubagentReport: false,
  };
}

/**
 * Whether version 3 may have kept this line — which this version drops — as a
 * message, and so may have hung the notes of the calls behind it on this uuid
 * (`ParsedToolNote.earlierPositions`).
 *
 * Version 3's set of messages contains version 4's: 4 drops lines 3 kept and
 * makes a message of none that 3 refused. There are five ways a line can be in
 * the difference, and they are exactly these:
 *
 *   * this version dropped it for `timestamp` or `orca_header`, neither of
 *     which version 3 had as a rule at all;
 *   * its `origin.kind` is `peer` — a hand-back, which 3 read as a report — or
 *     `task-notification`, which 3 read as a report when the run had finished;
 *   * its `toolUseResult` carries an `agentId`: the synchronous result of an
 *     `Agent` call, which 3 read as a report.
 *
 * It is deliberately a superset of what version 3 actually kept. Asking the
 * question exactly would mean keeping the whole of the old rules — the two
 * notice sentences, the hand-back framing, which agents this session started —
 * alive inside the new parser, and the cost of being too generous is nothing: a
 * position version 3 never wrote a row at simply does not match anything in the
 * store (`domain/ingest-batch.ts`, Design Notes).
 */
function keptByVersion3(entry: Record<string, unknown>, reason: DropReason): boolean {
  // Two rules version 3 did not have at all, so a line only this version
  // dropped for one of them was a message to it.
  if (reason === 'timestamp' || reason === 'orca_header') return true;
  if (entry['isSidechain'] === true) return false;
  if (asRole(entry['type']) === undefined) return false;

  const origin = asRecord(entry['origin']);
  if (origin?.['kind'] === 'peer' || origin?.['kind'] === 'task-notification') return true;
  const result = asRecord(entry['toolUseResult']);
  return result !== undefined && asString(result['agentId']) !== undefined;
}

/** What `readToolUses` reads and writes as it walks one line's calls. */
interface NoteContext {
  /** The message a call attaches to, or `null` before the first one. */
  lastMessageId: string | null;
  /** How many messages the read has produced, for `resolveNotes`. */
  messagesBefore: number;
  /** How many calls have taken a number before this line's. */
  calls: number;
  /** The lines since the last message that version 3 may have kept. */
  anchors: readonly EarlierAnchor[];
  ordinals: Map<string, number>;
  pending: PendingNote[];
  beforeFirst: EarlyCall[];
}

/**
 * The `tool_use` blocks of one line, as notes waiting for their results, and
 * how many calls the read has made once they are in.
 *
 * A note belongs to the last message before it in the file, and `ordinal`
 * counts the calls after that message from 0. An assistant line carrying only a
 * `tool_use` is not a message, and the parser contract requires a note to point
 * at a message the batch carries — so the alternatives were an empty message to
 * hang the calls on, or a weaker contract.
 *
 * A call made before the first message of the read has no such message behind
 * it, and is held until one arrives: it then hangs on *that* message at a
 * negative ordinal, which is what keeps every call after a message at the
 * 0-based position version 3 gave it (#8, Design Notes). Version 3 dropped
 * those calls; a read that never reaches a message drops them still, and they
 * come back with the next version bump.
 *
 * `isSidechain` lines are skipped: those are a subagent's own calls, and the
 * only thing this parser keeps about a delegated run is the `Agent` call that
 * started it.
 */
function readToolUses(
  entry: Record<string, unknown>,
  context: NoteContext,
): number {
  let { calls } = context;
  if (entry['type'] !== 'assistant' || entry['isSidechain'] === true) return calls;
  const message = asRecord(entry['message']);
  if (message === undefined) return calls;
  const blocks = message['content'];
  if (!Array.isArray(blocks)) return calls;

  const { lastMessageId, messagesBefore, anchors, ordinals, pending, beforeFirst } =
    context;
  for (const block of blocks) {
    const record = asRecord(block);
    if (record === undefined || record['type'] !== 'tool_use') continue;
    const tool = asString(record['name']);
    const toolUseId = asString(record['id']);
    if (tool === undefined || toolUseId === undefined) continue;

    const made = calls;
    calls += 1;
    const early: EarlyCall = {
      tool,
      // One value of the input and nothing else: never the output, never the
      // content a write carried.
      target: toolTarget(tool, record['input']),
      toolUseId,
      messagesBefore,
      // The nearest candidate first, because it is the likeliest: version 3
      // kept the last line it could, and the ones further back are only
      // reached when it dropped that one too.
      earlierPositions: anchors
        .map((anchor) => ({
          harnessMessageId: anchor.harnessMessageId,
          ordinal: made - anchor.calls,
        }))
        .reverse(),
    };

    if (lastMessageId === null) {
      beforeFirst.push(early);
      continue;
    }
    const ordinal = ordinals.get(lastMessageId) ?? 0;
    ordinals.set(lastMessageId, ordinal + 1);
    pending.push({ ...early, harnessMessageId: lastMessageId, ordinal });
  }
  return calls;
}

/**
 * Whether each `tool_use_id` this line answers came back without an error.
 *
 * Only a line of the conversation answers for a call: `type: user` and not a
 * sidechain. The editor also writes `tool_result` blocks onto lines of its own
 * — 457 of them on this machine, every one on an `api-request-blob` line — and
 * those describe the request it made and not the call the model asked for. Read
 * as outcomes they would mark a call that worked as failed, in a row nobody can
 * correct (#7, AD-11).
 */
function readOutcomes(
  entry: Record<string, unknown>,
  outcomes: Map<string, boolean>,
): void {
  if (entry['type'] !== 'user' || entry['isSidechain'] === true) return;
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

/** The two tools whose result may arrive long after the turn moved on. */
const DELEGATING_TOOLS = new Set(['Agent', 'Task']);

/**
 * The notes, once the whole read is in: a call is `ok` unless its result said
 * `is_error`.
 *
 * A call whose result has not arrived is the interesting case. If the
 * conversation went on afterwards, the result is usually never coming — the
 * turn moved past it — so the note is written with `ok: false`. If the call is
 * the last thing in the file, the harness is simply still working: no note is
 * written, the cursor does not pass it, and the next read sees the call again
 * with its answer. A note, once stored, cannot be corrected (AD-11).
 *
 * Delegation is the exception. An `Agent` or a `Task` is *expected* to answer
 * after the conversation has moved on — the whole point of a background run —
 * so "a message came after it" says nothing about whether it failed, and
 * writing `ok: false` there would freeze a run that was still going as a
 * failure (#7). Such a call waits for its result however many turns that takes.
 * Measured on this machine: of 517 `Agent` and `Task` calls in the main
 * transcripts, 0 had a message between the call and its result, and the only
 * ones with no result at all are runs still going when the file happened to be
 * read — 1 at one measurement, 0 an hour later. So nothing is held back for
 * long, the cursor is not held back at all (it names the last *message*), and a
 * withheld note arrives with the next full re-read, which is the parser's
 * standing promise about anything it drops (Design Notes).
 */
function resolveNotes(
  pending: readonly PendingNote[],
  outcomes: ReadonlyMap<string, boolean>,
  messages: number,
): ParsedToolNote[] {
  const notes: ParsedToolNote[] = [];
  for (const note of pending) {
    const outcome = outcomes.get(note.toolUseId);
    if (outcome === undefined) {
      if (DELEGATING_TOOLS.has(note.tool)) continue;
      if (messages <= note.messagesBefore) continue;
    }
    notes.push({
      harnessMessageId: note.harnessMessageId,
      ordinal: note.ordinal,
      tool: note.tool,
      target: note.target,
      ok: outcome ?? false,
      // The harness's own id for the call, which is what lets a store
      // recognise it wherever an older version put it (#9).
      callId: note.toolUseId,
      earlierPositions: note.earlierPositions,
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

/** Whether this user line is a tool's own output rather than something said. */
function isToolOutput(body: string): boolean {
  return TOOL_OUTPUT_MARKERS.some((marker) => body.startsWith(marker));
}

/** Whether this user line opens with one of orca's fixed prompt headings. */
function isOrcaHeader(body: string): boolean {
  return (
    ORCA_PROMPT_HEADINGS.some((heading) => body.startsWith(heading)) ||
    ORCA_MESSAGE_BATCH.test(body)
  );
}

/**
 * Whether this user line is one a person typed: it carries no `origin` at all,
 * or an `origin` that says `human`.
 *
 * An allow list, and the direction matters. The editor writes an `origin` onto
 * a user line precisely when nobody typed it — a delegated run moving on, a
 * peer's traffic, whatever it invents next — so a list of kinds to *exclude*
 * quietly stores every kind added after it was written as something the person
 * said (follow-up review #5). Dropping a kind nobody has looked at yet costs a
 * message that comes back when the parser version moves; storing one costs a
 * row that cannot be taken back (AD-11).
 *
 * Measured on this machine: the user lines carry no `origin` (859) or `human`
 * (1425), `peer` (391) or `task-notification` (171) and nothing else, and every
 * line with a `toolUseResult` carries none.
 */
function isHumanOrigin(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const origin = asRecord(value);
  if (origin === undefined) return false;
  return origin['kind'] === 'human';
}

/**
 * One line as the parse loop reads it: the object it carried, or which of the
 * two things was wrong with it.
 *
 * The two are different answers and only one of them is a problem. A line that
 * is not JSON at all is content this parser could not read — `unreadable`,
 * which Core warns about and which, alone in a file, is a refusal. A line that
 * is valid JSON and not an object was read perfectly well; it is just not a
 * turn of anything (story 23).
 *
 * `readJson` answers `undefined` for both, which is all its two callers need:
 * a non-object line can be neither the cursor's message nor a hook attachment.
 */
function readEntry(
  line: string,
): { entry: Record<string, unknown> } | { entry: null; json: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { entry: null, json: false };
  }
  const entry = asRecord(value);
  return entry === undefined ? { entry: null, json: true } : { entry };
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
 * One instant, believed only in the shape the harness writes
 * (`INSTANT_PATTERN`), or `undefined` for anything else — including a date the
 * pattern allows and the calendar does not, which the round trip catches.
 */
function readInstant(value: string): Date | undefined {
  if (!INSTANT_PATTERN.test(value)) return undefined;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return undefined;
  return instant.toISOString() === value ? instant : undefined;
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
