import type { SourceStore } from '../../ports/source-store.js';
import { assertEqual as equal, assertOk as ok, assertNotOk as notOk } from '../assert.js';
function assertOk<T extends {ok:boolean}>(value:T): asserts value is Extract<T,{ok:true}> { ok(value, 'expected success'); }
const assertNotOk = (value: {ok:boolean}) => notOk(value, 'expected failure');
const assertEqual = (actual: unknown, expected: unknown) => equal(actual, expected, 'values differ');
import { contractCase, withSubject, type ContractCase } from '../contract.js';
/** Factory creates a valid source_sync work claim for sourceId and returns it. */
export type SourceContractSubject = {store:SourceStore; claim:{workId:string;claimedBy:string;claimedAt:Date;attempts:number;now:Date}};
const sourceId='019a0000-0000-7000-8000-000000000001', scanId='019a0000-0000-7000-8000-000000000002', entryId='019a0000-0000-7000-8000-000000000003';
export function sourceStoreContract():ContractCase<SourceContractSubject>[] {return [contractCase('outside node evidence follows cursor and is cleared when reconciliation begins',factory=>withSubject(factory,async ({store,claim})=>{
  assertOk(await store.ensureSource({id:sourceId,kind:'drive',account:'outside-contract',rootId:'root'}));assertOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'start',claim}));assertOk(await store.finishSourceScan({sourceId,generation:1,scanId,claim}));
  const page={sourceId,generation:1,expectedCursor:'start',nextCursor:'next',changes:[{kind:'outside' as const,remoteId:'outside'}],claim};assertNotOk(await store.applySourceChanges({...page,claim:{...claim,claimedBy:'other'}}));const before=await store.listOutsideSourceNodes({sourceId,generation:1});assertOk(before);assertEqual(before.remoteIds,[]);
  assertOk(await store.applySourceChanges(page));const saved=await store.listOutsideSourceNodes({sourceId,generation:1});assertOk(saved);assertEqual(saved.remoteIds,['outside']);assertNotOk(await store.listOutsideSourceNodes({sourceId,generation:2}));
  assertOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'rescan',claim}));const cleared=await store.listOutsideSourceNodes({sourceId,generation:1});assertOk(cleared);assertEqual(cleared.remoteIds,[]);
})),contractCase('changes task defers atomically to reconciliation without early prune',factory=>withSubject(factory,async ({store,claim})=>{
  assertOk(await store.ensureSource({id:sourceId,kind:'drive',account:'defer-page',rootId:'root'}));assertOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'start',claim}));assertOk(await store.finishSourceScan({sourceId,generation:1,scanId,claim}));
  const entry={id:entryId,remoteId:'remote',name:'alias',path:'',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:3};assertOk(await store.applySourceChanges({sourceId,generation:1,expectedCursor:'start',nextCursor:'next',changes:[{kind:'upsert',entry}],claim}));
  assertNotOk(await store.deferSourceChangeToReconcile({sourceId,generation:1,sourceFileId:entryId,remoteVersion:'v1',claim:{...claim,claimedBy:'other'}}));
  assertOk(await store.deferSourceChangeToReconcile({sourceId,generation:1,sourceFileId:entryId,remoteVersion:'v1',claim}));const source=await store.readSource(sourceId);assertOk(source);assertEqual(source.source?.lastFullScanAt,null);
  const rows=await store.listSourceEntries(sourceId);assertOk(rows);assertEqual(rows.entries[0]?.unreachable,false);const tasks=await store.listSourceChangeTasks({sourceId,generation:1,claim});assertOk(tasks);assertEqual(tasks.tasks,[]);
})),contractCase('same version MIME changes reset classification in scans and change pages',factory=>withSubject(factory,async ({store,claim})=>{
  assertOk(await store.ensureSource({id:sourceId,kind:'drive',account:'mime-contract',rootId:'root'}));
  const entry={id:entryId,remoteId:'mime',name:'mime',path:'',mimeType:'application/octet-stream',remoteVersion:'v1',sizeBytes:3};
  assertOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'start',claim}));assertOk(await store.observeSourceEntry({sourceId,generation:1,scanId,entry,claim}));
  assertOk(await store.markSourceCarryCheck({sourceId,generation:1,sourceFileId:entryId,remoteVersion:'v1',extractorVersion:'v',claim}));
  const photo=await store.observeSourceEntry({sourceId,generation:1,scanId,entry:{...entry,mimeType:'image/jpeg'},claim});assertOk(photo);assertEqual(photo.entry.indexStatus,'pending');
  assertOk(await store.markSourceEntry({sourceId,generation:1,sourceFileId:entryId,remoteVersion:'v1',status:'photo',claim}));assertOk(await store.finishSourceScan({sourceId,generation:1,scanId,claim}));
  assertOk(await store.applySourceChanges({sourceId,generation:1,expectedCursor:'start',nextCursor:'next',changes:[{kind:'upsert',entry:{...entry,mimeType:'text/plain'}}],claim}));
  const rows=await store.listSourceEntries(sourceId);assertOk(rows);assertEqual(rows.entries[0]?.indexStatus,'pending');const tasks=await store.listSourceChangeTasks({sourceId,generation:1,claim});assertOk(tasks);assertEqual(tasks.tasks,[{sourceFileId:entryId,remoteVersion:'v1'}]);
})),contractCase('changes page cursor CAS and pending entries survive replay',factory=>withSubject(factory,async ({store,claim})=>{
  assertOk(await store.ensureSource({id:sourceId,kind:'drive',account:'page',rootId:'root'}));
  assertOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'start',claim}));assertOk(await store.finishSourceScan({sourceId,generation:1,scanId,claim}));
  const entry={id:entryId,remoteId:'remote',name:'one',path:'',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:3};
  const page={sourceId,generation:1,expectedCursor:'start',nextCursor:'next',changes:[{kind:'upsert' as const,entry}],claim};
  assertNotOk(await store.applySourceChanges({...page,claim:{...claim,claimedBy:'other'}}));
  assertOk(await store.applySourceChanges(page));assertNotOk(await store.applySourceChanges(page));
  const cursor=await store.readSource(sourceId);assertOk(cursor);assertEqual(cursor.source?.cursor,'next');
  const rows=await store.listSourceEntries(sourceId);assertOk(rows);assertEqual(rows.entries[0]?.indexStatus,'pending');assertEqual(rows.entries[0]?.completedVersion,null);
  const task={sourceId,generation:1,sourceFileId:entryId,remoteVersion:'v1',claim};
  const pending=await store.listSourceChangeTasks({sourceId,generation:1,claim});assertOk(pending);assertEqual(pending.tasks,[{sourceFileId:entryId,remoteVersion:'v1'}]);
  assertNotOk(await store.resolveSourceChangeTask(task));assertNotOk(await store.resolveSourceChangeTask({...task,claim:{...claim,claimedBy:'other'}}));assertNotOk(await store.resolveSourceChangeTask({...task,generation:2}));
  assertNotOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'unsafe',claim}));
  assertOk(await store.markSourceEntry({...task,status:'unsupported'}));assertOk(await store.resolveSourceChangeTask(task));
  const drained=await store.listSourceChangeTasks({sourceId,generation:1,claim});assertOk(drained);assertEqual(drained.tasks,[]);

  assertOk(await store.applySourceChanges({...page,expectedCursor:'next',nextCursor:'end',changes:[{kind:'removed',remoteId:'remote'}]}));
  const removed=await store.listSourceEntries(sourceId);assertOk(removed);assertEqual(removed.entries[0]?.unreachable,true);
})),contractCase('source identity, incomplete scan and claim fencing', factory=>withSubject(factory,async ({store,claim})=>{
  const first=await store.ensureSource({id:sourceId,kind:'drive',account:'synthetic',rootId:'root'});assertOk(first);
  const duplicate=await store.ensureSource({id:'019a0000-0000-7000-8000-000000000004',kind:'drive',account:'synthetic',rootId:'root'});assertOk(duplicate);assertEqual(duplicate.source.id,sourceId);
  assertNotOk(await store.ensureSource({id:'019a0000-0000-7000-8000-000000000006',kind:'drive',account:'synthetic',rootId:'different-root'}));
  const stable=await store.readSource(sourceId);assertOk(stable);assertEqual(stable.source?.rootId,'root');assertEqual(stable.source?.cursor,null);
  assertOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'token',claim}));
  const entry={id:entryId,remoteId:'remote',name:'문서',path:'folder',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:3};
  assertOk(await store.observeSourceEntry({sourceId,generation:1,scanId,entry,claim}));
  assertNotOk(await store.finishSourceScan({sourceId,generation:1,scanId,claim:{...claim,claimedBy:'other'}}));
  const before=await store.readSource(sourceId);assertOk(before);assertEqual(before.source?.cursor,null);
  assertOk(await store.finishSourceScan({sourceId,generation:1,scanId,claim}));
  const after=await store.readSource(sourceId);assertOk(after);assertEqual(after.source?.cursor,'token');
  assertNotOk(await store.ensureSource({id:'019a0000-0000-7000-8000-000000000006',kind:'drive',account:'synthetic',rootId:'different-root'}));
  const unchanged=await store.readSource(sourceId);assertOk(unchanged);assertEqual(unchanged.source?.cursor,'token');assertEqual(unchanged.source?.generation,1);
  const rows=await store.listSourceEntries(sourceId);assertOk(rows);assertEqual(rows.entries.length,1);assertEqual(rows.entries[0]?.fileId,null);
  assertNotOk(await store.observeSourceEntry({sourceId,generation:1,scanId,entry,claim}));
  const second='019a0000-0000-7000-8000-000000000007', third='019a0000-0000-7000-8000-000000000008', fourth='019a0000-0000-7000-8000-000000000009';
  const at=(seconds:number)=>({...claim,now:new Date(claim.now.getTime()+seconds*1000)});
  assertOk(await store.beginSourceScan({sourceId,generation:1,scanId:second,startToken:'next',claim:at(1)}));
  assertOk(await store.finishSourceScan({sourceId,generation:1,scanId:second,claim:at(2)}));
  const missing=await store.listSourceEntries(sourceId);assertOk(missing);assertEqual(missing.entries[0]?.unreachable,true);assertEqual(missing.entries[0]?.unreachableAt?.toISOString(),at(2).now.toISOString());
  assertOk(await store.beginSourceScan({sourceId,generation:1,scanId:third,startToken:'again',claim:at(3)}));
  assertOk(await store.finishSourceScan({sourceId,generation:1,scanId:third,claim:at(4)}));
  const stillMissing=await store.listSourceEntries(sourceId);assertOk(stillMissing);assertEqual(stillMissing.entries[0]?.unreachableAt?.toISOString(),at(2).now.toISOString());
  assertOk(await store.beginSourceScan({sourceId,generation:1,scanId:fourth,startToken:'restored',claim:at(5)}));
  const restored=await store.observeSourceEntry({sourceId,generation:1,scanId:fourth,entry,claim:at(6)});assertOk(restored);assertEqual(restored.entry.unreachable,false);assertEqual(restored.entry.unreachableAt,null);
  assertOk(await store.finishSourceScan({sourceId,generation:1,scanId:fourth,claim:at(7)}));
  const recovered=await store.listSourceEntries(sourceId);assertOk(recovered);assertEqual(recovered.entries[0]?.id,entryId);assertEqual(recovered.entries[0]?.unreachableAt,null);
  const fifth='019a0000-0000-7000-8000-000000000010';
  assertOk(await store.beginSourceScan({sourceId,generation:1,scanId:fifth,startToken:'lost-again',claim:at(8)}));
  assertOk(await store.finishSourceScan({sourceId,generation:1,scanId:fifth,claim:at(9)}));
  const lostAgain=await store.listSourceEntries(sourceId);assertOk(lostAgain);assertEqual(lostAgain.entries[0]?.unreachableAt?.toISOString(),at(9).now.toISOString());
})),contractCase('source lease renewal preserves claim identity and cannot revive expiration',factory=>withSubject(factory,async ({store,claim})=>{
  assertOk(await store.ensureSource({id:sourceId,kind:'drive',account:'lease',rootId:'root'}));
  const at=(seconds:number)=>({...claim,now:new Date(claim.now.getTime()+seconds*1000)});
  for(const bad of [{...claim,workId:'019a0000-0000-7000-8000-000000000099'},{...claim,claimedBy:'other'},{...claim,claimedAt:new Date(claim.claimedAt.getTime()+1)},{...claim,attempts:claim.attempts+1}]) assertNotOk(await store.renewSourceClaim({sourceId,claim:bad}));
  assertNotOk(await store.renewSourceClaim({sourceId:'019a0000-0000-7000-8000-000000000099',claim}));
  assertNotOk(await store.renewSourceClaim({sourceId,claim:at(1),nowAtLock:()=>at(600).now}));
  assertOk(await store.renewSourceClaim({sourceId,claim:at(599)}));
  assertOk(await store.renewSourceClaim({sourceId,claim:at(1198)}));
  assertNotOk(await store.renewSourceClaim({sourceId,claim:at(1798)}));
  assertNotOk(await store.renewSourceClaim({sourceId,claim:at(1799)}));
})),contractCase('source bytes remain preparing until fenced handoff makes them ready',factory=>withSubject(factory,async ({store,claim})=>{
  assertOk(await store.ensureSource({id:sourceId,kind:'drive',account:'stage',rootId:'root'}));assertOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'token',claim}));
  assertOk(await store.observeSourceEntry({sourceId,generation:1,scanId,claim,entry:{id:entryId,remoteId:'r',name:'n',path:'',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:3}}));
  const hash='sha256:'+'c'.repeat(64),tempKey='019a0000-0000-7000-8000-000000000050',fileId='019a0000-0000-7000-8000-000000000051',workId='019a0000-0000-7000-8000-000000000052';
  const stage={sourceId,generation:1,sourceFileId:entryId,remoteVersion:'v1',contentHash:hash,tempKey,claim};assertOk(await store.prepareSourceBytes(stage));assertOk(await store.prepareSourceBytes(stage));
  const before=await store.readSourceAttempt(tempKey);assertOk(before);assertEqual(before.binding?.open,true);assertEqual(before.binding?.fileId,null);
  assertNotOk(await store.handoffSourceFile({...stage,fileId,sizeBytes:3,workId,claim:{...claim,attempts:claim.attempts+1}}));
  assertOk(await store.handoffSourceFile({...stage,fileId,sizeBytes:3,workId}));const rows=await store.listSourceHandoffs(fileId);assertOk(rows);assertEqual(rows.handoffs[0]?.tempKey,tempKey);
  const ready=await store.readSourceAttempt(tempKey);assertOk(ready);assertEqual(ready.binding?.open,true);assertEqual(ready.binding?.fileId,fileId);
 })),contractCase('MIME changes invalidate an existing source handoff in scan and changes paths',factory=>withSubject(factory,async ({store,claim})=>{
  assertOk(await store.ensureSource({id:sourceId,kind:'drive',account:'mime-handoff',rootId:'root'}));assertOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'t',claim}));
  const entry={id:entryId,remoteId:'mime',name:'mime',path:'',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:3},fileId='019a0000-0000-7000-8000-000000000071',workId='019a0000-0000-7000-8000-000000000072';
  assertOk(await store.observeSourceEntry({sourceId,generation:1,scanId,entry,claim}));assertOk(await store.handoffSourceFile({sourceId,generation:1,sourceFileId:entryId,remoteVersion:'v1',fileId,contentHash:'sha256:'+'e'.repeat(64),sizeBytes:3,workId,claim}));
  const before=await store.listSourceHandoffs(fileId);assertOk(before);assertEqual(before.handoffs.length,1);
  assertOk(await store.observeSourceEntry({sourceId,generation:1,scanId,entry:{...entry,mimeType:'image/jpeg'},claim}));const after=await store.listSourceHandoffs(fileId);assertOk(after);assertEqual(after.handoffs.length,0);assertOk(await store.markSourceEntry({sourceId,generation:1,sourceFileId:entryId,remoteVersion:'v1',status:'photo',claim}));assertOk(await store.finishSourceScan({sourceId,generation:1,scanId,claim}));
  assertOk(await store.applySourceChanges({sourceId,generation:1,expectedCursor:'t',nextCursor:'next',changes:[{kind:'upsert',entry}],claim}));assertOk(await store.handoffSourceFile({sourceId,generation:1,sourceFileId:entryId,remoteVersion:'v1',fileId,contentHash:'sha256:'+'e'.repeat(64),sizeBytes:3,workId,claim}));
  assertOk(await store.applySourceChanges({sourceId,generation:1,expectedCursor:'next',nextCursor:'end',changes:[{kind:'upsert',entry:{...entry,mimeType:'image/jpeg'}}],claim}));const final=await store.listSourceHandoffs(fileId);assertOk(final);assertEqual(final.handoffs.length,0);
})),contractCase('source Carry classification is versioned and fenced' ,factory=>withSubject(factory,async ({store,claim})=>{
  assertOk(await store.ensureSource({id:sourceId,kind:'drive',account:'carry',rootId:'root'}));assertOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'t',claim}));
  const entry={id:entryId,remoteId:'binary',name:'binary',path:'',mimeType:'application/octet-stream',remoteVersion:'v1',sizeBytes:3};assertOk(await store.observeSourceEntry({sourceId,generation:1,scanId,entry,claim}));
  const check={sourceId,generation:1,sourceFileId:entryId,remoteVersion:'v1',extractorVersion:'doc/new',claim};assertNotOk(await store.markSourceCarryCheck({...check,claim:{...claim,claimedBy:'wrong'}}));
  assertOk(await store.markSourceCarryCheck(check));const found=await store.readSourceCarryCheck(check);assertOk(found);assertEqual(found.checked,true);
  const later=await store.readSourceCarryCheck({...check,extractorVersion:'doc/later'});assertOk(later);assertEqual(later.checked,false);
  assertOk(await store.observeSourceEntry({sourceId,generation:1,scanId,entry:{...entry,remoteVersion:'v2'},claim}));assertNotOk(await store.markSourceCarryCheck(check));
  assertOk(await store.disconnectSource({id:sourceId,now:claim.now}));assertNotOk(await store.markSourceCarryCheck({...check,remoteVersion:'v2'}));
})),contractCase('native Sheets unsupported is not a Carry scan candidate',factory=>withSubject(factory,async ({store,claim})=>{
  assertOk(await store.ensureSource({id:sourceId,kind:'drive',account:'native-excluded',rootId:'root'}));assertOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'t',claim}));
  assertOk(await store.observeSourceEntry({sourceId,generation:1,scanId,claim,entry:{id:entryId,remoteId:'sheet',name:'sheet',path:'',mimeType:'application/vnd.google-apps.spreadsheet',remoteVersion:'v1',sizeBytes:null}}));assertOk(await store.markSourceEntry({sourceId,generation:1,sourceFileId:entryId,remoteVersion:'v1',status:'unsupported',claim}));
  const reserved=await store.reserveSourceCarry({sourceId,generation:1,extractorVersion:'doc/current',workId:'019a0000-0000-7000-8000-000000000064',now:claim.now});assertOk(reserved);assertEqual(reserved.reserved,false);
})),contractCase('source Carry joins same version and keeps old version pending',factory=>withSubject(factory,async ({store,claim})=>{
  assertOk(await store.ensureSource({id:sourceId,kind:'drive',account:'carry-join',rootId:'root'}));assertOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'t',claim}));
  const other='019a0000-0000-7000-8000-000000000060',fileId='019a0000-0000-7000-8000-000000000061',workId='019a0000-0000-7000-8000-000000000062',next='019a0000-0000-7000-8000-000000000063';
  for(const id of [entryId,other])assertOk(await store.observeSourceEntry({sourceId,generation:1,scanId,claim,entry:{id,remoteId:id,name:id,path:'',mimeType:'application/octet-stream',remoteVersion:'v1',sizeBytes:3}}));
  const base={sourceId,generation:1,remoteVersion:'v1',fileId,contentHash:'sha256:'+'d'.repeat(64),sizeBytes:3,claim};
  const first=await store.handoffSourceFile({...base,sourceFileId:entryId,workId,carryExtractorVersion:'new'});assertOk(first);
  assertNotOk(await store.handoffSourceFile({...base,sourceFileId:other,workId:next,carryExtractorVersion:'old'}));
  const pending=await store.readSourceCarryCheck({sourceFileId:other,remoteVersion:'v1',extractorVersion:'old'});assertOk(pending);assertEqual(pending.checked,false);
  const joined=await store.handoffSourceFile({...base,sourceFileId:other,workId:next,carryExtractorVersion:'new'});assertOk(joined);assertEqual(joined.workId,first.workId);
  assertOk(await store.disconnectSource({id:sourceId,now:claim.now}));assertOk(await store.connectSource({id:sourceId}));
  const afterReconnect=await store.readSourceCarryCheck({sourceFileId:other,remoteVersion:'v1',extractorVersion:'new'});assertOk(afterReconnect);assertEqual(afterReconnect.checked,false);
})),contractCase('disconnect and reconnect fence generations without replacing identity',factory=>withSubject(factory,async ({store,claim})=>{
  assertOk(await store.ensureSource({id:sourceId,kind:'drive',account:'transition',rootId:'root'}));
  const disconnected=await store.disconnectSource({id:sourceId,now:claim.now});assertOk(disconnected);assertEqual(disconnected.source.connected,false);assertEqual(disconnected.source.generation,2);
  const again=await store.disconnectSource({id:sourceId,now:claim.now});assertOk(again);assertEqual(again.source.generation,2);
  assertNotOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'t',claim}));
  const existing=await store.ensureSource({id:sourceId,kind:'drive',account:'transition',rootId:'root'});assertOk(existing);assertEqual(existing.source.connected,false);
  const connected=await store.connectSource({id:sourceId});assertOk(connected);assertEqual(connected.source.connected,true);assertEqual(connected.source.generation,3);
  assertNotOk(await store.beginSourceScan({sourceId,generation:1,scanId,startToken:'t',claim}));
})),];}
