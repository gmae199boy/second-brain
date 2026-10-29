import { expect, it, vi } from 'vitest';
import { enqueueWorkGraph, type WorkGraphNode } from '../src/queue/work-graph.js';
import { memoryStore, sequenceIdGen } from '../src/testing/index.js';
const now = new Date('2026-02-03T04:05:06Z');
const node = (key: string, after: string[] = []): WorkGraphNode => ({ key, after, kind: 'analysis', targetKind: 'period', targetId: key });
function kit() {
  const store = memoryStore();
  return { store, clock: { now: vi.fn(() => now) }, idGen: sequenceIdGen({ timestampMs: now.getTime() }) };
}
it.each([
  [], [node('a'), node('a')], [node('a', ['missing'])], [node('a', ['b']), node('b', ['a'])],
  [node('a'), { ...node('b'), targetId: 'a' }],
])('rejects invalid graphs before calling the store: %j', async (...nodes) => {
  const k = kit(); const add = vi.spyOn(k.store, 'addWorkGraph');
  expect(await enqueueWorkGraph(k, { nodes })).toMatchObject({ ok: false, code: 'WORK_GRAPH_INVALID' });
  expect(add).not.toHaveBeenCalled(); expect(k.clock.now).not.toHaveBeenCalled();
});
it('sorts a shuffled chain and only claims each node after success', async () => {
  const k = kit(); const nodes = [node('all', ['30d']), node('7d', ['day']), node('30d', ['7d']), node('day')];
  const result = await enqueueWorkGraph(k, { nodes }); expect(result.ok).toBe(true); if (!result.ok) return;
  expect(k.clock.now).toHaveBeenCalledTimes(1);
  expect(k.store.snapshot().workItems.map(i => i.targetId)).toEqual(['day', '7d', '30d', 'all']);
  for (const targetId of ['day', '7d', '30d', 'all']) {
    const claim = await k.store.claimWork({ now, kinds: ['analysis'], claimedBy: 'worker' });
    expect(claim).toMatchObject({ ok: true, item: { targetId, id: result.items[targetId]!.id } });
    expect(await k.store.claimWork({ now, kinds: ['analysis'], claimedBy: 'other' })).toEqual({ ok: true, item: null });
    if (claim.ok && claim.item) await k.store.completeWork({ id: claim.item.id, claimedBy: 'worker', now });
  }
});
it('keeps input order among nodes at the same stage', async () => {
  const k = kit(); await enqueueWorkGraph(k, { nodes: [node('c', ['a']), node('b'), node('a')] });
  expect(k.store.snapshot().workItems.map(i => i.targetId)).toEqual(['b', 'a', 'c']);
});
it('returns the existing id and created false for merged work', async () => {
  const k = kit(); const first = await enqueueWorkGraph(k, { nodes: [node('a')] });
  expect(await enqueueWorkGraph(k, { nodes: [node('a')] })).toEqual(first.ok ? { ok: true, items: { a: { ...first.items.a, created: false } } } : first);
});
it('passes store failures through unchanged', async () => {
  const k = kit(); const failure = { ok: false as const, code: 'DB_LOCKED' as const, message: 'locked' };
  k.store.addWorkGraph = async () => failure;
  expect(await enqueueWorkGraph(k, { nodes: [node('a')] })).toBe(failure);
});
