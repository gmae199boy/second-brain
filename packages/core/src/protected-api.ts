/** 인증된 전송이 제공될 때만 사용하는 제한된 사용자 데이터 경계다. */
export interface ProtectedDataPort {
  status(): Promise<{ available: boolean; requiresAction: boolean }>;
  listQueue(limit: number): Promise<readonly { id: string; kind: string; outcome: string | null }[]>;
  commands?: {
    cancel(id: string): ReturnType<import('./brain.js').BrainQueue['cancel']>;
    hold(group: string): ReturnType<import('./brain.js').BrainQueue['hold']>;
    disable(name: string): ReturnType<import('./brain.js').BrainExt['disable']>;
  };
}

export type ProtectedApiResult =
  | { ok: true; status: { available: boolean; requiresAction: boolean } }
  | { ok: true; items: { id: string; kind: string; outcome: string | null }[] }
  | { ok: true; id: string; state: 'cancelled' | 'requested' | 'already_closed' }
  | { ok: true; group: string; held: boolean }
  | { ok: true; name: string; enabled: false; changed: boolean }
  | { ok: false; code: 'INVALID_REQUEST' | 'SERVICE_UNAVAILABLE' | 'WORK_NOT_FOUND' | 'EXTENSION_NOT_FOUND' | 'DB_UNAVAILABLE' | 'DB_LOCKED' | 'USAGE'; message?: string };

function commandFailure(code: string): ProtectedApiResult {
  const messages: Readonly<Record<string,string>>={WORK_NOT_FOUND:'지정한 일감이 없습니다',EXTENSION_NOT_FOUND:'설치된 확장이 없습니다',DB_UNAVAILABLE:'저장소를 확인할 수 없습니다',DB_LOCKED:'저장소가 사용 중입니다',USAGE:'요청을 확인하세요'};
  if(Object.hasOwn(messages,code))return {ok:false,code:code as 'WORK_NOT_FOUND'|'EXTENSION_NOT_FOUND'|'DB_UNAVAILABLE'|'DB_LOCKED'|'USAGE',message:messages[code]!};
  return {ok:false,code:'SERVICE_UNAVAILABLE'};
}

/** 입력을 명령·SQL·경로·URL로 해석하지 않으며 오류 원문을 반환하지 않는다. */
export async function handleProtectedRequest(input: unknown, port: ProtectedDataPort): Promise<ProtectedApiResult> {
  let operation: string;
  let limit = 0;
  let valueText = '';
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
    } else if (operation === 'queue.cancel' || operation === 'queue.hold' || operation === 'extension.disable') {
      const key=operation==='queue.cancel'?'id':operation==='queue.hold'?'group':'name';
      const value=Object.getOwnPropertyDescriptor(input,key);
      if(fields.length!==2 || !value || !('value' in value) || typeof value.value!=='string' || !value.value || value.value.length>200) return {ok:false,code:'INVALID_REQUEST'};
      valueText=value.value;
    } else return { ok: false, code: 'INVALID_REQUEST' };
  } catch { return { ok: false, code: 'INVALID_REQUEST' }; }
  try {
    if (operation === 'status') {
      const result = await port.status();
      if (typeof result.available !== 'boolean' || typeof result.requiresAction !== 'boolean') return { ok: false, code: 'SERVICE_UNAVAILABLE' };
      return { ok: true, status: { available: result.available, requiresAction: result.requiresAction } };
    }
    if(operation==='queue.cancel' || operation==='queue.hold' || operation==='extension.disable') {
      if(!port.commands)return {ok:false,code:'SERVICE_UNAVAILABLE'};
      if(operation==='queue.cancel') {const result=await port.commands.cancel(valueText);if(!result.ok)return commandFailure(result.code);return {ok:true,id:result.id,state:result.state};}
      if(operation==='queue.hold') {const result=await port.commands.hold(valueText);if(!result.ok)return commandFailure(result.code);return {ok:true,group:result.group,held:result.held};}
      const result=await port.commands.disable(valueText);if(!result.ok)return commandFailure(result.code);return {ok:true,name:result.name,enabled:false,changed:result.changed};
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
  commands?: ProtectedDataPort['commands'],
): ProtectedDataPort {
  return {
    status,
    ...(commands ? { commands } : {}),
    async listQueue(limit) {
      const result = await queue.list({ limit });
      if (!result.ok) throw new Error('SERVICE_UNAVAILABLE');
      return result.items.map(item => ({ id: item.id, kind: item.kind, outcome: item.outcome }));
    },
  };
}

/** 보호 store로 조립한 기존 Brain의 명령을 명명된 API에 연결한다. */
export function protectedDataFromBrain(brain: Pick<import('./brain.js').Brain,'queue'|'ext'>, status: ProtectedDataPort['status']): ProtectedDataPort {
  return protectedDataFromCore(brain.queue,status,{
    cancel: id => brain.queue.cancel({id}), hold: group => brain.queue.hold({group}), disable: name => brain.ext.disable({name}),
  });
}

/** 사용자 프로세스는 명명된 조회만 전송한다. 실패 시 다른 저장소로 전환하지 않는다. */
type ProtectedRequest = { operation: 'status' } | { operation: 'queue.list'; limit: number } | { operation: 'queue.cancel'; id: string } | { operation: 'queue.hold'; group: string } | { operation: 'extension.disable'; name: string };
export function protectedDataClient(transport: { request(value: ProtectedRequest): Promise<ProtectedApiResult> }) {
  const send = async (request: ProtectedRequest): Promise<ProtectedApiResult> => {
    try { return await transport.request(request); }
    catch { return { ok: false, code: 'SERVICE_UNAVAILABLE' }; }
  };
  return {
    status: () => send({ operation: 'status' }),
    listQueue: (limit: number) => Number.isSafeInteger(limit) && limit >= 1 && limit <= 200
      ? send({ operation: 'queue.list', limit })
      : Promise.resolve({ ok: false as const, code: 'INVALID_REQUEST' as const }),
    cancel: (id: string) => send({operation:'queue.cancel',id}),
    hold: (group: string) => send({operation:'queue.hold',group}),
    disable: (name: string) => send({operation:'extension.disable',name}),
  };
}
