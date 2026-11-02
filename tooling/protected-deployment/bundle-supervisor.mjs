import { readFile, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';

/** 후보 closure의 외부 로더를 제한한다. 운영 설치 검증을 대신하지 않는다. */
export async function bundleSupervisor(repo, target) {
  const result=spawnSync(process.execPath,[`${repo}/node_modules/.pnpm/rolldown@1.2.12/node_modules/rolldown/bin/cli.mjs`,`${repo}/apps/cli/dist/daemon/sealed-supervisor-entry.js`,'--platform','node','--format','esm','--no-codeSplitting','--file',target],{cwd:repo,env:{PATH:'/usr/bin:/bin',LANG:'C'},encoding:'utf8'});
  if(result.error||result.status!==0)throw new Error('BUILD_FAILED');
  let bundle=await readFile(target,'utf8');
  const optional='Native = __require("pg-native");';
  if(bundle.split(optional).length!==2)throw new Error('UNSEALED_LOADER');
  bundle=bundle.replace(optional,'throw new Error("native PostgreSQL disabled");');
  const builtins=new Set(builtinModules.flatMap(name=>[name,`node:${name}`]));
  const loader=/__require\(([^)]*)\)|\bimport\(([^)]*)\)/gu;
  for(const match of bundle.matchAll(loader)) {
    const arg=(match[1]??match[2]).trim(), literal=/^"([^"\\]+)"$/u.exec(arg);
    if(!literal||!builtins.has(literal[1]))throw new Error('UNSEALED_LOADER');
  }
  if([...bundle.matchAll(/^import .*? from "([^"]+)";/gmu)].some(match=>!builtins.has(match[1]))||/\b(?:eval|process\.dlopen)\s*\(/u.test(bundle))throw new Error('UNSEALED_LOADER');
  const requires=[...bundle.matchAll(/createRequire\(import\.meta\.url\)\(([^)]*)\)/gu)];
  if(requires.length!==2||requires.some(match=>match[1]!=='"./peer.node"'))throw new Error('UNSEALED_LOADER');
  await writeFile(target,bundle);
}
