import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { AddWorkGraphResult, WorkStore } from '../ports/store.js';

export interface WorkGraphNode {
  serializationKey?: string | null;
  key: string; kind: string; targetKind: string; targetId: string; after: readonly string[];
}
export type EnqueueWorkGraphResult =
  | { ok: true; items: Record<string, { id: string; created: boolean }> }
  | Extract<AddWorkGraphResult, { ok: false }>
  | { ok: false; code: 'WORK_GRAPH_INVALID'; message: string };

/** Validate before touching the store, then insert the whole graph atomically. */
export async function enqueueWorkGraph({ store, clock, idGen }: {
  store: Pick<WorkStore, 'addWorkGraph'>; clock: Clock; idGen: IdGen;
}, { nodes }: { nodes: readonly WorkGraphNode[] }): Promise<EnqueueWorkGraphResult> {
  const invalid = (): EnqueueWorkGraphResult => ({ ok: false, code: 'WORK_GRAPH_INVALID', message: '일감 의존 그래프가 올바르지 않습니다' });
  const byKey = new Map(nodes.map(node => [node.key, node]));
  if (nodes.length === 0 || byKey.size !== nodes.length ||
    new Set(nodes.map(node => JSON.stringify([node.kind, node.targetKind, node.targetId]))).size !== nodes.length ||
    nodes.some(node => node.after.some(key => !byKey.has(key)))) return invalid();
  const ordered: WorkGraphNode[] = [];
  const indices = new Map<string, number>();
  while (ordered.length < nodes.length) {
    const ready = nodes.filter(node => !indices.has(node.key) && node.after.every(key => indices.has(key)));
    if (ready.length === 0) return invalid();
    for (const node of ready) { indices.set(node.key, ordered.length); ordered.push(node); }
  }
  const now = clock.now();
  const result = await store.addWorkGraph({ nodes: ordered.map(node => ({
    id: idGen.next(), kind: node.kind, targetKind: node.targetKind, targetId: node.targetId,
    serializationKey: node.serializationKey, createdAt: now, nextAttemptAt: now, after: node.after.map(key => indices.get(key)!),
  })) });
  if (!result.ok) return result;
  return { ok: true, items: Object.fromEntries(ordered.map((node, index) => [node.key, {
    id: result.items[index]!.item.id, created: result.items[index]!.created,
  }])) };
}
