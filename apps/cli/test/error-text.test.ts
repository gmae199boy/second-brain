import { describe, expect, it } from 'vitest';
import { describeErrorLine, oneLine } from '../src/error-text.js';

describe('CLI error text preserves first-line trimming', () => {
  it.each([
    [new Error(' a\nb '), 'a'], [new Error(''), 'Error'],
    [Object.assign(new Error(' \nmessage'), { code: ' E\nnext ', name: 'Named' }), ' E\nnext '],
    [Object.assign(new Error(''), { name: '' }), '알 수 없는 오류'],
    [' x\ny ', 'x'], ['', ''], [undefined, 'undefined'], [null, 'null'],
    [{ code: 'E' }, '[object Object]'],
  ])('describes %s', (input, expected) => expect(describeErrorLine(input)).toBe(expected));
  it.each([[' a\nb ', 'a'], ['', ''], ['\na', ''], ['  ', '']])(
    'takes the first string line %s', (text, expected) => expect(oneLine(text)).toBe(expected),
  );
});
