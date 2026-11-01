import type { Brain } from 'second_brain';

type CoreResult = Awaited<ReturnType<Brain['queue']['list']>>;
type CoreItem = Extract<CoreResult, {ok: true}>['items'][number];
const fields = ['id','kind','holdGroup','targetKind','targetId','executionClass','state','attempts','nextAttemptAt','createdAt','completedAt','cancelRequestedAt','lastError','attemptOutcome','attemptStartedAt','lastProgressAt','elapsedMs','usage'] as const;
type PublicItem = Pick<CoreItem, typeof fields[number]>;
export type QueueResult = {ok: true; items: PublicItem[]; count: number; hasMore: boolean} | {ok: false; code: 'USAGE'|'DB_LOCKED'|'DB_UNAVAILABLE'|'SERVICE_UNAVAILABLE'|'SERVICE_DENIED'|'SERVICE_INVALID_RESPONSE'|'SERVICE_INVALID_REQUEST'; message: string};
export type QueueInput = {all?: boolean; kind?: string; limit?: number};
export interface ProtectedQueueTransport { request(frame: string): Promise<string> }
export class ProtectedQueueTransportError extends Error {
  constructor(readonly reason: 'unavailable'|'denied') { super(reason); }
}
const failure = (code: 'SERVICE_UNAVAILABLE'|'SERVICE_DENIED'|'SERVICE_INVALID_RESPONSE'|'SERVICE_INVALID_REQUEST'): QueueResult => ({ok:false,code,message:{SERVICE_UNAVAILABLE:'보호 서비스를 사용할 수 없습니다',SERVICE_DENIED:'보호 서비스 연결이 거부되었습니다',SERVICE_INVALID_RESPONSE:'보호 서비스 응답이 올바르지 않습니다',SERVICE_INVALID_REQUEST:'보호 서비스 요청이 올바르지 않습니다'}[code]});
const messages = {USAGE:'목록 한도는 1~200 정수여야 합니다',DB_LOCKED:'저장소가 사용 중입니다',DB_UNAVAILABLE:'저장소를 확인할 수 없습니다'} as const;
// [ASSUMPTION] 일반 조회 프레임·깊이·문자열 상한은 실제 부하에서 재평가한다.
const MAX_FRAME = 1024 * 1024;

