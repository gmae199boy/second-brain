import { contentHash } from './sha256.js';

/**
 * Core's one versioned list of secret patterns, and the masking function that
 * runs it (AD-11).
 *
 * Everything in here is a pure function of its input: no clock, no id, no port.
 * That is what lets masking happen where text leaves Brain rather than where it
 * is stored: capture writes the original down and the output codecs
 * (`output/codecs.ts`) run this list over whatever goes out (마스킹 B,
 * 2026-10-18 사용자).
 *
 * Which way a pattern errs follows from that. Missing a secret lets it out of
 * Brain, so the keyword forms are wide. Masking too much costs one unreadable
 * line of output and nothing more — the stored original is untouched — so the
 * value-shape rules below are a convenience and not a safety net.
 *
 * Two rules hold the whole file together:
 *
 *   * a pattern either masks its whole match or one named group of it. A
 *     keyword pattern masks the group, because the name is what makes the
 *     record readable afterwards: `password: [REDACTED:password]` still says
 *     what was there, and a marker that swallowed the name would not.
 *   * every position this module reports is a code point index over the text as
 *     it stood *before* the masking (Conventions, AD-11). Regular expressions
 *     count UTF-16 units, so the two are not the same the moment a body carries
 *     an emoji, and the conversion happens once per call.
 */

/**
 * Which version of this list did a masking. Bump it whenever a pattern is
 * added, removed or changed, so a record can be found again when the list
 * grows (AD-11, inputs A6).
 */
export const SECRET_PATTERN_VERSION = '2';

/** Where a text came from, which decides which patterns run over it. */
export type SecretField = 'body' | 'tool_target';

/** One pattern of the list. `kind` goes into the marker and into the record. */
interface SecretPattern {
  /** English snake_case, and the word inside `[REDACTED:<kind>]` (AD-11). */
  kind: string;
  /** Global, unicode and with indices: the spans come from `match.indices`. */
  expression: RegExp;
  /**
   * The named groups to mask instead of the whole match, tried in order; the
   * first one that took part in the match is the span. Left out, the span is
   * the whole match.
   */
  value?: readonly string[];
  /** The fields this pattern runs over. Most run over both. */
  fields: readonly SecretField[];
  /**
   * A last check the expression alone cannot make: the Luhn sum of a card
   * number, or the shape of a keyword's value. A match it refuses leaves no
   * span. The second argument is everything about the match this file knows
   * that the matched text alone does not say.
   */
  accept?: (matched: string, context: SecretMatch) => boolean;
  /**
   * Take unmatched closing brackets off the end of the span. Only the keyword
   * forms want it: their value set holds brackets so that `parse(input)` stays
   * one value, and `{"token": 123}` would otherwise end in the object's `}`.
   */
  trimClosers?: boolean;
}

/** What `accept` is told about a match, beyond the matched text itself. */
export interface SecretMatch {
  /** The text the span covers right now — the value, for a keyword form. */
  value: string;
  /** Whether the pattern consumed an opening quote right before the value. */
  quoted: boolean;
  /** What follows the span in the text, cut to a few characters. */
  after: string;
}

const BOTH: readonly SecretField[] = ['body', 'tool_target'];

/** Hangul syllables and the bare jamo, for "the value must not start in Korean". */
const HANGUL = String.raw`\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F`;

/**
 * The value of a keyword assignment: everything up to the first whitespace,
 * quote, backtick, comma, semicolon, full-width punctuation or Hangul
 * character (version 2).
 *
 * `!`, `?`, `.`, `:` and brackets are *inside* a value. Version 1 stopped at
 * them, which cut `Pa!ss2024` in half and left the rest of the password in the
 * output. Hangul is a stop instead, because a Korean sentence after a value is
 * the common case and nothing of that sentence is the secret.
 *
 * `\S+` would still be wrong: it swallows the rest of a line.
 */
const VALUE = String.raw`[^\s,;，。、'"\u0060${HANGUL}]+`;

