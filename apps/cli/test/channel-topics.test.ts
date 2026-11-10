import { expect, it } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';
import { pgRunner } from './pg-home.js';
import { channelFixture } from './channel-fixture.js';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';

const tokenA = '123456789:' + 'A'.repeat(35), tokenB = '987654321:' + 'B'.repeat(35);
async function setup() {
  const f = await channelFixture();
  const cli = async (args: string[], input = '') => {
    let stdout = '', stderr = '';
    const code = await dispatch(commands, [...args, '--json'], { env: { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home }, clock: { now: f.now }, runner: pgRunner, stdin: async () => input, stdout: v => { stdout += v; }, stderr: v => { stderr += v; } });
    expect(stdout + stderr).not.toContain(tokenA); expect(stdout + stderr).not.toContain(tokenB);
    return { code, envelope: JSON.parse(stdout) };
  };
  const messenger = async (name: string, token: string) => {
    const r = await cli(['messengers', 'add', 'telegram', '--name', name, '--token', '-'], token + '\n');
    expect(r.code).toBe(0); return r.envelope.data.messengerId as string;
  };
  const channel = async (messengerId: string, chat: string, name = 'reports') => {
    const r = await cli(['channels', 'add', '--messenger', messengerId, '--chat', chat, '--name', name]);
    expect(r.code).toBe(0); return r.envelope.data.channelId as string;
  };
  return { f, cli, messenger, channel };
}

it('메신저 두 개와 메신저별 같은 이름 채널, topic·직접 발신과 소속 검증, 마스킹', async () => {
  const { f, cli, messenger, channel } = await setup();
  try {
    const a = await messenger('alpha', tokenA), b = await messenger('beta', tokenB);
    const ca = await channel(a, '-1001111111111'), cb = await channel(b, '-1002222222222');
    const extra = await channel(a, '-1003333333333', 'extra');
    expect((await cli(['channels','route','set','test.alpha','--messenger',b,'--channel',ca])).code).toBe(2);
    expect((await cli(['channels','route','set','test.alpha','--messenger','alpha','--channel','reports'])).code).toBe(0);
    expect((await cli(['channels','route','set','test.beta','--messenger','beta','--channel','reports'])).code).toBe(0);
    expect((await cli(['channels','send','--messenger',b,'--channel',extra,'--text','wrong'])).code).toBe(2);
    expect((await cli(['channels','send','--topic','test.alpha','--messenger',a,'--channel',ca,'--text','both'])).code).toBe(2);
    const first = await cli(['channels','send','--topic','test.alpha','--text','alpha','--key','once']); expect(first.code).toBe(0);
    const duplicate = await cli(['channels','send','--topic','test.alpha','--text','alpha','--key','once']); expect(duplicate.envelope.data).toEqual(first.envelope.data);
    expect((await cli(['channels','send','--topic','test.beta','--text','beta'])).code).toBe(0);
    expect((await cli(['channels','send','--messenger',a,'--channel',extra,'--text','extra'])).code).toBe(0);
    const list = await cli(['messengers','list']); expect(list.envelope.data.channels).toEqual(expect.arrayContaining([{ messengerId: a, channelId: ca, name: 'reports' }, { messengerId: b, channelId: cb, name: 'reports' }]));
    const status = await cli(['channels','status',first.envelope.data.id]); expect(status.envelope.data).toMatchObject({ messengerId:a,channelId:ca });
    await f.start(false);
    await expect.poll(() => f.store.listChannelStatuses(), { timeout: 15000 }).toMatchObject({ requests: expect.arrayContaining([expect.objectContaining({id:first.envelope.data.id,delivery:'sent'})]) });
    await expect.poll(() => f.requests.length, { timeout: 15000 }).toBe(3);
    expect(f.requests.map(r => [r.url,JSON.parse(r.body).chat_id])).toEqual(expect.arrayContaining([
      [`/bot${tokenA}/sendMessage`,'-1001111111111'],[`/bot${tokenB}/sendMessage`,'-1002222222222'],[`/bot${tokenA}/sendMessage`,'-1003333333333'],
    ]));
  } finally { await f.close(); }
}, 30000);

