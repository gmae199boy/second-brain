import { it } from 'vitest';
import pg from 'pg';
import { channelStoreContract } from '@second-brain/core/testing';
import { subject } from './fixture.js';
for (const test of channelStoreContract()) it(test.name, () => test.run(subject));

import { expect } from 'vitest';
import { postgresStore } from '../src/index.js';
import { database } from './fixture.js';
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
it('독립 생산과 인계를 직렬화하고 오래된 직접 삽입을 거부한다', async () => {
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
it('중단과 실패를 시도별로 기록하고 최초 gate를 보존한다', async () => {
  const db = await database(); const store = postgresStore({ databaseUrl: db.appUrl });
  const now = new Date('2026-10-31T00:00:00Z');
  try {
    await store.ensureChannel({ id: id(1), kind: 'telegram', botRef: 'bot' });
    await store.ensureChannelConversation({ id: id(2), channelId: id(1), externalRef: 'chat', threadRef: null });
    await store.createChannelRequest({ id: id(3), conversationId: id(2), producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text: 'text', createdAt: now });
    await store.handoffChannelRequest({ requestId: id(3), workId: id(4), now });
    for (const n of [5, 6, 7]) {
      await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: id(n) });
      const attempt = { requestId: id(3), workItemId: id(4), attemptToken: id(n), now };
      expect(await store.gateChannelAttempt(attempt)).toEqual({ ok: true, outcome: 'won' });
      if (n === 6) await store.finishChannelAttempt({ ...attempt, result: { outcome: 'definite_failed', code: 'network_before_send', retryable: true } });
      if (n === 7) await store.finishChannelAttempt({ ...attempt, result: { outcome: 'sent', externalMessageId: '42' } });
      if (n === 5) expect(await store.recoverChannelAttempt(attempt)).toMatchObject({ outcome: 'ready', result: { outcome: 'unknown' } });
      if (n !== 7) await store.finishSupervisedWork({ id: id(4), attemptToken: id(n), now, outcome: 'failed', nextAttemptAt: now });
    }
    expect(await db.rows('select attempt_token, outcome, error_code from brain.channel_attempt_results order by attempt_token')).toEqual([
      { attempt_token: id(5), outcome: 'unknown', error_code: 'INTERRUPTED' },
      { attempt_token: id(6), outcome: 'definite_failed', error_code: 'network_before_send' },
      { attempt_token: id(7), outcome: 'sent', error_code: null },
    ]);
    await expect(db.query(`update brain.channel_attempt_results set outcome='sent',external_message_id='forged',error_code=null,retryable=null where attempt_token='${id(5)}'`)).rejects.toMatchObject({ code: 'BRS01' });
    await expect(db.query(`update brain.channel_attempt_results set external_message_id='forged' where attempt_token='${id(7)}'`)).rejects.toMatchObject({ code: 'BRS01' });
    expect(await db.rows('select attempt_token from brain.channel_gates')).toEqual([{ attempt_token: id(5) }]);
  } finally { await store.close(); await db.drop(); }
});
it('토큰을 잃은 진행 중 결과의 직접 변경을 거부한다', async () => {
  const db = await database(); const store = postgresStore({ databaseUrl: db.appUrl }); const now = new Date('2026-10-31T00:00:00Z');
  try {
    await store.ensureChannel({ id: id(1), kind: 'telegram', botRef: 'bot' });
    await store.ensureChannelConversation({ id: id(2), channelId: id(1), externalRef: 'chat', threadRef: null });
    await store.createChannelRequest({ id: id(3), conversationId: id(2), producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text: 'text', createdAt: now });
    await store.handoffChannelRequest({ requestId: id(3), workId: id(4), now });
    await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'old', attemptToken: id(5) });
    await store.gateChannelAttempt({ requestId: id(3), workItemId: id(4), attemptToken: id(5), now });
    await store.finishSupervisedWork({ id: id(4), attemptToken: id(5), now, outcome: 'failed', nextAttemptAt: now });
    await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'new', attemptToken: id(6) });
    const app = new pg.Client({ connectionString: db.appUrl }); await app.connect();
    try { await expect(app.query(`update brain.channel_attempt_results set outcome='sent',external_message_id='forged',finished_at=now() where attempt_token='${id(5)}'`)).rejects.toMatchObject({ code: 'BRS01' }); }
    finally { await app.end(); }
    expect(await db.rows('select outcome,finished_at from brain.channel_attempt_results')).toEqual([{ outcome: null, finished_at: null }]);
  } finally { await store.close(); await db.drop(); }
});
it('종료가 불확실한 시도는 보존하고 종료 확인 뒤 불명 결과를 확정한다', async () => {
  const db = await database(); const store = postgresStore({ databaseUrl: db.appUrl }); const now = new Date('2026-10-31T00:00:00Z');
  try {
    await store.ensureChannel({ id: id(1), kind: 'telegram', botRef: 'bot' });
    await store.ensureChannelConversation({ id: id(2), channelId: id(1), externalRef: 'chat', threadRef: null });
    await store.createChannelRequest({ id: id(3), conversationId: id(2), producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text: 'text', createdAt: now });
    await store.handoffChannelRequest({ requestId: id(3), workId: id(4), now });
    await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'old', attemptToken: id(5) });
    const attempt = { requestId: id(3), workItemId: id(4), attemptToken: id(5), now };
    await store.gateChannelAttempt(attempt);
    await store.settleSupervisedAttempt({ id: id(4), attemptToken: id(5), now, outcome: 'unknown' });
    expect(await db.rows('select outcome,finished_at from brain.channel_attempt_results')).toEqual([{ outcome: null, finished_at: null }]);
    expect(await store.recoverChannelAttempt(attempt)).toMatchObject({ outcome: 'ready', result: { outcome: 'unknown' } });
    expect(await db.rows('select outcome,finished_at from brain.channel_attempt_results')).toEqual([{ outcome: null, finished_at: null }]);
    expect(await store.finishSupervisedWork({ id: id(4), attemptToken: id(5), now, outcome: 'died', confirmedDead: true })).toEqual({ ok: true, outcome: 'done' });
    expect(await db.rows('select outcome,finished_at from brain.channel_attempt_results')).toEqual([{ outcome: 'unknown', finished_at: now }]);
  } finally { await store.close(); await db.drop(); }
});
it('같은 시각의 역순 UUID 시도에서도 마지막 삽입 결과를 읽는다', async () => {
  const db = await database(); const store = postgresStore({ databaseUrl: db.appUrl }); const now = new Date('2026-10-31T00:00:00Z');
  try {
    await store.ensureChannel({ id: id(1), kind: 'telegram', botRef: 'bot' });
    await store.ensureChannelConversation({ id: id(2), channelId: id(1), externalRef: 'chat', threadRef: null });
    await store.createChannelRequest({ id: id(3), conversationId: id(2), producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text: 'text', createdAt: now });
    await store.handoffChannelRequest({ requestId: id(3), workId: id(4), now });
    for (const [token, outcome] of [[id(9), 'definite_failed'], [id(5), 'unknown']] as const) {
      await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: token });
      const attempt = { requestId: id(3), workItemId: id(4), attemptToken: token, now }; await store.gateChannelAttempt(attempt);
      await store.finishChannelAttempt({ ...attempt, result: { outcome, code: 'FAIL', retryable: true } });
      await store.finishSupervisedWork({ id: id(4), attemptToken: token, now, outcome: 'failed', nextAttemptAt: now });
    }
    expect(await store.readChannelStatus(id(3))).toMatchObject({ request: { delivery: 'unknown', attempts: 2 } });
  } finally { await store.close(); await db.drop(); }
});
