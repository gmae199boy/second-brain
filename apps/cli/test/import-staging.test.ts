import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { importStaging } from '../src/runtime/import-staging.js';
import { importFileHandler, type ImportStore } from 'second_brain';

it('staging 경계 밖의 경로와 심볼릭 링크는 바이트를 반환하지 않는다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'brain-staging-'));
  try {
    const root = join(home,'extensions','sample','staging'); await mkdir(root,{recursive:true});
    await writeFile(join(root,'ok'), 'safe'); await writeFile(join(home,'outside'), 'outside');
    await symlink(join(home,'outside'),join(root,'link'));
    const staging = importStaging(home);
    expect(await staging.read('sample','ok',10)).toMatchObject({ok:true});
    for (const path of ['/tmp/outside','../outside','link','nested/../../outside']) expect(await staging.read('sample',path,100)).toMatchObject({ok:false,code:'IMPORT_FILE_INVALID'});
    expect(await staging.read('sample','ok',2)).toMatchObject({ok:false});
  } finally { await rm(home,{recursive:true,force:true}); }
});

it.each([{name:'크기',size:4}, {name:'해시',size:3}])('$name 불일치면 FileStore에 쓰지 않는다', async ({size}) => {
  let writes = 0;
  const store = {
    readImport: async () => ({ ok:true as const, request:{id:'r',source:'sample',locator:'x',sha256:'0'.repeat(64),sizeBytes:size,mediaType:'text/plain'},completed:false }),
    failImport: async () => ({ok:true as const}),
  } as unknown as ImportStore;
  const handler = importFileHandler(store, { read: async () => ({ok:true,bytes:new TextEncoder().encode('bad')}), remove: async () => {} }, { put: async () => { writes++; return {ok:false,code:'FILES_UNAVAILABLE',message:''}; } } as never, {now:()=>new Date()}, {next:()=> 'id'}, {listRedactedContentHashes:async()=>({ok:true,hashes:[]})});
  const result = await handler({ id:'w',targetId:'r',claimedBy:'worker' } as never);
  expect(result).toMatchObject({ok:false,code:'IMPORT_FILE_INVALID'}); expect(writes).toBe(0);
});

it('가린 해시 조회가 실패하면 FileStore에 쓰지 않는다', async () => {
  const { contentHashOfBytes } = await import('second_brain');
  const bytes=new TextEncoder().encode('safe'); let puts=0;
  const store={readImport:async()=>({ok:true as const,request:{id:'r',source:'sample',locator:'x',sha256:contentHashOfBytes(bytes).slice(7),sizeBytes:bytes.length,mediaType:'text/plain'},completed:false})} as unknown as ImportStore;
  const handler=importFileHandler(store,{read:async()=>({ok:true,bytes}),remove:async()=>{}},{put:async()=>{puts++; return {ok:false,code:'FILES_UNAVAILABLE',message:''};}} as never,{now:()=>new Date()},{next:()=> 'id'},{listRedactedContentHashes:async()=>({ok:false,code:'DB_UNAVAILABLE',message:'조회 실패'})});
  expect(await handler({id:'w',targetId:'r',claimedBy:'worker'} as never)).toMatchObject({ok:false,code:'DB_UNAVAILABLE'});
  expect(puts).toBe(0);
});


it('작성자가 없는 FIFO를 기다리지 않고 거부한다', async () => {
  const home=await mkdtemp(join(tmpdir(),'brain-fifo-'));
  try {
    const root=join(home,'extensions','sample','staging'); await mkdir(root,{recursive:true});
    execFileSync('mkfifo',[join(root,'pipe')]);
    const result=await Promise.race([importStaging(home).read('sample','pipe',100),new Promise<'timeout'>(resolve=>setTimeout(()=>resolve('timeout'),1000))]);
    expect(result).toMatchObject({ok:false,code:'IMPORT_FILE_INVALID'});
  } finally {await rm(home,{recursive:true,force:true});}
});
