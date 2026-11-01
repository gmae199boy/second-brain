import { mkdtemp, rm, readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';
import { HOME_ENV } from '../src/config/paths.js';
import { encodeQueueFrame, serveQueueFrames } from '../src/daemon/queue-frame-stream.js';
import { supervisorFixture } from './supervisor-fixture.js';
import { ProtectedQueueTransportError } from '../src/daemon/protected-queue.js';

it('분할·연속 frame을 순서대로 처리하고 잘린 입력을 거부한다',async()=>{
  const first=encodeQueueFrame('one'),second=encodeQueueFrame('two');const bytes=Buffer.concat([first,second]);
  const handler={requestQueueFrame:vi.fn(async (s:string)=>s.toUpperCase())};const responses:Buffer[]=[];
  async function* chunks(){yield bytes.subarray(0,2);yield bytes.subarray(2,7);yield bytes.subarray(7);}
  await serveQueueFrames(chunks(),async b=>{responses.push(b);},handler);
  expect(handler.requestQueueFrame.mock.calls).toEqual([['one'],['two']]);
  expect(Buffer.concat(responses)).toEqual(Buffer.concat([encodeQueueFrame('ONE'),encodeQueueFrame('TWO')]));
  async function* truncated(){yield first.subarray(0,first.length-1);}
  await expect(serveQueueFrames(truncated(),async()=>{},handler)).rejects.toThrow('truncated');
  async function* invalid(){yield Buffer.from([0,0,0,1,255]);}
  await expect(serveQueueFrames(invalid(),async()=>{},handler)).rejects.toThrow();
  async function* oversized(){yield Buffer.from([0,16,0,1]);}
  await expect(serveQueueFrames(oversized(),async()=>{},handler)).rejects.toThrow('invalid frame');
});
it('별도 합성 서비스 프로세스에서 제품 handler와 실제 Core·격리 PG를 왕복한다',async()=>{
  const home=await mkdtemp(join(tmpdir(),'brain-queue-stream-'));const f=await supervisorFixture(home);
  try {
    const id=await f.enqueueProbe();const env={...process.env,...f.env,[HOME_ENV]:home};const createStore=vi.fn(()=>{throw new Error('forbidden');});
    const transport={async request(frame:string){
      const child=spawn(process.execPath,['apps/cli/test/fixtures/queue-data-service.mjs'],{env:{...env,BRAIN_QUEUE_FIXTURE_HOME:home,BRAIN_QUEUE_FIXTURE_DB:f.db.appUrl},stdio:['pipe','pipe','pipe']});
      const output:Buffer[]=[];child.stdout.on('data',b=>output.push(b));child.stdin.end(encodeQueueFrame(frame));
      const [code]=await once(child,'close');if(code!==0)throw new Error('fixture');
      const bytes=Buffer.concat(output);if(bytes.length<4 || bytes.readUInt32BE(0)!==bytes.length-4)throw new Error('frame');
      return bytes.subarray(4).toString('utf8');
    }};
    let stdout='';const code=await dispatch(commands,['queue','list','--all','--kind','process_probe','--json'],{env,clock:{now:()=>new Date('2026-01-01T00:00:00.000Z')},createStore,protectedQueueTransport:transport,stdout:s=>{stdout+=s;}});
    expect(code).toBe(0);expect(JSON.parse(stdout).data.items).toEqual([expect.objectContaining({id,kind:'process_probe'})]);expect(createStore).not.toHaveBeenCalled();
  } finally {await f.close();await rm(home,{recursive:true,force:true});}
});

it('합성 native 상호 인증을 거쳐 분리 서비스의 실제 Core·PG 목록을 읽는다',async()=>{
  const home=await mkdtemp(join(tmpdir(),'brain-queue-native-'));const f=await supervisorFixture(home);
  try {
    const bundle=join(home,'bundle');await mkdir(bundle,{mode:0o700});const binary=join(bundle,'data-gateway');
    execFileSync('xcrun',['clang','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','extensions/garmin/native/peer.c','extensions/garmin/native/data-peer.c','extensions/garmin/native/sealed-files.c','extensions/garmin/native/sealed-bundle.c','extensions/garmin/native/sealed-signature.c','extensions/garmin/native/sealed-queue-spawn.c','extensions/garmin/native/tests/data-gateway-fixture.c','-lbsm','-framework','Security','-framework','CoreFoundation','-o',binary]);
    let details='';try{execFileSync('codesign',['-dv','--verbose=4',binary],{encoding:'utf8',stdio:['ignore','pipe','pipe']});}catch(error){details=String((error as {stderr?:string}).stderr ?? '');}
    // codesign은 진단을 stderr로 출력한다.
    if(!details){const {spawnSync}=await import('node:child_process');details=spawnSync('codesign',['-dv','--verbose=4',binary],{encoding:'utf8'}).stderr;}
    const hash=/^CDHash=([0-9a-f]{40})$/mu.exec(details)?.[1];if(!hash)throw new Error('fixture hash');
    const digest=createHash('sha256').update(await readFile(binary)).digest('hex');
    const id=await f.enqueueProbe();const env={...process.env,...f.env,[HOME_ENV]:home};const createStore=vi.fn(()=>{throw new Error('forbidden');});
    let mode='fixture';
    const transport={async request(frame:string){
      const service=spawn(process.execPath,['apps/cli/test/fixtures/queue-data-service.mjs'],{env:{...env,BRAIN_QUEUE_FIXTURE_HOME:home,BRAIN_QUEUE_FIXTURE_DB:f.db.appUrl},stdio:['pipe','pipe','pipe']});
      const gateway=spawn(binary,[hash,mode,mode==='deny-payload'?'0'.repeat(64):digest],{env:{...env,NODE_OPTIONS:'--require /tmp/injected.cjs',NODE_PATH:'/tmp',DYLD_LIBRARY_PATH:'/tmp'},stdio:['pipe','pipe','pipe','pipe','pipe']});
      const serviceDone=once(service,'close');const gatewayDone=once(gateway,'close');
      (gateway.stdio[3] as Readable).pipe(service.stdin);service.stdout.pipe(gateway.stdio[4] as Writable);
      const output:Buffer[]=[];let diagnostic='';gateway.stderr.on('data',b=>{diagnostic+=String(b);});gateway.stdout.on('data',b=>output.push(b));gateway.stdin.end(encodeQueueFrame(frame));
      const [gatewayCode]=await gatewayDone;const [serviceCode]=await serviceDone;
      if(gatewayCode!==0 || serviceCode!==0){console.error('게이트웨이 종료 코드',gatewayCode,'서비스 종료 코드',serviceCode,diagnostic);throw new ProtectedQueueTransportError('denied');}
      const bytes=Buffer.concat(output);if(bytes.length<4 || bytes.readUInt32BE(0)!==bytes.length-4)throw new Error('frame');
      return bytes.subarray(4).toString('utf8');
    }};
    let stdout='';const code=await dispatch(commands,['queue','list','--all','--json'],{env,clock:{now:()=>new Date('2026-01-01T00:00:00.000Z')},createStore,protectedQueueTransport:transport,stdout:s=>{stdout+=s;}});
    expect(code).toBe(0);expect(JSON.parse(stdout).data.items).toEqual([expect.objectContaining({id})]);expect(createStore).not.toHaveBeenCalled();
    for(mode of ['deny-client','deny-server','deny-instance','deny-payload','deny-signature','deny-extra']) {
      if(mode==='deny-extra')await writeFile(join(bundle,'unregistered.js'),'fixture',{mode:0o600});
      stdout='';const denied=await dispatch(commands,['queue','list','--json'],{env,clock:{now:()=>new Date('2026-01-01T00:00:00.000Z')},createStore,protectedQueueTransport:transport,stdout:s=>{stdout+=s;}});
      expect(denied).toBe(2);expect(JSON.parse(stdout).error.code).toBe('SERVICE_DENIED');expect(createStore).not.toHaveBeenCalled();
      if(mode==='deny-extra')await unlink(join(bundle,'unregistered.js'));
    }
  } finally {await f.close();await rm(home,{recursive:true,force:true});}
});
