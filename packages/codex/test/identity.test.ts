import { describe, expect, it } from 'vitest';
import { codexParser } from '../src/parser.js';

const line = (row: unknown) => JSON.stringify(row) + '\n';
const meta = (cwd?: unknown, branch?: string) => ({ type: 'session_meta', payload: { id: 'synthetic', cwd, ...(branch ? { git: { branch } } : {}) } });
const turn = (cwd: string) => ({ type: 'turn_context', payload: { cwd } });
const message = { timestamp: '2026-01-01T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } };

function parse(...rows: unknown[]) {
  const result = codexParser().parse(rows.map(line).join(''));
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe('Codex start identity evidence', () => {
  it.each([undefined, 'other-branch'])('keeps the first metadata cwd independently of turn and branch %s', branch => {
    const result = parse(meta('/synthetic/start', branch), meta('/synthetic/later', 'later'), turn('/synthetic/turn'), message);
    expect(result.startCwd).toBe('/synthetic/start');
    expect(result.messages[0]).toMatchObject({ cwd: '/synthetic/turn', gitBranch: branch ?? 'later' });
  });
  it.each([undefined, '', '   ', null, 123])('does not replace missing first metadata cwd (%s) with later metadata', cwd => {
    const result = parse(meta(cwd), meta('/synthetic/later'), turn('/synthetic/turn'), message);
    expect(result.startCwd).toBeNull();
    expect(result.messages[0]?.cwd).toBe('/synthetic/turn');
  });
  it('preserves start evidence and turn cwd through ID reconciliation and a prefix rewrite', () => {
    const parser = codexParser();
    const initial = [meta('/synthetic/start'), turn('/synthetic/turn'), message].map(line).join('');
    const first = parser.reconcile!(initial, null, []).result;
    if (!first.ok) throw new Error(first.message);
    const rewritten = [meta('/synthetic/start'), { type: 'event_msg', payload: {} }, turn('/synthetic/turn'), message].map(line).join('');
    const next = parser.reconcile!(rewritten, first.cursor, first.messages.map(m => m.harnessMessageId)).result;
    if (!next.ok) throw new Error(next.message);
    expect(next).toMatchObject({ startCwd: '/synthetic/start', cursorReset: true });
    expect(next.messages[0]).toMatchObject({ cwd: '/synthetic/turn', harnessMessageId: first.messages[0]!.harnessMessageId });
    expect(next.cursor?.lastHarnessMessageId).toBe(first.messages[0]!.harnessMessageId);
  });
});
