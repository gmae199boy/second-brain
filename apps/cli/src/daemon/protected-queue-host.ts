import { randomUUID } from 'node:crypto';

/** 제품 보호 supervisor 내부에서만 공급한다. 불명은 저장되어 다음 시작을 막는다. */
export interface QueueHostFence {
  begin(token: string): Promise<boolean>;
  settle(token: string, confirmed: boolean): Promise<boolean>;
}
export interface QueueHostRunner { run(request: string): Promise<{cleanup:'confirmed'|'unknown'; response?:string}> }
export async function serveProtectedQueueHost(fence: QueueHostFence, host: QueueHostRunner, request: string): Promise<string | undefined> {
  const token=randomUUID();
  try {
    if(!await fence.begin(token))return undefined;
    let result: Awaited<ReturnType<QueueHostRunner['run']>>={cleanup:'unknown'};
    try {result=await host.run(request);} catch { /* 시작 또는 종료 불명은 영속 fence를 유지한다. */ }
    if(!await fence.settle(token,result.cleanup==='confirmed'))return undefined;
    return result.cleanup==='confirmed'?result.response:undefined;
  } catch {return undefined;}
}
