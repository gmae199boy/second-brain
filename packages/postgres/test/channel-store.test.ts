import { it } from 'vitest';
import { channelStoreContract } from '@second-brain/core/testing';
import { subject } from './fixture.js';
for (const test of channelStoreContract()) it(test.name, () => test.run(subject));

import { expect } from 'vitest';
import { postgresStore } from '../src/index.js';
import { database } from './fixture.js';
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
it('serializes independent producers and handoffs and fences direct stale inserts', async () => {
  const db=await database(); const a=postgresStore({databaseUrl:db.appUrl}); const b=postgresStore({databaseUrl:db.appUrl});
  try {
    const now=new Date('2026-10-31T00:00:00Z');
    await a.ensureChannel({id:id(1),kind:'telegram',botRef:'bot'});
    await a.ensureChannelConversation({id:id(2),channelId:id(1),externalRef:'chat',threadRef:null});
    const input={id:id(3),conversationId:id(2),producer:'test',producerResultId:'same',purpose:'notice',revision:null,text:'text',createdAt:now};
    const results=await Promise.all([a.createChannelRequest(input),b.createChannelRequest({...input,id:id(4)})]);
    expect(results.filter(x=>x.ok && x.created)).toHaveLength(1);
    const first=results[0]!; if(!first.ok) throw Error(first.message); const requestId=first.request.id;
    const handoffs=await Promise.all([a.handoffChannelRequest({requestId,workId:id(5),now}),b.handoffChannelRequest({requestId,workId:id(6),now})]);
    expect(handoffs[0]).toEqual(handoffs[1]); expect(await db.rows("select id from brain.work_items where kind='channel_send'")).toHaveLength(1);
    const handoff=handoffs[0]!; if(!handoff.ok || !handoff.workItemId) throw Error('handoff failed');
    await expect(db.query(`insert into brain.channel_gates(request_id,work_item_id,attempt_token,created_at) values ('${requestId}','${handoff.workItemId}','${id(7)}',now())`)).rejects.toMatchObject({code:'BRS01'});
    await expect(db.query(`insert into brain.channel_attempt_results(request_id,work_item_id,attempt_token,external_message_id,created_at) values ('${requestId}','${handoff.workItemId}','${id(7)}','42',now())`)).rejects.toMatchObject({code:'BRS01'});
  } finally { await a.close(); await b.close(); await db.drop(); }
});
