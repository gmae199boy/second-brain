import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { expect, it } from 'vitest';

it('고정 Node 제한 프로세스의 OS peer와 목록 요청을 연결하고 신원 실패를 닫는다', async () => {
  const root=await mkdtemp(join(tmpdir(),'brain-node-peer-'));
  try {
    const payload=join(root,'payload'),reg=join(root,'registry');
    await mkdir(payload);await mkdir(reg);await mkdir(join(payload,'bin'));await mkdir(join(payload,'cli'));
    const node=join(payload,'bin/node'),cli=join(payload,'cli/bin.js'),gateway=join(root,'gateway');
    execFileSync('cp',[process.execPath,node]);execFileSync('codesign',['--force','--sign','-',node],{stdio:'ignore'});
    execFileSync(process.execPath,['node_modules/.pnpm/rolldown@1.2.12/node_modules/rolldown/bin/cli.mjs','apps/cli/dist/daemon/sealed-queue-entry.js','--platform','node','--format','esm','--no-codeSplitting','--file',cli],{stdio:'ignore'});
    const details=spawnSync('codesign',['-d','--verbose=4',node],{encoding:'utf8'}).stderr;
    const hash=/^CDHash=([0-9a-f]{40})$/mu.exec(details)?.[1];if(!hash)throw new Error('hash');
    const digest=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
    const base='extensions/garmin/native/';
    execFileSync('xcrun',['clang','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-DBRAIN_REGISTRY_FIXTURE','-DBRAIN_PEER_DIAGNOSTIC',...['sealed-files.c','sealed-bundle.c','sealed-signature.c','sealed-registry.c','peer.c','data-peer.c','tests/node-queue-gateway-fixture.c'].map(p=>base+p),'-lbsm','-framework','Security','-framework','CoreFoundation','-o',gateway]);
    const gatewayDetails=spawnSync('codesign',['-d','--verbose=4',gateway],{encoding:'utf8'}).stderr;
    const gatewayHash=/^CDHash=([0-9a-f]{40})$/mu.exec(gatewayDetails)?.[1];if(!gatewayHash)throw new Error('gateway hash');
    const addon=join(payload,'cli/peer.node');
    execFileSync('xcrun',['clang','-bundle','-undefined','dynamic_lookup','-Wno-deprecated-declarations','-DBRAIN_PEER_DIAGNOSTIC',`-I${join(dirname(dirname(process.execPath)),'include/node')}`,`-DBRAIN_QUEUE_GATEWAY_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_GATEWAY_HASH="${gatewayHash}"`,base+'queue-peer-addon.c',base+'peer.c','-lbsm','-framework','Security','-framework','CoreFoundation','-o',addon]);
    execFileSync('codesign',['--force','--sign','-',addon],{stdio:'ignore'});
    const addonHash=/^CDHash=([0-9a-f]{40})$/mu.exec(spawnSync('codesign',['-d','--verbose=4',addon],{encoding:'utf8'}).stderr)?.[1];if(!addonHash)throw new Error('addon hash');
    await writeFile(join(reg,'queue.registry'),`brain-queue-registry-v2\n${hash}\n${addonHash}\n${await digest(node)} bin/node\n${await digest(cli)} cli/bin.js\n${await digest(addon)} cli/peer.node\n`);
    async function run(mode:string, serviceEnv?: NodeJS.ProcessEnv, executable=gateway, pinnedHash=gatewayHash!) {
      const child=spawn(executable,[reg,payload,hash!,mode,pinnedHash],{stdio:['pipe','pipe','pipe','pipe','pipe']});
      const calls: Buffer[]=[];const replies=child.stdio[4] as Writable;
      const service = serviceEnv ? spawn(process.execPath,['apps/cli/test/fixtures/queue-data-service.mjs'],{env:serviceEnv,stdio:['pipe','pipe','pipe']}) : undefined;
      const serviceDone = service ? once(service,'close') : undefined;
      if(service) { (child.stdio[3] as Readable).pipe(service.stdin); service.stdout.pipe(replies); }
      else (child.stdio[3] as Readable).on('data',(b:Buffer)=>{calls.push(b); const all=Buffer.concat(calls);if(all.length>=4 && all.length===all.readUInt32BE(0)+4){const body=Buffer.from(JSON.stringify({ok:true,items:[],count:0,hasMore:false}));const head=Buffer.alloc(4);head.writeUInt32BE(body.length);replies.end(Buffer.concat([head,body]));}});
      let output='',diagnostic='';child.stdout.on('data',b=>output+=String(b));child.stderr.on('data',b=>diagnostic+=String(b));child.stdin.end(JSON.stringify({all:true,kind:serviceEnv?'process_probe':'probe',limit:'2'}));
      const [code]=await once(child,'close');if(serviceDone)expect((await serviceDone)[0]).toBe(0);return {code,output,diagnostic,calls:Buffer.concat(calls)};
    }
    const forged=spawn(node,[cli,'--sealed-queue-client'],{stdio:['pipe','pipe','pipe','pipe','pipe','pipe','pipe']});
    let forgedOut='';forged.stdout.on('data',b=>forgedOut+=String(b));
    const forgedAck = (forged.stdio as unknown as Writable[])[6]!;forgedAck.on('error',()=>{});forgedAck.end(Buffer.from([1]));
    forged.stdin.end(JSON.stringify({all:true}));
    expect((await once(forged,'close'))[0]).toBe(2);expect(forgedOut).toBe('');
    const normal=await run('ok');expect(normal.code,normal.diagnostic).toBe(0);expect(normal.diagnostic).toMatch(/SERVICE_EXEC pid=[1-9][0-9]* parent=[1-9][0-9]*/u);expect(JSON.parse(normal.output).result).toMatchObject({ok:true,data:{items:[]},meta:{count:0,has_more:false}});
    expect(JSON.parse(normal.calls.subarray(4).toString())).toEqual({operation:'queue.list.v1',all:true,kind:'probe',limit:2});
    if(process.env['BRAIN_G6_PG']==='1') {
      const {supervisorFixture}=await import('./supervisor-fixture.js');
      const home=join(root,'home');await mkdir(home);const f=await supervisorFixture(home);
      try {
        const id=await f.enqueueProbe();
        const real=await run('ok',{...process.env,...f.env,BRAIN_QUEUE_FIXTURE_HOME:home,BRAIN_QUEUE_FIXTURE_DB:f.db.appUrl});
        expect(real.code,real.diagnostic).toBe(0);expect(JSON.parse(real.output).result.data.items).toEqual(expect.arrayContaining([expect.objectContaining({id})]));
      } finally {await f.close();}
    }
    const extra=join(payload,'cli/other.js');await writeFile(extra,'process.exit(0)');
    const extraDenied=await run('ok');expect(extraDenied.code).not.toBe(0);expect(extraDenied.calls.length).toBe(0);await rm(extra);
    const original=await readFile(cli);await writeFile(cli,'process.exit(0)');
    const tamperDenied=await run('ok');expect(tamperDenied.code).not.toBe(0);expect(tamperDenied.calls.length).toBe(0);await writeFile(cli,original);
    for(const mode of ['deny-hash','deny-pid','deny-ack','deny-service','deny-service-pid','replace']) {const denied=await run(mode);expect(denied.code).not.toBe(0);if(denied.output)expect(JSON.parse(denied.output).result).toMatchObject({ok:false,code:'SERVICE_UNAVAILABLE'});expect(denied.calls.length).toBe(0);}
    const productGateway=join(root,'product-gateway');
    execFileSync('xcrun',['clang','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-DBRAIN_REGISTRY_FIXTURE',...['sealed-files.c','sealed-bundle.c','sealed-signature.c','sealed-registry.c','peer.c','data-peer.c','queue-launcher.c','tests/queue-launcher-fixture.c'].map(p=>base+p),'-lbsm','-framework','Security','-framework','CoreFoundation','-o',productGateway]);
    const productDetails=spawnSync('codesign',['-d','--verbose=4',productGateway],{encoding:'utf8'}).stderr;
    const productHash=/^CDHash=([0-9a-f]{40})$/mu.exec(productDetails)?.[1];if(!productHash)throw new Error('product hash');
    await rm(addon);
    execFileSync('xcrun',['clang','-bundle','-undefined','dynamic_lookup','-Wno-deprecated-declarations',`-I${join(dirname(dirname(process.execPath)),'include/node')}`,`-DBRAIN_QUEUE_GATEWAY_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_GATEWAY_HASH="${productHash}"`,base+'queue-peer-addon.c',base+'peer.c','-lbsm','-framework','Security','-framework','CoreFoundation','-o',addon]);
    execFileSync('codesign',['--force','--sign','-',addon],{stdio:'ignore'});
    const productAddonHash=/^CDHash=([0-9a-f]{40})$/mu.exec(spawnSync('codesign',['-d','--verbose=4',addon],{encoding:'utf8'}).stderr)?.[1];if(!productAddonHash)throw new Error('addon hash');
    await writeFile(join(reg,'queue.registry'),`brain-queue-registry-v2\n${hash}\n${productAddonHash}\n${await digest(node)} bin/node\n${await digest(cli)} cli/bin.js\n${await digest(addon)} cli/peer.node\n`);
    execFileSync(productGateway,[reg,payload,hash!,'cleanup',productHash],{stdio:'ignore'});
    const product=await run('ok',undefined,productGateway,productHash);expect(product.code).toBe(0);expect(JSON.parse(product.output).result).toMatchObject({ok:true,data:{items:[]}});
    for(const mode of ['deny-service','deny-service-pid','replace']) {const denied=await run(mode,undefined,productGateway,productHash);expect(denied.code).not.toBe(0);expect(denied.calls.length).toBe(0);}
    const repeat=await run('repeat',undefined,productGateway,productHash);expect(repeat.code).toBe(0);
    const rogue=join(payload,'cli/rogue.js');await writeFile(rogue,'process.exit(0)');
    const proxy=await run('ok',undefined,productGateway,productHash);expect(proxy.code).not.toBe(0);expect(proxy.calls.length).toBe(0);await rm(rogue);

    if(process.env['BRAIN_G6_PG']==='1') {
      const {supervisorFixture}=await import('./supervisor-fixture.js');
      const home=join(root,'product-home');await mkdir(home);const f=await supervisorFixture(home);
      try {
        const id=await f.enqueueProbe();
        const actual=await run('ok',{...process.env,...f.env,BRAIN_QUEUE_FIXTURE_HOME:home,BRAIN_QUEUE_FIXTURE_DB:f.db.appUrl},productGateway,productHash);
        expect(actual.code,actual.diagnostic).toBe(0);expect(JSON.parse(actual.output).result.data.items).toEqual(expect.arrayContaining([expect.objectContaining({id})]));
      } finally {await f.close();}
    }


    const supervisor=join(root,'supervisor'),host=join(root,'host');
    const common=['-Wall','-Wextra','-Werror','-Wno-deprecated-declarations'];
    execFileSync('xcrun',['clang',...common,...['peer.c','data-peer.c','tests/queue-supervisor-fixture.c'].map(p=>base+p),'-lbsm','-framework','Security','-framework','CoreFoundation','-o',supervisor]);
    const cdhash=(path:string)=>/^CDHash=([0-9a-f]{40})$/mu.exec(spawnSync('codesign',['-d','--verbose=4',path],{encoding:'utf8'}).stderr)?.[1];
    const supervisorHash=cdhash(supervisor);if(!supervisorHash)throw new Error('supervisor hash');
    execFileSync('xcrun',['clang',...common,'-DBRAIN_REGISTRY_FIXTURE',`-DBRAIN_QUEUE_SUPERVISOR_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_SUPERVISOR_HASH="${supervisorHash}"`,...['sealed-files.c','sealed-bundle.c','sealed-signature.c','sealed-registry.c','peer.c','data-peer.c','queue-launcher.c','queue-host.c','tests/queue-host-process-fixture.c'].map(p=>base+p),'-lbsm','-framework','Security','-framework','CoreFoundation','-o',host]);
    const hostHash=cdhash(host);if(!hostHash)throw new Error('host hash');
    await rm(addon);
    execFileSync('xcrun',['clang','-bundle','-undefined','dynamic_lookup','-Wno-deprecated-declarations',`-I${join(dirname(dirname(process.execPath)),'include/node')}`,`-DBRAIN_QUEUE_GATEWAY_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_GATEWAY_HASH="${hostHash}"`,base+'queue-peer-addon.c',base+'peer.c','-lbsm','-framework','Security','-framework','CoreFoundation','-o',addon]);
    execFileSync('codesign',['--force','--sign','-',addon],{stdio:'ignore'});
    const lastAddonHash=cdhash(addon);if(!lastAddonHash)throw new Error('addon hash');
    await writeFile(join(reg,'queue.registry'),`brain-queue-registry-v2\n${hash}\n${lastAddonHash}\n${await digest(node)} bin/node\n${await digest(cli)} cli/bin.js\n${await digest(addon)} cli/peer.node\n`);
    async function runHost(serviceEnv?: NodeJS.ProcessEnv,mode='ok') {
      const proc=spawn(supervisor,[host,reg,payload,supervisorHash!,hostHash!,mode],{stdio:['pipe','pipe','pipe','pipe','pipe']});
      const service=serviceEnv?spawn(process.execPath,['apps/cli/test/fixtures/queue-data-service.mjs'],{env:serviceEnv,stdio:['pipe','pipe','pipe']}):undefined;
      const serviceDone=service?once(service,'close'):undefined;const output:Buffer[]=[];let diagnostic='';proc.stderr.on('data',b=>diagnostic+=String(b));
      if(service){(proc.stdio[3] as Readable).pipe(service.stdin);service.stdout.pipe(proc.stdio[4] as Writable);}
      else (proc.stdio[3] as Readable).on('data',(b:Buffer)=>{const body=Buffer.from(JSON.stringify({ok:true,items:[],count:0,hasMore:false}));const header=Buffer.alloc(4);header.writeUInt32BE(body.length);(proc.stdio[4] as Writable).end(Buffer.concat([header,body]));});
      proc.stdout.on('data',b=>output.push(b));proc.stdin.end(JSON.stringify({all:true,kind:serviceEnv?'process_probe':'probe',limit:'2'}));
      const [code]=await once(proc,'close');if(serviceDone)expect((await serviceDone)[0]).toBe(0);return {code,output:Buffer.concat(output).toString(),diagnostic};
    }
    const fakeSupervisor=spawn(host,[],{stdio:['pipe','pipe','pipe','pipe','pipe','pipe','pipe','pipe']});
    const fakeFds=fakeSupervisor.stdio as unknown as Writable[];fakeFds[5]!.on('error',()=>{});fakeFds[5]!.end(Buffer.alloc(32));
    fakeSupervisor.stdin.end(JSON.stringify({all:true}));let fakeOutput='';fakeSupervisor.stdout.on('data',b=>fakeOutput+=String(b));
    expect((await once(fakeSupervisor,'close'))[0]).toBe(3);expect(fakeOutput).toBe('');
    const disconnected=await runHost(undefined,'disconnect');expect(disconnected.code).not.toBe(0);expect(disconnected.output).toBe('');
    const hosted=await runHost();expect(hosted.code,hosted.diagnostic).toBe(0);expect(JSON.parse(hosted.output).result).toMatchObject({ok:true,data:{items:[]}});
    if(process.env['BRAIN_G6_PG']==='1') {
      const {supervisorFixture}=await import('./supervisor-fixture.js');const home=join(root,'host-home');await mkdir(home);const f=await supervisorFixture(home);
      try {const id=await f.enqueueProbe();const actual=await runHost({...process.env,...f.env,BRAIN_QUEUE_FIXTURE_HOME:home,BRAIN_QUEUE_FIXTURE_DB:f.db.appUrl});expect(actual.code,actual.diagnostic).toBe(0);expect(JSON.parse(actual.output).result.data.items).toEqual(expect.arrayContaining([expect.objectContaining({id})]));} finally {await f.close();}
    }

  } finally {await rm(root,{recursive:true,force:true});}
}, 30000);
