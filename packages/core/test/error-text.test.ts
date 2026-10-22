import { describe, expect, it } from 'vitest';
import { errorLine, describeError } from '../src/error-text.js';

const coded = Object.assign(new Error(''), { code: ' E\nsecond ', name: 'Named' });
const unnamed = Object.assign(new Error(''), { name: '' });
describe('error text preserves the original helper contracts', () => {
  it.each([
    [new Error(' a\nb '), 'a', ' a\nb '],
    [new Error(''), '', 'Error'],
    [coded, '', ' E\nsecond '],
    [unnamed, '', '알 수 없는 오류'],
    [' x\ny ', 'x', ' x\ny '],
    ['', '', ''], [undefined, 'undefined', 'undefined'],
    [null, 'null', 'null'], [{ code: 'E' }, '[object Object]', '[object Object]'],
  ])('formats %s', (input, line, description) => {
    expect(errorLine(input)).toBe(line);
    expect(describeError(input)).toBe(description);
  });
});
