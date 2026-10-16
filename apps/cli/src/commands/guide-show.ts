import { guideShow } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';

/**
 * `brain guide show`: the CLI usage conventions, as Markdown — the exit codes
 * and what to do about each, the six things an agent must not do, and that a
 * line on stderr is not a failure signal.
 *
 * The text is Core's (`guideShow`), because the discipline is Core's (AD-17)
 * and because the daemon and MCP will answer the same question in epic 9. This
 * command chooses nothing about it: text mode prints it as it is, and `--json`
 * carries the same string so a caller that reads envelopes does not have to
 * parse one out of stdout.
 *
 * The record-keeping discipline — what to write down, and when — is epic 3's
 * section of the same guide and is not here yet.
 */

export interface GuideShowData {
  /** The conventions section, as Markdown. */
  markdown: string;
}

export const guideShowCommand: CommandSpec<GuideShowData> = {
  ns: 'guide',
  verb: 'show',
  nsDescription: '이 CLI를 어떻게 쓰는지 알려 줍니다',
  usedFor: 'CLI 사용 규약을 Markdown으로 냅니다',
  required: [],
  examples: ['brain guide show', 'brain guide show --json'],
  output: '규약 절 전체인 `markdown`',
  risk: 'read',
  hook: false,
  dryRun: false,
  standalone: true,

  async run() {
    const markdown = guideShow();
    return {
      ok: true as const,
      data: { markdown },
      // The same string, as the lines the dispatcher prints: a guide that was
      // one JSON string in text mode would be a guide nobody reads.
      text: markdown.trimEnd().split('\n'),
    };
  },
};
