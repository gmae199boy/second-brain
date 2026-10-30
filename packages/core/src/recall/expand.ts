import { maskOutputText } from '../output/mask.js';
import { validRecallTime } from './time.js';
import type { SessionStore } from '../ports/store.js';
import { boundedResults } from './results.js';
export interface ExpandInput { session: string; ranges?: { from_at: string; to_at: string }[]; from_at?: string; to_at?: string; before?: number; after?: number }
export async function expandRecall(store: SessionStore, input: ExpandInput) {
  // [ASSUMPTION] 앞뒤 문맥은 각각 기본 두 건, 최대 100건이다.
  const before = input.before ?? 2, after = input.after ?? 2;
  const ranges = input.ranges ?? (input.from_at && input.to_at ? [{ from_at: input.from_at, to_at: input.to_at }] : []);
  if (!input.session || maskOutputText(input.session) !== input.session || !Array.isArray(ranges) || !ranges.length || ![before, after].every(n => Number.isInteger(n) && n >= 0 && n <= 100) || ranges.some(r => !r || typeof r.from_at !== 'string' || typeof r.to_at !== 'string' || !validRecallTime(r.from_at) || !validRecallTime(r.to_at) || Date.parse(r.from_at) > Date.parse(r.to_at))) return { ok: false as const, code: 'INVALID_ARGUMENT', message: '세션, 시각 범위 또는 문맥 개수가 올바르지 않습니다' };
  const read = await store.readSession(input.session); if (!read.ok) return read;
  const messages = [...read.messages].sort((a,b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  const selected = new Set<string>();
  for (const range of ranges) { const indices = messages.flatMap((m,i) => m.occurredAt.getTime() >= Date.parse(range.from_at) && m.occurredAt.getTime() <= Date.parse(range.to_at) ? [i] : []); if (indices.length) for (let i = Math.max(0, indices[0]! - before); i <= Math.min(messages.length - 1, indices[indices.length - 1]! + after); i++) selected.add(messages[i]!.id); }
  const rows = messages.filter(m => selected.has(m.id)).map(m => ({ id: m.id, session: input.session, occurred_at: m.occurredAt.toISOString(), role: m.role, body: m.body }));
  return boundedResults(rows, { get: r => r.body, set: (r, body) => ({ ...r, body }) }, result => ({ warnings: result.truncated ? ['RESULT_TRUNCATED' as const] : [], meta: { count: result.data.length, has_more: result.truncated, ...(result.truncated ? { omitted: { count: result.omitted, reason: '결과 크기 한도' }, next: { ns: 'sessions', verb: 'read', args: { session: input.session, from_at: rows[result.nextIndex ?? 0]?.occurred_at } } } : {}), ...(rows.length === 0 ? { hint: '해당 구간에 메시지가 없습니다' } : {}) } }), data => data.length ? data.map(r => `시각 ${r.occurred_at} ${r.role}: ${r.body}`) : ['해당 구간에 메시지가 없습니다']);
}
