import { assertKoreanProse, englishSentences } from 'second_brain/testing';

/**
 * 출력 언어 검사를 CLI 테스트에서 쓰기 쉽게 감싼 것. 검사기 자체는 Core에
 * 있고(`packages/core/src/testing/language.ts`), 여기 있는 것은 CLI 출력에만
 * 해당하는 두 가지다: Node·SQLite·git이 낸 원문을 검사 입력에서 빼는 일과,
 * 여러 줄짜리 출력을 줄 단위로 보는 일.
 */

/**
 * 번역하지 않는 원문이 붙을 수 있는 자리(Boundaries). Node·SQLite·git이 낸
 * 영어 한 문장은 한국어 문장 뒤에 그대로 붙으므로 — 번역하면 사람이 검색해서
 * 찾을 수 있는 유일한 문구가 사라진다 — 그 부분은 검사에서 뺀다.
 *
 * 자리는 `한국어 절 + ": " + 한 문장`이고, 거기 있다는 것만으로는 원문이
 * 아니다: 우리가 쓴 문장도 그 자리에 온다. 그래서 `looksLikeSystemOriginal`이
 * 한 번 더 본다.
 */
const APPENDED_TAIL = /(?<=[가-힣]): [^\n]*?(?=\.(?:\s|$)|$)/g;

/**
 * 시스템이 낸 원문처럼 보이는 꼬리들. 아는 모양만 인정한다 — 아무 영어나
 * 원문으로 봐 주면 번역을 빠뜨린 문장도 함께 통과한다.
 */
const ENGINE_CODE = /^[A-Z][A-Z0-9_]{2,}:|\b(?:E[A-Z]{3,}|SQLITE_[A-Z]+)\b/;

/** 코드를 달지 않고 오는 엔진·라이브러리 문장들. */
const ENGINE_SENTENCES: readonly string[] = [
  'unable to open database file',
  'attempt to write a readonly database',
  'database disk image is malformed',
  'file is not a database',
  'no such table',
  'no such column',
  'table sessions already exists',
  'Invalid TOML document',
];

function looksLikeSystemOriginal(tail: string): boolean {
  if (ENGINE_CODE.test(tail)) return true;
  return ENGINE_SENTENCES.some((sentence) => tail.includes(sentence));
}

/** 우리가 쓴 부분만 남긴 문자열. 원문은 빈칸으로 바뀐다. */
export function authored(text: string): string {
  return text.replace(APPENDED_TAIL, (match) => {
    const tail = match.slice(2);
    return looksLikeSystemOriginal(tail) ? ' '.repeat(match.length) : match;
  });
}

export interface KoreanOutputOptions {
  /** 이 출력에서만 영어로 허용할 낱말·구. */
  allow?: readonly string[];
  label?: string;
}

/** 한 줄이 한국어임을 단정한다. 원문은 빼고 본다. */
export function assertKoreanLine(line: string, options: KoreanOutputOptions = {}): void {
  assertKoreanProse(authored(line), options);
}

/** 여러 줄 출력의 모든 줄이 한국어임을 단정한다. */
export function assertKoreanLines(text: string, options: KoreanOutputOptions = {}): void {
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    assertKoreanLine(line, {
      ...options,
      label: `${options.label ?? 'output'} line ${String(index + 1)}`,
    });
  }
}

/** 영어가 남아 있는 줄들. 음성 사례를 쓰는 테스트가 쓴다. */
export function englishLines(text: string, options: KoreanOutputOptions = {}): readonly string[] {
  return text
    .split('\n')
    .filter((line) => englishSentences(authored(line), options).length > 0);
}
