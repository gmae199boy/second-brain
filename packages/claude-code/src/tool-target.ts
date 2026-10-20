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
 * The input key that is the target, per tool. Spelled out rather than guessed,
 * because the right value is a fact about each tool: a `Bash` note is useless
 * without the command, a `Read` note without the path, and `Grep` has both a
 * `pattern` and a `path` of which only one says what the call was looking for.
 */
const TARGET_KEY: Readonly<Record<string, string>> = {
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern',
  Glob: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  ToolSearch: 'query',
  Agent: 'description',
  Task: 'description',
  Skill: 'skill',
};

/**
 * What to try for a tool nobody listed above — an MCP tool, a plugin's, a tool
 * this parser has never heard of. The order is from the most specific thing a
 * call can name to the least, so a tool that carries two of them is described
 * by the narrower one.
 */
const FALLBACK_KEYS = [
  'file_path',
  'path',
  'url',
  'query',
  'pattern',
  'command',
  'description',
  'name',
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

  const named = TARGET_KEY[tool];
  const value =
    named === undefined ? firstOf(record, FALLBACK_KEYS) : asString(record[named]);
  if (value === undefined) return '';

  // The first line only: `split` and not a regex, because the separator is the
  // newline alone — U+2028 and U+2029 are characters inside a string here, not
  // line breaks (Boundaries).
  const firstLine = value.split('\n')[0] ?? '';
  return firstLine.slice(0, TOOL_TARGET_LIMIT);
}

/** The first of these keys the input carries as a string. */
function firstOf(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
