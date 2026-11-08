import { contentHashOfBytes } from '../domain/file.js';
import { DOCUMENT_EXTRACT_MAX_BYTES } from '../domain/document.js';
import type { WorkItem } from '../domain/work-item.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { SourceClaim, SourceStore } from '../ports/source-store.js';
import type { SourceRemote, SourceTemp, RemoteSourceItem, RemoteError } from '../ports/source-remote.js';
import { SOURCE_DOCS_MAX_BYTES } from '../ports/source-remote.js';
import type { WorkHandlerResult } from '../queue/drain.js';
export const SOURCE_SYNC_KIND='source_sync';
const folder='application/vnd.google-apps.folder', shortcut='application/vnd.google-apps.shortcut', docs='application/vnd.google-apps.document';
const fail=(x:{code:string;message:string},retryable=true):WorkHandlerResult=>({ok:false,code:x.code,message:x.message,retryable});
export function sourceClaim(item:WorkItem,clock:Clock):SourceClaim|null {return item.claimedBy&&item.claimedAt?{workId:item.id,claimedBy:item.claimedBy,claimedAt:item.claimedAt,attempts:item.attempts,now:clock.now()}:null;}
export function sourceSyncHandler(deps:{store:SourceStore;remote:SourceRemote;temp?:SourceTemp;clock:Clock;idGen:IdGen}) {
  return async (work:WorkItem):Promise<WorkHandlerResult>=>{
    const {store,remote,clock,idGen}=deps;if(deps.temp)await cleanupSourceTemps(deps.temp,store,clock);const claim=()=>sourceClaim(work,clock);const initial=claim();if(!initial)return fail({code:'CLAIM_LOST',message:'source 청구가 없습니다'},false);
    const renew=async()=>store.renewSourceClaim({sourceId:work.targetId,claim:claim()!});
    const firstRenewal=await renew();if(!firstRenewal.ok)return fail(firstRenewal);
    const read=await store.readSource(work.targetId);if(!read.ok)return fail(read);if(!read.source)return {ok:true};const source=read.source;
    const token=await remote.startToken();if(!token.ok)return fail(token,token.code!=='UNREACHABLE');
    const afterToken=await renew();if(!afterToken.ok)return fail(afterToken);
    const scanId=idGen.next();const begun=await store.beginSourceScan({sourceId:source.id,generation:source.generation,scanId,startToken:token.token,claim:claim()!});if(!begun.ok)return fail(begun);
    const prior=await store.listSourceEntries(source.id);if(!prior.ok)return fail(prior);const known=new Map(prior.entries.map(e=>[e.remoteId,e]));
    const queue=[{id:source.rootId,path:''}], visitedFolders=new Set<string>(),seenFiles=new Set<string>();
    while(queue.length){const current=queue.shift()!;if(visitedFolders.has(current.id))continue;visitedFolders.add(current.id);let page:string|undefined;const pages=new Set<string>();
      do {const pageLease=await renew();if(!pageLease.ok)return fail(pageLease);if(page){if(pages.has(page))return fail({code:'SOURCE_PAGE_LOOP',message:'목록 페이지가 반복됩니다'});pages.add(page);}const list=await remote.list({parentId:current.id,...(page?{pageToken:page}:{})});if(!list.ok)return fail(list,list.code!=='UNREACHABLE');if(list.incomplete)return fail({code:'SOURCE_INCOMPLETE',message:'목록이 완전하지 않습니다'});
        for(const raw of list.items){const fileLease=await renew();if(!fileLease.ok)return fail(fileLease);let item:RemoteSourceItem=raw;if(raw.mimeType===shortcut){if(!raw.shortcutTargetId)continue;const target=await remote.metadata(raw.shortcutTargetId);if(!target.ok){if(target.code==='UNREACHABLE')continue;return fail(target);}item=target.item;const shortcutLease=await renew();if(!shortcutLease.ok)return fail(shortcutLease);}
          if(item.mimeType===folder){queue.push({id:item.id,path:current.path?`${current.path}/${raw.name}`:raw.name});continue;}if(seenFiles.has(item.id))continue;seenFiles.add(item.id);
          const observed=await store.observeSourceEntry({sourceId:source.id,generation:source.generation,scanId,claim:claim()!,entry:{id:known.get(item.id)?.id??idGen.next(),remoteId:item.id,name:raw.name,path:current.path,mimeType:item.mimeType,remoteVersion:item.version,sizeBytes:item.sizeBytes}});if(!observed.ok)return fail(observed);const row=observed.entry;
          if(row.completedVersion===item.version&&row.completedHash!==null&&row.fileId!==null)continue;
          const maxBytes=item.mimeType===docs?SOURCE_DOCS_MAX_BYTES:DOCUMENT_EXTRACT_MAX_BYTES;
          const status=item.mimeType.startsWith('image/')?'photo':item.sizeBytes!==null&&item.sizeBytes>maxBytes?'too_large':item.mimeType!==docs&&item.mimeType!=='text/plain'&&item.mimeType!=='text/markdown'&&!(item.mimeType==='application/octet-stream'&&/\.(txt|md)$/i.test(raw.name))?'unsupported':null;
          if(status){const marked=await store.markSourceEntry({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,status,claim:claim()!});if(!marked.ok)return fail(marked);continue;}
          const bytes=await remote.download({id:item.id,docs:item.mimeType===docs,maxBytes});if(!bytes.ok){if(bytes.code==='TOO_LARGE'){const marked=await store.markSourceEntry({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,status:'too_large',claim:claim()!});if(!marked.ok)return fail(marked);continue;}if(bytes.code==='UNREACHABLE'){const marked=await store.markSourceUnreachable({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,claim:claim()!});if(!marked.ok)return fail(marked);continue;}return fail(bytes);}
          const downloadLease=await renew();if(!downloadLease.ok)return fail(downloadLease);
          if(bytes.bytes.length>maxBytes){const marked=await store.markSourceEntry({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,status:'too_large',claim:claim()!});if(!marked.ok)return fail(marked);continue;}
          const latest=await remote.metadata(item.id);if(!latest.ok){if(latest.code==='UNREACHABLE'){const m=await store.markSourceUnreachable({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,claim:claim()!});if(!m.ok)return fail(m);continue;}return fail(latest);}const metadataLease=await renew();if(!metadataLease.ok)return fail(metadataLease);if(latest.item.version!==item.version)return fail({code:'SOURCE_CHANGED',message:'다운로드 중 원격 버전이 변경되었습니다'});
          const contentHash=contentHashOfBytes(bytes.bytes);let tempKey:string|undefined;
          if(deps.temp){tempKey=idGen.next();const prepared=await store.prepareSourceBytes({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,contentHash,tempKey,claim:claim()!});if(!prepared.ok)return fail(prepared);const saved=await deps.temp.write(tempKey,bytes.bytes);if(!saved.ok)return fail({code:'FILES_UNAVAILABLE',message:saved.message});}
          const handoff=await store.handoffSourceFile({sourceId:source.id,generation:source.generation,sourceFileId:row.id,remoteVersion:item.version,fileId:idGen.next(),contentHash,sizeBytes:bytes.bytes.length,workId:idGen.next(),...(tempKey?{tempKey}:{}),claim:claim()!});if(!handoff.ok){if(handoff.code==='FILE_REDACTED')continue;return fail(handoff);}
        }page=list.nextPageToken??undefined;
      }while(page);
    }
    const finalLease=await renew();if(!finalLease.ok)return fail(finalLease);
    const finished=await store.finishSourceScan({sourceId:source.id,generation:source.generation,scanId,claim:claim()!});return finished.ok?{ok:true}:fail(finished);
  };
}
export type { RemoteError };

/** A missing or failed binding lookup is unknown, never proof of orphanhood. */
export async function cleanupSourceTemps(temp:import('../ports/source-remote.js').SourceTemp,store:Pick<SourceStore,'readSourceAttempt'> & Partial<Pick<SourceStore,'recoverSourceAttempt'>>,clock?:Clock):Promise<void> {
  await temp.cleanup(async key=>{try{const r=clock&&store.recoverSourceAttempt?await store.recoverSourceAttempt(key,clock.now()):await store.readSourceAttempt(key);return !r.ok||!r.binding?'unknown':r.binding.open?'open':'preparing' in r.binding&&r.binding.preparing?'preparing':'closed';}catch{return 'unknown';}});
}
