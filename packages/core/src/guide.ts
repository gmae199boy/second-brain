import { EXIT_CODES } from './codes.js';

/**
 * The CLI usage conventions, as the one piece of prose every surface hands an
 * agent: `brain guide show` prints this, and nothing re-words it.
 *
 * It lives in Core and not in the CLI because the discipline is Core's (AD-17):
 * the daemon and MCP answer the same questions in epic 9, and a second wording
 * of "do not add `--yes` yourself" is a second rule as far as whatever reads it
 * is concerned. The CLI renders; it does not decide.
 *
 * The record-keeping discipline itself — what to write down, and when — is
 * epic 3's section and is deliberately not here.
 */

/**
 * The exit-code table as Markdown, built from `EXIT_CODES` rather than written
 * out: the guide and the README cannot disagree about what a 2 means, because
 * neither of them holds the sentence.
 */
function exitCodeTable(): string {
  const header = ['| 코드 | 뜻 | 에이전트 행동 |', '| --- | --- | --- |'];
  const rows = EXIT_CODES.map(
    (row) => `| \`${row.code}\` | ${row.meaning} | ${row.agent_action} |`,
  );
  return [...header, ...rows].join('\n');
}

/**
 * What an agent has to know before it runs anything: what the exit codes mean,
 * the six things it must not do, and that stderr is not a failure signal.
 *
 * The six are the Conventions' own list. They are written as prohibitions
 * rather than as advice because each one is a way of turning a question for a
 * person into an answer the agent gave itself.
 */
export function guideShow(): string {
  return `## CLI 사용 규약

모든 명령은 \`brain <ns> <verb>\`입니다. \`--json\`을 붙이면 엔벨로프
\`{ ok, now, data, warnings[], error?, meta? }\`가 나오고, 붙이지 않으면 사람이
읽는 줄이 나옵니다. 어느 쪽이든 결과를 판단하는 것은 종료 코드입니다.

### 종료 코드

${exitCodeTable()}

\`--json\`에서는 같은 숫자가 \`error.exit_code\`에 있습니다. \`error.hint\`는
무엇을 하면 되는지, \`error.retryable\`은 같은 명령을 다시 실행해서 될 일인지
말합니다(없으면 "경우에 따라 다르다"는 뜻입니다).

### 에이전트가 하지 않는 것

- **\`--yes\`를 스스로 붙이지 않습니다.** 동의는 사람의 것입니다.
- **사람에게 묻지 않고 \`error.retry\`를 부르지 않습니다.** 그것은 사람에게
  보여 줄 호출이고, 사람이 그렇다고 한 뒤에만 부르는 것입니다. 확인을 건너뛰는
  지름길이 아닙니다.
- **백오프 루프로 되풀이하지 않습니다.** \`error.retryable\`이 참일 때 한 번
  다시 실행하고, 그래도 안 되면 사람에게 말합니다.
- **덜 파괴적인 동사로 우회하지 않습니다.** 막힌 동사를 여러 동사로 나누어
  해내는 것은 거절된 일을 그대로 하는 것입니다.
- **이전 승인을 다시 쓰지 않습니다.** 동의는 그때 그 호출에만 해당합니다.
- **\`--json\`으로 확인을 피해 가지 않습니다.** 출력 방식은 게이트를 바꾸지
  않습니다.

### stderr는 실패 신호가 아닙니다

경고 줄과 \`hint\`도 stderr로 갑니다. stderr에 무언가 있다는 것만으로 실패라고
보지 말고 종료 코드를 보세요. 거꾸로, 하네스 hook 경로의 명령은 무슨 일이
있어도 0으로 끝나므로 그 한 줄이 실패를 아는 유일한 방법입니다.
`;
}
