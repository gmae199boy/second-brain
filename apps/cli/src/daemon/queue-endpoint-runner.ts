import { spawn, type ChildProcess } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { serveQueueFrames, type QueueFrameHandler } from './queue-frame-stream.js';
import { SEALED_QUEUE_ENDPOINT, verifyInstalledQueueEndpoint } from './sealed-native-bridge.js';

export interface QueueEndpointRunner { run(handler: QueueFrameHandler,signal: AbortSignal): Promise<void> }
/** 고정 설치 조립 또는 격리 fixture만 실행물을 공급한다. */
export function createQueueEndpointRunner(start: () => Promise<ChildProcess>): QueueEndpointRunner {
  return {async run(handler,signal) {
    if(signal.aborted)return;
    const child=await start();const control=child.stdio[3] as Duplex | null,channel=child.stdio[4] as Duplex | null;
    if(!control||!channel||!child.stdout||!child.stderr){child.kill('SIGKILL');throw new Error('endpoint unavailable');}
    child.stdout.resume();child.stderr.resume();control.on('error',()=>{});channel.on('error',()=>{});
    let stopped: boolean=signal.aborted;let killTimer: NodeJS.Timeout | undefined;const abort=()=>{stopped=true;child.kill('SIGTERM');killTimer ??= setTimeout(()=>child.kill('SIGKILL'),10000);};signal.addEventListener('abort',abort,{once:true});
    const done=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    let frameError=false;const frames=serveQueueFrames(channel,async frame=>await new Promise<void>((resolve,reject)=>{channel.write(frame,e=>e?reject(e):resolve());}),handler).catch(()=>{frameError=true;});
    channel.write(Buffer.from([1]));if(stopped)abort();
    try {const code=await done;channel.destroy();control.destroy();await frames;if(frameError||!stopped||code!==0)throw new Error('endpoint exited');}
    finally {if(killTimer)clearTimeout(killTimer);signal.removeEventListener('abort',abort);channel.destroy();control.destroy();}
  }};
}
export function createInstalledQueueEndpointRunner(expectedHash: string): QueueEndpointRunner {
  return createQueueEndpointRunner(async()=>{
    if(!await verifyInstalledQueueEndpoint(expectedHash))throw new Error('unverified');
    return spawn(SEALED_QUEUE_ENDPOINT,[],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','pipe','pipe','pipe']});
  });
}
