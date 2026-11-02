import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { Writable } from 'node:stream';
import pg from 'pg';
import { expect, it } from 'vitest';
import { isolatedClusterDatabase } from '../../../packages/postgres/test/isolated-cluster.js';
import { prepareProtectedRoles } from '../../../packages/postgres/src/protected-roles.js';
import { CORE_SCHEMA_VERSION, postgresStore } from 'second_brain/postgres';
import { writeConfig } from '../src/config/codec.js';
import { createQueueTransport } from '../src/daemon/installed-queue-transport.js';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';

it('봉인 supervisor의 실제 OS 인스턴스는 durable record와 ACK에 결합된다',async()=>{
  const root=await mkdtemp(join(tmpdir(),'brain-sealed-supervisor-')),db=await isolatedClusterDatabase();const admin=new pg.Client({connectionString:db.url});
  try {
    await admin.connect();await prepareProtectedRoles(db.url);
    await admin.query('set role brain_owner');
    for(const name of ['0028_protected_work.sql','0029_protected_auth_revoke.sql','0030_protected_mutation_read.sql','0031_protected_mutation_receipts.sql','0032_protected_queue_host_fence.sql','0033_sealed_supervisor_instance.sql'])await admin.query(await readFile(new URL(`../../../packages/postgres/protected-migrations/${name}`,import.meta.url),'utf8'));
    await admin.query('reset role');
    const payload=join(root,'payload'),reg=join(root,'registry'),lib=join(root,'lib');await mkdir(payload);await mkdir(reg);await mkdir(lib);await mkdir(join(payload,'bin'));await mkdir(join(payload,'supervisor'));
    const node=join(payload,'bin/node'),entry=join(payload,'supervisor/main.js'),addon=join(payload,'supervisor/peer.node'),launcher=join(root,'launcher');
    execFileSync('cp',[process.execPath,node]);execFileSync('codesign',['--force','--sign','-',node],{stdio:'ignore'});
    execFileSync(process.execPath,['--input-type=module','-e','import {bundleSupervisor} from "./tooling/protected-deployment/bundle-supervisor.mjs"; await bundleSupervisor(process.cwd(),process.argv[1]);',entry],{stdio:'ignore'});
    const bundle=await readFile(entry,'utf8');expect(bundle).not.toContain('__require("pg-native")');expect(bundle).toContain('createInstalledProtectedService');
    const marker=join(root,'product-imported');const hook='var init_protected_supervisor = __esmMin((() => {';
    const claim='if (!configuration || peer.readSupervisorConfig() !== void 0) throw new Error("configuration");';
    expect(bundle).toContain(hook);expect(bundle).toContain(claim);
    const instrumented=bundle.replace(hook,`${hook} fixtureMark(${JSON.stringify(marker)},"loaded");`).replace(claim,`${claim} if (configuration === '{"mode":"probe"}' && (!peer.consumeSupervisor(authority) || peer.consumeSupervisor(authority))) throw new Error("capability replay");`);
    await writeFile(entry,`import { writeFileSync as fixtureMark } from "node:fs";\n`+instrumented);

    const libSource='extensions/garmin/.venv/lib/python3.14/site-packages/psycopg_binary/.dylibs';
    for(const file of await readdir(libSource))if(file.endsWith('.dylib'))await copyFile(join(libSource,file),join(lib,file));
    execFileSync('install_name_tool',['-id','@rpath/libpq.5.dylib',join(lib,'libpq.5.dylib')]);execFileSync('codesign',['--force','--sign','-',join(lib,'libpq.5.dylib')],{stdio:'ignore'});await symlink('libpq.5.dylib',join(lib,'libpq.dylib'));
    const base='extensions/garmin/native/',sources=['sealed-files.c','sealed-bundle.c','sealed-signature.c','sealed-registry.c','peer.c','data-peer.c','queue-launcher.c','sealed-supervisor-launch.c','sealed-supervisor-store.c','supervisor-authority.c','broker-credential.c','tests/sealed-supervisor-fixture.c'].map(p=>base+p);
    execFileSync('xcrun',['clang','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-DBRAIN_REGISTRY_FIXTURE',...sources,'-lbsm','-framework','Security','-framework','CoreFoundation',`-L${lib}`,'-lpq',`-Wl,-rpath,${lib}`,'-o',launcher]);
    const cdhash=(p:string)=>/^CDHash=([0-9a-f]{40})$/mu.exec(spawnSync('codesign',['-d','--verbose=4',p],{encoding:'utf8'}).stderr)?.[1];
    const launcherHash=cdhash(launcher),nodeHash=cdhash(node);if(!launcherHash||!nodeHash)throw new Error('hash');
    execFileSync('xcrun',['clang','-bundle','-undefined','dynamic_lookup','-Wno-deprecated-declarations','-DBRAIN_SUPERVISOR_AUTHORITY','-DBRAIN_SUPERVISOR_FIXTURE','-DBRAIN_REGISTRY_FIXTURE',`-I${join(dirname(dirname(process.execPath)),'include/node')}`,`-DBRAIN_QUEUE_GATEWAY_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_GATEWAY_HASH="${launcherHash}"`,base+'queue-peer-addon.c',base+'peer.c','-lbsm','-framework','Security','-framework','CoreFoundation','-o',addon]);
    execFileSync('codesign',['--force','--sign','-',addon],{stdio:'ignore'});const addonHash=cdhash(addon);if(!addonHash)throw new Error('addon hash');
    const hash=async(p:string)=>createHash('sha256').update(await readFile(p)).digest('hex');
    const registry=`brain-supervisor-registry-v1\n${nodeHash}\n${addonHash}\n${await hash(node)} bin/node\n${await hash(entry)} supervisor/main.js\n${await hash(addon)} supervisor/peer.node\n`;
    await writeFile(join(reg,'supervisor.registry'),registry);const packageHash=createHash('sha256').update(registry).digest('hex');
    function launch(mode:string,configuration?:string) {
      const child=spawn(launcher,[reg,payload,mode],{stdio:['ignore','pipe','pipe','ignore','ignore','ignore','ignore','ignore','pipe','pipe']});
      const descriptors=child.stdio as unknown as (Writable|null)[];descriptors[8]!.end(db.url+(configuration?'\n'+configuration:''));let diagnostic='';child.stderr!.on('data',b=>diagnostic+=String(b));
      const lines=createInterface({input:child.stdout!});const iterator=lines[Symbol.asyncIterator]();
      const done=once(child,'close');return {child,descriptors,iterator,done,diagnostic:()=>diagnostic};
    }
    const forged=spawn(node,[entry,'--sealed-supervisor'],{stdio:['pipe','pipe','pipe','pipe','pipe','pipe','pipe']});
    const forgedFds=forged.stdio as unknown as Writable[];forgedFds[6]!.on('error',()=>{});forgedFds[6]!.end(Buffer.from([1]));
    let forgedOut='';forged.stdout!.on('data',b=>forgedOut+=String(b));expect((await once(forged,'close'))[0]).toBe(2);expect(forgedOut).toBe('');
    let swapped=launch('swap');expect((await swapped.done)[0]).toBe(8);expect((await admin.query('select count(*)::int as n from brain.sealed_supervisor_instance')).rows[0].n).toBe(0);
    const injected=join(payload,'supervisor/injected.js');await writeFile(injected,'process.exit(0)');
    let attempt=launch('normal');expect((await attempt.done)[0]).toBe(8);expect((await admin.query('select count(*)::int as n from brain.sealed_supervisor_instance')).rows[0].n).toBe(0);await rm(injected);
    const original=await readFile(entry);await writeFile(entry,'process.exit(0)');attempt=launch('normal');expect((await attempt.done)[0]).toBe(8);await writeFile(entry,original);
    expect((await admin.query('select count(*)::int as n from brain.sealed_supervisor_instance')).rows[0].n).toBe(0);
    await admin.query('begin');
    await admin.query("insert into brain.sealed_supervisor_instance(singleton,token,pid,uid,boot_seconds,start_microseconds,package_hash,node_hash,state) values(true,gen_random_uuid(),10,501,1,1,$1,$2,'starting')",['a'.repeat(64),'b'.repeat(40)]);
    const startedAt=Date.now();attempt=launch('normal');expect((await attempt.done)[0]).toBe(8);expect(Date.now()-startedAt).toBeLessThan(4500);await admin.query('rollback');
    expect((await admin.query('select count(*)::int as n from brain.sealed_supervisor_instance')).rows[0].n).toBe(0);
    attempt=launch('lost');expect((await attempt.done)[0]).toBe(8);
    expect((await admin.query('select state,package_hash from brain.sealed_supervisor_instance')).rows).toEqual([{state:'starting',package_hash:packageHash}]);
    attempt=launch('normal');expect((await attempt.done)[0]).toBe(8);
    await admin.query('delete from brain.sealed_supervisor_instance');
    attempt=launch('lost-confirm');expect((await attempt.done)[0]).toBe(8);
    expect((await admin.query('select state from brain.sealed_supervisor_instance')).rows).toEqual([{state:'verified'}]);
    await expect(stat(marker)).rejects.toMatchObject({code:'ENOENT'});await admin.query('delete from brain.sealed_supervisor_instance');

    attempt=launch('normal');let line=await attempt.iterator.next();expect(line.value,attempt.diagnostic()).toMatch(/^ACTIVE [1-9][0-9]*$/u);
    expect((await stat(marker)).isFile()).toBe(true);
    const pid=Number(String(line.value).split(' ')[1]);const row=(await admin.query('select pid,uid,boot_seconds,start_microseconds,package_hash,node_hash,state from brain.sealed_supervisor_instance')).rows[0];
    expect(row).toMatchObject({pid,uid:String(process.getuid!()),package_hash:packageHash,node_hash:nodeHash,state:'verified'});expect(Number(row.boot_seconds)).toBeGreaterThan(0);expect(Number(row.start_microseconds)).toBeGreaterThan(0);
    attempt.descriptors[9]!.write('V');line=await attempt.iterator.next();expect(line.value,attempt.diagnostic()).toBe('VALID');
    await admin.query("update brain.sealed_supervisor_instance set state='starting'");attempt.descriptors[9]!.write('V');line=await attempt.iterator.next();expect(line.value,attempt.diagnostic()).toBe('REJECT');await admin.query("update brain.sealed_supervisor_instance set state='verified'");
    const newFile=join(payload,'supervisor/late.js');await writeFile(newFile,'fixture');attempt.descriptors[9]!.write('V');line=await attempt.iterator.next();expect(line.value,attempt.diagnostic()).toBe('REJECT');await rm(newFile);
    attempt.descriptors[9]!.write('V');line=await attempt.iterator.next();expect(line.value,attempt.diagnostic()).toBe('VALID');

    attempt.descriptors[9]!.end(Buffer.from([1]));line=await attempt.iterator.next();expect(line.value,attempt.diagnostic()).toBe('CLOSED');expect((await attempt.done)[0],attempt.diagnostic()).toBe(0);
    expect((await admin.query('select count(*)::int as n from brain.sealed_supervisor_instance')).rows[0].n).toBe(0);
    attempt=launch('reaped');line=await attempt.iterator.next();expect(line.value,attempt.diagnostic()).toMatch(/^ACTIVE /u);
    attempt.descriptors[9]!.end(Buffer.from([1]));line=await attempt.iterator.next();expect(line.value,attempt.diagnostic()).toBe('UNKNOWN');expect((await attempt.done)[0]).toBe(10);
    expect((await admin.query('select state from brain.sealed_supervisor_instance')).rows).toEqual([{state:'verified'}]);await admin.query('delete from brain.sealed_supervisor_instance');
    attempt=launch('normal');line=await attempt.iterator.next();expect(line.value,attempt.diagnostic()).toMatch(/^ACTIVE /u);
    attempt.child.kill('SIGKILL');expect((await attempt.done)[1]).toBe('SIGKILL');
    expect((await admin.query('select state,package_hash from brain.sealed_supervisor_instance')).rows).toEqual([{state:'verified',package_hash:packageHash}]);
    attempt=launch('normal');expect((await attempt.done)[0]).toBe(8);
    await admin.query('delete from brain.sealed_supervisor_instance');

    // 같은 native launcher의 확인된 실제 child가 서비스·endpoint·host를 소유한다.
    const socketRoot=await mkdtemp('/tmp/bq-sealed-');
    try {
      const home=join(root,'home'),queuePayload=join(root,'queue-payload'),queueRegistry=join(root,'queue-registry'),socketDir=join(socketRoot,'run'),policyDir=join(socketRoot,'policy');
      for(const dir of [home,queuePayload,queueRegistry,socketDir,policyDir])await mkdir(dir);
      await mkdir(join(queuePayload,'bin'));await mkdir(join(queuePayload,'cli'));expect((await writeConfig(home,{})).ok).toBe(true);
      const queueNode=join(queuePayload,'bin/node'),queueEntry=join(queuePayload,'cli/bin.js'),queueAddon=join(queuePayload,'cli/peer.node'),host=join(root,'host'),endpoint=join(socketRoot,'endpoint'),client=join(socketRoot,'client'),socketPath=join(socketDir,'queue.sock');
      await copyFile(process.execPath,queueNode);execFileSync('codesign',['--force','--sign','-',queueNode],{stdio:'ignore'});
      execFileSync(process.execPath,['node_modules/.pnpm/rolldown@1.2.12/node_modules/rolldown/bin/cli.mjs','apps/cli/dist/daemon/sealed-queue-entry.js','--platform','node','--format','esm','--no-codeSplitting','--file',queueEntry],{stdio:'ignore'});
      const queueNodeHash=cdhash(queueNode)!;
      const authorityFlags=['-DBRAIN_FIXTURE_SUPERVISOR_AUTHORITY',`-DBRAIN_SUPERVISOR_REGISTRY_DIR="${reg}"`,`-DBRAIN_SUPERVISOR_PAYLOAD_DIR="${payload}"`];
      const authoritySources=['sealed-supervisor-store.c','supervisor-authority.c','broker-credential.c'].map(p=>base+p),pqFlags=[`-L${lib}`,'-lpq',`-Wl,-rpath,${lib}`];
      const queueSources=['sealed-files.c','sealed-bundle.c','sealed-signature.c','sealed-registry.c','peer.c','data-peer.c','queue-launcher.c','queue-supervisor-host.c'].map(p=>base+p);
      execFileSync('xcrun',['clang','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-DBRAIN_REGISTRY_FIXTURE',...authorityFlags,`-DBRAIN_QUEUE_SUPERVISOR_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_SUPERVISOR_HASH="${nodeHash}"`,`-DBRAIN_QUEUE_REGISTRY_DIR="${queueRegistry}"`,`-DBRAIN_QUEUE_PAYLOAD_DIR="${queuePayload}"`,...queueSources,...authoritySources,...pqFlags,'-lbsm','-framework','Security','-framework','CoreFoundation','-o',host]);
      const hostHash=cdhash(host)!;
      execFileSync('xcrun',['clang','-bundle','-undefined','dynamic_lookup','-Wno-deprecated-declarations',`-I${join(dirname(dirname(process.execPath)),'include/node')}`,`-DBRAIN_QUEUE_GATEWAY_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_GATEWAY_HASH="${hostHash}"`,base+'queue-peer-addon.c',base+'peer.c','-lbsm','-framework','Security','-framework','CoreFoundation','-o',queueAddon]);
      execFileSync('codesign',['--force','--sign','-',queueAddon],{stdio:'ignore'});
      await writeFile(join(queueRegistry,'queue.registry'),`brain-queue-registry-v2\n${queueNodeHash}\n${cdhash(queueAddon)}\n${await hash(queueNode)} bin/node\n${await hash(queueEntry)} cli/bin.js\n${await hash(queueAddon)} cli/peer.node\n`);
      const endpointSources=['sealed-files.c','sealed-bundle.c','sealed-signature.c','sealed-registry.c','peer.c','data-peer.c','queue-policy.c','queue-endpoint.c'].map(p=>base+p);
      execFileSync('xcrun',['clang','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-DBRAIN_REGISTRY_FIXTURE',...authorityFlags,`-DBRAIN_QUEUE_SUPERVISOR_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_SUPERVISOR_HASH="${nodeHash}"`,`-DBRAIN_QUEUE_POLICY_DIR="${policyDir}"`,`-DBRAIN_QUEUE_SOCKET_DIR="${socketDir}"`,...endpointSources,...authoritySources,...pqFlags,'-lbsm','-framework','Security','-framework','CoreFoundation','-o',endpoint]);
      const endpointHash=cdhash(endpoint)!;
      execFileSync('xcrun',['clang','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations',`-DBRAIN_QUEUE_ENDPOINT_UID=${process.getuid!()}`,`-DBRAIN_QUEUE_ENDPOINT_HASH="${endpointHash}"`,`-DBRAIN_QUEUE_ENDPOINT_PATH="${socketPath}"`,base+'peer.c',base+'data-peer.c',base+'queue-data-client.c','-lbsm','-framework','Security','-framework','CoreFoundation','-o',client]);
      await writeFile(join(policyDir,'queue-client.pin'),`${process.getuid!()} ${cdhash(client)}\n`);
      await admin.query("alter role brain_protected_supervisor login password 'fixture-supervisor'");
      const url=new URL(db.url);url.username='brain_protected_supervisor';url.password='fixture-supervisor';
      const store=postgresStore({databaseUrl:db.appUrl});
      try {
        const id='065a3af7-3a06-4e25-a093-82fa3641f7c7',now=new Date();expect((await store.addWork({id,kind:'process_probe',targetKind:'probe',targetId:'fixture',createdAt:now,nextAttemptAt:now})).ok).toBe(true);
        const config=JSON.stringify({mode:'service',databaseUrl:url.toString(),home,bridgeHash:hostHash,hostHash,endpointHash,fixtureHost:host,fixtureEndpoint:endpoint,schemaVersion:CORE_SCHEMA_VERSION});
        attempt=launch('service',config);line=await attempt.iterator.next();expect(line.value,attempt.diagnostic()).toMatch(/^ACTIVE /u);
        const transport=createQueueTransport(async()=>spawn(client,[],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe']}));
        let reply='';for(let i=0;i<50;i++){try{reply=await transport.request(JSON.stringify({operation:'queue.list.v1',all:true,limit:20}));if(JSON.parse(reply).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
        expect(JSON.parse(reply)).toMatchObject({ok:true});expect(reply).toContain(id);
        const outputs:string[]=[];
        for(const format of [[],['--json']]) {
          let output='';expect(await dispatch(commands,['queue','list','--all',...format],{env:{},clock:{now:()=>new Date()},protectedQueueTransport:transport,stdout:s=>{output+=s;}})).toBe(0);outputs.push(output);
        }
        expect(outputs[0]).toContain(id);expect(JSON.parse(outputs[1]!).data).toBeDefined();
        expect(JSON.parse(await transport.request(JSON.stringify({operation:'auth.approve',payload:'fixture'}))).ok).toBe(false);
        await admin.query("update brain.sealed_supervisor_instance set state='starting'");
        await expect(transport.request(JSON.stringify({operation:'queue.list.v1',all:true,limit:20}))).rejects.toThrow();
        await admin.query("update brain.sealed_supervisor_instance set state='verified'");
        expect(JSON.parse(await transport.request(JSON.stringify({operation:'queue.list.v1',all:true,limit:20}))).ok).toBe(true);
        attempt.descriptors[9]!.end(Buffer.from([1]));line=await attempt.iterator.next();expect(line.value).toBe('CLOSED');expect((await attempt.done)[0]).toBe(0);
      } finally {await store.close();}
    } finally {await rm(socketRoot,{recursive:true,force:true});}
  } finally {await admin.end();await db.drop();await rm(root,{recursive:true,force:true});}
},60000);
