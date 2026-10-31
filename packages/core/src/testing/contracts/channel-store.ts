import type { ChannelStore } from '../../channels/store.js';
import type { WorkStore } from '../../ports/store.js';
import { assertEqual, assertOk, assertTrue } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-10-31T00:00:00Z');
export function channelStoreContract(): ContractCase<ChannelStore & WorkStore>[] {
  return [contractCase('channel identity, duplicate request, atomic handoff and attempt fence', async make => withSubject(make, async store => {
    const channel = { id:id(1),kind:'telegram',botRef:'test-bot' };
    const conversation = { id:id(2),channelId:channel.id,externalRef:'chat',threadRef:'thread' };
    assertOk(await store.ensureChannel(channel),'channel'); assertOk(await store.ensureChannelConversation(conversation),'conversation');
    const input = {id:id(3),conversationId:conversation.id,producer:'test',producerResultId:'result',purpose:'notice',revision:null,text:'원문 secret',createdAt:now};
    const inserted=await Promise.all([store.createChannelRequest(input),store.createChannelRequest({...input,id:id(4)})]);
    inserted.forEach(r=>assertOk(r,'insert')); assertEqual(inserted.filter(r=>r.ok && r.created).length,1,'one semantic request');
    const first=inserted[0]!; assertOk(first,'first'); const requestId=first.request.id;
    assertEqual(await store.listUnhandedChannelRequests(),{ok:true,requestIds:[requestId]},'unhanded');
    const handoffs=await Promise.all([store.handoffChannelRequest({requestId,workId:id(5),now}),store.handoffChannelRequest({requestId,workId:id(6),now})]);
    const a=handoffs[0]!; const b=handoffs[1]!; assertOk(a,'handoff'); assertOk(b,'handoff race'); assertTrue(a.workItemId!==null && a.workItemId===b.workItemId,'one work');
    const workItemId=a.workItemId!; assertEqual(await store.listUnhandedChannelRequests(),{ok:true,requestIds:[]},'handoff marked');
    const claim=await store.claimSupervisedWork({now,kinds:['channel_send'],claimedBy:'supervisor',attemptToken:id(7)}); assertOk(claim,'claim'); assertEqual(claim.item?.id,workItemId,'supervised work');
    const gate={requestId,workItemId,attemptToken:id(7),now};
    assertEqual(await store.gateChannelAttempt({...gate,attemptToken:id(8)}),{ok:true,outcome:'lost'},'stale gate');
    assertEqual(await store.gateChannelAttempt(gate),{ok:true,outcome:'won'},'gate won'); assertEqual(await store.gateChannelAttempt(gate),{ok:true,outcome:'already'},'gate once');
    assertEqual(await store.finishChannelAttempt({...gate,attemptToken:id(8),externalMessageId:'42'}),{ok:true,outcome:'lost'},'stale result');
    assertEqual(await store.finishChannelAttempt({...gate,externalMessageId:'42'}),{ok:true,outcome:'done'},'result');
    const read=await store.readChannelRequest(requestId); assertOk(read,'read'); assertEqual(read.channel,channel,'channel preserved'); assertEqual(read.conversation,conversation,'conversation preserved'); assertEqual(read.request,{...input,id:requestId,workItemId,status:'sent',externalMessageId:'42'},'request preserved');
  })), contractCase('성공 응답에 식별자가 없어도 sent를 보존한다', async make => withSubject(make, async store => {
    await store.ensureChannel({ id: id(1), kind: 'telegram', botRef: 'bot' });
    await store.ensureChannelConversation({ id: id(2), channelId: id(1), externalRef: 'chat', threadRef: null });
    await store.createChannelRequest({ id: id(3), conversationId: id(2), producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text: 'text', createdAt: now });
    await store.handoffChannelRequest({ requestId: id(3), workId: id(4), now });
    await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: id(5) });
    const attempt = { requestId: id(3), workItemId: id(4), attemptToken: id(5), now };
    assertEqual(await store.gateChannelAttempt(attempt), { ok: true, outcome: 'won' }, 'gate');
    assertEqual(await store.finishChannelAttempt({ ...attempt, externalMessageId: null }), { ok: true, outcome: 'done' }, '빈 식별자로 성공');
    const read = await store.readChannelRequest(id(3));
    assertOk(read, '요청 읽기');
    assertEqual(read.request?.status, 'sent', '성공 상태');
    assertEqual(read.request?.externalMessageId, null, '식별자 없음');
  }))];
}
