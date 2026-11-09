import type { DriveMigrationStore } from '../../ports/drive-store.js';

/** The caller supplies a claim initially expiring ten minutes after claimedAt. */
export async function driveMigrationClaimContract(store:Pick<DriveMigrationStore,'renewDriveMigration'>,input:{workId:string;fileId:string;claimedBy:string;claimedAt:Date;attempts:number;sourceFence:{sourceId:string;generation:number}}):Promise<void>{
  const check=async(now:Date,extra:Partial<typeof input>,expected:boolean)=>{const result=await store.renewDriveMigration({...input,...extra,now});if(!result.ok||result.renewed!==expected)throw Error('migration claim contract');};
  const time=(minutes:number)=>new Date(input.claimedAt.getTime()+minutes*60_000);
  await check(time(1),{claimedBy:'stale-owner'},false);await check(time(1),{attempts:input.attempts+1},false);await check(time(1),{sourceFence:{...input.sourceFence,generation:input.sourceFence.generation+1}},false);
  const delayed=await store.renewDriveMigration({...input,now:time(1),nowAtLock:()=>time(11)});if(!delayed.ok||delayed.renewed)throw Error('expired lock wait was revived');
  await check(time(9),{},true);await check(time(18),{},true);await check(time(29),{},false);
}
