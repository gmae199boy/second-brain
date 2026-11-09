import { contentHashOfBytes } from '../domain/file.js';
import { DOCUMENT_EXTRACT_MAX_BYTES, DOCUMENT_BINARY_EXTRACT_MAX_BYTES } from '../domain/document.js';
import type { WorkItem } from '../domain/work-item.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { SourceClaim, SourceStore, SourceEntry } from '../ports/source-store.js';
import type { SourceRemote, SourceTemp, RemoteSourceItem, RemoteError } from '../ports/source-remote.js';
import { SOURCE_DOCS_MAX_BYTES } from '../ports/source-remote.js';
import type { WorkHandlerResult } from '../queue/drain.js';
import { DOCUMENT_EXTRACTOR_VERSION, type DocumentExtractor } from '../files/extractors.js';
import { workProgress, type WorkProgressSink } from '../queue/progress.js';
import type { WorkStore } from '../ports/store.js';
export const SOURCE_SYNC_KIND='source_sync';
const folder='application/vnd.google-apps.folder', shortcut='application/vnd.google-apps.shortcut', docs='application/vnd.google-apps.document';
const fail=(x:{code:string;message:string;retryAfter?:Date},retryable=true):WorkHandlerResult=>({ok:false,code:x.code,message:'원본 동기화를 완료하지 못했습니다',retryable:x.code==='AUTH_REQUIRED'||x.code==='AUTH_LOGIN_REQUIRED'?false:retryable,...(x.retryAfter?{retryAfter:x.retryAfter}:{})});
export function sourceClaim(item:WorkItem,clock:Clock):SourceClaim|null {return item.claimedBy&&item.claimedAt?{workId:item.id,claimedBy:item.claimedBy,claimedAt:item.claimedAt,attempts:item.attempts,now:clock.now()}:null;}
export function sourceSyncHandler(deps:{store:SourceStore & Partial<Pick<WorkStore,'resolveFailures'>>;remote:SourceRemote;temp?:SourceTemp;clock:Clock;idGen:IdGen;extractors?:readonly DocumentExtractor[];roots?:()=>Promise<{ok:true;roots:string[]}|{ok:false;code:string;message:string}>;validateSource?:(id:string)=>Promise<{ok:true}|{ok:false;code:string;message:string}>;onProgress?:WorkProgressSink}) {
  const run=async (work:WorkItem, allowRestart:boolean, progress:ReturnType<typeof workProgress>, counter:{value:number}):Promise<WorkHandlerResult>=>{
    const {store,remote,clock,idGen}=deps;const permitted=await deps.validateSource?.(work.targetId);if(permitted&&!permitted.ok)return fail(permitted);if(deps.temp)await cleanupSourceTemps(deps.temp,store,clock);const claim=()=>sourceClaim(work,clock);const initial=claim();if(!initial)return fail({code:'CLAIM_LOST',message:'source 청구가 없습니다'},false);
    const renew=async()=>store.renewSourceClaim({sourceId:work.targetId,claim:claim()!,nowAtLock:()=>clock.now()});
    const firstRenewal=await renew();if(!firstRenewal.ok)return fail(firstRenewal);
    const success=async():Promise<WorkHandlerResult>=>{if(store.resolveFailures){const resolved=await store.resolveFailures({targetKind:'source',targetId:work.targetId,stage:SOURCE_SYNC_KIND,now:clock.now()});if(!resolved.ok)return fail(resolved);}return {ok:true};};
    const read=await store.readSource(work.targetId);if(!read.ok)return fail(read);if(!read.source)return {ok:true};const source=read.source;
    const processEntry=async(row:SourceEntry,item:RemoteSourceItem,rawName:string,redactionIsError=false,scanId?:string):Promise<WorkHandlerResult & {unreachable?:boolean}>=>{
      if(row.indexStatus==='indexed'&&row.completedVersion===item.version&&row.completedHash!==null&&row.fileId!==null)return {ok:true};
      const probes=deps.extractors?.filter(x=>x.detectCarry)??[];
      const binaryEnabled=probes.length>0;
      const isText=item.mimeType==='text/plain'||item.mimeType==='text/markdown'||(item.mimeType==='application/octet-stream'&&/\.(txt|md)$/i.test(rawName));
      const nativeUnsupported=item.mimeType.startsWith('application/vnd.google-apps.')&&item.mimeType!==docs;
      const checkCarry=binaryEnabled&&item.mimeType!==docs&&!item.mimeType.startsWith('image/')&&!nativeUnsupported&&(!isText||row.indexStatus==='unsupported');
      if(checkCarry){const checked=await store.readSourceCarryCheck({sourceFileId:row.id,remoteVersion:item.version,extractorVersion:DOCUMENT_EXTRACTOR_VERSION});if(!checked.ok)return fail(checked);if(checked.checked&&row.indexStatus!=='pending')return {ok:true};}
      const maxBytes=item.mimeType===docs?SOURCE_DOCS_MAX_BYTES:binaryEnabled?DOCUMENT_BINARY_EXTRACT_MAX_BYTES:DOCUMENT_EXTRACT_MAX_BYTES;
      const status=item.mimeType.startsWith('image/')?'photo':item.sizeBytes!==null&&item.sizeBytes>maxBytes?'too_large':nativeUnsupported||(!binaryEnabled&&item.mimeType!==docs&&!isText)?'unsupported':null;
      if(status){const marked=await store.markSourceEntry({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,status,claim:claim()!});if(!marked.ok)return fail(marked);return {ok:true};}
      const bytes=await remote.download({id:item.id,docs:item.mimeType===docs,maxBytes});if(!bytes.ok){if(bytes.code==='TOO_LARGE'){if(checkCarry){const renewed=await renew();if(!renewed.ok)return fail(renewed);const verified=await remote.metadata(item.id);if(!verified.ok)return fail(verified);if(verified.item.version!==item.version||verified.item.mimeType!==item.mimeType)return fail({code:'SOURCE_CHANGED',message:'다운로드 중 원격 버전이 변경되었습니다'});const marked=await store.markSourceCarryCheck({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,extractorVersion:DOCUMENT_EXTRACTOR_VERSION,status:'too_large',claim:claim()!});if(!marked.ok)return fail(marked);}else{const marked=await store.markSourceEntry({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,status:'too_large',claim:claim()!});if(!marked.ok)return fail(marked);}return {ok:true};}if(bytes.code==='UNREACHABLE'){const marked=scanId?await store.deferSourceScanUnreachable({sourceId:source.id,generation:source.generation,scanId,sourceFileId:row.id,remoteVersion:item.version,claim:claim()!}):await store.markSourceUnreachable({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,claim:claim()!});if(!marked.ok)return fail(marked);return {ok:true,unreachable:true};}return fail(bytes);}
      const downloadLease=await renew();if(!downloadLease.ok)return fail(downloadLease);
      if(bytes.bytes.length>maxBytes){if(checkCarry){const verified=await remote.metadata(item.id);if(!verified.ok)return fail(verified);if(verified.item.version!==item.version||verified.item.mimeType!==item.mimeType)return fail({code:'SOURCE_CHANGED',message:'다운로드 중 원격 버전이 변경되었습니다'});const marked=await store.markSourceCarryCheck({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,extractorVersion:DOCUMENT_EXTRACTOR_VERSION,status:'too_large',claim:claim()!});if(!marked.ok)return fail(marked);}else{const marked=await store.markSourceEntry({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,status:'too_large',claim:claim()!});if(!marked.ok)return fail(marked);}return {ok:true};}
      const latest=await remote.metadata(item.id);if(!latest.ok){if(latest.code==='UNREACHABLE'){const m=scanId?await store.deferSourceScanUnreachable({sourceId:source.id,generation:source.generation,scanId,sourceFileId:row.id,remoteVersion:item.version,claim:claim()!}):await store.markSourceUnreachable({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,claim:claim()!});if(!m.ok)return fail(m);return {ok:true,unreachable:true};}return fail(latest);}const metadataLease=await renew();if(!metadataLease.ok)return fail(metadataLease);if(latest.item.version!==item.version||latest.item.mimeType!==item.mimeType)return fail({code:'SOURCE_CHANGED',message:'다운로드 중 원격 버전이 변경되었습니다'});
      let supportedCarry=false;
      if(checkCarry){let inconclusive=false,tooLarge=false;for(const probe of probes){let result:boolean|'too_large'|null;try{result=await probe.detectCarry!(bytes.bytes);}catch{result=null;}if(result===null){inconclusive=true;break;}if(result==='too_large'){tooLarge=true;break;}if(result){supportedCarry=true;break;}}
        if(inconclusive)return fail({code:'TEMPORARY',message:'문서 바이트 판정을 완료하지 못했습니다'});
        const renewed=await renew();if(!renewed.ok)return fail(renewed);
        const verified=await remote.metadata(item.id);if(!verified.ok)return fail(verified);if(verified.item.version!==item.version||verified.item.mimeType!==item.mimeType)return fail({code:'SOURCE_CHANGED',message:'형식 판정 중 원격 버전이 변경되었습니다'});
        if(!supportedCarry){const marked=await store.markSourceCarryCheck({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,extractorVersion:DOCUMENT_EXTRACTOR_VERSION,...(tooLarge?{status:'too_large' as const}:{}),claim:claim()!});if(!marked.ok)return fail(marked);return {ok:true};}
      }
      const contentHash=contentHashOfBytes(bytes.bytes);let tempKey:string|undefined;
      if(deps.temp){tempKey=idGen.next();const prepared=await store.prepareSourceBytes({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,contentHash,tempKey,claim:claim()!});if(!prepared.ok)return fail(prepared);const saved=await deps.temp.write(tempKey,bytes.bytes);if(!saved.ok)return fail({code:'FILES_UNAVAILABLE',message:saved.message});}
      const handoff=await store.handoffSourceFile({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,fileId:idGen.next(),contentHash,sizeBytes:bytes.bytes.length,workId:idGen.next(),...(tempKey?{tempKey}:{}),...(supportedCarry?{carryExtractorVersion:DOCUMENT_EXTRACTOR_VERSION}:{}),claim:claim()!});if(!handoff.ok){if(handoff.code==='FILE_REDACTED'&&!redactionIsError)return {ok:true};return fail(handoff);}
      return {ok:true};
    };
    const rootsResult=deps.roots?await deps.roots():{ok:true as const,roots:[source.rootId]};if(!rootsResult.ok)return fail(rootsResult);
    const rootsSet=new Set(rootsResult.roots);
    const sourcePath=async(item:RemoteSourceItem):Promise<{ok:true;path:string|null;uncertain?:boolean}|RemoteError|{ok:false;code:string;message:string}>=>{
      let parents=item.parents;if(!parents)return {ok:true,path:null,uncertain:true};
      const queue=parents.map(id=>({id,names:[] as string[],visited:new Set<string>()}));
      while(queue.length){const node=queue.shift()!;if(rootsSet.has(node.id))return {ok:true,path:node.names.reverse().join('/')};if(node.visited.has(node.id))continue;const visited=new Set(node.visited);visited.add(node.id);const renewal=await renew();if(!renewal.ok)return renewal;const parent=await remote.metadata(node.id);if(!parent.ok){if(parent.code==='UNREACHABLE')return {ok:true,path:null,uncertain:true};return parent;}if(parent.item.trashed||parent.item.mimeType!==folder)continue;if(!parent.item.parents)return {ok:true,path:null,uncertain:true};for(const id of parent.item.parents)queue.push({id,names:[...node.names,parent.item.name],visited});}
      return {ok:true,path:null};
    };
    let pendingNeedsScan=false;
    const drainTasks=async():Promise<WorkHandlerResult>=>{
      for(;;){const renewed=await renew();if(!renewed.ok)return fail(renewed);const pending=await store.listSourceChangeTasks({sourceId:source.id,generation:source.generation,claim:claim()!});if(!pending.ok)return fail(pending);if(!pending.tasks.length)return {ok:true};
        const entries=await store.listSourceEntries(source.id);if(!entries.ok)return fail(entries);const byId=new Map(entries.entries.map(entry=>[entry.id,entry]));let superseded=false;
        for(const task of pending.tasks){const row=byId.get(task.sourceFileId);if(!row)return fail({code:'SOURCE_CHANGED',message:'변경 작업의 원본이 없습니다'});if(row.redacted){const hidden=await store.markSourceUnreachable({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:row.remoteVersion,claim:claim()!});if(!hidden.ok)return fail(hidden);continue;}const lease=await renew();if(!lease.ok)return fail(lease);const latest=await remote.metadata(row.remoteId);
          if(!latest.ok){if(latest.code!=='UNREACHABLE')return fail(latest);const removed=await store.markSourceUnreachable({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:row.remoteVersion,claim:claim()!});if(!removed.ok)return fail(removed);continue;}
          if(latest.item.trashed){const removed=await store.markSourceUnreachable({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:row.remoteVersion,claim:claim()!});if(!removed.ok)return fail(removed);continue;}
          if(latest.item.mimeType===folder||latest.item.mimeType===shortcut){const deferred=await store.deferSourceChangeToReconcile({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:row.remoteVersion,claim:claim()!});if(!deferred.ok)return fail(deferred);pendingNeedsScan=true;continue;}
          let currentPath=row.path;if(remote.changes){const path=await sourcePath(latest.item);if(!path.ok)return fail(path);if(path.path===null){const deferred=await store.deferSourceChangeToReconcile({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:row.remoteVersion,claim:claim()!});if(!deferred.ok)return fail(deferred);pendingNeedsScan=true;continue;}currentPath=path.path;}
          if(latest.item.name!==row.name||currentPath!==row.path){const deferred=await store.deferSourceChangeToReconcile({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:row.remoteVersion,claim:claim()!});if(!deferred.ok)return fail(deferred);pendingNeedsScan=true;continue;}
          if(latest.item.version!==row.remoteVersion||latest.item.mimeType!==row.mimeType){const current=await store.readSource(source.id);if(!current.ok)return fail(current);if(!current.source?.cursor)return fail({code:'SOURCE_CHANGED',message:'변경 cursor가 없습니다'});const replaced=await store.applySourceChanges({sourceId:source.id,generation:source.generation,expectedCursor:current.source.cursor,nextCursor:current.source.cursor,changes:[{kind:'upsert',entry:{id:row.id,remoteId:row.remoteId,name:latest.item.name,path:currentPath,mimeType:latest.item.mimeType,remoteVersion:latest.item.version,sizeBytes:latest.item.sizeBytes}}],claim:claim()!});if(!replaced.ok){if(replaced.code==='FILE_REDACTED'){const hidden=await store.markSourceUnreachable({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:row.remoteVersion,claim:claim()!});if(!hidden.ok)return fail(hidden);continue;}return fail(replaced);}superseded=true;continue;}
          const processed=await processEntry(row,latest.item,row.name,true);if(!processed.ok){if(processed.code==='FILE_REDACTED'){const removed=await store.markSourceUnreachable({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:row.remoteVersion,claim:claim()!});if(!removed.ok)return fail(removed);continue;}return processed;}
          if(processed.unreachable)continue;
          const resolved=await store.resolveSourceChangeTask({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:row.remoteVersion,claim:claim()!});if(!resolved.ok){if(resolved.code==='FILE_REDACTED'){const hidden=await store.markSourceUnreachable({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:row.remoteVersion,claim:claim()!});if(!hidden.ok)return fail(hidden);continue;}return fail(resolved);}
        }
        if(superseded)continue;
      }
    };
    const drained=await drainTasks();if(!drained.ok)return drained;
    const now=clock.now().getTime(), fullDue=!source.lastFullScanAt || now-source.lastFullScanAt.getTime()>=7*86400000;
    const carry=await store.hasSourceCarryRun({sourceId:source.id,generation:source.generation,workId:work.id});if(!carry.ok)return fail(carry);
    let mustScan=carry.pending||pendingNeedsScan||!remote.changes||!source.cursor||source.cursorGeneration!==source.generation||!!source.scanInProgress||fullDue;
    if(!mustScan&&remote.changes&&source.cursor){let cursor=source.cursor;const seen=new Set<string>();
      while(!mustScan){if(seen.has(cursor))return fail({code:'SOURCE_PAGE_LOOP',message:'변경 페이지가 반복됩니다'});seen.add(cursor);const lease=await renew();if(!lease.ok)return fail(lease);const page=await remote.changes({pageToken:cursor});if(!page.ok){if(page.code==='CHANGED'){mustScan=true;break;}return fail(page);}
        const known=await store.listSourceEntries(source.id);if(!known.ok)return fail(known);
        const knownByRemote=new Map(known.entries.map(entry=>[entry.remoteId,entry]));const outside=await store.listOutsideSourceNodes({sourceId:source.id,generation:source.generation});if(!outside.ok)return fail(outside);const outsideIds=new Set(outside.remoteIds);
        const changes:import('../ports/source-store.js').SourceChange[]=[];
        // A post-scan creation or a cursor-scoped witness proves old ancestry was outside.
        // An older untracked node can have moved or changed visibility, so reconcile it.
        for(const change of page.changes){const prior=knownByRemote.get(change.remoteId);if(prior?.redacted)continue;if((change.removed||change.item?.trashed)&&!prior){if(outsideIds.has(change.remoteId)){changes.push({kind:'outside',remoteId:change.remoteId});continue;}mustScan=true;break;}if(change.removed||change.item?.trashed){changes.push({kind:'removed',remoteId:change.remoteId});continue;}if(!change.item)return fail({code:'SOURCE_CHANGED',message:'변경 메타데이터가 없습니다'});if(change.item.mimeType===folder||change.item.mimeType===shortcut){const scope=await sourcePath(change.item);if(!scope.ok)return fail(scope);if(scope.path===null&&!scope.uncertain&&outsideIds.has(change.item.id)&&!prior&&!rootsSet.has(change.item.id)){changes.push({kind:'outside',remoteId:change.item.id});outsideIds.add(change.item.id);continue;}mustScan=true;break;}const path=await sourcePath(change.item);if(!path.ok)return fail(path);if(path.path===null){if(prior||path.uncertain){mustScan=true;break;}continue;}if(prior&&(prior.name!==change.item.name||prior.path!==path.path)){mustScan=true;break;}changes.push({kind:'upsert',entry:{id:prior?.id??idGen.next(),remoteId:change.remoteId,name:change.item.name,path:path.path,mimeType:change.item.mimeType,remoteVersion:change.item.version,sizeBytes:change.item.sizeBytes}});}
        if(mustScan)break;
        const next=page.nextPageToken??page.newStartPageToken;if(!next)return fail({code:'SOURCE_CHANGED',message:'변경 cursor가 없습니다'});const applied=await store.applySourceChanges({sourceId:source.id,generation:source.generation,expectedCursor:cursor,nextCursor:next,changes,claim:claim()!});if(!applied.ok){if(applied.code==='FILE_REDACTED'&&allowRestart)return run(work,false,progress,counter);return fail(applied);}await progress('source_page',++counter.value);const delivered=await drainTasks();if(!delivered.ok)return delivered;cursor=next;if(pendingNeedsScan){mustScan=true;break;}if(!page.nextPageToken)return success();
      }
    }
    const token=await remote.startToken();if(!token.ok)return fail(token,token.code!=='UNREACHABLE');
    const afterToken=await renew();if(!afterToken.ok)return fail(afterToken);
    const scanId=idGen.next();const begun=await store.beginSourceScan({sourceId:source.id,generation:source.generation,scanId,startToken:token.token,claim:claim()!});if(!begun.ok)return fail(begun);
    const prior=await store.listSourceEntries(source.id);if(!prior.ok)return fail(prior);const known=new Map(prior.entries.map(e=>[e.remoteId,e]));
    const roots=rootsResult;
    const queue=roots.roots.map(id=>({id,path:''})), visitedFolders=new Set<string>(),seenFiles=new Set<string>();
    while(queue.length){const current=queue.shift()!;if(visitedFolders.has(current.id))continue;visitedFolders.add(current.id);let page:string|undefined;const pages=new Set<string>();
      do {const pageLease=await renew();if(!pageLease.ok)return fail(pageLease);if(page){if(pages.has(page))return fail({code:'SOURCE_PAGE_LOOP',message:'목록 페이지가 반복됩니다'});pages.add(page);}const list=await remote.list({parentId:current.id,...(page?{pageToken:page}:{})});if(!list.ok){if(list.code==='CHANGED'&&allowRestart)return run(work,false,progress,counter);return fail(list,list.code!=='UNREACHABLE');}if(list.incomplete)return fail({code:'SOURCE_INCOMPLETE',message:'목록이 완전하지 않습니다'});
        for(const raw of list.items){const fileLease=await renew();if(!fileLease.ok)return fail(fileLease);let item:RemoteSourceItem=raw;if(raw.mimeType===shortcut){if(!raw.shortcutTargetId)continue;const target=await remote.metadata(raw.shortcutTargetId);if(!target.ok){if(target.code==='UNREACHABLE')continue;return fail(target);}item=target.item;const shortcutLease=await renew();if(!shortcutLease.ok)return fail(shortcutLease);}
          if(item.mimeType===folder){queue.push({id:item.id,path:current.path?`${current.path}/${raw.name}`:raw.name});continue;}if(seenFiles.has(item.id))continue;seenFiles.add(item.id);
          const observed=await store.observeSourceEntry({sourceId:source.id,generation:source.generation,scanId,claim:claim()!,entry:{id:known.get(item.id)?.id??idGen.next(),remoteId:item.id,name:raw.name,path:current.path,mimeType:item.mimeType,remoteVersion:item.version,sizeBytes:item.sizeBytes}});if(!observed.ok)return fail(observed);const row=observed.entry;
          if(row.indexStatus==='indexed'&&row.completedVersion===item.version&&row.completedHash!==null&&row.fileId!==null)continue;
          const processed=await processEntry(row,item,raw.name,false,scanId);if(!processed.ok)return processed;
        }await progress('source_page',++counter.value);page=list.nextPageToken??undefined;
      }while(page);
    }
    const finalLease=await renew();if(!finalLease.ok)return fail(finalLease);
    const finished=await store.finishSourceScan({sourceId:source.id,generation:source.generation,scanId,claim:claim()!});if(!finished.ok)return fail(finished);return success();
  };
  return (work:WorkItem)=>run(work,true,workProgress(deps.onProgress),{value:0});
}
export type { RemoteError };

/** A missing or failed binding lookup is unknown, never proof of orphanhood. */
export async function cleanupSourceTemps(temp:import('../ports/source-remote.js').SourceTemp,store:Pick<SourceStore,'readSourceAttempt'> & Partial<Pick<SourceStore,'recoverSourceAttempt'>>,clock?:Clock):Promise<void> {
  await temp.cleanup(async key=>{try{const r=clock&&store.recoverSourceAttempt?await store.recoverSourceAttempt(key,clock.now()):await store.readSourceAttempt(key);return !r.ok||!r.binding?'unknown':r.binding.open?'open':'preparing' in r.binding&&r.binding.preparing?'preparing':'closed';}catch{return 'unknown';}});
}
