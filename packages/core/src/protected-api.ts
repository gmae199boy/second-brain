/** 인증된 전송이 제공될 때만 사용하는 제한된 사용자 데이터 경계다. */
export interface ProtectedDataPort {
  status(): Promise<{ available: boolean; requiresAction: boolean }>;
  listQueue(limit: number): Promise<readonly { id: string; kind: string; outcome: string | null }[]>;
}

export type ProtectedApiResult =
  | { ok: true; status: { available: boolean; requiresAction: boolean } }
  | { ok: true; items: { id: string; kind: string; outcome: string | null }[] }
  | { ok: false; code: 'INVALID_REQUEST' | 'SERVICE_UNAVAILABLE' };

/** 입력을 명령·SQL·경로·URL로 해석하지 않으며 오류 원문을 반환하지 않는다. */
export async function handleProtectedRequest(input: unknown, port: ProtectedDataPort): Promise<ProtectedApiResult> {
  let operation: string;
  let limit = 0;
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return { ok: false, code: 'INVALID_REQUEST' };
    const fields = Reflect.ownKeys(input);
    const op = Object.getOwnPropertyDescriptor(input, 'operation');
    if (!op || !('value' in op) || typeof op.value !== 'string') return { ok: false, code: 'INVALID_REQUEST' };
    operation = op.value;
    if (operation === 'status') {
      if (fields.length !== 1) return { ok: false, code: 'INVALID_REQUEST' };
    } else if (operation === 'queue.list') {
      const value = Object.getOwnPropertyDescriptor(input, 'limit');
      if (fields.length !== 2 || !value || !('value' in value) || !Number.isSafeInteger(value.value) || value.value < 1 || value.value > 200) return { ok: false, code: 'INVALID_REQUEST' };
      limit = value.value;
    } else return { ok: false, code: 'INVALID_REQUEST' };
  } catch { return { ok: false, code: 'INVALID_REQUEST' }; }
  try {
    if (operation === 'status') {
      const result = await port.status();
      if (typeof result.available !== 'boolean' || typeof result.requiresAction !== 'boolean') return { ok: false, code: 'SERVICE_UNAVAILABLE' };
      return { ok: true, status: { available: result.available, requiresAction: result.requiresAction } };
    }
    const result = await port.listQueue(limit);
    if (!Array.isArray(result) || result.length > limit || result.some(item => typeof item.id !== 'string' || typeof item.kind !== 'string' || (item.outcome !== null && typeof item.outcome !== 'string'))) return { ok: false, code: 'SERVICE_UNAVAILABLE' };
    return { ok: true, items: result.map(({ id, kind, outcome }) => ({ id, kind, outcome })) };
  } catch { return { ok: false, code: 'SERVICE_UNAVAILABLE' }; }
}

/** 기존 Core 명령 operation만 어댑터에 연결한다. Store 전체는 내보내지 않는다. */
export function protectedDataFromCore(
  queue: Pick<import('./brain.js').BrainQueue, 'list'>,
  status: ProtectedDataPort['status'],
): ProtectedDataPort {
  return {
    status,
    async listQueue(limit) {
      const result = await queue.list({ limit });
      if (!result.ok) throw new Error('SERVICE_UNAVAILABLE');
      return result.items.map(item => ({ id: item.id, kind: item.kind, outcome: item.outcome }));
    },
  };
}

/** 사용자 프로세스는 명명된 조회만 전송한다. 실패 시 다른 저장소로 전환하지 않는다. */
export function protectedDataClient(transport: { request(value: { operation: 'status' } | { operation: 'queue.list'; limit: number }): Promise<ProtectedApiResult> }) {
  const send = async (request: { operation: 'status' } | { operation: 'queue.list'; limit: number }): Promise<ProtectedApiResult> => {
    try { return await transport.request(request); }
    catch { return { ok: false, code: 'SERVICE_UNAVAILABLE' }; }
  };
  return {
    status: () => send({ operation: 'status' }),
    listQueue: (limit: number) => Number.isSafeInteger(limit) && limit >= 1 && limit <= 200
      ? send({ operation: 'queue.list', limit })
      : Promise.resolve({ ok: false as const, code: 'INVALID_REQUEST' as const }),
  };
}
