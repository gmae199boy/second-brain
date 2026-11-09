import { pathToFileURL } from 'node:url';
const config=JSON.parse(process.env.BRAIN_TEST_DRIVE_RESUME);
const pg=await import('../../dist/index.js');
const runtime=await import(pathToFileURL(config.driveModule).href);
const store=pg.postgresStore({databaseUrl:config.url});
const bytes=new Uint8Array(20*1024*1024);bytes.fill(37);
const transport=async(input,init)=>{
  const response=await fetch(input,init);
  if(!config.resume && new Headers(init?.headers).get('content-range')==='bytes 5242880-10485759/20971520'){
    process.send('half-accepted');await new Promise(()=>{});
  }
  return response;
};
const drive=runtime.driveFileStore({rootFolderId:'root',baseUrl:config.baseUrl,uploads:store.driveUploads,clock:{now:()=>new Date(config.now)},fetch:transport});
if(config.resume){const first=await drive.put(bytes),second=await drive.put(bytes);process.send({first:first.ok,second:second.ok,contentHash:second.ok?second.contentHash:null});await store.close();process.disconnect();}else {await drive.put(bytes);throw Error('synthetic barrier was not reached');}
