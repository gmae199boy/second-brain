import type { ChannelStore } from './store.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';

/** 미인계 요청을 일감으로 옮긴다. 각 요청의 생성과 표식은 Store가 함께 확정한다. */
export async function handoffChannelRequests(store: ChannelStore, clock: Clock, idGen: IdGen): Promise<{ ok: true; count: number } | { ok: false; code: string; message: string }> {
  const pending = await store.listUnhandedChannelRequests();
  if (!pending.ok) return pending;
  let count = 0;
  for (const requestId of pending.requestIds) {
    const result = await store.handoffChannelRequest({ requestId, workId: idGen.next(), now: clock.now() });
    if (!result.ok) return result;
    if (result.workItemId !== null) count++;
  }
  return { ok: true, count };
}
