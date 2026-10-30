/** LIKE의 와일드카드와 이스케이프 문자를 리터럴로 취급하는 검색 패턴. */
export function literalLikePattern(text: string): string {
  return `%${text.replaceAll('\0', '�').replace(/[\\%_]/g, '\\$&')}%`;
}
