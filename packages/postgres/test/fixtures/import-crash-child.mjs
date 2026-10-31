import { pathToFileURL } from 'node:url';
import pg from 'pg';
const config = JSON.parse(process.env.BRAIN_TEST_CRASH_CONFIG);
const core = await import('@second-brain/core');
const postgres = await import('../../dist/index.js');
const staging = await import(pathToFileURL(config.stagingModule).href);
const fileStore = await import(pathToFileURL(config.fileModule).href);
const wait = () => new Promise(() => {});
if (config.phase === 'request') {
  const ext = new pg.Client({connectionString:config.url}); await ext.connect();
  await ext.query(`insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) values ($1,$2,'crash','d','b','document.md',$3,$4,'text/markdown',$5,$6,$7)`,config.values);
  process.send('request-committed'); await wait();
} else {
  const store=postgres.postgresStore({databaseUrl:config.url});
  if (config.phase === 'handoff') {
    process.send('handoff-started');
    await store.imports.handoffImport({requestId:config.requestId,workId:config.workId,now:new Date(config.now)});
  } else if (config.phase === 'cleanup') {
    await store.imports.cleanupImport({requestId:config.requestId,now:new Date(config.now),remove:async(source,locator)=>{await staging.importStaging(config.home).remove(source,locator); process.send('unlinked'); await wait();}});
  } else if (config.phase === 'cleanup-recover') {
    const clock={now:()=>new Date(config.now)};
    const result=await core.cleanupImportRequests(store.imports,staging.importStaging(config.home),clock);
    if (!result.ok) throw Error('cleanup failed');
    await store.close(); process.send('cleanup-recovered'); process.disconnect(); process.exit(0);
  } else if (config.phase === 'recover') {
    const {memorySpool}=await import('@second-brain/core/testing');
    const files=fileStore.localFileStore({root:config.root}), clock={now:()=>new Date(config.now)}, ids={next:()=>crypto.randomUUID()};
    const handed=await core.handoffImportRequests(store.imports,clock,ids);
    if (!handed.ok) throw Error('handoff failed');
    const handler=core.importFileHandler(store.imports,staging.importStaging(config.home),files,clock,ids,store,store);
    const result=await core.drainQueue({store,clock,idGen:ids,spool:memorySpool()},{budgetMs:5000,handlers:{[core.FILE_IMPORT_KIND]:handler}});
    if (result.completed!==1) throw Error('recovery failed');
    await store.close(); process.send('recovered');
    process.disconnect();
    process.exit(0);
  } else {
    const files=fileStore.localFileStore({root:config.root});
    const wrapped=config.phase==='put' ? {...files,put:async bytes=>{const result=await files.put(bytes); process.send('put-completed'); await wait(); return result;}} : files;
    const imports=config.phase==='result' ? {...store.imports,cleanupImport:async()=>{process.send('result-committed'); await wait();}} : store.imports;
    const item={...config.item,claimedAt:new Date(config.item.claimedAt),claimExpiresAt:new Date(config.item.claimExpiresAt)};
    const clock={now:()=>new Date(config.now)}, ids={next:()=>crypto.randomUUID()};
    await core.importFileHandler(imports,staging.importStaging(config.home),wrapped,clock,ids,store,store)(item);
  }
  await store.close();
}