/** Closing brackets, and the opener each one would have to be paired with. */
const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{', '>': '<' };

/** How much of the text after a span `accept` is shown. */
const AFTER_WINDOW = 24;

/**
 * The patterns, in the order they are tried. Order decides only which `kind` a
 * merged span carries, never whether something is masked: the provider tokens
 * come first so that `token=sk-…` is recorded as the token it is rather than as
 * the keyword that introduced it.
 *
 * The lookbehind on the token patterns is there so a longer opaque string that
 * merely contains a prefix is not cut in half: `xsk-…` is not an API key.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: 'api_key',
    expression: /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{16,}/gdu,
    fields: BOTH,
  },
  {
    kind: 'stripe_key',
    expression: /(?<![A-Za-z0-9_])sk_(?:live|test)_[A-Za-z0-9]{16,}/gdu,
    fields: BOTH,
  },
  {
    kind: 'github_token',
    expression: /(?<![A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/gdu,
    fields: BOTH,
  },
  {
    kind: 'github_token',
    expression: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/gdu,
    fields: BOTH,
  },
  {
    kind: 'aws_access_key',
    expression: /(?<![A-Za-z0-9_])(?:AKIA|ASIA)[0-9A-Z]{16}/gdu,
    fields: BOTH,
  },
  {
    kind: 'slack_token',
    expression: /(?<![A-Za-z0-9_])xox[baprs]-[A-Za-z0-9-]{10,}/gdu,
    fields: BOTH,
  },
  {
    kind: 'google_api_key',
    expression: /(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{35}/gdu,
    fields: BOTH,
  },
  {
    // Three base64url pieces of at least ten characters each, the first two of
    // them a JSON object's opening brace: `eyJ` is `{"` encoded.
    kind: 'jwt',
    expression:
      /(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]{7,}\.eyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}/gdu,
    fields: BOTH,
  },
  {
    // The word stays, the credential goes: a note that said `Bearer` was in use
    // is worth keeping, and the scheme name is not a secret.
    kind: 'bearer_token',
    expression: /(?<![A-Za-z0-9_])Bearer\s+(?<value>[A-Za-z0-9._~+/=-]{20,})/gdiu,
    value: ['value'],
    fields: BOTH,
  },
  {
    // The whole block, header and footer included. It stops at the first
    // `-----END …-----` line whatever that line is labelled, because a block
    // whose footer says something else is still a block that ended — demanding
    // a matching label would run the mask to the end of the text and take the
    // prose after it with it.
    //
    // Only a block with no `END` line at all runs to the end: a half of a
    // private key is still a private key, and the rest of it is somewhere in
    // the same message.
    kind: 'private_key',
    expression:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*-----|-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*/gdu,
    fields: BOTH,
  },
  {
    // `scheme://user:password@host`: the user name stays, because it is often
    // the only thing that says which service the line was talking about.
    kind: 'url_credentials',
    expression: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:(?<value>[^\s/@]+)@/gdu,
    value: ['value'],
    fields: BOTH,
  },
  {
    // The English keyword form. The lookbehind refuses a letter or a digit but
    // allows `_`, which is what makes `DB_PASSWORD=` a match and `max_tokens:`
    // not one — the keyword there is followed by an `s`, not by a separator.
    //
    // `pwd` is deliberately missing: a shell transcript is full of `PWD=` and a
    // path is not a secret (Decision 2026-10-18).
    //
    // The separator is one character, so `(?!=)` is what keeps a comparison
    // from looking like an assignment: in `if (password === input)` the class
    // takes the first `=` and the rest of the operator would become the value.
    kind: 'password',
    expression: new RegExp(
      String.raw`(?<![A-Za-z0-9])(?:password|passwd|secret|token|api[_ -]?key|access[_ -]?key)` +
        String.raw`["']?\s*[:=]\s*(?!=)(?<open>["'])?(?<value>${VALUE})`,
      'gdiu',
    ),
    value: ['value'],
    trimClosers: true,
    accept: keywordValueLooksLikeSecret,
    fields: BOTH,
  },
  {
    // The Korean keyword form. No `\b` anywhere near the Hangul: JavaScript's
    // word boundary is ASCII only and would quietly never match (inputs A4).
    //
    // Three separators, which is version 2's widening (change D4): the colon
    // or equals sign, a particle, or simply a space. "비밀번호 Tiger2024" and
    // "비밀번호가 Tiger2024" are how a person actually writes it, and version
    // 1 let both of them out of Brain.
    //
    // A value that starts in Korean is still not a value: "비밀번호는 바꿨어"
    // is somebody saying they changed it, and masking the next word would
    // delete a sentence rather than a secret. That one rule is what makes a
    // bare space safe as a separator.
    //
    // No value-shape rule here. The English one exists because English
    // keywords collide with ordinary code (`let token = parse(x)`); nothing
    // writes "비밀번호" in a program.
    kind: 'password',
    expression: new RegExp(
      String.raw`(?:비밀번호|암호|패스워드)` +
        String.raw`(?:\s*[:=]\s*|[은는이가을를도]\s*(?:[:=]\s*)?|\s+)` +
        String.raw`(?<value>(?![${HANGUL}])${VALUE})`,
      'gdu',
    ),
    value: ['value'],
    trimClosers: true,
    fields: BOTH,
  },
  {
    // A Korean resident registration number, anchored on the birth date so that
    // thirteen digits of something else do not match (inputs A2).
    kind: 'resident_registration_number',
    expression: /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-?[1-8]\d{6}(?!\d)/gdu,
    fields: BOTH,
  },
  {
    kind: 'phone_number',
    expression: /(?<!\d)01[016789]-?\d{3,4}-?\d{4}(?!\d)/gdu,
    fields: BOTH,
  },
  {
    // Fifteen or sixteen digits in groups of four, opening with a digit a card
    // network actually uses, and only when the digits pass Luhn. Without those
    // two conditions this pattern eats epoch milliseconds and order numbers.
    kind: 'card_number',
    expression: /(?<!\d)[3-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{3,4}(?!\d)/gdu,
    accept: luhnPasses,
    fields: BOTH,
  },
  {
    // Shell `NAME=value`, upper-case snake only, so `--model` and a URL are not
    // matches (inputs A5). The groups carry names this file needs; what the
    // expression accepts is the inputs regex unchanged.
    //
    // Tool note targets only. A body's `NODE_ENV=production` is an ordinary
    // line of a conversation, and a reader who cannot see it has lost
    // something; a `NAME=value` on a command line is far more often a
    // credential (Decision 2026-10-18, kept by D1). Which column a string came
    // from is what `toolNoteForOutput` carries, because a codec walking a
    // finished answer can no longer tell.
    kind: 'shell_assignment',
    expression:
      /(?:^|[;|&\s])(?:export\s+)?[A-Z_][A-Z0-9_]{0,127}=(?:"(?<quoted>[^"]*)"|'(?<single>[^']*)'|(?<bare>[^\s;|&]+))/gdu,
    value: ['quoted', 'single', 'bare'],
    fields: ['tool_target'],
  },
];

