import { randomUUID } from 'node:crypto';
/** 보호 서비스 내부 port다. 사용자 데이터 API에 attempt 신원이나 증거 쓰기를 노출하지 않는다. */
export type ProtectedMutation = ({ type: 'cancel'; id: string } | { type: 'hold'; group: string } | { type: 'disable'; extension: string }) & { at?: string };
export type ProtectedMutationResult = { type: 'cancel'; state: 'requested' } | { type: 'hold'; held: boolean } | { type: 'disable'; found: boolean; changed: boolean };
export interface ProtectedAttempt {
  work: string; token: string; run: number; state: 'pending' | 'spawning' | 'closed';
  lease: string | null; epoch: number | null; revoked: boolean;
}
export interface ProtectedMutationStore {
  list(action: ProtectedMutation): Promise<readonly ProtectedAttempt[] | null>;
  /** 재조회와 증거·mutation은 동일 transaction에서 원자 처리한다. */
  commit(action: ProtectedMutation, attempts: readonly ProtectedAttempt[], request: string): Promise<{ status: 'committed'; result: ProtectedMutationResult } | { status: 'changed' | 'unknown' }>;
  applied(action: ProtectedMutation, attempts: readonly ProtectedAttempt[], request: string): Promise<ProtectedMutationResult | null>;
}
export interface ProtectedAttemptRevoker { revoke(attempt: ProtectedAttempt): Promise<boolean> }

/** 각 ACK를 받은 뒤에만 증거를 commit한다. 연결·세대 불명은 재사용하지 않는다. */
export function protectedMutations(store: ProtectedMutationStore, revoker: ProtectedAttemptRevoker) {
  const executeResult = async (action: ProtectedMutation): Promise<ProtectedMutationResult | null> => {
      const request=randomUUID();
      try {
        // [ASSUMPTION] claim 경합은 세 번 재조회하고 계속 바뀌면 실패 닫힘이다.
        for (let round = 0; round < 3; round++) {
          const attempts = await store.list(action); if (!attempts) return null;
          for (const attempt of attempts) {
            if (attempt.state === 'closed' || attempt.revoked || attempt.state === 'pending') continue;
            if (!attempt.lease || !attempt.epoch || !(await revoker.revoke(attempt))) return null;
          }
          const result = await store.commit(action, attempts, request);
          if (result.status === 'committed') return result.result;
          if (result.status === 'unknown') return await store.applied(action, attempts, request);
        }
      } catch { /* 결과 불명은 입력을 다시 열지 않는다. */ }
      return null;
  };
  return {
    executeResult,
    async execute(action: ProtectedMutation): Promise<'done' | 'unavailable'> {return await executeResult(action)?'done':'unavailable';},
  };
}
