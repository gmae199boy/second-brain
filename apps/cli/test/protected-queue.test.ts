import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBrain } from 'second_brain';
import { postgresStore } from 'second_brain/postgres';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';
import { runQueueList } from '../src/commands/queue-list.js';
import { createProtectedService } from '../src/daemon/protected-supervisor.js';
import { handleQueueFrame, protectedQueueClient, ProtectedQueueTransportError } from '../src/daemon/protected-queue.js';
import { brainDependencies } from '../src/assembly.js';
import { readConfig } from '../src/config/codec.js';
import { HOME_ENV } from '../src/config/paths.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { supervisorFixture } from './supervisor-fixture.js';

const clock={now:()=>new Date('2026-01-01T00:00:00.000Z')};
describe('보호 일감 목록 전송',()=>{
  it('CLI 옵션을 명명된 handler와 실제 Core·격리 PostgreSQL에 전달한다',async()=>{
    const home=await mkdtemp(join(tmpdir(),'brain-protected-queue-'));const f=await supervisorFixture(home);
    const store=postgresStore({databaseUrl:f.db.appUrl});
    try {
      const first=await f.enqueueProbe();await f.enqueueProbe(3000);
      const token=uuidV7IdGen().next();const now=new Date('2026-01-02T00:00:00.000Z');
      const claimed=await store.claimSupervisedWork({now:new Date(),claimedBy:uuidV7IdGen().next(),kinds:['process_probe'],attemptToken:token});
      if(!claimed.ok || !claimed.item)throw new Error('claim failed');
      await store.renewSupervisedLease({id:claimed.item.id,attemptToken:token,now,progressAt:now});
      await store.finishSupervisedWork({id:claimed.item.id,attemptToken:token,now:new Date(now.getTime()+1500),outcome:'succeeded',elapsedMs:1500,usage:{inputTokens:10,cachedInputTokens:2,outputTokens:5}});
      const env={...process.env,...f.env,[HOME_ENV]:home};const config=await readConfig(home);
      const assembly={home,env,config,store,clock,idGen:uuidV7IdGen(),workHandlers:{},schemaVersions:{core:1}};
      const brain=createBrain(brainDependencies(assembly));
      const service=createProtectedService({store} as never, {garmin:{},mutations:{},status:async()=>({available:true,requiresAction:false}),makeBrain:(commandStore:typeof store)=>createBrain(brainDependencies({...assembly,store:commandStore}))} as never, {revoker:{}} as never);
      const frames:string[]=[];const responses:string[]=[];const createStore=vi.fn(()=>{throw new Error('forbidden direct store');});
      const transport={request:async(frame:string)=>{frames.push(frame);const response=await service.requestQueueFrame(frame);expect(response).not.toContain('currentAttemptToken');expect(response).not.toContain('claimedBy');responses.push(response);return response;}};
      for(const options of [{all:true,kind:'process_probe',limit:'1'},{all:true,kind:'process_probe',limit:'2'},{all:false,kind:'missing',limit:'2'}]) {
        const expected=await runQueueList({options,queue:brain.queue});let stdout='';
        const argv=['queue','list','--json',...(options.all?['--all']:[]),'--kind',options.kind,'--limit',options.limit];
        const code=await dispatch(commands,argv,{env,clock,createStore,protectedQueueTransport:transport,stdout:s=>{stdout+=s;}});
        expect(code).toBe(0);expect(expected.ok).toBe(true);if(expected.ok){const actual=JSON.parse(stdout);expect(actual.data).toEqual(expected.data);expect(actual.meta).toMatchObject(expected.meta);}
      }
      const textExpected=await runQueueList({options:{all:true,kind:'process_probe',limit:'2'},queue:brain.queue});let textOutput='';
      const textCode=await dispatch(commands,['queue','list','--all','--kind','process_probe','--limit','2'],{env,clock,createStore,protectedQueueTransport:transport,stdout:s=>{textOutput+=s;}});
      expect(textCode).toBe(0);expect(textExpected.ok).toBe(true);if(textExpected.ok)expect(textOutput).toBe(textExpected.text.join('\n')+'\n');
      expect(first).toBeTruthy();expect(createStore).not.toHaveBeenCalled();expect(frames).toHaveLength(4);
      expect(JSON.parse(frames[0]!)).toEqual({operation:'queue.list.v1',all:true,kind:'process_probe',limit:1});
      expect(JSON.parse(responses[0]!).hasMore).toBe(true);
      const success=JSON.parse(responses[1]!);expect(success.items.some((item: {usage: unknown})=>item.usage!==null)).toBe(true);
      for(const change of [
        (v: any)=>{v.items[0].createdAt='not-a-date';},
        (v: any)=>{v.items[0].state='invented';},
        (v: any)=>{v.items[0].currentAttemptToken='secret';},
        (v: any)=>{v.count=999;},
      ]) {const forged=structuredClone(success);change(forged);expect(await protectedQueueClient({request:async()=>JSON.stringify(forged)}).list({all:true,limit:2})).toMatchObject({ok:false,code:'SERVICE_INVALID_RESPONSE'});}

    } finally {await store.close();await f.close();await rm(home,{recursive:true,force:true});}
  });
  it('부재·거부·불량·중복·초과 프레임은 실패 닫힘이다',async()=>{
    for(const [transport,code] of [
      [undefined,'SERVICE_UNAVAILABLE'],
      [{request:async()=>{throw new ProtectedQueueTransportError('denied');}},'SERVICE_DENIED'],
      [{request:async()=>'{"ok":true,"ok":false}'},'SERVICE_INVALID_RESPONSE'],
      [{request:async()=> ' '.repeat(1024*1024+1)},'SERVICE_INVALID_RESPONSE'],
      [{request:async()=>'{"ok":false,"code":"INVALID_REQUEST"}'},'SERVICE_INVALID_REQUEST'],
    ] as const) expect(await protectedQueueClient(transport).list()).toMatchObject({ok:false,code});
    const list=vi.fn();const queue={list} as unknown as Parameters<typeof handleQueueFrame>[1];
    for(const frame of ['{"operation":"queue.list.v1","all":false,"limit":1,"limit":2}','{"operation":"queue.list.v1","all":false,"limit":1,"sql":"select"}']) {
      expect(JSON.parse(await handleQueueFrame(frame,queue))).toEqual({ok:false,code:'INVALID_REQUEST'});
    }
    expect(list).not.toHaveBeenCalled();
  });
  it('서비스 부재와 거부 시 PostgreSQL을 열지 않는다',async()=>{
    const home=await mkdtemp(join(tmpdir(),'brain-protected-queue-absence-'));const f=await supervisorFixture(home);
    try {const env={...process.env,...f.env,[HOME_ENV]:home};const createStore=vi.fn(()=>{throw new Error('forbidden');});
      for(const [protectedQueueTransport,expected] of [[undefined,'SERVICE_UNAVAILABLE'],[{request:async()=>{throw new ProtectedQueueTransportError('denied');}},'SERVICE_DENIED']] as const) {
        let stdout='';const code=await dispatch(commands,['queue','list','--json'],{env,clock,createStore,protectedQueueTransport,stdout:s=>{stdout+=s;}});
        expect(code).not.toBe(0);expect(JSON.parse(stdout).error.code).toBe(expected);expect(createStore).not.toHaveBeenCalled();
      }
    } finally {await f.close();await rm(home,{recursive:true,force:true});}
  });
});
