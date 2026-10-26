import { describe, expect, it } from 'vitest';
import { externalLocator, externalPath, isExternalLocator } from '../src/domain/file.js';

describe('external 로컬 위치 코덱', () => {
  it.each([
    ['/h/u/a/b.md', '/h/u', '~/a/b.md', '/h/u/a/b.md'],
    ['/h/u/a/./c/../b.md', '/h/u/', '~/a/b.md', '/h/u/a/b.md'],
    ['/h/u//a', '/h/u', '~/a', '/h/u/a'],
    ['/h/u/a', '/h/./u//', '~/a', '/h/u/a'],
    ['/a', '/', '~/a', '/a'],
    ['/h/u/한글/e\u0301.md', '/h/u', '~/한글/e\u0301.md', '/h/u/한글/e\u0301.md'],
  ])('홈 아래 경로를 정규화하고 왕복한다: %s', (path, home, locator, normalized) => {
    expect(externalLocator(path, home)).toBe(locator);
    expect(isExternalLocator(locator)).toBe(true);
    expect(externalPath(locator, home)).toBe(normalized);
  });

  it.each([
    ['/tmp/x', '/h/u'], ['/Volumes/disk/x', '/h/u'], ['/h/u', '/h/u'],
    ['/h/u/', '/h/u/'], ['/h/user2/x', '/h/u'], ['/h/u/../v/x', '/h/u'],
    ['a/b', '/h/u'], ['/h/u/a', 'h/u'], ['/../h/u/a', '/h/u'],
    ['/h/u/a', '/../h/u'], ['/h/u/a\n', '/h/u'], ['/h/u/a', '/h/u\n'],
  ])('홈 자체와 홈 밖 또는 잘못된 경로를 거부한다: %s', (path, home) => {
    expect(externalLocator(path, home)).toBeNull();
  });

  it.each(['~/', '~/../x', '~/a/../b', '~/a/./b', '~/a//b', '~/a/', '/abs', 'a/b', '~/a\n'])('잘못된 locator를 거부한다: %s', locator => {
    expect(isExternalLocator(locator)).toBe(false);
    expect(externalPath(locator, '/h/u')).toBeNull();
  });

  it('모든 제어 문자를 거부한다', () => {
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
      const character = String.fromCharCode(code);
      expect(externalLocator(`/h/u/a${character}b`, '/h/u')).toBeNull();
      expect(externalLocator('/h/u/a', `/h/u${character}`)).toBeNull();
      expect(isExternalLocator(`~/a${character}b`)).toBe(false);
      expect(externalPath(`~/a${character}b`, '/h/u')).toBeNull();
      expect(externalPath('~/a', `/h/u${character}`)).toBeNull();
    }
    expect(externalPath('~/a', 'h/u')).toBeNull();
    expect(externalPath('~/a', '/../h/u')).toBeNull();
  });

});
