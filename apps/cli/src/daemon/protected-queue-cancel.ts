import type { Brain } from 'second_brain';
import { parseFrame } from './protected-queue.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const failureMessages = {
  WORK_NOT_FOUND: '지정한 일감이 없습니다',
  DB_UNAVAILABLE: '저장소를 확인할 수 없습니다',
  DB_LOCKED: '저장소가 사용 중입니다',
} as const;

/** 내부 취소 use case만 호출한다. 별도 전송과 권한 연결 전에는 외부에 노출하지 않는다. */
export async function handleQueueCancelFrame(raw: string, queue: Pick<Brain['queue'], 'cancel'>): Promise<string> {
  let id: string;
  try {
    const value = parseFrame(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request');
    const request = value as Record<string, unknown>;
    if (Object.keys(request).length !== 2 || request.operation !== 'queue.cancel.v1' || typeof request.id !== 'string' || !uuid.test(request.id)) throw new Error('request');
    id = request.id;
  } catch { return JSON.stringify({ok:false,code:'INVALID_REQUEST'}); }
  try {
    const result = await queue.cancel({id});
    if (!result.ok) {
      if (!Object.hasOwn(failureMessages, result.code)) throw new Error('result');
      return JSON.stringify({ok:false,code:result.code,message:failureMessages[result.code]});
    }
    if (result.id !== id || !['cancelled','requested','already_closed'].includes(result.state)) throw new Error('result');
    return JSON.stringify({ok:true,id,state:result.state});
  } catch { return JSON.stringify({ok:false,code:'DB_UNAVAILABLE',message:failureMessages.DB_UNAVAILABLE}); }
}