// JSON.parse는 중복 키를 지우므로 파싱 전에 거부한다.
function parseFrame(raw: string): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_FRAME) throw new Error('frame');
  let i=0;
  const ws=()=>{while (/\s/u.test(raw[i] ?? '') && i<raw.length) i++;};
  const string=()=>{const start=i++; while(i<raw.length) {const c=raw[i++]; if(c==='\\') i++; else if(c==='"') return JSON.parse(raw.slice(start,i)) as string;} throw new Error('string');};
  const value=(depth: number): void => {
    if(depth>8) throw new Error('depth'); ws(); const c=raw[i];
    if(c==='"') { string(); return; }
    if(c==='{') {i++;ws();const names=new Set<string>();if(raw[i]==='}') {i++;return;} for(;;) {ws();if(raw[i]!=='"') throw new Error('key');const name=string();if(names.has(name)) throw new Error('duplicate');names.add(name);ws();if(raw[i++]!==':') throw new Error('colon');value(depth+1);ws();const end=raw[i++];if(end==='}')return;if(end!==',')throw new Error('object');}}
    if(c==='[') {i++;ws();if(raw[i]===']'){i++;return;}for(;;){value(depth+1);ws();const end=raw[i++];if(end===']')return;if(end!==',')throw new Error('array');}}
    const match=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(raw.slice(i));if(!match)throw new Error('value');i+=match[0].length;
  };
  value(0);ws();if(i!==raw.length)throw new Error('trailing');return JSON.parse(raw) as unknown;
}
const object=(v: unknown): v is Record<string,unknown> => v!==null && typeof v==='object' && !Array.isArray(v);
const exact=(v: Record<string,unknown>, keys: readonly string[]) => Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const text=(v: unknown) => typeof v==='string' && v.length<=16384;
const nullableText=(v: unknown) => v===null || text(v);
const nat=(v: unknown) => typeof v==='number' && Number.isSafeInteger(v) && v>=0;
const date=(v: unknown) => typeof v==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString()===v;
const nullableDate=(v: unknown) => v===null || date(v);
function decodeItem(v: unknown): PublicItem {
  if(!object(v) || !exact(v,fields) || !text(v.id) || !text(v.kind) || !nullableText(v.holdGroup) || !text(v.targetKind) || !text(v.targetId) || !['core','supervised'].includes(v.executionClass as string) || !['queued','running','extension_disabled','unknown','succeeded','failed','cancelled','dependency_failed'].includes(v.state as string) || !nat(v.attempts) || !date(v.nextAttemptAt) || !date(v.createdAt) || !nullableDate(v.completedAt) || !nullableDate(v.cancelRequestedAt) || !nullableText(v.lastError) || !(v.attemptOutcome===null || ['succeeded','failed','stalled','died','cancelled','unknown'].includes(v.attemptOutcome as string)) || !nullableDate(v.attemptStartedAt) || !nullableDate(v.lastProgressAt) || !(v.elapsedMs===null || (typeof v.elapsedMs==='number' && Number.isSafeInteger(v.elapsedMs)))) throw new Error('item');
  if(v.usage!==null && (!object(v.usage) || !exact(v.usage,['inputTokens','cachedInputTokens','outputTokens']) || !nat(v.usage.inputTokens) || !nat(v.usage.cachedInputTokens) || !nat(v.usage.outputTokens))) throw new Error('usage');
  for(const key of ['nextAttemptAt','createdAt','completedAt','cancelRequestedAt','attemptStartedAt','lastProgressAt']) if(v[key]!==null) v[key]=new Date(v[key] as string);
  return v as unknown as PublicItem;
}
/** 서버는 고정된 공개 필드만 반환하며 저장소나 attempt 권한은 내보내지 않는다. */
export async function handleQueueFrame(raw: string, queue: Pick<Brain['queue'],'list'>): Promise<string> {
  let request: Record<string,unknown>;
  try {
    const value=parseFrame(raw);
    if(!object(value) || !(exact(value,['operation','all','limit']) || exact(value,['operation','all','limit','kind'])) || value.operation!=='queue.list.v1' || typeof value.all!=='boolean' || !nat(value.limit) || (value.limit as number)<1 || (value.limit as number)>200 || (Object.hasOwn(value,'kind') && !text(value.kind))) throw new Error('request');
    request=value;
  } catch { return JSON.stringify({ok:false,code:'INVALID_REQUEST'}); }
  try {
    const result=await queue.list({all:request.all as boolean,limit:request.limit as number,...(typeof request.kind==='string'?{kind:request.kind}:{})});
    if(!result.ok) return JSON.stringify({ok:false,code:result.code,message:messages[result.code]});
    const items=result.items.map(item => Object.fromEntries(fields.map(key=>[key,item[key]])));
    const response=JSON.stringify({ok:true,items,count:result.count,hasMore:result.hasMore});
    // Core 결과도 외부에 내보내기 전에 같은 엄격한 decoder로 검사한다.
    decodeResponse(response, request.limit as number);
    return response;
  } catch { return JSON.stringify({ok:false,code:'DB_UNAVAILABLE',message:messages.DB_UNAVAILABLE}); }
}
function decodeResponse(raw: string, limit: number): QueueResult {
  const v=parseFrame(raw);
  if(!object(v) || typeof v.ok!=='boolean') throw new Error('response');
  if(v.ok===false) {
    if(exact(v,['ok','code']) && v.code==='INVALID_REQUEST') return failure('SERVICE_INVALID_REQUEST');
    if(!exact(v,['ok','code','message']) || typeof v.code!=='string' || !Object.hasOwn(messages,v.code) || v.message!==messages[v.code as keyof typeof messages]) throw new Error('failure');
    return v as QueueResult;
  }
  if(!exact(v,['ok','items','count','hasMore']) || !Array.isArray(v.items) || v.items.length>limit || !nat(v.count) || v.count!==v.items.length || typeof v.hasMore!=='boolean') throw new Error('result');
  return {ok:true,items:v.items.map(decodeItem),count:v.count as number,hasMore:v.hasMore};
}
/** 전송 오류와 불량 응답은 닫히며 다른 저장소로 전환하지 않는다. */
export function protectedQueueClient(transport?: ProtectedQueueTransport): {list(input?: QueueInput): Promise<QueueResult>} {
  return {async list(input={}) {
    const limit=input.limit ?? 50;
    if(!Number.isInteger(limit)||limit<1||limit>200)return {ok:false,code:'USAGE',message:messages.USAGE};
    if(!transport)return failure('SERVICE_UNAVAILABLE');
    if(input.kind!==undefined && !text(input.kind))return failure('SERVICE_INVALID_REQUEST');
    let raw: string;
    try {raw=await transport.request(JSON.stringify({operation:'queue.list.v1',all:input.all===true,limit,...(input.kind===undefined?{}:{kind:input.kind})}));}
    catch(error) {return failure(error instanceof ProtectedQueueTransportError && error.reason==='denied'?'SERVICE_DENIED':'SERVICE_UNAVAILABLE');}
    try {return decodeResponse(raw,limit);}catch{return failure('SERVICE_INVALID_RESPONSE');}
  }};
}
