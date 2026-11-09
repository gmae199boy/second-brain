import { workKindPolicy, type WorkItem } from '../../domain/work-item.js';
import type { DriveMigrationStore } from '../../ports/drive-store.js';

/** Mutable synthetic state has the same identity, expiry and generation fences as PG. */
export function memoryDriveMigrationClaim(options:{work:WorkItem;source?:{sourceId:string;generation:number;connected:boolean}}):Pick<DriveMigrationStore,'renewDriveMigration'|'commitDriveMigration'> {
  const valid=(input:{workId:string;fileId:string;claimedBy:string;claimedAt:Date;attempts:number;now:Date;nowAtLock?:()=>Date;sourceFence?:{sourceId:string;generation:number}})=>{
    const w=options.work,f=input.sourceFence,s=options.source,now=input.nowAtLock?.()??input.now;
    return (!f||!!s?.connected&&s.sourceId===f.sourceId&&s.generation===f.generation)&&w.id===input.workId&&w.kind==='drive_migrate'&&w.targetKind==='file'&&w.targetId===input.fileId&&w.claimedBy===input.claimedBy&&w.claimedAt?.getTime()===input.claimedAt.getTime()&&w.attempts===input.attempts&&w.completedAt===null&&w.cancelRequestedAt===null&&!!w.claimExpiresAt&&w.claimExpiresAt.getTime()>now.getTime();
  };
  return {async renewDriveMigration(input){
    if(!valid(input))return {ok:true,renewed:false};
    const w=options.work,now=input.nowAtLock?.()??input.now;
    if(!w.claimExpiresAt)return {ok:true,renewed:false};
    w.claimExpiresAt=new Date(Math.max(w.claimExpiresAt.getTime(),now.getTime()+workKindPolicy('drive_migrate').claimForMs));return {ok:true,renewed:true};
  },async commitDriveMigration(input){const claim=input.migrationClaim;if(claim&&!valid({...claim,fileId:input.fileId,sourceFence:input.sourceFence}))return {ok:true,state:'changed'};return {ok:true,state:'committed',locationId:input.locationId};}};
}
