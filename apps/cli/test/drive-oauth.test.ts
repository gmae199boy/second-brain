import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp,readFile,rm,stat,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect,it } from 'vitest';
import { connectDrive,disconnectDrive,driveAuth,driveRootSettings } from '../src/runtime/drive-oauth.js';
import { deleteDriveRefreshToken,postgresSecrets,readDriveCredentials,saveDriveCredentials } from '../src/config/codec.js';
import { memorySchemaStore,memorySettingsStore } from 'second_brain/testing';

async function fakeOAuth(){
  let folder=false,creates=0,exchanges=0,refreshes=0,failRoot=false,invalidGrant=false,rootUnauthorized=0,incomplete=false,rootFields='';const tokenBodies:URLSearchParams[]=[];
  let refreshEntered:(()=>void)|undefined,refreshWait:Promise<void>|undefined,exchangeWait:Promise<void>|undefined;
  const server=createServer(async(req,res)=>{
    const u=new URL(req.url??'/', 'http://localhost');
    if(req.method==='POST'&&u.pathname==='/token'){
      let body='';for await(const chunk of req)body+=String(chunk);const fields=new URLSearchParams(body);tokenBodies.push(fields);
      if(fields.get('grant_type')==='refresh_token'){refreshes++;refreshEntered?.();if(refreshWait)await refreshWait;if(invalidGrant){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:'invalid_grant',error_description:'synthetic-secret'}));return;}}
      else {exchanges++;if(exchangeWait)await exchangeWait;}
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({access_token:'synthetic-access',refresh_token:fields.get('grant_type')==='authorization_code'?'synthetic-refresh':'synthetic-rotated'}));return;
    }
    if(req.method==='GET'&&u.pathname==='/drive/v3/files/synthetic-root'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'synthetic-root',mimeType:'application/vnd.google-apps.folder',trashed:false,owners:[{permissionId:'synthetic-account'}],capabilities:{canListChildren:true}}));return;}
    if(req.method==='GET'&&u.pathname==='/drive/v3/files'){rootFields=u.searchParams.get('fields')??'';if(rootUnauthorized>0){rootUnauthorized--;res.writeHead(401).end();return;}res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({files:folder?[{id:'synthetic-root'}]:[],...(incomplete?{incompleteSearch:true}:{})}));return;}
    if(req.method==='POST'&&u.pathname==='/drive/v3/files'){creates++;folder=true;res.writeHead(failRoot?503:200,{'content-type':'application/json'}).end(JSON.stringify({id:'synthetic-root'}));return;}
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const a=server.address();if(!a||typeof a==='string')throw Error('no address');
  return {base:`http://127.0.0.1:${a.port}`,get creates(){return creates;},get exchanges(){return exchanges;},get refreshes(){return refreshes;},get rootFields(){return rootFields;},tokenBodies,
    setIncomplete(value:boolean,withFolder=false){incomplete=value;folder=withFolder;},rejectRootOnce(){rootUnauthorized=1;},expireGrant(){invalidGrant=true;},loseRootResponse(){failRoot=true;},recoverRoot(){failRoot=false;},
    holdExchange(){let release!:()=>void;exchangeWait=new Promise<void>(r=>{release=r;});return {release};},
    holdRefresh(){let release!:()=>void;let entered!:()=>void;const wait=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{entered=r;});refreshEntered=entered;refreshWait=wait;return {started,release};},
    async close(){await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
async function setup(){const home=await mkdtemp(join(tmpdir(),'brain-oauth-'));await writeFile(join(home,'.env'),'KEEP="preserve"\nBRAIN_DRIVE_CLIENT_ID="synthetic-client"\nBRAIN_DRIVE_CLIENT_SECRET="synthetic-secret"\n',{mode:0o600});const server=await fakeOAuth();return {home,server,async close(){await server.close();await rm(home,{recursive:true,force:true});}};}
const now=new Date('2026-01-01Z');
function roots(){const self={async readSelfUser(){return {ok:true as const,user:{id:'019a0000-0000-7000-8000-000000000001',name:'synthetic',isSelf:true,createdAt:now}};}};const store={...memorySettingsStore(),...memorySchemaStore({version:1}),...self};return driveRootSettings({store,clock:{now:()=>now},schemaVersions:{core:1}});}
function callback(mode:'valid'|'wrong'|'deny'='valid',observe?:(url:URL)=>void){return async (input:string)=>{const url=new URL(input);observe?.(url);const redirect=new URL(url.searchParams.get('redirect_uri')!);redirect.searchParams.set('state',mode==='wrong'?'wrong':url.searchParams.get('state')!);redirect.searchParams.set(mode==='deny'?'error':'code',mode==='deny'?'access_denied':'synthetic-code');await fetch(redirect);};}
it('real loopback callback uses PKCE and stores refresh only after DB root',async()=>{
 const k=await setup();try{const root=roots();let challenge='';const r=await connectDrive({home:k.home,tokenEndpoint:`${k.server.base}/token`,authorizationEndpoint:`${k.server.base}/authorize`,driveBaseUrl:k.server.base,roots:root,openAuthorization:callback('valid',u=>{challenge=u.searchParams.get('code_challenge')!;expect(u.searchParams.get('code_challenge_method')).toBe('S256');expect(u.searchParams.get('scope')).toContain('drive.readonly');expect(u.searchParams.get('scope')).toContain('drive.file');})});
 expect(r).toEqual({ok:true,rootId:'synthetic-root'});expect(await root.readRoot()).toEqual({ok:true,rootId:'synthetic-root'});const verifier=k.server.tokenBodies[0]!.get('code_verifier')!;expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
 const file=await readFile(join(k.home,'.env'),'utf8');expect(file).toContain('synthetic-refresh');expect(file).toContain('KEEP="preserve"');expect(file).not.toContain('synthetic-access');expect(file).not.toContain('synthetic-code');expect((await stat(join(k.home,'.env'))).mode&0o777).toBe(0o600);expect(JSON.stringify(r)).not.toContain('synthetic-secret');
 }finally{await k.close();}
});
it.each(['wrong','deny'] as const)('rejects %s callback before token exchange',async mode=>{const k=await setup();try{const r=await connectDrive({home:k.home,tokenEndpoint:`${k.server.base}/token`,driveBaseUrl:k.server.base,roots:roots(),openAuthorization:callback(mode)});expect(r.ok).toBe(false);expect(k.server.exchanges).toBe(0);expect(await readDriveCredentials(k.home)).toBeNull();}finally{await k.close();}});
it('times out and closes the loopback listener without exchanging credentials',async()=>{const k=await setup();try{let redirect='';const result=await connectDrive({home:k.home,timeoutMs:20,roots:roots(),openAuthorization:u=>{redirect=new URL(u).searchParams.get('redirect_uri')!;}});expect(result).toMatchObject({ok:false,code:'AUTH_TIMEOUT'});expect(k.server.exchanges).toBe(0);await expect(fetch(redirect)).rejects.toThrow();}finally{await k.close();}});
it('recovers a lost folder response without a duplicate',async()=>{
 const k=await setup();try{const root=roots();k.server.loseRootResponse();const options={home:k.home,tokenEndpoint:`${k.server.base}/token`,driveBaseUrl:k.server.base,roots:root,openAuthorization:callback()};expect(await connectDrive(options)).toMatchObject({ok:false});expect(await readDriveCredentials(k.home)).toBeNull();k.server.recoverRoot();expect(await connectDrive(options)).toMatchObject({ok:true,rootId:'synthetic-root'});expect(k.server.creates).toBe(1);}finally{await k.close();}
});
it('serializes refresh calls and does not revive a deleted token after an in-flight refresh',async()=>{
 const k=await setup();try{await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'});const auth=driveAuth({home:k.home,tokenEndpoint:`${k.server.base}/token`});const gate=k.server.holdRefresh();const a=auth.token(),b=auth.token();await gate.started;await deleteDriveRefreshToken(k.home);gate.release();expect(await a).toMatchObject({ok:false,code:'AUTH_SESSION_CHANGED'});expect(await b).toMatchObject({ok:false,code:'AUTH_SESSION_CHANGED'});expect(k.server.refreshes).toBe(1);expect(await readDriveCredentials(k.home)).toBeNull();expect(await auth.token()).toMatchObject({ok:false,code:'AUTH_REQUIRED'});}finally{await k.close();}
});

it('failed DB registration retains no refresh token and reuses the orphaned marked root',async()=>{
 const k=await setup();try{const real=roots();const failed={readRoot:real.readRoot,async writeRoot(){return {ok:false as const};}};const options={home:k.home,tokenEndpoint:`${k.server.base}/token`,driveBaseUrl:k.server.base,roots:failed,openAuthorization:callback()};expect(await connectDrive(options)).toMatchObject({ok:false,code:'AUTH_STORAGE'});expect(await readDriveCredentials(k.home)).toBeNull();expect(await connectDrive({...options,roots:real})).toMatchObject({ok:true,rootId:'synthetic-root'});expect(k.server.creates).toBe(1);}finally{await k.close();}
});
it('cached access is invalidated after token deletion and deletion preserves other secrets',async()=>{
 const k=await setup();try{await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'});const auth=driveAuth({home:k.home,tokenEndpoint:`${k.server.base}/token`});expect(await auth.token()).toMatchObject({ok:true});await deleteDriveRefreshToken(k.home);expect(await auth.token()).toMatchObject({ok:false,code:'AUTH_SESSION_CHANGED'});const file=await readFile(join(k.home,'.env'),'utf8');expect(file).toContain('KEEP="preserve"');expect(file).not.toContain('synthetic-rotated');expect(file).not.toContain('synthetic-access');}finally{await k.close();}
});
it('persists the Brainroot through a real isolated PG settings adapter',async()=>{
 const k=await setup();const {pgHome}=await import('./pg-home.js');const {createIsolatedTestDatabase}=await import('@second-brain/test-db');const {postgresStore,CORE_SCHEMA_VERSION}=await import('second_brain/postgres');let db:Awaited<ReturnType<typeof pgHome>>|undefined;let store:ReturnType<typeof postgresStore>|undefined;
 try {db=await pgHome(k.home,true,createIsolatedTestDatabase);await writeFile(join(k.home,'.env'),'BRAIN_DRIVE_CLIENT_ID="synthetic-client"\nBRAIN_DRIVE_CLIENT_SECRET="synthetic-secret"\n',{mode:0o600});store=postgresStore({databaseUrl:db.appUrl});const root=driveRootSettings({store,clock:{now:()=>now},schemaVersions:{core:CORE_SCHEMA_VERSION}});expect(await connectDrive({home:k.home,tokenEndpoint:`${k.server.base}/token`,driveBaseUrl:k.server.base,roots:root,openAuthorization:callback()})).toMatchObject({ok:true,rootId:'synthetic-root'});expect(await root.readRoot()).toEqual({ok:true,rootId:'synthetic-root'});expect(await db.rows("select value from brain.settings where key='drive.root_folder_id' ")).toEqual([{value:'synthetic-root'}]);}
 finally {await store?.close();await db?.drop();await k.close();}
});

it('accepts only one callback code while exchange is pending',async()=>{
 const k=await setup();try{const gate=k.server.holdExchange();let second=0;const open=async(input:string)=>{const u=new URL(input),redirect=new URL(u.searchParams.get('redirect_uri')!);redirect.searchParams.set('state',u.searchParams.get('state')!);redirect.searchParams.set('code','synthetic-code');expect((await fetch(redirect)).status).toBe(200);second=(await fetch(redirect)).status;gate.release();};expect(await connectDrive({home:k.home,tokenEndpoint:`${k.server.base}/token`,driveBaseUrl:k.server.base,roots:roots(),openAuthorization:open})).toMatchObject({ok:true});expect(second).toBe(410);expect(k.server.exchanges).toBe(1);}finally{await k.close();}
});
it('disconnect deletes refresh only after DB fence and preserves it on DB failure',async()=>{
 const k=await setup();try{await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'});expect(await disconnectDrive(k.home,async()=>({ok:false}))).toMatchObject({ok:false});expect(await readDriveCredentials(k.home)).not.toBeNull();expect(await disconnectDrive(k.home,async()=>({ok:true}))).toMatchObject({ok:true});expect(await readDriveCredentials(k.home)).toBeNull();}finally{await k.close();}
});
it('serializes concurrent codec writers and rejects unrepresentable values atomically',async()=>{
 const k=await setup();try{await Promise.all([saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'}),postgresSecrets(k.home,23456,'BRAIN_DATABASE_URL')]);const before=await readFile(join(k.home,'.env'),'utf8');expect(before).toContain('BRAIN_DATABASE_URL=');expect(before).toContain('synthetic-refresh');await expect(saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:`both"'quotes`})).rejects.toThrow();expect(await readFile(join(k.home,'.env'),'utf8')).toBe(before);expect((await stat(join(k.home,'.env'))).mode&0o777).toBe(0o600);}finally{await k.close();}
});

it('invalid_grant returns a fixed reconsent code without external error text',async()=>{
 const k=await setup();try{await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'});k.server.expireGrant();const result=await driveAuth({home:k.home,tokenEndpoint:`${k.server.base}/token`}).token();expect(result).toMatchObject({ok:false,code:'AUTH_REQUIRED'});expect(JSON.stringify(result)).not.toContain('synthetic-secret');expect(k.server.refreshes).toBe(1);}finally{await k.close();}
});

it('refuses to publish a consent token when the registered client changed mid-flow',async()=>{
 const k=await setup();try{const gate=k.server.holdExchange();const started=connectDrive({home:k.home,tokenEndpoint:`${k.server.base}/token`,driveBaseUrl:k.server.base,roots:roots(),openAuthorization:async input=>{await callback()(input);await writeFile(join(k.home,'.env'),'BRAIN_DRIVE_CLIENT_ID="changed"\nBRAIN_DRIVE_CLIENT_SECRET="changed"\n',{mode:0o600});gate.release();}});expect(await started).toMatchObject({ok:false,code:'AUTH_STORAGE'});expect(await readDriveCredentials(k.home)).toBeNull();}finally{await k.close();}
});

it('aborts a pending loopback without exchanging or storing a token',async()=>{
 const k=await setup();try{const controller=new AbortController();const result=await connectDrive({home:k.home,roots:roots(),signal:controller.signal,openAuthorization:()=>controller.abort()});expect(result).toMatchObject({ok:false,code:'AUTH_CANCELLED'});expect(k.server.exchanges).toBe(0);expect(await readDriveCredentials(k.home)).toBeNull();}finally{await k.close();}
});

it('actual invalid_grant flows through source queue into doctor without retrying',async()=>{
 const k=await setup();try{
  const {drainQueue,runDoctor,sourceSyncHandler}=await import('second_brain');const {memoryStore,memorySourceStore,memorySpool,sequenceIdGen,sampleWorkInput,memorySchemaStore}=await import('second_brain/testing');const {sourceDrive}=await import('../src/runtime/source-drive.js');
  await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'});k.server.expireGrant();const auth=driveAuth({home:k.home,tokenEndpoint:`${k.server.base}/token`});const clock={now:()=>now},q=memoryStore(),spool=memorySpool(),id='019a0000-0000-7000-8000-000000000231',work='019a0000-0000-7000-8000-000000000232';
  const sources=memorySourceStore({claim:()=>true,renew:()=>true,file:(_h,_s,i)=>({id:i,redacted:false}),extraction:()=>true,workOpen:()=>true,isRedacted:()=>false,handoff:()=>{}});await sources.ensureSource({id,kind:'drive',account:'synthetic',rootId:'root'});await q.addWork(sampleWorkInput({id:work,kind:'source_sync',targetKind:'source',targetId:id,createdAt:now,nextAttemptAt:now}));
  const remote=sourceDrive({baseUrl:k.server.base,auth,clock});await drainQueue({store:q,spool,clock,idGen:sequenceIdGen({timestampMs:now.getTime(),start:100})},{budgetMs:1000,handlers:{source_sync:sourceSyncHandler({store:sources,remote,clock,idGen:sequenceIdGen({timestampMs:now.getTime(),start:200})})}});
  expect(q.snapshot().workItems[0]).toMatchObject({outcome:'failed',attempts:1});const schema=memorySchemaStore({version:1});const report=await runDoctor({...schema,async checkHealth(){return {ok:true as const,serverVersion:'test',source:{location:'synthetic',probes:[]}};}},{store:q,clock,schemaVersions:{core:1}});expect(report.checks).toContainEqual(expect.objectContaining({id:'failures',status:'warn',detail:expect.stringContaining('Drive 재동의')}));expect(k.server.refreshes).toBe(1);expect(JSON.stringify(report)).not.toContain('synthetic-secret');
 }finally{await k.close();}
});

it('refreshes once on a Drive 401 before replaying the request',async()=>{
 const k=await setup();try{const {sourceDrive}=await import('../src/runtime/source-drive.js');await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'});const auth=driveAuth({home:k.home,tokenEndpoint:`${k.server.base}/token`});let requests=0;const fetcher:typeof fetch=async()=>{requests++;return requests===1?new Response('private',{status:401}):new Response(JSON.stringify({startPageToken:'cursor'}),{status:200,headers:{'content-type':'application/json'}});};const result=await sourceDrive({baseUrl:'http://local',auth,fetch:fetcher}).startToken();expect(result).toEqual({ok:true,token:'cursor'});expect(k.server.refreshes).toBe(2);expect(requests).toBe(2);}finally{await k.close();}
});

it('refreshes once when Brainroot discovery returns 401',async()=>{
 const k=await setup();try{k.server.rejectRootOnce();const result=await connectDrive({home:k.home,tokenEndpoint:`${k.server.base}/token`,driveBaseUrl:k.server.base,roots:roots(),openAuthorization:callback()});expect(result).toMatchObject({ok:true,rootId:'synthetic-root'});expect(k.server.refreshes).toBe(1);expect(await readDriveCredentials(k.home)).toMatchObject({refreshToken:'synthetic-rotated'});}finally{await k.close();}
});

it('preserves a safe recovery instruction when disconnect sees an uncertain deletion marker',async()=>{
 const home=await mkdtemp(join(tmpdir(),'drive-disconnect-marker-'));
 try {expect(await disconnectDrive(home,async()=>({ok:false,code:'DB_LOCKED',message:'unsafe external detail'}))).toEqual({ok:false,code:'DB_LOCKED',message:'이전 로컬 삭제 결과를 확인한 뒤 삭제 표식을 복구해야 합니다'});} finally {await rm(home,{recursive:true,force:true});}
});

it('serializes two auth instances across refresh rotation without reviving deleted credentials',async()=>{
 const k=await setup();try{
  await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'});
  let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});const received:string[]=[];
  const fetcher:typeof fetch=async(_url,init)=>{const token=new URLSearchParams(String(init?.body)).get('refresh_token')!;received.push(token);if(received.length===1){entered();await hold;}return new Response(JSON.stringify({access_token:'synthetic-access',refresh_token:token==='synthetic-refresh'?'synthetic-rotated':'synthetic-final'}),{status:200});};
  const a=driveAuth({home:k.home,tokenEndpoint:'http://synthetic/token',fetch:fetcher}),b=driveAuth({home:k.home,tokenEndpoint:'http://synthetic/token',fetch:fetcher});const first=a.token();await waiting;const second=b.token();release();expect(await first).toMatchObject({ok:true});expect(await second).toMatchObject({ok:true});expect(received.slice(0,2)).toEqual(['synthetic-refresh','synthetic-rotated']);expect(await readDriveCredentials(k.home)).toMatchObject({refreshToken:'synthetic-final'});
  expect(await a.token()).toMatchObject({ok:true});await deleteDriveRefreshToken(k.home);expect(await a.token()).toMatchObject({ok:false,code:'AUTH_SESSION_CHANGED'});
 }finally{await k.close();}
});

it('rejects account replacement even when the same client registration is reused',async()=>{
 const k=await setup();try{await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'first'});const auth=driveAuth({home:k.home,tokenEndpoint:`${k.server.base}/token`});expect(await auth.token()).toMatchObject({ok:true});await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'second'});expect(await auth.token()).toMatchObject({ok:false,code:'AUTH_SESSION_CHANGED'});expect(await auth.token(true)).toMatchObject({ok:false,code:'AUTH_SESSION_CHANGED'});}finally{await k.close();}
});

it.each(['missing','forbidden','wrong-owner','wrong-mime','trashed','unreadable'] as const)('rejects an existing Brainroot that is %s',async problem=>{
 const k=await setup();try{
  const existing={async readRoot(){return {ok:true as const,rootId:'synthetic-root'};},async writeRoot(){return {ok:true as const};}};
  const fetcher:typeof fetch=async(input,init)=>{const url=new URL(String(input));if(url.pathname==='/token')return fetch(input,init);if(url.pathname==='/drive/v3/about')return new Response(JSON.stringify({user:{permissionId:'synthetic-account'}}));if(url.pathname==='/drive/v3/files/synthetic-root'){if(problem==='missing'||problem==='forbidden')return new Response('synthetic-private',{status:problem==='missing'?404:403});return new Response(JSON.stringify({id:'synthetic-root',mimeType:problem==='wrong-mime'?'text/plain':'application/vnd.google-apps.folder',trashed:problem==='trashed',owners:[{permissionId:problem==='wrong-owner'?'other':'synthetic-account'}],capabilities:{canListChildren:problem!=='unreadable'}}));}return new Response('',{status:404});};
  const result=await connectDrive({home:k.home,tokenEndpoint:`${k.server.base}/token`,driveBaseUrl:k.server.base,roots:existing,fetch:fetcher,bindAccount:async()=>true,openAuthorization:callback()});expect(result).toMatchObject({ok:false});expect(await readDriveCredentials(k.home)).toBeNull();
 }finally{await k.close();}
});

it('rejects a delayed refresh after disconnect and a new consent with the same client',async()=>{
 const k=await setup();try{
  await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'first'});
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});
  const auth=driveAuth({home:k.home,tokenEndpoint:'http://synthetic/token',fetch:async()=>{entered();await hold;return new Response(JSON.stringify({access_token:'stale-access',refresh_token:'stale-refresh'}));}});
  const pending=auth.token();await started;await deleteDriveRefreshToken(k.home);await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'new-account'});release();
  expect(await pending).toMatchObject({ok:false,code:'AUTH_SESSION_CHANGED'});expect(await readDriveCredentials(k.home)).toMatchObject({refreshToken:'new-account'});
 }finally{await k.close();}
});

it.each([false,true])('rejects incomplete root discovery with existing result %s',async exists=>{
 const k=await setup();try{k.server.setIncomplete(true,exists);const root=roots();const result=await connectDrive({home:k.home,tokenEndpoint:`${k.server.base}/token`,driveBaseUrl:k.server.base,roots:root,openAuthorization:callback()});expect(result).toMatchObject({ok:false,code:'AUTH_TEMPORARY'});expect(k.server.creates).toBe(0);expect(k.server.rootFields).toContain('incompleteSearch');expect(await root.readRoot()).toEqual({ok:true,rootId:null});expect(await readDriveCredentials(k.home)).toBeNull();}finally{await k.close();}
});

it('keeps an old daemon round bound to its original consent even before its first refresh',async()=>{
 const k=await setup();try{
  await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'first'});const original=await readDriveCredentials(k.home);expect(original).not.toBeNull();let requests=0;const old=driveAuth({home:k.home,expectedCredentials:original,tokenEndpoint:'http://fake/token',fetch:async()=>{requests++;return new Response(JSON.stringify({access_token:'wrong'}));}});
  await deleteDriveRefreshToken(k.home);await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'different-account'});expect(await old.token()).toMatchObject({ok:false,code:'AUTH_SESSION_CHANGED'});expect(requests).toBe(0);expect(await readDriveCredentials(k.home)).toMatchObject({refreshToken:'different-account'});
 }finally{await k.close();}
});

it('preserves a live and then killed child refresh lock until its owner and I/O are confirmed stopped',async()=>{
 const {fork}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const {runtimeChecks}=await import('../src/doctor/checks.js');const {sourceDrive}=await import('../src/runtime/source-drive.js');
 const k=await setup();const child=fork(fileURLToPath(new URL('./fixtures/drive-refresh-lock-child.mjs',import.meta.url)),[],{stdio:['ignore','ignore','pipe','ipc']});
 const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 try{
  await saveDriveCredentials(k.home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'});const entered=once(child,'message');child.send({home:k.home});expect(await Promise.race([entered.then(([message])=>message),closed.then(result=>{throw Error(`refresh lock child exited before barrier: ${JSON.stringify(result)}`);})])).toBe('held');const lock=join(k.home,'.drive-refresh.lock'),owner=await readFile(join(lock,'owner'),'utf8');let requests=0;
  const auth=driveAuth({home:k.home,tokenEndpoint:'http://synthetic/token',fetch:async()=>{requests++;return new Response('{}');}});const result=await auth.token();expect(result).toMatchObject({ok:false,code:'AUTH_REFRESH_LOCKED'});expect(JSON.stringify(result)).not.toContain(k.home);expect(JSON.stringify(result)).not.toContain('synthetic-secret');expect(requests).toBe(0);expect(await readFile(join(lock,'owner'),'utf8')).toBe(owner);
  expect(child.kill('SIGKILL')).toBe(true);expect(await closed).toMatchObject({signal:'SIGKILL'});expect(await readFile(join(lock,'owner'),'utf8')).toBe(owner);
  const diagnostic=await runtimeChecks({home:k.home}).find(check=>check.id==='drive-refresh-lock')!.run();expect(diagnostic).toMatchObject({status:'warn',code:'DRIVE_REFRESH_LOCK_PRESENT'});expect(JSON.stringify(diagnostic)).not.toContain(k.home);
  await deleteDriveRefreshToken(k.home);expect(await readDriveCredentials(k.home)).toBeNull();await rm(lock,{recursive:true});expect(await auth.token()).toMatchObject({ok:false,code:'AUTH_REQUIRED'});expect(requests).toBe(0);
  const retry=await sourceDrive({baseUrl:'http://synthetic',auth:{async token(){return result;},async retryAfter401(){return result;}}}).startToken();expect(retry).toMatchObject({ok:false,code:'TEMPORARY',message:expect.stringContaining('토큰 갱신 잠금')});
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;await k.close();}
},30000);
