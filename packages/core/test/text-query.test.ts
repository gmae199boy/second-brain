import { describe, expect, it } from 'vitest';
import { literalLikePattern } from '../src/recall/text-query.js';

describe('literalLikePattern', () => {
  it('LIKE 특수 문자를 이스케이프하고 부분 문자열을 찾는다', () => {
    expect(literalLikePattern('한글%_\\Ab')).toBe('%한글\\%\\_\\\\Ab%');
    expect(literalLikePattern('가\0나')).toBe('%가�나%');
  });
});
