import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { createBrain } from 'second_brain';
import { CORE_SCHEMA_VERSION, postgresQueueHostFence, postgresStore } from 'second_brain/postgres';
import { isolatedClusterDatabase } from '../../../packages/postgres/test/isolated-cluster.js';
import { prepareProtectedRoles } from '../../../packages/postgres/src/protected-roles.js';
import { writeConfig, readConfig } from '../src/config/codec.js';
import { HOME_ENV } from '../src/config/paths.js';
import { brainDependencies } from '../src/assembly.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { createProtectedService } from '../src/daemon/protected-supervisor.js';
import { createQueueHostRunner } from '../src/daemon/queue-host-runner.js';
import { createQueueEndpointRunner } from '../src/daemon/queue-endpoint-runner.js';
import { createQueueTransport } from '../src/daemon/installed-queue-transport.js';
import { systemProcessInspector } from '../src/runtime/process-inspector.js';
import { systemTimer } from '../src/runtime/clock.js';
import { ProtectedQueueTransportError } from '../src/daemon/protected-queue.js';
import { runQueueList } from '../src/commands/queue-list.js';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';

it('보호 서비스가 native host와 영속 fence를 소유하여 기존 queue 출력을 낸다',async()=>{
  const root=await mkdtemp(join(tmpdir(),'brain-queue-product-'));const db=await isolatedClusterDatabase();
  const admin=new pg.Client({connectionString:db.url});let fence: ReturnType<typeof postgresQueueHostFence> | undefined;
  const store=postgresStore({databaseUrl:db.appUrl});
  try {
    await admin.connect();await prepareProtectedRoles(db.url);
    const migration=await readFile(new URL('../../../packages/postgres/protected-migrations/0032_protected_queue_host_fence.sql',import.meta.url),'utf8');
    await admin.query('set role brain_owner');await admin.query(migration);await admin.query('reset role');
    await admin.query("alter role brain_protected_supervisor login password 'fixture-queue-host'");
    const roleUrl=new URL(db.url);roleUrl.username='brain_protected_supervisor';roleUrl.password='fixture-queue-host';fence=postgresQueueHostFence({databaseUrl:roleUrl.toString()});
    const home=join(root,'home'),payload=join(root,'payload'),reg=join(root,'registry');await mkdir(home);await mkdir(payload);await mkdir(reg);await mkdir(join(payload,'bin'));await mkdir(join(payload,'cli'));expect((await writeConfig(home,{})).ok).toBe(true);
    const node=join(payload,'bin/node'),cli=join(payload,'cli/bin.js'),addon=join(payload,'cli/peer.node'),host=join(root,'host');
    execFileSync('cp',[process.execPath,node]);execFileSync('codesign',['--force','--sign','-',node],{stdio:'ignore'});
    execFileSync(process.execPath,['node_modules/.pnpm/rolldown@1.2.12/node_modules/rolldown/bin/cli.mjs','apps/cli/dist/daemon/sealed-queue-entry.js','--platform','node','--format','esm','--no-codeSplitting','--file',cli],{stdio:'ignore'});
    const cdhash=(p:string)=>/^CDHash=([0-9a-f]{40})$/mu.exec(spawnSync('codesign',['-d','--verbose=4',p],{encoding:'utf8'}).stderr)?.[1];
    const supervisorHash=cdhash(process.execPath),nodeHash=cdhash(node);if(!supervisorHash||!nodeHash)throw new Error('hash');
    const base='extensions/garmin/native/';const sources=['sealed-files.c','sealed-bundle.c','sealed-signature.c','sealed-registry.c','peer.c','data-peer.c','queue-launcher.c','queue-supervisor-host.c'].map(p=>base+p);
    execFileSync('xcrun',['clang','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-DBRAIN_REGISTRY_FIXTURE',`-DBRAIN_QUEUE_SUPERVISOR_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_SUPERVISOR_HASH="${supervisorHash}"`,`-DBRAIN_QUEUE_REGISTRY_DIR="${reg}"`,`-DBRAIN_QUEUE_PAYLOAD_DIR="${payload}"`,...sources,'-lbsm','-framework','Security','-framework','CoreFoundation','-o',host]);
    const hostHash=cdhash(host);if(!hostHash)throw new Error('host hash');
    execFileSync('xcrun',['clang','-bundle','-undefined','dynamic_lookup','-Wno-deprecated-declarations',`-I${join(dirname(dirname(process.execPath)),'include/node')}`,`-DBRAIN_QUEUE_GATEWAY_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_GATEWAY_HASH="${hostHash}"`,base+'queue-peer-addon.c',base+'peer.c','-lbsm','-framework','Security','-framework','CoreFoundation','-o',addon]);
    execFileSync('codesign',['--force','--sign','-',addon],{stdio:'ignore'});const addonHash=cdhash(addon);if(!addonHash)throw new Error('addon hash');
    const digest=async(p:string)=>createHash('sha256').update(await readFile(p)).digest('hex');
    await writeFile(join(reg,'queue.registry'),`brain-queue-registry-v2\n${nodeHash}\n${addonHash}\n${await digest(node)} bin/node\n${await digest(cli)} cli/bin.js\n${await digest(addon)} cli/peer.node\n`);
    const id=randomUUID(),now=new Date();expect((await store.addWork({id,kind:'process_probe',targetKind:'probe',targetId:'fixture',createdAt:now,nextAttemptAt:now})).ok).toBe(true);
    const env={...process.env,[HOME_ENV]:home,BRAIN_DATABASE_URL:db.appUrl},clock={now:()=>new Date('2026-01-01T00:00:00.000Z')},config=await readConfig(home);
    const assembly={home,env,config,store,clock,idGen:uuidV7IdGen(),workHandlers:{},schemaVersions:{core:CORE_SCHEMA_VERSION}};
    let service: ReturnType<typeof createProtectedService<typeof store>>;
    let hostStarts=0;const runner=createQueueHostRunner(async()=>{hostStarts++;return spawn(host,[],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe','pipe','pipe']});},{requestQueueFrame:frame=>service.requestQueueFrame(frame)});
    service=createProtectedService({store} as never,{garmin:{},mutations:{},status:async()=>({available:true,requiresAction:false}),makeBrain:(commandStore:typeof store)=>createBrain(brainDependencies({...assembly,store:commandStore})),queueHost:{fence,runner}} as never,{revoker:{}} as never);
    const createStore=vi.fn(()=>{throw new Error('forbidden');});const transport={request:async(frame:string)=>{const value=await service.requestQueueViaHost(frame);if(value===undefined)throw new ProtectedQueueTransportError('denied');return value;}};
    const expected=await runQueueList({options:{all:true,kind:'process_probe',limit:'2'},queue:createBrain(brainDependencies(assembly)).queue});expect(expected.ok).toBe(true);
    let output='';const args=['queue','list','--all','--kind','process_probe','--limit','2'];
    expect(await dispatch(commands,[...args,'--json'],{env,clock,createStore,protectedQueueTransport:transport,stdout:s=>{output+=s;}})).toBe(0);
    if(expected.ok)expect(JSON.parse(output).data).toEqual(expected.data);
    output='';expect(await dispatch(commands,args,{env,clock,createStore,protectedQueueTransport:transport,stdout:s=>{output+=s;}})).toBe(0);
    if(expected.ok)expect(output).toBe(expected.text.join('\n')+'\n');
    expect(createStore).not.toHaveBeenCalled();expect((await admin.query('select count(*)::int as n from brain.protected_queue_host_fence')).rows[0].n).toBe(0);
    const endpointRoot=await mkdtemp('/tmp/bq-endpoint-');
    try {
      const socketDir=join(endpointRoot,'run'),policyDir=join(endpointRoot,'policy');await mkdir(socketDir);await mkdir(policyDir);
      const endpoint=join(endpointRoot,'endpoint'),client=join(endpointRoot,'client'),socketPath=join(socketDir,'queue.sock');
      const endpointSources=['sealed-files.c','sealed-bundle.c','sealed-signature.c','sealed-registry.c','peer.c','data-peer.c','queue-policy.c','queue-endpoint.c'].map(p=>base+p);
      execFileSync('xcrun',['clang','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-DBRAIN_REGISTRY_FIXTURE',`-DBRAIN_QUEUE_SUPERVISOR_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_SUPERVISOR_HASH="${supervisorHash}"`,`-DBRAIN_QUEUE_POLICY_DIR="${policyDir}"`,`-DBRAIN_QUEUE_SOCKET_DIR="${socketDir}"`,...endpointSources,'-lbsm','-framework','Security','-framework','CoreFoundation','-o',endpoint]);
      const endpointHash=cdhash(endpoint);if(!endpointHash)throw new Error('endpoint hash');
      execFileSync('xcrun',['clang','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations',`-DBRAIN_QUEUE_ENDPOINT_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_ENDPOINT_HASH="${endpointHash}"`,`-DBRAIN_QUEUE_ENDPOINT_PATH="${socketPath}"`,base+'peer.c',base+'data-peer.c',base+'queue-data-client.c','-lbsm','-framework','Security','-framework','CoreFoundation','-o',client]);
      const clientHash=cdhash(client);if(!clientHash)throw new Error('client hash');await writeFile(join(policyDir,'queue-client.pin'),`${process.getuid!()} ${clientHash}\n`);
      const endpointRunner=createQueueEndpointRunner(async()=>spawn(endpoint,[],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','pipe','pipe','pipe']}));
      const controller=new AbortController();let supervisorReady=false,held=false;let releaseReady!:()=>void;
      const readinessGate=new Promise<void>(resolve=>{releaseReady=resolve;});
      service=createProtectedService({store,clock,timer:systemTimer,idGen:uuidV7IdGen(),signal:controller.signal,schemaVersions:{core:CORE_SCHEMA_VERSION},pollMs:100,onReadiness:async(ready:boolean)=>{if(ready&&!held){held=true;await readinessGate;}supervisorReady=ready;}} as never,{garmin:{},mutations:{},status:async()=>({available:true,requiresAction:false}),makeBrain:(commandStore:typeof store)=>createBrain(brainDependencies({...assembly,store:commandStore})),queueHost:{fence,runner},queueEndpoint:endpointRunner} as never,{revoker:{},launcher:{},inspector:systemProcessInspector,bootstrap:{authorize:async()=>false}} as never);
      const running=service.run();
      try {
        let socketReady=false;for(let i=0;i<100;i++){try{await stat(socketPath);socketReady=true;break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}expect(socketReady).toBe(true);
        const actualTransport=createQueueTransport(async()=>spawn(client,[],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe']}));
        const beforeReady=hostStarts;output='';expect(await dispatch(commands,[...args,'--json'],{env,clock,createStore,protectedQueueTransport:actualTransport,stdout:s=>{output+=s;}})).not.toBe(0);
        expect(JSON.parse(output).error.code).toBe('SERVICE_UNAVAILABLE');expect(hostStarts).toBe(beforeReady);releaseReady();
        for(let i=0;i<100&&!supervisorReady;i++)await new Promise(resolve=>setTimeout(resolve,50));expect(supervisorReady).toBe(true);
        output='';expect(await dispatch(commands,[...args,'--json'],{env,clock,createStore,protectedQueueTransport:actualTransport,stdout:s=>{output+=s;}})).toBe(0);if(expected.ok)expect(JSON.parse(output).data).toEqual(expected.data);
        output='';expect(await dispatch(commands,args,{env,clock,createStore,protectedQueueTransport:actualTransport,stdout:s=>{output+=s;}})).toBe(0);if(expected.ok)expect(output).toBe(expected.text.join('\n')+'\n');
        const before=hostStarts;const unauthorized=await actualTransport.request(JSON.stringify({operation:'auth.approve',payload:'fixture'}));
        expect(JSON.parse(unauthorized)).toMatchObject({ok:false,code:'SERVICE_UNAVAILABLE'});expect(hostStarts).toBe(before);

        const fake=join(endpointRoot,'fake-client');execFileSync('cp',[client,fake]);execFileSync('codesign',['--force','--sign','-','--identifier','fixture.untrusted',fake],{stdio:'ignore'});
        const fakeTransport=createQueueTransport(async()=>spawn(fake,[],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe']}));
        output='';expect(await dispatch(commands,[...args,'--json'],{env,clock,createStore,protectedQueueTransport:fakeTransport,stdout:s=>{output+=s;}})).not.toBe(0);expect(JSON.parse(output).error.code).toBe('SERVICE_UNAVAILABLE');
        expect(createStore).not.toHaveBeenCalled();
      } finally {releaseReady();controller.abort();await running;}
      const forgedServer=createServer(socket=>{socket.once('data',()=>socket.write(Buffer.from([1])));});
      forgedServer.listen(socketPath);await once(forgedServer,'listening');
      try {
        const actualTransport=createQueueTransport(async()=>spawn(client,[],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe']}));
        await expect(actualTransport.request(JSON.stringify({operation:'queue.list.v1',all:true,limit:2}))).rejects.toThrow();
      } finally {await new Promise<void>(resolve=>forgedServer.close(()=>resolve()));}
    } finally {await rm(endpointRoot,{recursive:true,force:true});}

    const originalAddon=await readFile(addon);await writeFile(addon,'tampered');
    output='';expect(await dispatch(commands,[...args,'--json'],{env,clock,createStore,protectedQueueTransport:transport,stdout:s=>{output+=s;}})).not.toBe(0);
    expect(JSON.parse(output).error.code).toBe('SERVICE_DENIED');expect(createStore).not.toHaveBeenCalled();
    expect((await admin.query('select count(*)::int as n from brain.protected_queue_host_fence')).rows[0].n).toBe(0);await writeFile(addon,originalAddon);
    let launches=0;
    const lostRunner=createQueueHostRunner(async()=>{launches++;const child=spawn(host,[],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe','pipe','pipe']});child.kill('SIGKILL');return child;},{requestQueueFrame:frame=>service.requestQueueFrame(frame)});
    service=createProtectedService({store} as never,{garmin:{},mutations:{},status:async()=>({available:true,requiresAction:false}),makeBrain:(commandStore:typeof store)=>createBrain(brainDependencies({...assembly,store:commandStore})),queueHost:{fence,runner:lostRunner}} as never,{revoker:{}} as never);
    output='';expect(await dispatch(commands,[...args,'--json'],{env,clock,createStore,protectedQueueTransport:transport,stdout:s=>{output+=s;}})).not.toBe(0);
    expect(launches).toBe(1);expect((await admin.query('select state from brain.protected_queue_host_fence')).rows).toEqual([{state:'unknown'}]);
    await fence.close();fence=postgresQueueHostFence({databaseUrl:roleUrl.toString()});
    service=createProtectedService({store} as never,{garmin:{},mutations:{},status:async()=>({available:true,requiresAction:false}),makeBrain:(commandStore:typeof store)=>createBrain(brainDependencies({...assembly,store:commandStore})),queueHost:{fence,runner:lostRunner}} as never,{revoker:{}} as never);
    output='';expect(await dispatch(commands,[...args,'--json'],{env,clock,createStore,protectedQueueTransport:transport,stdout:s=>{output+=s;}})).not.toBe(0);
    expect(launches).toBe(1);expect(createStore).not.toHaveBeenCalled();

  } finally {await fence?.close();await store.close();await admin.end();await db.drop();await rm(root,{recursive:true,force:true});}
},60000);
