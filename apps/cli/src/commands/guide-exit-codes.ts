import { exitCodeGuide, type ExitCodeGuide } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';

/**
 * `brain guide exit-codes`: the three code tables — exit codes, error codes,
 * warning codes — with what each one means and what to do about it.
 *
 * It renders and decides nothing (AD-17): the tables are Core constants, this
 * command puts them in an envelope, and the README is checked against the same
 * constants by `readme-codes.test.ts`. So the document, the command and the
 * code that throws the failure cannot disagree about what a `2` is.
 *
 * `standalone`: a caller asking what an exit code means has often just been
 * given one by a command that could not run at all, and an answer that needed
 * a working configuration would be unavailable exactly then.
 */

export const guideExitCodes: CommandSpec<ExitCodeGuide> = {
  ns: 'guide',
  verb: 'exit-codes',
  nsDescription: '이 CLI를 어떻게 쓰는지 알려 줍니다',
  usedFor: '종료 코드·오류 코드·경고 코드가 무엇을 뜻하는지 냅니다',
  required: [],
  examples: ['brain guide exit-codes', 'brain guide exit-codes --json'],
  output: '`exit_codes`, `error_codes`, `warning_codes` 세 목록',
  risk: 'read',
  hook: false,
  dryRun: false,
  standalone: true,

  async run() {
    const guide = exitCodeGuide();
    return { ok: true as const, data: guide, text: textTables(guide) };
  },
};

/**
 * The three tables as lines, for the person at the terminal.
 *
 * What to do about a row goes on its own indented line rather than after a
 * dash: a meaning is a sentence, and these sentences use the em dash
 * themselves — `USAGE` and `CONFIG_INVALID` both do — so joining the two with
 * one more would leave no way to see where the meaning ended.
 */
function textTables(guide: ExitCodeGuide): readonly string[] {
  return [
    '종료 코드',
    ...guide.exit_codes.flatMap((row) => [
      `  ${row.code}: ${row.meaning}`,
      `    ${row.agent_action}`,
    ]),
    '',
    '오류 코드',
    ...guide.error_codes.flatMap((row) => [
      `  ${row.code} (종료 ${String(row.exit_code)}): ${row.meaning}`,
      `    ${row.hint}`,
    ]),
    '',
    '경고 코드',
    ...guide.warning_codes.map((row) => `  ${row.code}: ${row.meaning}`),
  ];
}