/** A marker an earlier masking already left, which is never masked again. */
const MARKER = /\[REDACTED:[a-z0-9_]+\]/gu;

/** One span that was replaced by a marker. Positions are code points. */
export interface SecretSpan {
  /** Half-open `[start, end)` over the *unmasked* text, in code points. */
  start: number;
  end: number;
  /** The word the marker carries, and the `kind` of the record. */
  kind: string;
  /**
   * `sha256:<hex>` of the text that was taken out. The text itself is never
   * returned, logged or stored — only this (AD-11).
   */
  removed: string;
}

/** What one masking produced: the text to store, and what it cost. */
export interface MaskSecretsResult {
  text: string;
  spans: readonly SecretSpan[];
}

/** A span while it is still being worked out, in UTF-16 units. */
interface RawSpan {
  start: number;
  end: number;
  kind: string;
}

/**
 * Replace every secret this list knows with `[REDACTED:<kind>]`.
 *
 * The same input always gives the same output, and masking an already masked
 * text changes nothing: a marker is skipped rather than masked again, so a
 * second pass is a no-op. That matters because the same text goes out more
 * than once — a read, then a mirror, then an export — and a marker that grew a
 * marker every time would make the output drift.
 */
export function maskSecrets(text: string, field: SecretField): MaskSecretsResult {
  if (text === '') return { text, spans: [] };

  const skip = markerRanges(text);
  const found: RawSpan[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (!pattern.fields.includes(field)) continue;
    // A fresh expression per call: `lastIndex` is state, and a module-level
    // regex shared between calls would make masking depend on its own history.
    const expression = new RegExp(pattern.expression.source, pattern.expression.flags);
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text)) !== null) {
      const matched = match[0] ?? '';
      // A zero-width match would loop forever; nothing in the list can produce
      // one, and this is the guard that says so out loud.
      if (matched === '') {
        expression.lastIndex += 1;
        continue;
      }
      const raw = spanOf(match, matched, pattern);
      if (raw === null) continue;
      const span = pattern.trimClosers === true ? trimClosers(text, raw) : raw;
      if (span.end <= span.start) continue;
      if (
        pattern.accept !== undefined &&
        !pattern.accept(matched, {
          value: text.slice(span.start, span.end),
          quoted: match.indices?.groups?.['open'] !== undefined,
          after: text.slice(span.end, span.end + AFTER_WINDOW),
        })
      ) {
        continue;
      }
      // Already masked: this is what makes a second pass a no-op. Only a span
      // that lies wholly inside a marker is dropped — `token=[REDACTED:api_key]`
      // gives the value `[REDACTED`, which is the marker's own text. A span that
      // merely touches a marker, like a key block running on past one, is still
      // a secret and is masked whole.
      if (skip.some((range) => range.start <= span.start && span.end <= range.end)) continue;
      found.push({ ...span, kind: pattern.kind });
    }
  }

  if (found.length === 0) return { text, spans: [] };

  // Earliest first; on a tie the longer span, and on a tie in both the pattern
  // that comes first in the list — `Array.prototype.sort` is stable, and the
  // list order is the order `found` was filled in.
  const ordered = [...found].sort((left, right) =>
    left.start === right.start ? right.end - left.end : left.start - right.start,
  );

  // Union: two patterns that saw the same secret leave one marker and one
  // record. The `kind` is the first span's, which is why the order above is
  // decided and not incidental.
  const merged: RawSpan[] = [];
  for (const span of ordered) {
    const last = merged.at(-1);
    if (last !== undefined && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }

  const asCodePoint = codePointIndex(text);
  const pieces: string[] = [];
  const spans: SecretSpan[] = [];
  let read = 0;
  for (const span of merged) {
    pieces.push(text.slice(read, span.start), `[REDACTED:${span.kind}]`);
    spans.push({
      start: asCodePoint(span.start),
      end: asCodePoint(span.end),
      kind: span.kind,
      // The hash of what is about to disappear. Nothing else keeps it (AD-11).
      removed: contentHash(text.slice(span.start, span.end)),
    });
    read = span.end;
  }
  pieces.push(text.slice(read));

  return { text: pieces.join(''), spans };
}

