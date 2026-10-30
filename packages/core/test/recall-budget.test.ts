import { describe, expect, it } from 'vitest';
import { budgetResults } from '../src/recall/results.js';

const body = { get: (row: { body: string }) => row.body, set: (row: { body: string }, value: string) => ({ ...row, body: value }) };
const size = (value: unknown) => Array.from(JSON.stringify(value)).length;

describe('검색 결과 예산', () => {
  it('하위 행을 먼저 생략한다', () => {
    const result = budgetResults([{ body: '첫째' }, { body: '둘째' }], body, 18);
    expect(result).toMatchObject({ ok: true, data: [{ body: '첫째' }], omitted: 1, nextIndex: 1 });
  });
  it('이모지와 이스케이프를 직렬화한 크기로 세고 첫 본문을 자른다', () => {
    const result = budgetResults([{ body: '😀"'.repeat(100) }], body, 30);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(size(result.data)).toBeLessThanOrEqual(30); expect(result.nextIndex).toBe(0); }
  });
  it('가림 표식 중간에서 자르지 않는다', () => {
    const result = budgetResults([{ body: '앞[REDACTED:secret]뒤' }], body, 20);
    expect(result).toMatchObject({ ok: true, data: [{ body: '앞' }], truncated: true });
  });
  it('출처만으로도 초과하면 실패한다', () => {
    const result = budgetResults([{ body: '', source: '긴 출처입니다' }], { get: r => r.body, set: (r, value) => ({ ...r, body: value }) }, 10);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  });
});

it('8,000자 경계와 가림 후 증가를 직렬화 기준으로 센다', () => {
  for (const n of [7986, 7987, 7988]) {
    const value = [{ body: '가'.repeat(n) }];
    const result = budgetResults(value, body);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(size(result.data)).toBeLessThanOrEqual(8000); expect(result.truncated).toBe(size(value) > 8000); }
  }
  const masked = budgetResults([{ body: 'x'.repeat(7970) + ' password=a' }], body);
  expect(masked.ok && size(masked.data)).toBeLessThanOrEqual(8000);
});
