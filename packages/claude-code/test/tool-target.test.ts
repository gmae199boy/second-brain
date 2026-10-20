import { TOOL_NOTE_TARGET_LIMIT } from '@second-brain/core';
import { describe, expect, it } from 'vitest';
import { TOOL_TARGET_LIMIT, toolTarget } from '../src/tool-target.js';

/**
 * The one number this adapter and Core have to agree on.
 *
 * The parser cuts a tool note target to the first line's first
 * `TOOL_TARGET_LIMIT` units and that cut is what gets *stored*, for good: a
 * stored row is never rewritten (AD-8, AD-11). Core knows the same number as
 * `TOOL_NOTE_TARGET_LIMIT`, because the output masking needs it — a secret the
 * cut broke in two is left as a prefix no pattern recognises, and the
 * truncated-tail rule exists for exactly that (`output/mask.ts`).
 *
 * So changing this number changes what every future session stores and what
 * the masking believes about every stored session, and it may only be changed
 * with a `CLAUDE_CODE_PARSER_VERSION` bump so the already stored sessions are
 * read again. That is why the value is pinned here and not merely derived.
 */
describe('the tool note target limit', () => {
  it('is 500, in both packages, and is one number and not two', () => {
    expect(TOOL_TARGET_LIMIT).toBe(500);
    expect(TOOL_NOTE_TARGET_LIMIT).toBe(500);
    expect(TOOL_TARGET_LIMIT).toBe(TOOL_NOTE_TARGET_LIMIT);
  });

  it('is the length a cut target comes out at', () => {
    const command = `echo ${'x'.repeat(600)}`;

    const target = toolTarget('Bash', { command });

    expect(target).toHaveLength(500);
    expect(target).toBe(command.slice(0, 500));
  });
});
