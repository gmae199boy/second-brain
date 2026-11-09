import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const config=JSON.parse(process.env.BRAIN_TEST_SOURCE_CHANGES);
const core=await import('@second-brain/core');const pg=await import('../../dist/index.js');const runtime=await import(pathToFileURL(config.sourceModule).href);
const store=pg.postgresStore({databaseUrl:config.url}),clock={now:()=>new Date(config.now)};
const wrapped={...store,async applySourceChanges(input){const result=await store.applySourceChanges(input);if(result.ok&&input.expectedCursor==='page2'){process.send('second-page-committed');await new Promise(()=>{});}return result;}};
const read=await store.getWork(config.workId);if(!read.ok||!read.entry)throw Error('synthetic claim missing');
await core.sourceSyncHandler({store:wrapped,remote:runtime.sourceDrive({baseUrl:config.baseUrl,clock}),clock,idGen:{next:()=>randomUUID()}})(read.entry.item);
throw Error('synthetic barrier was not reached');
