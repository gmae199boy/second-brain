/** Remove only resources whose identity and fixture label can both be proven. */
export async function cleanupOwnedContainers(input:{docker:(...args:string[])=>Promise<string>;nonce:string;names:readonly string[];ids:readonly string[];volume:string;volumeCreated:boolean;record:(event:unknown)=>void}):Promise<void> {
 const {docker,nonce,names,ids,volume,volumeCreated,record}=input;const failures:{resource:string;stage:string}[]=[];
 for(const [index,name] of names.entries()){
  let info:{Id:string;Config:{Labels:Record<string,string>}};
  try {info=JSON.parse(await docker('inspect','--format','{{json .}}',name)) as typeof info;}
  catch(error){if(!/no such (object|container)/i.test((error as {stderr?:string}).stderr??''))failures.push({resource:name,stage:'inspect'});continue;}
  if(!info||typeof info!=='object'||!/^[a-f0-9]{64}$/.test(info.Id)||info.Config?.Labels?.['brain.fixture']!==nonce||(ids[index]!==undefined&&ids[index]!==info.Id)){failures.push({resource:name,stage:'ownership'});continue;}
  try {await docker('rm','-f',info.Id);}catch{failures.push({resource:name,stage:'remove'});continue;}
  try {await docker('inspect',name);failures.push({resource:name,stage:'still-present'});}catch(error){if(!/no such (object|container)/i.test((error as {stderr?:string}).stderr??''))failures.push({resource:name,stage:'verify'});}
 }
 try {
  const info=JSON.parse(await docker('volume','inspect',volume)) as {Labels:Record<string,string>}[];
  if(info[0]?.Labels?.['brain.fixture']!==nonce)failures.push({resource:volume,stage:'ownership'});
  else {
   try {await docker('volume','rm',volume);}catch{failures.push({resource:volume,stage:'remove'});}
   try {await docker('volume','inspect',volume);failures.push({resource:volume,stage:'still-present'});}catch(error){if(!/no such volume/i.test((error as {stderr?:string}).stderr??''))failures.push({resource:volume,stage:'verify'});}
  }
 }catch(error){if(volumeCreated||!/no such volume/i.test((error as {stderr?:string}).stderr??''))failures.push({resource:volume,stage:'inspect'});}
 record({fixture:'e9-volume',event:failures.length?'cleanup-failed':'removed',names,ids,volume,failures});
 if(failures.length)throw new AggregateError(failures.map(f=>new Error(`${f.resource}: ${f.stage}`)),'fixture resource cleanup failed');
}
