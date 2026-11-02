import { expect, it, vi } from 'vitest';
import { serveProtectedQueueHost } from '../src/daemon/protected-queue-host.js';
import { createInstalledProtectedService } from '../src/daemon/protected-supervisor.js';

it('영속 admission 실패와 종료 불명은 새 보호 host 시작을 막는다',async()=>{
  let state: 'empty'|'running'|'unknown'='empty';let owner='';
  const fence={begin:vi.fn(async(token:string)=>{if(state!=='empty')return false;state='running';owner=token;return true;}),settle:vi.fn(async(token:string,confirmed:boolean)=>{if(token!==owner||state!=='running')return false;state=confirmed?'empty':'unknown';return true;})};
  const failing={run:vi.fn(async():Promise<{cleanup:'confirmed'|'unknown';response?:string}>=>{throw new Error('lost');})};
  expect(await serveProtectedQueueHost(fence,failing,'fixture')).toBeUndefined();expect(state).toBe('unknown');
  const next={run:vi.fn(async()=> ({cleanup:'confirmed' as const,response:'ok'}))};expect(await serveProtectedQueueHost(fence,next,'fixture')).toBeUndefined();expect(next.run).not.toHaveBeenCalled();
  expect(fence.settle).toHaveBeenCalledWith(owner,false);
});
it('확정 종료만 fence를 정리하며 DB 기록 실패는 성공으로 바꾸지 않는다',async()=>{
  const fence={begin:vi.fn(async()=>true),settle:vi.fn(async(_token:string,_confirmed:boolean)=>false)};
  expect(await serveProtectedQueueHost(fence,{run:async()=> ({cleanup:'confirmed',response:'ok'})},'fixture')).toBeUndefined();
  expect(fence.settle.mock.calls[0]?.[1]).toBe(true);
});

it('supervisor 전체 로딩 신원이 입증되기 전 설치 endpoint 설정을 거부한다',()=>{
  expect(()=>createInstalledProtectedService({} as never,{bridgeHash:'0'.repeat(40),queueInstallation:{hostHash:'1'.repeat(40),endpointHash:'2'.repeat(40),fence:{}}} as never)).toThrow('closure unverified');
});
