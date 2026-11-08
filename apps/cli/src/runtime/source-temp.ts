import { mkdir, open, readdir, rm, lstat, chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceTemp } from 'second_brain';
const valid=(key:string)=>/^[0-9a-f-]{36}$/.test(key);
/** Dedicated caller-owned root, never the FileStore root. */
export function sourceTemp(root:string):SourceTemp {
  const path=(key:string)=>{if(!valid(key))throw new Error('잘못된 임시 키');return join(root,`source-${key}`);};
  return {
    async write(key,bytes){let marker=false;try{await mkdir(root,{recursive:true,mode:0o700});const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())return {ok:false,message:'임시 디렉터리가 올바르지 않습니다'};await chmod(root,0o700);const owner=await open(`${path(key)}.owner`,'wx',0o600);try{await owner.writeFile(JSON.stringify({pid:process.pid}));marker=true;}finally{await owner.close();}const h=await open(path(key),'wx',0o600);try{await h.writeFile(bytes);}finally{await h.close();}return {ok:true};}catch{return {ok:false,message:'임시 파일을 쓸 수 없습니다'};}finally{if(marker)await writeFile(`${path(key)}.done`,'',{mode:0o600,flag:'wx'}).catch(()=>{});}},
    async read(key,maxBytes){try{const h=await open(path(key),'r');try{const stat=await h.stat();if(!stat.isFile())return {ok:false,message:'임시 파일이 아닙니다'};if(stat.size>maxBytes)return {ok:false,code:'TOO_LARGE',message:'임시 파일이 너무 큽니다'};const chunks:Buffer[]=[];let n=0;for(;;){const b=Buffer.allocUnsafe(Math.min(65536,maxBytes+1-n));const r=await h.read(b,0,b.length,null);if(!r.bytesRead)break;if(r.bytesRead>maxBytes-n)return {ok:false,code:'TOO_LARGE',message:'임시 파일이 너무 큽니다'};chunks.push(b.subarray(0,r.bytesRead));n+=r.bytesRead;}return {ok:true,bytes:Buffer.concat(chunks,n)};}finally{await h.close();}}catch{return {ok:false,message:'임시 파일을 읽을 수 없습니다'};}},
    async remove(key){await rm(path(key),{force:true});await rm(`${path(key)}.owner`,{force:true});await rm(`${path(key)}.done`,{force:true});},
    async cleanup(inspect){let names:string[];try{names=await readdir(root);}catch{return;}for(const name of names){if(!name.startsWith('source-'))continue;const key=name.slice(7);if(!valid(key))continue;const p=path(key);try{if(!(await lstat(p)).isFile())continue;const state=await inspect(key);let safe=state==='closed';if(state==='preparing'){const owner=JSON.parse(await readFile(`${p}.owner`,'utf8')) as {pid?:unknown};if(typeof owner.pid==='number'&&Number.isSafeInteger(owner.pid)&&owner.pid>0){try{safe=(await lstat(`${p}.done`)).isFile();}catch{try{process.kill(owner.pid,0);}catch(e){safe=(e as NodeJS.ErrnoException).code==='ESRCH';}}}}if(safe){await rm(p,{force:true});await rm(`${p}.owner`,{force:true});await rm(`${p}.done`,{force:true});}}catch{/* Unknown ownership and observation failures stay in place. */}}},
  };
}
