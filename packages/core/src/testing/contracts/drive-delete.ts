import type { DriveUploadStore } from '../../ports/drive-store.js';

/** Caller supplies an uploaded mapping with no deletion journal. */
export async function driveDeleteContract(store:DriveUploadStore,input:{rootFolderId:string;contentHash:string;remoteId:string;at:Date}):Promise<void>{
  const absent=await store.markDeleted(input);if(!absent.ok||absent.upload!==null)throw Error('unsubmitted delete was marked');
  const wrong=await store.beginDelete({...input,remoteId:'wrong-id'});if(!wrong.ok||wrong.upload!==null)throw Error('wrong identity accepted');
  const before=await store.submitDelete(input);if(!before.ok||before.upload!==null)throw Error('submission without intent accepted');
  const intent=await store.beginDelete(input);if(!intent.ok||!intent.upload?.deleteIntentAt||intent.upload.deleteSubmittedAt)throw Error('delete intent not recorded');
  const submitted=await store.submitDelete(input);if(!submitted.ok||!submitted.upload?.deleteSubmittedAt)throw Error('delete submission not recorded');
  const marked=await store.markDeleted(input);if(!marked.ok||!marked.upload?.deletedAt)throw Error('delete not marked');
}
