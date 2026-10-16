/**
 * 출력 언어 검사. 사람이 읽는 문장은 한국어이고, 영어로 남는 것은 코드·키·
 * 식별자·명령·경로뿐이라는 Conventions의 '출력 언어' 결정(2026-10-16)을
 * 테스트가 확인하게 하는 도우미다.
 *
 * 검사기는 "한국어인가"가 아니라 "영어 문장이 남아 있는가"를 본다. 사람이
 * 쓴 문장과 기계가 쓴 토큰을 완벽히 구별하는 일은 불가능하지만, 영어 낱말이
 * 두 개 이상 잇달아 나오는 것은 거의 언제나 번역을 빠뜨린 문장이고, 한 낱말만
 * 남았는데 문장 안에 한글이 하나도 없으면 그 줄 전체가 영어다. 이 둘만 잡으면
 * 이후 스토리가 영어 문장을 새로 넣었을 때 테스트가 막아 준다.
 *
 * Core에 있으므로 Node API도 테스트 러너도 쓰지 않는다(AD-1): 어떤 패키지의
 * 테스트든 `@second-brain/core/testing`으로 가져다 쓴다.
 */

/** 한글 음절·자모. 한 글자라도 있으면 그 줄은 한국어 문장으로 본다. */
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

/**
 * 영어로 남겨 두기로 한 고유명사·약어. Boundaries가 영어로 못 박은 것들(코드,
 * 키, 점검 id, 상태 낱말, 명령·옵션 이름)과, 한국어로 옮기면 오히려 못 알아볼
 * 제품·기술 이름이다. 두 낱말 이상인 것도 하나의 이름으로 지운다.
 *
 * 길이 순으로 지우므로 `Claude Code`가 `Claude`보다 먼저 사라진다.
 */
export const ALLOWED_PROPER_NOUNS: readonly string[] = [
  // 제품·도구
  'Claude Code',
  'Claude',
  'Personal Brain',
  'Brain',
  'brain',
  'second-brain',
  'SQLite',
  'Node',
  'node',
  'npm',
  'npx',
  'pnpm',
  'git',
  'Homebrew',
  'brew',
  'Docker',
  'Postgres',
  'PostgreSQL',
  'vitest',
  // 기술 용어·약어
  'WAL',
  'FTS5',
  'fts5',
  'trigram',
  'SQL',
  'TOML',
  'JSON',
  'JSON Lines',
  'UUIDv7',
  'UUID',
  'ISO-8601',
  'UTC',
  'IANA',
  'PATH',
  'TTY',
  'stdin',
  'stdout',
  'stderr',
  'MCP',
  'SDK',
  'CLI',
  // 상태 낱말과 점검 id 조각(Boundaries: 영어로 둔다)
  'ok',
  'warn',
  'fail',
  'skip',
  'shim',
  'config',
  'db',
  'wal',
  'schema',
  // 사람 이름이 아닌, 명령·설정에서 그대로 쓰는 낱말
  'Enter',
  'y',
  'N',
];

export interface LanguageCheckOptions {
  /**
   * 이 문장에서만 영어로 허용할 낱말·구. 지면에 한 번만 나오는 제품 이름이나
   * 테이블 이름처럼, 목록에 넣을 만큼 일반적이지 않은 것들.
   */
  allow?: readonly string[];
  /** 메시지에 붙일 이름. 어느 문장이 걸렸는지 테스트 출력에서 찾기 쉽도록. */
  label?: string;
}

/** 정규식 안에서 그대로 쓰이도록 메타문자를 막는다. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 검사에서 빼는 부분을 빈칸으로 바꾼다. 빈칸이지 삭제가 아닌 이유: 백틱 하나를
 * 지워 앞뒤 낱말이 붙어 버리면 영어 두 낱말이 한 낱말로 보인다.
 */
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => ' '.repeat(match.length));
}

/**
 * 검사 대상에서 코드·식별자·값을 지운 문자열. 지우는 것은 plan의 목록 그대로다:
 * 백틱 구간, 대문자 코드, 경로·URL·플래그, 따옴표 값, 허용 고유명사. 여기에
 * 줄 앞머리의 `id: `·`CODE: ` 라벨을 더한다 — 점검 id와 오류 코드는 영어로
 * 두기로 했고(Boundaries), 그 라벨 때문에 줄 전체가 영어로 보이면 안 된다.
 */