it('unrouted는 정상 보관되고 경로 추가 후 자동 발신하지 않으며 send-pending 동시 요청도 한 번만 보낸다', async () => {
  const { f, cli, messenger, channel } = await setup();
  try {
    const accepted = await cli(['channels','send','--topic','test.pending','--text','held']); expect(accepted.code).toBe(0);
    const requestId = accepted.envelope.data.id;
    expect(await f.store.readChannelStatus(requestId)).toMatchObject({request:{delivery:'unrouted'}});
    const m = await messenger('alpha',tokenA), c = await channel(m,'-1001111111111');
    await cli(['channels','route','set','test.pending','--messenger',m,'--channel',c]);
    expect(await f.store.listUnhandedChannelRequests(f.now())).toEqual({ok:true,requestIds:[]});
    expect(f.requests).toHaveLength(0);
    const attempts = await Promise.all([cli(['channels','send-pending','--topic','test.pending','--id',requestId]),cli(['channels','send-pending','--topic','test.pending','--id',requestId])]);
    expect(attempts.map(a=>a.envelope.data.count).sort()).toEqual([0,1]);
    expect((await cli(['channels','send-pending','--topic','test.pending'])).envelope.data.count).toBe(0);
    await f.start(false);
    await expect.poll(() => f.store.readChannelStatus(requestId), { timeout:15000 }).toMatchObject({request:{delivery:'sent'}});
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
}, 30000);

it('예약은 도래 시 경로를 찾고, 도래 시 미경로는 이후에도 자동 발신하지 않는다', async () => {
  const { f, cli, messenger, channel } = await setup();
  try {
    const a=await messenger('alpha',tokenA),b=await messenger('beta',tokenB),ca=await channel(a,'-1001111111111'),cb=await channel(b,'-1002222222222');
    await cli(['channels','route','set','test.future','--messenger',a,'--channel',ca]);
    const at=new Date(f.now().getTime()+3600000).toISOString();
    const future=await cli(['channels','send','--topic','test.future','--text','future','--at',at]);
    const missing=await cli(['channels','send','--topic','test.missing','--text','missing','--at',at]);
    const direct=await cli(['channels','send','--messenger',a,'--channel',ca,'--text','direct future','--at',at]);
    expect(await f.store.listUnhandedChannelRequests(f.now())).toEqual({ok:true,requestIds:[]});
    await cli(['channels','route','set','test.future','--messenger',b,'--channel',cb]);
    f.advance(3600001); await f.start(false);
    await expect.poll(()=>f.store.readChannelStatus(future.envelope.data.id),{timeout:15000}).toMatchObject({request:{delivery:'sent',messengerId:b,channelId:cb}});
    await expect.poll(()=>f.store.readChannelStatus(direct.envelope.data.id),{timeout:15000}).toMatchObject({request:{delivery:'sent',messengerId:a,channelId:ca}});
    expect(await f.store.readChannelStatus(missing.envelope.data.id)).toMatchObject({request:{delivery:'unrouted'}});
    await cli(['channels','route','set','test.missing','--messenger',a,'--channel',ca]);
    expect(await f.store.listUnhandedChannelRequests(f.now())).toEqual({ok:true,requestIds:[]});
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);

it('send-pending은 닫힌 실패만 재개하고 날짜·ID 선택과 sent 재발신 금지를 지킨다', async () => {
  const { f, cli, messenger, channel } = await setup();
  try {
    const m=await messenger('alpha',tokenA),c=await channel(m,'-1001111111111');
    await cli(['channels','route','set','test.retry','--messenger',m,'--channel',c]);
    const r=await cli(['channels','send','--topic','test.retry','--text','retry']);const id=r.envelope.data.id,work=f.ids.next(),token=f.ids.next(),now=f.now();
    await f.store.handoffChannelRequest({requestId:id,workId:work,now});await f.store.claimSupervisedWork({now,kinds:['channel_send'],claimedBy:'test',attemptToken:token});
    const attempt={requestId:id,workItemId:work,attemptToken:token,now};await f.store.gateChannelAttempt(attempt);await f.store.finishChannelAttempt({...attempt,result:{outcome:'definite_failed',code:'TEST',retryable:false}});await f.store.finishSupervisedWork({id:work,attemptToken:token,now,outcome:'failed',failure:{id:f.ids.next(),stage:'channel_send',fingerprint:'synthetic',code:'TEST',message:'synthetic',occurredAt:now}});
    expect((await cli(['channels','send-pending','--topic','test.retry','--date','2020-01-01'])).envelope.data.count).toBe(0);
    expect((await cli(['channels','send-pending','--topic','test.retry','--date',now.toISOString().slice(0,10)])).envelope.data.count).toBe(1);
    expect((await cli(['channels','send-pending','--topic','test.retry','--id',id])).envelope.data.count).toBe(0);
    await f.start(false);await expect.poll(()=>f.store.readChannelStatus(id),{timeout:15000}).toMatchObject({request:{delivery:'sent'}});
    expect((await cli(['channels','send-pending','--topic','test.retry'])).envelope.data.count).toBe(0);expect(f.requests).toHaveLength(1);
    expect((await cli(['channels','send-pending','--topic','test.retry','--date','2026-02-30'])).code).toBe(2);
    expect((await cli(['channels','send','--topic','test.retry','--text','bad time','--at','2026-11-10T12:00:00'])).code).toBe(2);
  } finally { await f.close(); }
},30000);
