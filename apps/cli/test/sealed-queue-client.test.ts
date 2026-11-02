import { expect, it, vi } from 'vitest';
import { sealedQueueList } from '../src/daemon/sealed-queue-client.js';
import { runQueueList } from '../src/commands/queue-list.js';
import { protectedQueueClient } from '../src/daemon/protected-queue.js';

it('기존 queue 목록 렌더러와 보호 요청의 결과를 공유하고 transport 부재 시 닫힌다', async () => {
  const request = vi.fn(async (_frame: string) => JSON.stringify({ ok: true, items: [], count: 0, hasMore: false }));
  const options = { all: true, kind: 'test', limit: '2' };
  expect(await sealedQueueList(options, {request})).toEqual(await runQueueList({options, queue: protectedQueueClient({request})}));
  expect(JSON.parse(request.mock.calls[0]![0] as string)).toEqual({operation:'queue.list.v1',all:true,kind:'test',limit:2});
  expect(await sealedQueueList(options)).toMatchObject({ok:false,code:'SERVICE_UNAVAILABLE'});
});
