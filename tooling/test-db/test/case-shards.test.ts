import { expect, it } from 'vitest';
import { aggregateShardCases, shardModeForSource, casePattern, parseCollectedCases, validateShardResult } from '../src/slots/case-shards.js';
const report = (...rows: [string, string, string[]?][]) => ({ testResults: [{ assertionResults: rows.map(([title, status, ancestorTitles = []]) => ({ fullName: [...ancestorTitles, title].join(' '), title, ancestorTitles, status })) }] });
it('collects expanded names only when all cases are skipped', () => {
  expect(parseCollectedCases(report(['item 1', 'skipped', ['suite']], ['item 2', 'skipped', ['suite']]))).toEqual([{ fullName: 'suite item 1', filterName: 'suite > item 1' }, { fullName: 'suite item 2', filterName: 'suite > item 2' }]);
  for (const input of [report(), report(['', 'skipped']), report(['a', 'skipped'], ['a', 'skipped']), report(['a', 'passed']), report(['a > b', 'skipped'], ['b', 'skipped', ['a']])]) expect(() => parseCollectedCases(input)).toThrow();
});
it('escapes a full name into an anchored regular expression', () => {
  const name = 'suite . * + ? ^ $ { } ( ) | [ ] \\ %';
  const re = new RegExp(casePattern(name)); expect(re.test(name)).toBe(true); expect(re.test(`${name}x`)).toBe(false);
});
it('validates one selected case and ignores filtered cases', () => {
  const expected = [{ fullName: 'suite a', filterName: 'suite > a' }, { fullName: 'suite b', filterName: 'suite > b' }];
  expect(validateShardResult(report(['a', 'passed', ['suite']], ['b', 'skipped', ['suite']]), expected[0]!, expected)).toBe('passed');
  expect(() => validateShardResult(report(['a', 'skipped', ['suite']], ['b', 'skipped', ['suite']]), expected[0]!, expected)).toThrow('did not run');
  for (const input of [report(), report(['b', 'skipped', ['suite']]), report(['a', 'passed', ['suite']], ['a', 'passed', ['suite']]), report(['a', 'passed', ['suite']], ['b', 'passed', ['suite']])]) expect(() => validateShardResult(input, expected[0]!, expected)).toThrow();
  expect(() => validateShardResult(report(['a', 'skipped', ['suite']], ['b', 'skipped', ['suite']]), { fullName: 'missing', filterName: 'missing' }, expected)).toThrow();
});
it('uses file mode for forbidden modifier text, including comments and strings', () => {
  for (const modifier of ['skip', 'skipIf', 'runIf', 'todo', 'only', 'fails']) expect(shardModeForSource(`it.${modifier}('case', () => {})`)).toEqual({ shardMode: 'file', reason: 'forbidden-modifier-text' });
  for (const source of ["// .only is mentioned", "const note = '.only';"]) expect(shardModeForSource(source)).toEqual({ shardMode: 'file', reason: 'forbidden-modifier-text' });
  expect(shardModeForSource("it('case', () => {})")).toEqual({ shardMode: 'case', reason: 'allowlisted' });
});
it('aggregates only selected results and checks count', () => {
  expect(aggregateShardCases(['passed', 'failed', 'skipped'], 3)).toEqual({ pass: 1, fail: 1, skip: 1 });
  expect(() => aggregateShardCases(['passed'], 2)).toThrow();
});
