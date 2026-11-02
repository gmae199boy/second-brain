#!/usr/bin/env node
// 비권위 staging만 생성한다. root 설치·운영 서명·신원 승인이 아니다.
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleSupervisor } from './bundle-supervisor.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const native=join(repo,'extensions/garmin/native');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function command(file,args) {
  const result=spawnSync(file,args,{cwd:repo,env:{PATH:'/usr/bin:/bin',LANG:'C',TMPDIR:process.env.TMPDIR ?? '/tmp'},encoding:'utf8'});
  if(result.error || result.status!==0)throw new Error('BUILD_FAILED');return result;
}
function cdhash(path) {
  const result=command('/usr/bin/codesign',['-d','--verbose=4',path]);
  const value=/^CDHash=([0-9a-f]{40})$/mu.exec(result.stderr)?.[1];if(!value)throw new Error('SIGNATURE_MISSING');return value;
}
/** 생성 대상은 존재하지 않아야 한다. caller 입력은 staging 제안일 뿐 신뢰 근거가 아니다. */
export async function createSupervisorCandidate(target,{launcherUid,launcherHash}) {
  if(!Number.isSafeInteger(launcherUid)||launcherUid<=0||!/^[0-9a-f]{40}$/u.test(launcherHash)||/^0+$/u.test(launcherHash))throw new Error('INVALID_PIN');
  const root=resolve(target);await mkdir(root,{mode:0o700});
  try {
    const payload=join(root,'payload'),registry=join(root,'registry');await mkdir(payload,{mode:0o700});await mkdir(registry,{mode:0o700});
    for(const part of ['bin','supervisor','licenses'])await mkdir(join(payload,part),{mode:0o700});
    const node=join(payload,'bin/node'),entry=join(payload,'supervisor/main.js'),addon=join(payload,'supervisor/peer.node');
    await copyFile(process.execPath,node);command('/usr/bin/codesign',['--force','--sign','-',node]);
    await bundleSupervisor(repo,entry);
    command('/usr/bin/xcrun',['clang','-bundle','-undefined','dynamic_lookup','-Wno-deprecated-declarations','-DBRAIN_SUPERVISOR_AUTHORITY',`-I${join(dirname(dirname(process.execPath)),'include/node')}`,`-DBRAIN_QUEUE_GATEWAY_UID=${launcherUid}`,`-DBRAIN_QUEUE_GATEWAY_HASH="${launcherHash}"`,join(native,'queue-peer-addon.c'),join(native,'peer.c'),'-lbsm','-framework','Security','-framework','CoreFoundation','-o',addon]);
    command('/usr/bin/codesign',['--force','--sign','-',addon]);
    await copyFile(join(dirname(dirname(process.execPath)),'LICENSE'),join(payload,'licenses/node-LICENSE'));
    const bundle=await readFile(entry,'utf8');
    const modules=[...new Set([...bundle.matchAll(/^\/\/#region (node_modules\/\.pnpm\/[^/]+\/node_modules\/[^/]+)\//gmu)].map(match=>match[1]))].sort();
    const missing=[];
    for(const module of modules) {
      const metadata=JSON.parse(await readFile(join(repo,module,'package.json'),'utf8'));
      if(typeof metadata.name!=='string'||!/^[a-z0-9_-]+$/u.test(metadata.name))throw new Error('LICENSE_METADATA');
      const names=(await readdir(join(repo,module))).filter(name=>/^licen[cs]e(?:\.md|\.txt)?$/iu.test(name)).sort();
      if(!names.length)missing.push(`${metadata.name}: ${String(metadata.license ?? 'unknown')}`);
      for(const name of names)await copyFile(join(repo,module,name),join(payload,'licenses',`${metadata.name}-${name}`));
    }
    await writeFile(join(payload,'licenses/NOTICE'),`검토용 staging이다. 재배포 라이선스와 운영 서명은 아직 검증되지 않았다.\n별도 라이선스 파일이 없는 패키지: ${missing.join(', ')}\n`,{mode:0o600,flag:'wx'});
    const paths=[];
    async function walk(dir,prefix='') {for(const item of await readdir(dir,{withFileTypes:true})){const rel=prefix?`${prefix}/${item.name}`:item.name;if(item.isDirectory())await walk(join(dir,item.name),rel);else if(item.isFile())paths.push(rel);else throw new Error('UNSAFE_PAYLOAD');}}
    await walk(payload);paths.sort();if(paths.length>4096)throw new Error('BUNDLE_LIMIT');
    const lines=[];for(const path of paths)lines.push(`${hash(await readFile(join(payload,path)))} ${path}`);
    const content=`brain-supervisor-registry-v1\n${cdhash(node)}\n${cdhash(addon)}\n${lines.join('\n')}\n`;
    await writeFile(join(registry,'supervisor.registry'),content,{mode:0o600,flag:'wx'});
    return {root,packageHash:hash(content),files:paths.length,licenseStatus:'unverified',productionReady:false};
  } catch(error) {throw error;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [target,uid,launcherHash,...extra]=process.argv.slice(2);
  if(!target||!uid||!launcherHash||extra.length) {console.error('staging 경로·launcher UID·해시가 필요합니다');process.exitCode=2;}
  else createSupervisorCandidate(target,{launcherUid:Number(uid),launcherHash}).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('후보 생성 실패');process.exitCode=1;});
}