function maskable(text: string, options: LanguageCheckOptions): string {
  let masked = text;

  // 백틱 구간: 명령은 전부 여기 들어 있다.
  masked = blank(masked, /`[^`]*`/g);
  // URL.
  masked = blank(masked, /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi);
  // 따옴표 값. 홑따옴표는 영어 축약형(don't)을 먹지 않도록 양끝이 다 있을 때만.
  masked = blank(masked, /"[^"\n]*"/g);
  masked = blank(masked, /'[^'\n\s]*'/g);
  masked = blank(masked, /[“][^”\n]*[”]/g);
  // 경로: 슬래시나 `~/`를 품은 토큰 전체.
  masked = blank(masked, /\S*\/\S*/g);
  masked = blank(masked, /~\S*/g);
  // 플래그: `--json`, `-y`.
  masked = blank(masked, /(?<![\w-])--?[A-Za-z][\w-]*/g);
  // 사용법의 자리표시자: `[options]`, `[command]`, `<harness>`, `<harness...>`.
  // commander가 스스로 넣는 것이고 산문이 아니다.
  masked = blank(masked, /[[<][A-Za-z][\w.-]*(?:\.\.\.)?[\]>]/g);
  // 줄 앞머리 라벨: `config: `, `CONFIG_MISSING: `, `  node-path: `.
  masked = masked
    .split('\n')
    .map((line) => blank(line, /^\s*[A-Za-z][\w-]*:(?=\s)/))
    .join('\n');
  // 대문자 코드: `USAGE`, `CONFIG_MISSING`, `AD-19`.
  masked = blank(masked, /\b[A-Z][A-Z0-9]+(?:[_-][A-Z0-9]+)*\b/g);
  // 코드 식별자: `schema_version.applied_at`, `claude-code`, `config.toml`,
  // `0001_initial.sql`. 숫자로 시작하는 것도 식별자다 — 마이그레이션 파일 이름이
  // 그렇다.
  masked = blank(masked, /\b[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)+/g);

  for (const noun of [...(options.allow ?? []), ...ALLOWED_PROPER_NOUNS].sort(
    (left, right) => right.length - left.length,
  )) {
    masked = blank(masked, new RegExp(`(?<![A-Za-z])${escape(noun)}(?![A-Za-z])`, 'g'));
  }

  return masked;
}

/** 공백으로만 이어진 라틴 낱말 덩어리. */
const LATIN_RUN = /[A-Za-z][A-Za-z0-9'’]*(?:[ \t]+[A-Za-z][A-Za-z0-9'’]*)*/g;

/**
 * 절을 나누는 자리: 줄바꿈, 그리고 마침표·콜론·쉼표·세미콜론 뒤의 공백.
 *
 * 한글이 있는지는 절마다 따로 본다. 한 줄 안에서 한국어 문장 뒤에 영어 문장이
 * 따라오는 것 — `… 없습니다. Run …` — 이 가장 흔한 번역 누락이고, 줄 전체로
 * 보면 한글이 있으니 그냥 지나가 버린다.
 */
const CLAUSE_BREAK = /\n|(?<=[.:,;])[ \t]/;

/**
 * `text`에 남아 있는 영어 문장들. 빈 배열이면 통과다.
 *
 * 한 덩어리가 걸리는 조건은 둘이다. 라틴 낱말이 둘 이상 잇달아 있으면 번역하지
 * 않은 문장이고, 하나뿐이어도 그 절에 한글이 없으면 그 절은 한국어가 아니다.
 * 지워진 뒤 아무 낱말도 남지 않은 절 — 경로 하나, 버전 하나뿐인 점검 detail —
 * 은 사람이 읽는 문장이 아니므로 통과한다.
 */
export function englishSentences(
  text: string,
  options: LanguageCheckOptions = {},
): readonly string[] {
  if (typeof text !== 'string' || text === '') return [];
  const masked = maskable(text, options);

  const found: string[] = [];
  for (const clause of masked.split(CLAUSE_BREAK)) {
    const hasHangul = HANGUL.test(clause);
    for (const [run] of clause.matchAll(LATIN_RUN)) {
      const words = run.trim().split(/[ \t]+/).filter((word) => word !== '');
      if (words.length === 0) continue;
      if (words.length >= 2 || !hasHangul) found.push(words.join(' '));
    }
  }
  return found;
}

/**
 * `text`가 한국어 문장임을 단정한다. 영어가 남아 있으면 남은 조각과 원문을
 * 함께 들고 던지므로, 실패한 테스트가 어느 문자열을 고쳐야 하는지 말해 준다.
 *
 * 테스트 러너에 의존하지 않도록 `Error`를 던진다(AD-1). 예상 실패가 아니라
 * 테스트의 단정이므로 값으로 돌려주지 않는다.
 */
export function assertKoreanProse(text: string, options: LanguageCheckOptions = {}): void {
  const found = englishSentences(text, options);
  if (found.length === 0) return;
  const where = options.label === undefined ? '' : `${options.label}: `;
  throw new Error(
    `${where}사람이 읽는 출력에 영어가 남아 있습니다: ${found
      .map((run) => `"${run}"`)
      .join(', ')} — 원문: ${JSON.stringify(text)}`,
  );
}