/**
 * The same span with unmatched closing brackets taken off the end.
 *
 * `{"token": 123}` gives the value `123}`, and the brace belongs to the JSON
 * around it and not to the value. `parse(input)` keeps its bracket, because
 * that one is matched — and that is what lets the call-shape rule below see a
 * call at all.
 */
function trimClosers(
  text: string,
  span: { start: number; end: number },
): { start: number; end: number } {
  let end = span.end;
  while (end > span.start) {
    const last = text[end - 1] ?? '';
    const opener = CLOSERS[last];
    if (opener === undefined) break;
    let open = 0;
    let close = 0;
    for (let at = span.start; at < end; at += 1) {
      const character = text[at];
      if (character === opener) open += 1;
      else if (character === last) close += 1;
    }
    if (close <= open) break;
    end -= 1;
  }
  return { start: span.start, end };
}

/**
 * Whether an English keyword's value is worth masking (change D4).
 *
 * A quoted value always is: somebody who wrote `secret: "see"` meant the
 * string and not the sentence. An unquoted one is judged by shape, and three
 * shapes are ordinary code or prose rather than a credential:
 *
 *   * a call — `token = parse(input)`;
 *   * digits alone — `{"token": 123}`, and a count is not a password. A
 *     numeric PIN is the price of that one;
 *   * a word of letters with another word after it — `secret: see the README`.
 *
 * Getting this wrong costs a masked word in one line of output, never a
 * stored message: capture keeps the original (마스킹 B).
 */
