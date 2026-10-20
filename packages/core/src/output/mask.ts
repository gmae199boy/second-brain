import { TOOL_NOTE_TARGET_LIMIT } from '../domain/tool-note.js';
import { maskSecrets } from '../domain/secret-patterns.js';

/**
 * The masking that happens where text leaves Brain (마스킹 B, AD-11).
 *
 * Capture stores what the harness wrote, character for character. Nothing on
 * the way in is rewritten, because a stored message is never rewritten again
 * and a pattern that took one word too many would have deleted something
 * nobody could get back. So the pattern list runs here instead, on the way
 * out, where over-masking costs one unreadable line and nothing more.
 *
 * Everything in this file is a pure function of its input, it never mutates
 * what it is given, and running it twice gives what running it once gave: the
 * markers an earlier pass left are never masked again.
 */

/** The body rule: Core's pattern list over one piece of human text. */
export function maskOutputText(text: string): string {
  return maskSecrets(text, 'body').text;
}

/**
 * The same rule over every string *value* of a structure, however deep.
 *
 * Keys are left alone, and so are numbers, booleans and `null`: a key is the
 * shape of the answer and not its content, and a pattern run over `"password"`
 * as a key would turn a readable envelope into a puzzle.
 *
 * What comes back is what `JSON.stringify` would have emitted, masked — which
 * is the only definition that holds, because every surface this feeds turns
 * the result into JSON. So a `Date`, a `URL` or anything else with a `toJSON`
 * is masked through that method's value (a `Date` becomes its masked ISO
 * string), and a class instance, a `Map` or a `Set` through its own enumerable
 * string-keyed properties — which is how `JSON.stringify` sees all three, and
 * why a `Map` comes back as `{}`. Handing a non-plain object back untouched
 * instead let a `URL` carrying `user:password@host` out whole (follow-up
 * review).
 */
export function maskOutputValue<T>(value: T): T {
  return maskUnknown(value) as T;
}

function maskUnknown(value: unknown): unknown {
  if (typeof value === 'string') return maskOutputText(value);
  if (Array.isArray(value)) return value.map((item) => maskUnknown(item));
  if (typeof value !== 'object' || value === null) return value;
  if (!isPlainObject(value)) {
    const own = value as { toJSON?: unknown };
    // Called on the object, so a method that reads `this` still works.
    if (typeof own.toJSON === 'function') {
      return maskUnknown((own as { toJSON: () => unknown }).toJSON());
    }
  }
  const masked: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) masked[key] = maskUnknown(item);
  return masked;
}

/** An object literal, as opposed to a `Date`, a `Map` or a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The marker an earlier masking left, which is never masked again. */
const MARKER = /\[REDACTED:[a-z0-9_]+\]/gu;

/** The kind the truncated-tail rule leaves behind. */
const TRUNCATED_KIND = 'truncated';

/**
 * The `tool_target` rule, plus the one thing only a tool note needs: the
 * truncated tail.
 *
 * A target reaches the store already cut to its first line's first
 * `TOOL_NOTE_TARGET_LIMIT` units, and the cut can land in the middle of a
 * secret. What is left is a prefix too short for any pattern to recognise —
 * `sk-AAAAAAA` is not an API key to a regular expression — and yet it is still
 * the opening of one. So a target that reached the limit has its last token
 * masked whatever it is: the token began after the last space, or after the
 * last marker if that is further along, and a target that ends on a space or
 * on a marker has no token left to mask (2.7 follow-up review #21).
 *
 * Masking a word that was only ever a word is the price, and it is paid in the
 * output alone — the stored target still says what the call was.
 */
export function maskToolNoteTarget(target: string): string {
  const masked = maskSecrets(target, 'tool_target').text;
  // UTF-16 units, because that is what the parser's cut counts.
  if (target.length < TOOL_NOTE_TARGET_LIMIT) return masked;
  const start = Math.max(afterLastSpace(masked), afterLastMarker(masked));
  if (start >= masked.length) return masked;
  return `${masked.slice(0, start)}[REDACTED:${TRUNCATED_KIND}]`;
}

/** One index past the last whitespace character, or 0 when there is none. */
function afterLastSpace(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (/\s/u.test(text[index] ?? '')) return index + 1;
  }
  return 0;
}

/** One index past the last `[REDACTED:…]`, or 0 when there is none. */
function afterLastMarker(text: string): number {
  const expression = new RegExp(MARKER.source, MARKER.flags);
  let end = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    end = match.index + (match[0] ?? '').length;
  }
  return end;
}

/** The shape of a tool note as far as the output masking is concerned. */
export interface MaskableToolNote {
  target: string;
}

/**
 * A copy of a tool note whose `target` has been through the target rule.
 *
 * A read that answers with tool notes runs this first, and the codec then runs
 * the body rule over every string of the answer. The target needs both: the
 * shell rule (`NAME=value`) only ever runs over a target, and the codec has no
 * way to tell which string of a structure came from that column (Decision
 * 2026-10-19, 사용자).
 */
export function toolNoteForOutput<T extends MaskableToolNote>(note: T): T {
  return { ...note, target: maskToolNoteTarget(note.target) };
}

/**
 * A session read result whose every tool note has been through the target
 * rule — **the one function a path that answers with tool notes has to call**.
 *
 * A read verb, the mirror renderer and an MCP read all hand their answer to a
 * codec, and a codec walking a finished structure can no longer tell which
 * string came from the `target` column; the shell `NAME=value` rule and the
 * truncated tail run over that column alone (Decision 2026-10-19, 사용자). So
 * this is where that knowledge lives: call it on the store's result, then let
 * the codec run the body rule over the rest. `SessionStore.readSession` says
 * the same thing (`ports/store.ts`).
 *
 * Structural, not tied to the port's own types, so a narrower read result — a
 * page of notes, a mirror's view — keeps the type it came in as.
 */
export function sessionForOutput<
  N extends MaskableToolNote,
  T extends { toolNotes: readonly N[] },
>(read: T): T {
  return { ...read, toolNotes: read.toolNotes.map((note) => toolNoteForOutput(note)) };
}

export { TOOL_NOTE_TARGET_LIMIT };
