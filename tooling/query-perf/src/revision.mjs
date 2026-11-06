import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseRevisionFile(value) {
 if (!/^[0-9a-fA-F]{40}\n?$/.test(value)) throw Error('invalid .query-perf-revision');
 return value.trim().toLowerCase();
}
export function checkoutRevision(dir) {
 const checkout=realpathSync(dir);
 let root;
 try { root=realpathSync(execFileSync('git',['-C',checkout,'rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()); } catch { /* archive, not a repository */ }
 if(root===checkout) {
  const git=(args)=>execFileSync('git',['-C',checkout,...args]);
  const sha=parseRevisionFile(git(['rev-parse','HEAD']).toString());
  const dirty=git(['status','--porcelain']).length>0;
  const digest=createHash('sha256').update(git(['diff','HEAD']));
  const untracked=git(['ls-files','--others','--exclude-standard','-z','--','packages/postgres/src','packages/postgres/migrations']).toString().split('\0').filter(Boolean).sort();
  for(const file of untracked) { const content=readFileSync(resolve(checkout,file)); digest.update(`\0${file}\0${content.length}\0`).update(content); }
  const diffSha256=digest.digest('hex');
  return {sha,dirty,diffSha256};
 }
 return {sha:parseRevisionFile(readFileSync(resolve(checkout,'.query-perf-revision'),'utf8')),dirty:null,diffSha256:null};
}

// Hash framed relative names and bytes so paths and contents cannot collide.
export function artifactFingerprint(dir) {
 const root=realpathSync(dir), files=[];
 function walk(path, predicate) {
  for(const entry of readdirSync(resolve(root,path),{withFileTypes:true})) {
   const name=`${path}/${entry.name}`;
   if(entry.isDirectory()) walk(name,predicate);
   else if(entry.isFile() && predicate(name)) files.push(name);
  }
 }
 walk('packages/postgres/dist',p=>p.endsWith('.js'));
 walk('packages/core/dist',p=>p.endsWith('.js'));
 walk('packages/postgres/migrations',p=>/^packages\/postgres\/migrations\/[^/]+\.sql$/.test(p));
 files.sort(); const digest=createHash('sha256');
 for(const file of files) { const data=readFileSync(resolve(root,file)); digest.update(`${Buffer.byteLength(file)}:${file}:${data.length}:`).update(data); }
 const lockSha256=createHash('sha256').update(readFileSync(resolve(root,'pnpm-lock.yaml'))).digest('hex');
 return {sha256:digest.digest('hex'),lockSha256,files,migrations:files.filter(p=>p.startsWith('packages/postgres/migrations/'))};
}

export function runnerFingerprint() {
 const root=resolve(fileURLToPath(new URL('../..',import.meta.url))); const files=[];
 function walk(dir) { for(const entry of readdirSync(resolve(root,dir),{withFileTypes:true})) { const path=`${dir}/${entry.name}`; if(entry.isDirectory()) walk(path); else if(entry.isFile() && path.endsWith('.mjs')) files.push(path); } }
 walk('query-perf'); files.sort(); const digest=createHash('sha256');
 for(const file of files) { const data=readFileSync(resolve(root,file)); digest.update(`${Buffer.byteLength(file)}:${file}:${data.length}:`).update(data); }
 return {sha256:digest.digest('hex'),files};
}
