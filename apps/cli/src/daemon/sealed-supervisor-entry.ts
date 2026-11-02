import { readSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';

/** 고정 실행 경로의 bootstrap 부품이다. 보호 설치 조립이 완성되기 전 서비스는 시작하지 않는다. */
async function main(): Promise<void> {
  if(process.argv.length!==3||process.argv[2]!=='--sealed-supervisor')throw new Error('argv');
  const peer=createRequire(import.meta.url)('./peer.node') as {bootstrap():boolean;peer():boolean;claimSupervisor():unknown;readSupervisorConfig():string | undefined;consumeSupervisor(value:unknown):boolean;supervisorFixture():boolean};
  if(!peer.bootstrap()||writeSync(5,Buffer.from([1]))!==1)throw new Error('peer');
  const authority=peer.claimSupervisor();if(!authority)throw new Error('ack');
  if(peer.claimSupervisor()!==undefined||peer.consumeSupervisor({}))throw new Error('capability');
  const configuration=peer.readSupervisorConfig();if(!configuration||peer.readSupervisorConfig()!==undefined)throw new Error('configuration');
  // bootstrap ACK 전에는 제품 모듈 평가와 생성자/저장소 I/O를 시작하지 않는다.
  if(!peer.peer()||!peer.supervisorFixture())throw new Error('deployment');
  if(configuration!=='{"mode":"probe"}') {
    const product=await import('./sealed-supervisor-runtime.js');
    await product.runSealedSupervisor(configuration,authority,true);return;
  }
  const product=await import('./protected-supervisor.js');
  if(typeof product.createInstalledProtectedService!=='function')throw new Error('product');
  const body=Buffer.from('bootstrap-only'),frame=Buffer.alloc(4+body.length);frame.writeUInt32BE(body.length);body.copy(frame,4);
  if(writeSync(5,frame)!==frame.length)throw new Error('write');
  const end=Buffer.alloc(1);if(readSync(5,end,0,1,null)!==0)throw new Error('unexpected');
}
main().catch(()=>{process.exitCode=2;});
