import { expect,it } from 'vitest';
import { driveMigrationClaimContract,memoryDriveMigrationClaim,sampleWorkInput } from '../src/testing/index.js';
import type { WorkItem } from '../src/index.js';

it('migration claim contract renews a live identity but not stale expired or disconnected fences',async()=>{
 const at=new Date('2026-01-01T00:00:00Z'),base=sampleWorkInput({id:'work',kind:'drive_migrate',targetKind:'file',targetId:'file',createdAt:at,nextAttemptAt:at});
 const work={...base,executionClass:'core',currentAttemptToken:null,serializationKey:null,holdGroup:null,attempts:1,claimedBy:'worker',claimedAt:at,claimExpiresAt:new Date(at.getTime()+600_000),lastError:null,completedAt:null,outcome:null,cancelRequestedAt:null,scheduledOccurrences:null} as WorkItem;
 const source={sourceId:'source',generation:1,connected:true},store=memoryDriveMigrationClaim({work,source});
 await driveMigrationClaimContract(store,{workId:'work',fileId:'file',claimedBy:'worker',claimedAt:at,attempts:1,sourceFence:{sourceId:'source',generation:1}});
});

it('fake migration commit rejects expiry at the injected lock clock and changed fences',async()=>{
 const at=new Date('2026-01-01T00:00:00Z'),base=sampleWorkInput({id:'work',kind:'drive_migrate',targetKind:'file',targetId:'file',createdAt:at,nextAttemptAt:at});
 const work={...base,executionClass:'core',currentAttemptToken:null,serializationKey:null,holdGroup:null,attempts:1,claimedBy:'worker',claimedAt:at,claimExpiresAt:new Date(at.getTime()+600_000),lastError:null,completedAt:null,outcome:null,cancelRequestedAt:null,scheduledOccurrences:null} as WorkItem;
 const source={sourceId:'source',generation:1,connected:true},store=memoryDriveMigrationClaim({work,source});const claim={workId:'work',claimedBy:'worker',claimedAt:at,attempts:1,now:at};
 const input={fileId:'file',expectedHomeId:'local',contentHash:'sha256:synthetic',rootFolderId:'root',remoteId:'remote',locationId:'drive',locator:'synthetic',workId:'delete',verifiedAt:at,dueAt:at,sourceFence:{sourceId:'source',generation:1},migrationClaim:claim};
 expect(await store.commitDriveMigration({...input,migrationClaim:{...claim,nowAtLock:()=>new Date(at.getTime()+600_001)}})).toMatchObject({ok:true,state:'changed'});
 expect(await store.commitDriveMigration({...input,migrationClaim:{...claim,attempts:2}})).toMatchObject({ok:true,state:'changed'});work.cancelRequestedAt=at;expect(await store.commitDriveMigration(input)).toMatchObject({ok:true,state:'changed'});work.cancelRequestedAt=null;source.connected=false;expect(await store.commitDriveMigration(input)).toMatchObject({ok:true,state:'changed'});
});
