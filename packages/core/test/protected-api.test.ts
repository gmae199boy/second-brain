import { expect, it } from 'vitest';
import { handleProtectedRequest, protectedDataFromCore, protectedDataClient } from '../src/protected-api.js';

it('명명된 조회만 허용하고 임의 명령과 추가 필드는 호출하지 않는다', async () => {
  let calls = 0;
  const port = { async status() { calls++; return { available: true, requiresAction: false }; }, async listQueue() { calls++; return [{ id: 'fixture', kind: 'test', outcome: null, token: '비공개' }]; } };
  const hidden = Object.defineProperty({ operation: 'status' }, 'sql', { value: 'fixture' });
  for (const input of [hidden, null, 'select 1', { operation: 'sql' }, { operation: 'status', url: 'fixture' }, { operation: 'status', path: 'fixture' }, { operation: 'status', code: 'fixture' }, { operation: 'queue.list', limit: 201 }, { operation: 'queue.list', limit: 1, sql: 'fixture' }]) {
    expect(await handleProtectedRequest(input, port)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
  }
  expect(calls).toBe(0);
  expect(await handleProtectedRequest({ operation: 'status' }, port)).toEqual({ ok: true, status: { available: true, requiresAction: false } });
  expect(await handleProtectedRequest({ operation: 'queue.list', limit: 1 }, port)).toEqual({ ok: true, items: [{ id: 'fixture', kind: 'test', outcome: null }] });
  expect(calls).toBe(2);
});

it('보호 서비스 오류는 고정 코드로 닫힌다', async () => {
  expect(await handleProtectedRequest({ operation: 'status' }, { async status() { throw new Error('fixture-secret'); }, async listQueue() { return []; } })).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
});

it('queue 조회는 Core operation만 호출하고 내부 attempt 식별자를 제외한다', async () => {
  let limit = 0;
  const queue = { async list(input?: { limit?: number }) { limit = input?.limit ?? 0; return { ok: true, items: [{ id: 'id', kind: 'kind', outcome: null, currentAttemptToken: 'secret' }], count: 1, hasMore: false }; } } as unknown as Pick<import('../src/brain.js').BrainQueue, 'list'>;
  const port = protectedDataFromCore(queue, async () => ({ available: true, requiresAction: false }));
  expect(await handleProtectedRequest({ operation: 'queue.list', limit: 2 }, port)).toEqual({ ok: true, items: [{ id: 'id', kind: 'kind', outcome: null }] });
  expect(limit).toBe(2);
});

it('서비스가 없으면 클라이언트는 고정 실패를 반환하고 재시도나 저장소 fallback을 하지 않는다', async () => {
  let calls = 0;
  const client = protectedDataClient({ async request() { calls++; throw new Error('fixture-secret'); } });
  expect(await client.status()).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
  expect(await client.listQueue(201)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
  expect(calls).toBe(1);
});
