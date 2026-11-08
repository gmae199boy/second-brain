import type { Clock } from 'second_brain';
import type { DriveAuthError } from './drive-oauth.js';
export type DriveErrorCode='AUTH_REQUIRED'|'AUTH_LOGIN_REQUIRED'|'AUTH_SESSION_CHANGED'|'TEMPORARY'|'UNREACHABLE'|'TOO_LARGE';
export type DriveAuthProvider={token(force?:boolean):Promise<{ok:true;accessToken:string}|DriveAuthError>;retryAfter401(rejected:string):Promise<{ok:true;accessToken:string}|DriveAuthError>};
export class DriveRequestError extends Error {
  constructor(readonly code:DriveErrorCode,readonly retryAfter?:Date,refreshLocked=false){super(refreshLocked?'Drive 토큰 갱신 잠금이 사용 중입니다. 소유자와 자식, 진행 중 I/O 종료를 확인하세요':code==='AUTH_REQUIRED'?'Drive 재동의가 필요합니다':code==='AUTH_LOGIN_REQUIRED'?'Drive 로그인이 필요합니다':code==='UNREACHABLE'?'원격 파일에 접근할 수 없습니다':code==='TOO_LARGE'?'원격 파일이 너무 큽니다':'Drive 요청을 완료하지 못했습니다');}
}
export function parseRetryAfter(value:string|null,now:Date):Date|undefined {
  if(!value)return undefined;const trimmed=value.trim();let time:number;
  if(/^\d+$/.test(trimmed)){const seconds=Number(trimmed);if(!Number.isSafeInteger(seconds))return undefined;time=now.getTime()+seconds*1000;}
  else {time=Date.parse(trimmed);}
  if(!Number.isFinite(time)||!Number.isFinite(now.getTime()))return undefined;const result=new Date(Math.max(now.getTime(),time));return Number.isFinite(result.getTime())?result:undefined;
}
/** A single request owns at most one 401 refresh; bodies and errors are private. */
export async function driveRequest(input:{url:string;init?:RequestInit;fetch?:typeof fetch;headers?:()=>Promise<Record<string,string>>;auth?:DriveAuthProvider;clock?:Clock}):Promise<Response> {
  const fetcher=input.fetch??fetch, init=input.init??{};
  let token:string|undefined;
  const getToken=async(forceAfter?:string)=>{
    if(!input.auth)return;
    const result=forceAfter===undefined?await input.auth.token():await input.auth.retryAfter401(forceAfter);
    if(!result.ok)throw new DriveRequestError(result.code==='AUTH_REQUIRED'?'AUTH_REQUIRED':result.code==='AUTH_LOGIN_REQUIRED'?'AUTH_LOGIN_REQUIRED':result.code==='AUTH_SESSION_CHANGED'?'AUTH_SESSION_CHANGED':'TEMPORARY',result.retryAfter,result.code==='AUTH_REFRESH_LOCKED');
    token=result.accessToken;
  };
  try {
    await getToken();
    const send=async()=>{const headers=new Headers(await input.headers?.());new Headers(init.headers).forEach((value,key)=>headers.set(key,value));if(token)headers.set('authorization',`Bearer ${token}`);return fetcher(input.url,{...init,headers});};
    let response=await send();
    if(response.status===401&&input.auth&&token){await response.body?.cancel().catch(()=>{});await getToken(token);response=await send();}
    if(response.status===401){await response.body?.cancel().catch(()=>{});throw new DriveRequestError('AUTH_LOGIN_REQUIRED');}
    if(response.status===403){const body=await response.clone().text();const code=/exportSizeLimitExceeded/i.test(body)?'TOO_LARGE':/rateLimitExceeded|userRateLimitExceeded/i.test(body)?'TEMPORARY':'UNREACHABLE';const after=parseRetryAfter(response.headers.get('retry-after'),input.clock?.now()??new Date());await response.body?.cancel().catch(()=>{});throw new DriveRequestError(code,after);}
    if(response.status===429||response.status>=500){const after=parseRetryAfter(response.headers.get('retry-after'),input.clock?.now()??new Date());await response.body?.cancel().catch(()=>{});throw new DriveRequestError('TEMPORARY',after);}
    return response;
  } catch(error){if(error instanceof DriveRequestError)throw error;throw new DriveRequestError('TEMPORARY');}
}
