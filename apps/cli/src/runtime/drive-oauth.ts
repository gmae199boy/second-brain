import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Clock } from 'second_brain';
import { driveRequest, DriveRequestError, parseRetryAfter } from './drive-http.js';
import { readDriveClient, readDriveCredentials, saveDriveRefreshForClient, rotateDriveRefreshToken, withDriveConnectionLock, withDriveRefreshLock, DriveRefreshLockUnavailable, deleteDriveRefreshTokenUnderLock } from '../config/codec.js';

const scopes=['https://www.googleapis.com/auth/drive.readonly','https://www.googleapis.com/auth/drive.file'];
export type DriveAuthError = {ok:false;code:'AUTH_REQUIRED'|'AUTH_LOGIN_REQUIRED'|'AUTH_CANCELLED'|'AUTH_TIMEOUT'|'AUTH_INVALID_CALLBACK'|'AUTH_TEMPORARY'|'AUTH_REFRESH_LOCKED'|'AUTH_STORAGE'|'AUTH_SESSION_CHANGED';message:string;retryAfter?:Date};
type AuthResult<T> = ({ok:true}&T)|DriveAuthError;
const failure=(code:DriveAuthError['code']):DriveAuthError=>({ok:false,code,message:({AUTH_REQUIRED:'Drive 재동의가 필요합니다',AUTH_LOGIN_REQUIRED:'Drive 로그인이 필요합니다',AUTH_CANCELLED:'Drive 연결이 취소되었습니다',AUTH_TIMEOUT:'Drive 동의 시간이 만료되었습니다',AUTH_INVALID_CALLBACK:'Drive 동의 응답이 올바르지 않습니다',AUTH_TEMPORARY:'Drive 연결을 완료하지 못했습니다',AUTH_REFRESH_LOCKED:'Drive 토큰 갱신 잠금이 사용 중입니다. 소유자와 자식, 진행 중 I/O 종료를 확인하세요',AUTH_STORAGE:'Drive 연결 정보를 저장하지 못했습니다',AUTH_SESSION_CHANGED:'Drive 연결이 변경되어 다음 회차에 다시 처리합니다'})[code]});
type Options={home:string;expectedCredentials?:import('../config/codec.js').DriveCredentials|null;authorizationEndpoint?:string;tokenEndpoint?:string;driveBaseUrl?:string;fetch?:typeof fetch;timeoutMs?:number;signal?:AbortSignal;clock?:Clock};
type Tokens={accessToken:string;refreshToken?:string};
function requestSignal(options:Options):AbortSignal {const deadline=AbortSignal.timeout(options.timeoutMs??30_000);return options.signal?AbortSignal.any([options.signal,deadline]):deadline;}
async function tokenRequest(options:Options,body:URLSearchParams):Promise<AuthResult<Tokens>> {
  try {
    const response=await (options.fetch??fetch)(options.tokenEndpoint??'https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body,signal:requestSignal(options)});
    const data=await response.json().catch(()=>null) as {access_token?:unknown;refresh_token?:unknown;error?:unknown}|null;
    if(!response.ok){const result=failure(data?.error==='invalid_grant'||response.status===401?'AUTH_REQUIRED':'AUTH_TEMPORARY');const retryAfter=parseRetryAfter(response.headers.get('retry-after'),options.clock?.now()??new Date());return retryAfter?{...result,retryAfter}:result;}
    if(typeof data?.access_token!=='string'||!data.access_token)return failure('AUTH_TEMPORARY');
    return {ok:true,accessToken:data.access_token,...(typeof data.refresh_token==='string'&&data.refresh_token?{refreshToken:data.refresh_token}:{})};
  } catch{return failure(options.signal?.aborted?'AUTH_CANCELLED':'AUTH_TEMPORARY');}
}
/** Authentication state is process-local; callers must never render token results. */
export function driveAuth(options:Options) {
  let access:string|undefined, cached:Awaited<ReturnType<typeof readDriveCredentials>>, inflight:Promise<AuthResult<{accessToken:string}>>|undefined;
  const sameSession=(a:NonNullable<typeof cached>,b:NonNullable<typeof cached>)=>a.clientId===b.clientId&&a.clientSecret===b.clientSecret&&a.session===b.session;
  async function refresh():Promise<AuthResult<{accessToken:string}>> {
    try {
      const initial=await readDriveCredentials(options.home);
      if('expectedCredentials' in options && ((initial===null)!==(options.expectedCredentials===null) || (initial && options.expectedCredentials && !sameSession(initial,options.expectedCredentials))))return failure('AUTH_SESSION_CHANGED');
      if(!initial)return failure('AUTH_REQUIRED');
      return await withDriveRefreshLock(options.home,async()=>{
        let credentials=await readDriveCredentials(options.home);
        if(!credentials||!sameSession(initial,credentials))return failure('AUTH_SESSION_CHANGED');
        // A bounded retry also handles external rotation outside this lock.
        for(let attempt=0;attempt<2;attempt++) {
          const token=await tokenRequest(options,new URLSearchParams({grant_type:'refresh_token',client_id:credentials.clientId,client_secret:credentials.clientSecret,refresh_token:credentials.refreshToken}));
          if(token.ok && token.refreshToken && await rotateDriveRefreshToken(options.home,credentials,token.refreshToken)) {
            cached={...credentials,refreshToken:token.refreshToken};access=token.accessToken;return {ok:true as const,accessToken:access};
          }
          const current=await readDriveCredentials(options.home);
          if(!current||!sameSession(credentials,current))return failure('AUTH_SESSION_CHANGED');
          if(current.refreshToken!==credentials.refreshToken) {if(attempt===0){credentials=current;continue;}return failure('AUTH_TEMPORARY');}
          if(!token.ok)return token;
          if(token.refreshToken)return failure('AUTH_TEMPORARY');
          cached=current;access=token.accessToken;return {ok:true as const,accessToken:access};
        }
        return failure('AUTH_TEMPORARY');
      });
    }catch(error){return failure(error instanceof DriveRefreshLockUnavailable?'AUTH_REFRESH_LOCKED':'AUTH_TEMPORARY');}
  }
  return {
    async token(force=false):Promise<AuthResult<{accessToken:string}>> {
      if(force&&cached){try{const current=await readDriveCredentials(options.home);if(!current||!sameSession(current,cached)){access=undefined;return failure('AUTH_SESSION_CHANGED');}}catch{return failure('AUTH_STORAGE');}}
      if(!force&&access){
        try {const current=await readDriveCredentials(options.home);if(current&&cached&&sameSession(current,cached)){if(current.refreshToken===cached.refreshToken)return {ok:true,accessToken:access};access=undefined;}else {access=undefined;return failure('AUTH_SESSION_CHANGED');}}catch{return failure('AUTH_STORAGE');}
      }
      if(inflight)return inflight;
      inflight=refresh();try{return await inflight;}finally{inflight=undefined;}
    },
    async retryAfter401(rejected:string){if(access&&access!==rejected)return this.token();return this.token(true);},
    clear(){access=undefined;cached=null;},
  };
}

/** Connect this adapter to the same scoped DB settings used by config. */
export function driveRootSettings(deps:import('second_brain').SettingsDependencies):DriveRootStore {
  return {
    async readRoot(){const {getSetting}=await import('second_brain');const r=await getSetting(deps,{key:'drive.root_folder_id'});return r.ok?{ok:true,rootId:r.value||null}:{ok:false};},
    async writeRoot(rootId){const {setSetting}=await import('second_brain');const r=await setSetting(deps,{key:'drive.root_folder_id',value:rootId});return r.ok?{ok:true}:{ok:false};},
  };
}
export interface DriveRootStore {
  readRoot():Promise<{ok:true;rootId:string|null}|{ok:false}>;
  writeRoot(rootId:string):Promise<{ok:true}|{ok:false}>;
}
/** One-time loopback authorization and root registration. No returned secret. */
type ConnectOptions=Options & {roots:DriveRootStore;openAuthorization:(url:string)=>void|Promise<void>;signal?:AbortSignal;bindAccount?:(accountId:string)=>Promise<boolean>;commitAccount?:(accountId:string)=>Promise<boolean>};
export async function connectDrive(options:ConnectOptions):Promise<AuthResult<{rootId:string}>> {
  try{return await withDriveConnectionLock(options.home,()=>connectDriveUnderLock(options));}catch{return failure('AUTH_STORAGE');}
}
export async function connectDriveUnderLock(options:ConnectOptions):Promise<AuthResult<{rootId:string}>> {
  let client:Awaited<ReturnType<typeof readDriveClient>>;
  try {client=await readDriveClient(options.home);}catch{return failure('AUTH_STORAGE');}
  if(!client)return failure('AUTH_REQUIRED');
  if(options.signal?.aborted)return failure('AUTH_CANCELLED');
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url'),state=randomBytes(32).toString('base64url');
  const server=createServer();let settled=false;
  let settle!:(result:AuthResult<{code:string}>)=>void;
  const callback=new Promise<AuthResult<{code:string}>>(resolve=>{settle=result=>{if(!settled){settled=true;resolve(result);}};});
  server.on('request',(req,res)=>{
    let url:URL;try{url=new URL(req.url??'/', 'http://127.0.0.1');}catch{res.writeHead(400).end();return;}
    if(req.method!=='GET'){res.writeHead(405).end();return;}
    if(url.pathname!=='/callback'){res.writeHead(404).end();return;}
    if(settled){res.writeHead(410).end();return;}
    const validState=url.searchParams.getAll('state').length===1&&url.searchParams.get('state')===state;
    const codes=url.searchParams.getAll('code');const errors=url.searchParams.getAll('error');
    if(!validState||codes.length>1||errors.length>1||codes.length+errors.length!==1||(!codes[0]&&!errors[0])) {res.writeHead(400).end('Invalid response');settle(failure('AUTH_INVALID_CALLBACK'));return;}
    if(errors.length){res.writeHead(400).end('Authorization declined');settle(failure('AUTH_CANCELLED'));return;}
    res.writeHead(200,{'content-type':'text/plain; charset=utf-8'}).end('Authorization received. You may close this window.');settle({ok:true,code:codes[0]!});
  });
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string')return failure('AUTH_TEMPORARY');
    const redirect=`http://127.0.0.1:${address.port}/callback`;
    const authorize=new URL(options.authorizationEndpoint??'https://accounts.google.com/o/oauth2/v2/auth');
    authorize.search=new URLSearchParams({client_id:client.clientId,redirect_uri:redirect,response_type:'code',scope:scopes.join(' '),access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
    const timer=setTimeout(()=>settle(failure('AUTH_TIMEOUT')),options.timeoutMs??120_000);
    const abort=()=>settle(failure('AUTH_CANCELLED'));options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    let received:AuthResult<{code:string}>;
    try {Promise.resolve(options.openAuthorization(authorize.toString())).catch(()=>settle(failure('AUTH_TEMPORARY')));received=await callback;}
    catch {return failure('AUTH_TEMPORARY');}
    finally {clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
    if(!received.ok)return received;if(options.signal?.aborted)return failure('AUTH_CANCELLED');
    const token=await tokenRequest(options,new URLSearchParams({grant_type:'authorization_code',code:received.code,redirect_uri:redirect,client_id:client.clientId,client_secret:client.clientSecret,code_verifier:verifier}));
    if(!token.ok)return token;if(!token.refreshToken)return failure('AUTH_REQUIRED');
    let connectedAccess=token.accessToken,connectedRefresh=token.refreshToken;
    const connectAuth={async token(){return {ok:true as const,accessToken:connectedAccess};},async retryAfter401(){
      const refreshed=await tokenRequest(options,new URLSearchParams({grant_type:'refresh_token',client_id:client.clientId,client_secret:client.clientSecret,refresh_token:connectedRefresh}));
      if(!refreshed.ok)return refreshed;connectedAccess=refreshed.accessToken;connectedRefresh=refreshed.refreshToken??connectedRefresh;return {ok:true as const,accessToken:connectedAccess};
    }};
    let accountId:string|undefined;
    if(options.bindAccount){
      try {const base=(options.driveBaseUrl??'https://www.googleapis.com').replace(/\/$/,'');const about=await driveRequest({url:`${base}/drive/v3/about?fields=user(permissionId)`,fetch:options.fetch,auth:connectAuth,clock:options.clock,init:{signal:requestSignal(options)}});if(!about.ok)return failure('AUTH_TEMPORARY');const info=await about.json() as {user?:{permissionId?:unknown}};const candidate=info.user?.permissionId;if(typeof candidate!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(candidate)||!await options.bindAccount(candidate))return failure('AUTH_STORAGE');accountId=candidate;}
      catch(error){if(options.signal?.aborted)return failure('AUTH_CANCELLED');if(error instanceof DriveRequestError){const r=failure(error.code==='AUTH_REQUIRED'?'AUTH_REQUIRED':error.code==='AUTH_LOGIN_REQUIRED'?'AUTH_LOGIN_REQUIRED':'AUTH_TEMPORARY');return error.retryAfter?{...r,retryAfter:error.retryAfter}:r;}return failure('AUTH_STORAGE');}
    }
    let rootId:string|null;
    try {const root=await options.roots.readRoot();if(!root.ok)return failure('AUTH_STORAGE');rootId=root.rootId;}catch{return failure('AUTH_STORAGE');}
    if(rootId!==null&&!(/^[A-Za-z0-9_-]+$/.exec(rootId)?.[0]===rootId))return failure('AUTH_STORAGE');
    let verifyRoot=!!rootId;
    if(!rootId){
      try {
        const base=(options.driveBaseUrl??'https://www.googleapis.com').replace(/\/$/,'');
        const headers={'content-type':'application/json'};
        const query=new URLSearchParams({q:"appProperties has { key='second_brain_root' and value='1' } and trashed = false",fields:'files(id),nextPageToken,incompleteSearch',pageSize:'2'});
        const found=await driveRequest({url:`${base}/drive/v3/files?${query}`,fetch:options.fetch,auth:connectAuth,clock:options.clock,init:{headers,signal:requestSignal(options)}});
        if(!found.ok)return failure('AUTH_TEMPORARY');const listing=await found.json() as {files?:{id?:unknown}[];nextPageToken?:unknown;incompleteSearch?:unknown};
        if(listing.incompleteSearch===true||!Array.isArray(listing.files)||listing.files.length>1||listing.nextPageToken)return failure('AUTH_TEMPORARY');
        let id=listing.files[0]?.id;verifyRoot=listing.files.length===1;
        if(listing.files.length===1&&(typeof id!=='string'||!(/^[A-Za-z0-9_-]+$/.exec(id)?.[0]===id)))return failure('AUTH_TEMPORARY');
        if(listing.files.length===0){const response=await driveRequest({url:`${base}/drive/v3/files?fields=id`,fetch:options.fetch,auth:connectAuth,clock:options.clock,init:{method:'POST',headers,body:JSON.stringify({name:'Brain',mimeType:'application/vnd.google-apps.folder',appProperties:{second_brain_root:'1'}}),signal:requestSignal(options)}});if(!response.ok)return failure('AUTH_TEMPORARY');id=(await response.json() as {id?:unknown}).id;}
        if(typeof id!=='string'||!(/^[A-Za-z0-9_-]+$/.exec(id)?.[0]===id))return failure('AUTH_TEMPORARY');rootId=id;

      }catch(error){if(options.signal?.aborted)return failure('AUTH_CANCELLED');if(error instanceof DriveRequestError){const r=failure(error.code==='AUTH_REQUIRED'?'AUTH_REQUIRED':error.code==='AUTH_LOGIN_REQUIRED'?'AUTH_LOGIN_REQUIRED':'AUTH_TEMPORARY');return error.retryAfter?{...r,retryAfter:error.retryAfter}:r;}return failure(options.signal?.aborted?'AUTH_CANCELLED':'AUTH_STORAGE');}
    }
    if(verifyRoot){
      try {
        const base=(options.driveBaseUrl??'https://www.googleapis.com').replace(/\/$/,'');
        const response=await driveRequest({url:`${base}/drive/v3/files/${encodeURIComponent(rootId!)}?fields=id,mimeType,trashed,owners(permissionId),capabilities(canListChildren)`,fetch:options.fetch,auth:connectAuth,clock:options.clock,init:{signal:requestSignal(options)}});
        if(!response.ok)return failure('AUTH_STORAGE');
        const info=await response.json() as {id?:unknown;mimeType?:unknown;trashed?:unknown;owners?:{permissionId?:unknown}[];capabilities?:{canListChildren?:unknown}};
        if(info.id!==rootId||info.mimeType!=='application/vnd.google-apps.folder'||info.trashed!==false||info.capabilities?.canListChildren!==true||(accountId!==undefined&&(!Array.isArray(info.owners)||!info.owners.some(owner=>owner.permissionId===accountId))))return failure('AUTH_STORAGE');
      }catch(error){if(error instanceof DriveRequestError){const r=failure(error.code==='AUTH_REQUIRED'?'AUTH_REQUIRED':error.code==='AUTH_LOGIN_REQUIRED'?'AUTH_LOGIN_REQUIRED':'AUTH_TEMPORARY');return error.retryAfter?{...r,retryAfter:error.retryAfter}:r;}return failure('AUTH_STORAGE');}
    }
    if(options.signal?.aborted)return failure('AUTH_CANCELLED');
    try {if(accountId!==undefined&&options.commitAccount&&!await options.commitAccount(accountId))return failure('AUTH_STORAGE');}catch{return failure('AUTH_STORAGE');}
    try {const saved=await options.roots.writeRoot(rootId!);if(!saved.ok)return failure('AUTH_STORAGE');}catch{return failure('AUTH_STORAGE');}
    try {if(!await saveDriveRefreshForClient(options.home,client,connectedRefresh))return failure('AUTH_STORAGE');}catch{return failure('AUTH_STORAGE');}
    return {ok:true,rootId};
  } catch{return failure('AUTH_TEMPORARY');}
  finally {if(server.listening){server.close();server.closeIdleConnections();}}
}

/** Hold the same connection lock through the durable fence and secret deletion.
 * If deletion fails the DB fence remains and retry can safely remove the token. */
export async function disconnectDrive(home:string, disconnect:()=>Promise<{ok:true}|{ok:false;code?:string;message?:string}>):Promise<AuthResult<object>|{ok:false;code:'DB_LOCKED';message:string}> {
  try {return await withDriveConnectionLock(home,async()=>{
    const stopped=await disconnect();if(!stopped.ok)return stopped.code==='DB_LOCKED'?{ok:false as const,code:'DB_LOCKED' as const,message:'이전 로컬 삭제 결과를 확인한 뒤 삭제 표식을 복구해야 합니다'}:failure('AUTH_STORAGE');
    await deleteDriveRefreshTokenUnderLock(home);return {ok:true as const};
  });}catch{return failure('AUTH_STORAGE');}
}
