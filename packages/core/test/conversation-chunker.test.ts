import { describe, expect, it } from 'vitest';
import { chunkConversation } from '../src/recall/conversation-chunker.js';
const params = { targetChars: 5, overlapMessages: 1, splitMessagesOverChars: 10 };
const msg = (id: string, second: number, body: string) => ({ id, occurredAt: new Date(`2026-01-01T00:00:0${second}Z`), body });
describe('대화 조각 경계', () => {
  it('목표를 넘긴 시각 묶음까지 담고 이전 메시지를 겹친다', () => {
    const chunks = chunkConversation([msg('a', 1, 'aa'), msg('b', 2, 'bb'), msg('c', 3, 'cc')], params);
    expect(chunks.map(c => c.body)).toEqual(['aa\nbb', 'bb\ncc']);
    expect(chunks.map(c => c.part)).toEqual([0, 0]);
  });
  it('동시각을 나누지 않고 코드 포인트로 센다', () => {
    const chunks = chunkConversation([msg('b', 1, '🙂🙂'), msg('a', 1, '가'), msg('c', 2, '다')], { ...params, targetChars: 3 });
    expect(chunks.map(c => c.body)).toEqual(['가\n🙂🙂', '가\n🙂🙂\n다']);
  });
  it('긴 본문을 제한 크기로 나누고 범위별 part를 연속으로 매긴다', () => {
    const chunks = chunkConversation([msg('a', 1, 'x'.repeat(5000))], { targetChars: 1200, overlapMessages: 1, splitMessagesOverChars: 2400 });
    expect(chunks.map(c => [c.body.length, c.part])).toEqual([[2400, 1], [2400, 2], [200, 3]]);
  });
  it('잘못된 설정을 거부한다', () => expect(() => chunkConversation([], { ...params, targetChars: 0 })).toThrow());
});

it('설정별 겹침과 한 시각의 여러 긴 메시지 part를 정한다', () => {
  const noOverlap = chunkConversation([msg('a', 1, 'aa'), msg('b', 2, 'bb'), msg('c', 3, 'cc')], { ...params, overlapMessages: 0 });
  expect(noOverlap.map(c => c.body)).toEqual(['aa\nbb', 'cc']);
  const sameTime = chunkConversation([msg('b', 1, 'b'.repeat(11)), msg('a', 1, 'a'.repeat(11)), msg('c', 1, '짧음')], params);
  expect(sameTime.map(c => [c.body, c.part])).toEqual([['a'.repeat(10), 1], ['a', 2], ['a'.repeat(11) + '\n' + 'b'.repeat(10), 3], ['b', 4], ['a'.repeat(11) + '\n' + 'b'.repeat(11) + '\n짧음', 5]]);
});

it('기본 1200 경계와 다른 목표·겹침 설정을 적용한다', () => {
  const input = [msg('a', 1, '가'.repeat(599)), msg('b', 2, '🙂'.repeat(600)), msg('c', 3, '다')];
  const standard = chunkConversation(input, { targetChars: 1200, overlapMessages: 1, splitMessagesOverChars: 2400 });
  expect(standard.map(c => c.body)).toEqual(['가'.repeat(599) + '\n' + '🙂'.repeat(600), '🙂'.repeat(600) + '\n다']);
  const alternate = chunkConversation(input, { targetChars: 600, overlapMessages: 0, splitMessagesOverChars: 2400 });
  expect(alternate.map(c => c.body)).toEqual(['가'.repeat(599) + '\n' + '🙂'.repeat(600), '다']);
});

it('긴 메시지 앞뒤와 연속 긴 메시지 사이에 원래 메시지를 겹친다', () => {
  const a = msg('a', 1, 'A'), b = msg('b', 2, 'b'.repeat(11)), c = msg('c', 3, 'C');
  const chunks = chunkConversation([a, b, c], params);
  expect(chunks.map(c => [c.body, c.fromAt, c.toAt, c.part])).toEqual([
    ['A', a.occurredAt, a.occurredAt, 0],
    ['A\n' + 'b'.repeat(10), a.occurredAt, b.occurredAt, 0],
    ['b', b.occurredAt, b.occurredAt, 0],
    ['b'.repeat(11) + '\nC', b.occurredAt, c.occurredAt, 0],
  ]);
  const d = msg('d', 3, 'd'.repeat(11));
  expect(chunkConversation([b, d], params).map(c => c.body)).toEqual([
    'b'.repeat(10), 'b', 'b'.repeat(11) + '\n' + 'd'.repeat(10), 'd',
  ]);
});

it('긴 메시지와 같은 시각의 일반 메시지가 목표를 넘으면 다음 시각 전에 닫는다', () => {
  const b = msg('b', 1, 'b'.repeat(5000)); const c = msg('c', 1, 'c'.repeat(1200)); const d = msg('d', 2, 'D');
  const chunks = chunkConversation([b, c, d], { targetChars: 1200, overlapMessages: 1, splitMessagesOverChars: 2400 });
  expect(chunks.map(c => [c.body, c.fromAt, c.toAt, c.part])).toEqual([
    ['b'.repeat(2400), b.occurredAt, b.occurredAt, 1],
    ['b'.repeat(2400), b.occurredAt, b.occurredAt, 2],
    ['b'.repeat(200), b.occurredAt, b.occurredAt, 3],
    ['b'.repeat(5000) + '\n' + 'c'.repeat(1200), b.occurredAt, c.occurredAt, 4],
    ['b'.repeat(5000) + '\n' + 'c'.repeat(1200) + '\nD', b.occurredAt, d.occurredAt, 0],
  ]);
});
