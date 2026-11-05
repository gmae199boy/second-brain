import type { UserStore } from '../ports/store.js';

/** Resolve the single local owner without creating one as a side effect. */
export async function resolveSelfUser(store: Pick<UserStore, 'readSelfUser'>): Promise<
  { ok: true; userId: string } | { ok: false; code: 'USER_MISSING' | 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string }
> {
  const result = await store.readSelfUser();
  if (!result.ok) return result;
  if (!result.user) return { ok: false, code: 'USER_MISSING', message: '이 데이터베이스에 주인이 기록되어 있지 않습니다' };
  return { ok: true, userId: result.user.id };
}
