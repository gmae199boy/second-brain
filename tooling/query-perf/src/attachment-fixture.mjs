import { createHash } from 'node:crypto';
export const uuid=s=>{const h=createHash('md5').update(s).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
export const message=uuid('attachment-message');
export const session=uuid('attachment-session');
export const fixtureSpec={version:1,sizes:[1,10,100,1000],conditions:['new','existing','missing'],warmups:1,samples:3};
export function makeAttachments(size,condition) {
 return Array.from({length:size},(_,n)=>{
  const contentHash='sha256:'+createHash('sha256').update(`fixture-file-${n}`).digest('hex');
  return {id:uuid(`attachment-${n}`),harnessMessageId:'fixture-message',ordinal:n,sourceKind:'file',sourceRef:n%2?'reference\ufffd':'reference\u0000',displayName:n%2?'name\ufffd':'name\u0000',file:condition==='missing'?null:{id:uuid(`file-${n}`),contentHash,sizeBytes:n+1,location:{id:uuid(`home-${n}`),storeKind:'local',locator:`brain://${contentHash}`,ownership:'brain'},external:{id:uuid(`external-${n}`),storeKind:'local',locator:`~/synthetic/${n}`,ownership:'external'}}};
 });
}