function keywordValueLooksLikeSecret(_matched: string, context: SecretMatch): boolean {
  if (context.quoted) return true;
  // The *whole* value has to be the call. `foo(bar)baz` only begins like one,
  // and a credential that happens to open with an identifier and a bracket is
  // still a credential.
  if (/^[A-Za-z_$][A-Za-z0-9_$]*\(.*\)$/su.test(context.value)) return false;
  if (/^\d+$/u.test(context.value)) return false;
  // Space or tab, never a newline: the next line is a different sentence, and
  // a value at the end of one would otherwise be spared by whatever happened
  // to follow it — which differs from codec to codec, since one joins the
  // texts with a newline and another with a space.
  if (/^[A-Za-z]+$/u.test(context.value) && /^[ \t]+[A-Za-z]/u.test(context.after)) return false;
  return true;
}

/** Where the markers of an earlier masking sit, in UTF-16 units. */
function markerRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const expression = new RegExp(MARKER.source, MARKER.flags);
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + (match[0] ?? '').length });
  }
  return ranges;
}

/**
 * The part of a match that is masked: the first named group of `value` that
 * took part, or the whole match when the pattern names none.
 *
 * `null` for a match whose named groups all stayed out of it, which the
 * alternation of `shell_assignment` makes possible.
 */
function spanOf(
  match: RegExpExecArray,
  matched: string,
  pattern: SecretPattern,
): { start: number; end: number } | null {
  if (pattern.value === undefined) {
    return { start: match.index, end: match.index + matched.length };
  }
  const groups = match.indices?.groups;
  if (groups === undefined) {
    // Only possible without the `d` flag, which every pattern in the list has.
    throw new TypeError(`pattern ${pattern.kind} must be built with the d flag`);
  }
  for (const name of pattern.value) {
    const at = groups[name];
    if (at === undefined) continue;
    return { start: at[0], end: at[1] };
  }
  return null;
}

/**
 * A UTF-16 index to a code point index over the same text (Conventions).
 *
 * Built in one pass, and only when there is a surrogate pair to account for: a
 * body of plain text — which most are — gets the identity function and no
 * allocation at all.
 */
function codePointIndex(text: string): (at: number) => number {
  // Looked for by code unit and not with a regular expression: under the `u`
  // flag a class of surrogates matches only *lone* ones, because the engine
  // then works in code points — so the one case this function exists for would
  // be the one case the test missed.
  if (!hasSurrogate(text)) return (at) => at;

  const table = new Int32Array(text.length + 1);
  let codePoints = 0;
  let index = 0;
  while (index < text.length) {
    table[index] = codePoints;
    const code = text.charCodeAt(index);
    const wide =
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff;
    if (wide) {
      // The low half of a pair is inside the same code point as the high one.
      table[index + 1] = codePoints;
      index += 2;
    } else {
      index += 1;
    }
    codePoints += 1;
  }
  table[text.length] = codePoints;
  return (at) => table[at] ?? codePoints;
}

/** Whether any UTF-16 unit of the text is a surrogate, half of a pair or lone. */
function hasSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * The Luhn check digit test, over the digits of `text` alone.
 *
 * It is what separates a card number from any other fifteen digits: a run of
 * digits that happens to look like one fails this nine times in ten, and a
 * masked order number is a deletion nobody can undo.
 */
function luhnPasses(text: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const character = text.charCodeAt(index) - 48;
    if (character < 0 || character > 9) continue;
    let value = character;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}
