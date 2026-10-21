import { TOOL_NOTE_TARGET_LIMIT } from '@second-brain/core';

/**
 * What a tool call acted on, as one short line: the file it read, the command
 * it ran, the pattern it searched for (AD-15, PRD glossary).
 *
 * It is one *value of the input*, never the output and never the content a
 * write carried. A tool note exists so a person can recall "I had it read the
 * import notes", and `content`, `old_string` and `new_string` would turn the
 * note into a copy of the change — which is what the transcript already is.
 */

/**
 * Where the target sits in the input, per tool: a key, or a path into the
 * input for the one tool whose target is nested.
 *
 * Spelled out rather than guessed, because the right value is a fact about each
 * tool: a `Bash` note is useless without the command, a `Read` note without the
 * path, and `Grep` has both a `pattern` and a `path` of which only one says
 * what the call was looking for.
 *
 * `SendMessage` and `AskUserQuestion` are in here because they were the two
 * largest groups of empty targets measured — 102 and 101 calls on this machine
 * — and neither carries any of the fallback keys: one names a recipient, the
 * other an array of questions. What is read of `AskUserQuestion` is the first
 * question and not the answers, which is the same rule as everywhere else:
 * the input, never the output (#13).
 */
const TARGET_PATH: Readonly<Record<string, readonly (string | number)[]>> = {
  Bash: ['command'],
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  ToolSearch: ['query'],
  Agent: ['description'],
  Task: ['description'],
  Skill: ['skill'],
  SendMessage: ['to'],
  AskUserQuestion: ['questions', 0, 'question'],
};

/**
 * What to try for a tool nobody listed above — an MCP tool, a plugin's, a tool
 * this parser has never heard of. The order is from the most specific thing a
 * call can name to the least, so a tool that carries two of them is described
 * by the narrower one.
 *
 * The identifying keys at the end — a recipient, a task, a page, a query
 * language, an id — are what an MCP tool names its subject with, and adding
 * them is most of what closed the empty-target gap (#13). What is deliberately
 * *not* here is every key that holds content rather than a subject:
 * `content`, `message`, `code`, `script`, `payload`, `new_string`,
 * `old_string`. A note built from one of those would be a copy of the change,
 * which the transcript already is, and it is where a secret in a call would end
 * up in a row nobody can rewrite (AD-11).
 */
const FALLBACK_KEYS = [
  'file_path',
  'path',
  'filename',
  'url',
  'pageId',
  'cql',
  'query',
  'pattern',
  'command',
  'description',
  'to',
  'recipient',
  'task_id',
  'name',
  'id',
] as const;

/**
 * The first line of the target, cut to this many characters. A `Bash` command
 * can be a whole heredoc and a `Grep` pattern a long alternation; a note is a
 * reminder and not the call itself, so it keeps the opening and drops the rest.
 *
 * The number is Core's, because the output masking has to know it too: a
 * secret the cut split in half is left as a prefix no pattern recognises, and
 * the truncated-tail rule exists for exactly that (`TOOL_NOTE_TARGET_LIMIT`,
 * AD-11). Neither the value nor the way the cut is made changes here.
 */
export const TOOL_TARGET_LIMIT = TOOL_NOTE_TARGET_LIMIT;

/**
 * The target of one `tool_use` block, or `''` when the input holds nothing that
 * describes the call. Empty is a value and not a failure: the note still says
 * which tool ran and whether it worked, and `tool_notes.target` is `not null`
 * but may be empty.
 */
export function toolTarget(tool: string, input: unknown): string {
  const record = asRecord(input);
  if (record === undefined) return '';

  // `hasOwn`, because the table is looked up by a name the *transcript*
  // carries: a tool called `toString` or `constructor` would otherwise find
  // `Object.prototype`'s member and read the input under a key that is a
  // function (#14).
  const named = Object.hasOwn(TARGET_PATH, tool) ? TARGET_PATH[tool] : undefined;
  const value =
    named === undefined ? firstOf(record, FALLBACK_KEYS) : readPath(record, named);
  if (value === undefined) return '';

  // The first line only: `split` and not a regex, because the separator is the
  // newline alone — U+2028 and U+2029 are characters inside a string here, not
  // line breaks (Boundaries).
  const firstLine = value.split('\n')[0] ?? '';
  return cut(firstLine, TOOL_TARGET_LIMIT);
}

/**
 * The text at the end of a path through the input, or `undefined` when the path
 * does not lead to one. Arrays are walked by index, objects by own key alone.
 */
function readPath(
  record: Record<string, unknown>,
  path: readonly (string | number)[],
): string | undefined {
  let at: unknown = record;
  for (const step of path) {
    if (typeof step === 'number') {
      if (!Array.isArray(at)) return undefined;
      at = (at as readonly unknown[])[step];
      continue;
    }
    const held = asRecord(at);
    if (held === undefined || !Object.hasOwn(held, step)) return undefined;
    at = held[step];
  }
  return asString(at);
}

/** The first of these keys the input carries, as its own, as a string. */
function firstOf(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    const value = asString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The text cut to at most `limit` UTF-16 units, never through a character.
 *
 * A code point outside the BMP — an emoji, a rarer CJK character — is two UTF-16
 * units, and a cut between them leaves a lone surrogate: a half character that
 * is not text at all, which then goes into a column, through a search index and
 * out again through JSON. So when the unit at the limit is the *first* half of
 * such a pair, it goes too, and the target is one unit shorter (#14).
 */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  const high = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, high ? limit - 1 : limit);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
