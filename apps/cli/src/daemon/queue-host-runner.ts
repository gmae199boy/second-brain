import { spawn, type ChildProcess } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { serveQueueFrames, type QueueFrameHandler } from './queue-frame-stream.js';
import { queueOptionsFromFrame } from './protected-queue.js';
import type { QueueHostRunner } from './protected-queue-host.js';
import { SEALED_QUEUE_HOST, verifyInstalledQueueHost } from './sealed-native-bridge.js';

/** 고정 설치 조립 또는 격리 시험만 spawn을 공급한다. 일반 요청은 명령·경로를 고르지 못한다. */
export function createQueueHostRunner(start: () => Promise<ChildProcess>, service: QueueFrameHandler): QueueHostRunner {
  return {async run(request) {
    const options=queueOptionsFromFrame(request);if(!options)return {cleanup:'confirmed'};
    let child: ChildProcess;
    try {child=await start();} catch {return {cleanup:'unknown'};}
    const control=child.stdio[3] as Duplex | null, channel=child.stdio[4] as Duplex | null;
    if(!child.stdin || !child.stdout || !child.stderr || !control || !channel) {child.kill('SIGKILL');return {cleanup:'unknown'};}
    let output=Buffer.alloc(0),status=Buffer.alloc(0),failed=false;
    child.stderr.resume();
    child.stdout.on('data',(b:Buffer)=>{output=Buffer.concat([output,b]);if(output.length>1024*1024+65536){failed=true;child.kill('SIGKILL');}});
    control.on('data',(b:Buffer)=>{status=Buffer.concat([status,b]);if(status.length>1){failed=true;child.kill('SIGKILL');}});
    control.on('error',()=>{failed=true;});channel.on('error',()=>{failed=true;});child.stdin.on('error',()=>{failed=true;});
    const done=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{
      let settled=false;const finish=(code:number|null,signal:NodeJS.Signals|null)=>{if(!settled){settled=true;clearTimeout(timer);resolve({code,signal});}};
      const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');finish(null,'SIGKILL');},20000);
      child.once('error',()=>finish(null,null));child.once('close',(code,signal)=>finish(code,signal));
    });
    const frames=serveQueueFrames(channel,async frame=>await new Promise<void>((resolve,reject)=>{channel.write(frame,e=>e?reject(e):resolve());}),service).catch(()=>{failed=true;});
    channel.write(Buffer.from([1]));child.stdin.end(JSON.stringify(options));
    const exit=await done;channel.destroy();control.destroy();await frames;
    const cleanup=status.length===1&&status[0]===67?'confirmed' as const:'unknown' as const;
    if(failed||exit.code!==0||cleanup!=='confirmed')return {cleanup};
    try {const value:unknown=JSON.parse(output.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))return {cleanup};
      const record=value as Record<string,unknown>;if(Object.keys(record).sort().join(',')!=='response,result'||typeof record.response!=='string')return {cleanup};
      return {cleanup,response:record.response};
    } catch {return {cleanup};}
  }};
}

/** pin은 보호 설치 registry만 공급하며 호출자는 경로·환경을 선택하지 못한다. */
export function createInstalledQueueHostRunner(expectedHash: string, service: QueueFrameHandler): QueueHostRunner {
  return createQueueHostRunner(async()=>{
    if(!await verifyInstalledQueueHost(expectedHash))throw new Error('unverified');
    return spawn(SEALED_QUEUE_HOST,[],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe','pipe','pipe']});
  },service);
}
