import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const config=JSON.parse(process.env.BRAIN_TEST_HANDLER_RESUME);
const core=await import('@second-brain/core');
const {memorySpool}=await import('@second-brain/core/testing');
const pg=await import('../../dist/index.js');
const runtime=await import(pathToFileURL(config.driveModule).href);
const store=pg.postgresStore({databaseUrl:config.url});
const clock={now:()=>new Date(config.now)},idGen={next:()=>randomUUID()},bytes=new Uint8Array(20*1024*1024);bytes.fill(37);
let activeItem;
const transport=async(input,init)=>{
  const response=await fetch(input,init);
  if(config.mode==='first'&&new Headers(init?.headers).get('content-range')==='bytes 5242880-10485759/20971520'){
    process.send({event:'half-accepted',item:activeItem});await new Promise(()=>{});
  }
  return response;
};
const drive=runtime.driveFileStore({rootFolderId:'root',baseUrl:config.baseUrl,uploads:store.driveUploads,clock,fetch:transport});
const handler=core.driveMigrationHandler({store,uploads:store.driveUploads,local:{get:async()=>({ok:true,bytes})},drive,settings:{store,schemaVersions:pg.EXPECTED_SCHEMA_VERSIONS,clock},rootFolderId:'root',sourceFence:{sourceId:config.sourceId,generation:config.generation},clock,idGen});
if(config.mode==='stale'){
  const item={...config.item,createdAt:new Date(config.item.createdAt),nextAttemptAt:new Date(config.item.nextAttemptAt),claimedAt:new Date(config.item.claimedAt),claimExpiresAt:new Date(config.item.claimExpiresAt)};
  const result=await handler(item);process.send({event:'stale-result',result});
}else {
  const queueStore=config.mode==='resume'?{...store,claimWork:async input=>{const result=await store.claimWork(input);if(result.ok&&result.item){process.send({event:'reclaimed',item:result.item});await new Promise(resolve=>process.once('message',resolve));}return result;}}:store;
  const report=await core.drainQueue({store:queueStore,spool:memorySpool(),clock,idGen},{budgetMs:60000,handlers:{drive_migrate:async item=>{activeItem=item;return handler(item);}}});
  process.send({event:'finished',report});
}
await store.close();process.disconnect();
