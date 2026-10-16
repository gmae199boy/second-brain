import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exitCodeGuide } from 'second_brain';

/**
 * The README's three code tables against the Core constants, both ways.
 *
 * Both ways is the whole point. A test that only checked "every code in the
 * code is in the document" would pass a document that still lists a code
 * somebody removed, and one that only checked the other direction would pass a
 * document missing the code added last week. An agent reading either is being
 * told something untrue, and the document is the half nothing else tests.
 *
 * The parser is deliberately small and strict: it finds the heading, takes the
 * next Markdown table, and fails if that table has no rows. A table that
 * matched nothing would otherwise make this test agree with an empty document.
 */

const readmePath = fileURLToPath(new URL('../../../README.md', import.meta.url));
const readme = readFileSync(readmePath, 'utf8');

/** The cells of one table row, with the backticks around a code removed. */
function cells(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim().replace(/^`(.*)`$/, '$1'));
}

/**
 * The rows of the first Markdown table under one heading. The header row and
 * the `| --- |` separator are dropped; everything until the first line that is
 * not a row is taken.
 */
function tableUnder(heading: string): string[][] {
  const at = readme.indexOf(`\n${heading}\n`);
  expect(at, `${heading}이 README에 없습니다`).toBeGreaterThan(-1);

  const lines = readme.slice(at + 1).split('\n');
  const start = lines.findIndex((line) => line.startsWith('|'));
  expect(start, `${heading} 아래에 표가 없습니다`).toBeGreaterThan(-1);

  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(cells(line));
  }
  // A table of nothing would make every comparison below vacuously true.
  expect(rows.length, `${heading}의 표가 0행입니다`).toBeGreaterThan(0);
  return rows;
}

const guide = exitCodeGuide();

describe('the README exit code table', () => {
  it('lists exactly the rows the code has, with the same meanings and actions', () => {
    const rows = tableUnder('## 종료 코드');

    expect(rows.map((row) => row[0])).toEqual(guide.exit_codes.map((row) => row.code));
    expect(rows.map((row) => row.slice(1))).toEqual(
      guide.exit_codes.map((row) => [row.meaning, row.agent_action]),
    );
  });

  it('says what a hook path does with an exit code, which no number covers', () => {
    const rows = tableUnder('## 종료 코드');

    // The row that is not an exit code but the rule that overrides every one
    // of them (AD-6): a reader told only about 0 through 3 would read a hook's
    // 0 as success.
    expect(rows.map((row) => row[0])).toContain('hook');
  });
});

describe('the README error code table', () => {
  it('lists exactly the codes the code has, with the same exit code', () => {
    const rows = tableUnder('### 오류 코드');

    const documented = rows.map((row) => [row[0], Number(row[1])]);
    const known = guide.error_codes.map((row) => [row.code, row.exit_code]);
    // Both directions at once: same set, same order, same exit code.
    expect(documented).toEqual(known);
  });

  it('says the same thing about each code as the code does', () => {
    const rows = tableUnder('### 오류 코드');

    expect(rows.map((row) => row[2])).toEqual(guide.error_codes.map((row) => row.meaning));
  });
});

describe('the README warning code table', () => {
  it('lists exactly the codes the code has, with the same meanings', () => {
    const rows = tableUnder('### 경고 코드');

    expect(rows.map((row) => row[0])).toEqual(guide.warning_codes.map((row) => row.code));
    expect(rows.map((row) => row[1])).toEqual(guide.warning_codes.map((row) => row.meaning));
  });
});

describe('the table parser', () => {
  it('fails on a heading that is not there, rather than finding nothing', () => {
    expect(() => tableUnder('## 없는 절')).toThrow();
  });
});
