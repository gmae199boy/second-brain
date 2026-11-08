import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { it, onTestFinished } from 'vitest';
import { createLifecycle } from './artifacts-lifecycle.js';

// This file is selected only by the isolated child Vitest configuration.
// Its intentional timeout is asserted by the parent test, not the main suite.
it('intentional timeout exercises lifecycle fencing', async()=>{
  const marker=process.env.LIFECYCLE_MARKER!;
  const original=pg.Client.prototype.query;
  let child:ReturnType<typeof spawn>|undefined, close:Promise<void>|undefined;
  let release!:()=>void, spawned=0, lateSpawns=0, lateOverrides=0, resumed=false, bodySettled=false, childClosed=false, disposed=false;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const life=createLifecycle({
    interrupt:[()=>release(),async()=>{if(child){child.kill('SIGKILL'); await close;}}],
    dispose:[()=>{pg.Client.prototype.query=original;},()=>{disposed=true;}],
    mask:value=>value,diagnostic:()=>undefined,
  });
  onTestFinished(async()=>{
    let cleanupError=''; try {await life.finish();} catch(error) {cleanupError=String(error);}
    await writeFile(marker,JSON.stringify({spawned,lateSpawns,lateOverrides,resumed,bodySettled,childClosed,disposed,restored:pg.Client.prototype.query===original,cleanupError}));
  });
  await life.run(async()=>{
    life.check(); child=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore']});
    close=new Promise(resolve=>{child!.on('error',()=>{}); child!.on('close',()=>{childClosed=true; resolve();});});
    await new Promise<void>((resolve,reject)=>{child!.once('spawn',()=>{spawned++; resolve();}); child!.once('error',reject);});
    life.check(); (pg.Client.prototype as any).query=function(){throw Error('fixture override');};
    try {
      await pending; resumed=true;
      life.check(); lateSpawns++; spawn(process.execPath,['-e',''],{stdio:'ignore'});
      life.check(); lateOverrides++; (pg.Client.prototype as any).query=function(){throw Error('late override');};
    } finally {bodySettled=true;}
  });
  await life.finish().catch(()=>{});
},500);
