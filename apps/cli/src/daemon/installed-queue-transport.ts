import { spawn, type ChildProcess } from 'node:child_process';
import { SEALED_QUEUE_CLIENT, verifyInstalledQueueClient } from './sealed-native-bridge.js';
import { ProtectedQueueTransportError, type ProtectedQueueTransport } from './protected-queue.js';

/** 호출자는 프레임만 제공한다. 실행물 선택은 보호 설치 또는 격리 fixture 책임이다. */
export function createQueueTransport(start: () => Promise<ChildProcess>): ProtectedQueueTransport {
  return {async request(frame) {
    let child: ChildProcess;try {child=await start();}catch{throw new ProtectedQueueTransportError('unavailable');}
    if(!child.stdin||!child.stdout||!child.stderr){child.kill('SIGKILL');throw new ProtectedQueueTransportError('unavailable');}
    const stdin=child.stdin,stdout=child.stdout,stderr=child.stderr;
    return await new Promise<string>((resolve,reject)=>{
      let bytes=Buffer.alloc(0),done=false;stderr.resume();
      const finish=(value?:string)=>{if(done)return;done=true;clearTimeout(timer);value===undefined?reject(new ProtectedQueueTransportError('unavailable')):resolve(value);};
      const timer=setTimeout(()=>{child.kill('SIGKILL');finish();},15000);
      stdout.on('data',(b:Buffer)=>{bytes=Buffer.concat([bytes,b]);if(bytes.length>1024*1024){child.kill('SIGKILL');finish();}});
      stdin.on('error',()=>finish());child.once('error',()=>finish());
      child.once('close',(code)=>{if(code!==0||!bytes.length)return finish();try {finish(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{finish();}});
      stdin.end(frame);
    });
  }};
}
/** root 설치와 OS peer 확인에 실패하면 사용자 저장소로 전환하지 않는다. */
export const installedQueueTransport = createQueueTransport(async()=>{
  if(!await verifyInstalledQueueClient())throw new ProtectedQueueTransportError('unavailable');
  return spawn(SEALED_QUEUE_CLIENT,[],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe']});
});
