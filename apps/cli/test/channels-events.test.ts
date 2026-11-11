import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { provisionExtension } from 'second_brain/postgres';
import { channelFixture } from './channel-fixture.js';
import { runPgCommand } from './pg-home.js';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';

it('CLI 구독은 이벤트부터 가짜 Telegram까지 한 번 발송하고 과거 이벤트는 선택해서만 발송한다', async () => {
  const f = await channelFixture();
  const name = 'x' + randomBytes(5).toString('hex'), role = 'brain_ext_' + name;
  const work = randomUUID(), attempt = randomUUID(), event = name + '.report.completed';
  const cli = async (...args: string[]) => runPgCommand(args, { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home });
  const emit = async (key: string, day = 'current_date') => {
    await f.db.query(`set session authorization "${role}"; select brain.extension_event_emit('${work}','${attempt}','${event}','${key}',${day},null,'synthetic event',null,null); reset session authorization`);
    return (await f.db.rows<{ id: string }>(`select id from brain.result_events where event='${event}' and semantic_key='${key}'`))[0]!.id;
  };
  try {
    await provisionExtension(f.db.url, name, randomBytes(24).toString('hex'));
    await f.db.query(`insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values('${name}','1',now(),true,now()); insert into brain.extension_work_kinds(extension_name,kind) values('${name}','${name}.report')`);
    await f.store.addWork({ id: work, kind: name + '.report', targetKind: 'report', targetId: 'synthetic', createdAt: f.now(), nextAttemptAt: f.now() });
    await f.store.claimSupervisedWork({ now: f.now(), kinds: [name + '.report'], claimedBy: 'producer', attemptToken: attempt });
    const channels = await f.db.rows<{ channel_id: string }>(`select channel_id from brain.channel_conversations where id='${f.input.conversationId}'`);
    const messenger = channels[0]!.channel_id;
    await f.store.channelControl!.configureMessenger({ messengerId: messenger, kind: 'telegram', token: 'test-token' });
    // UTC를 고정하여 실제 날짜 경계에서도 날짜 판정이 일관된다.
    await f.db.query("insert into brain.settings(user_id,key,value,updated_at) select id,'timezone','UTC',now() from brain.users where is_self=1 on conflict(user_id,key) do update set value='UTC'");
    const archived = await emit('unsubscribed');
    expect(await f.db.rows('select * from brain.channel_requests')).toEqual([]);
    const set = await cli('channels', 'subscribe', 'set', event, '--messenger', messenger, '--channel', f.input.conversationId, '--at', '08:20', '--tz', 'Asia/Seoul', '--json');
    expect(set.code, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ data: { subscriptions: [{ event, at: '08:20', timeZone: 'Asia/Seoul' }] } });
    const list = await cli('channels', 'subscribe', 'list'); expect(list.stdout).toContain('08:20 (Asia/Seoul');
    const immediate = await cli('channels', 'subscribe', 'set', event, '--messenger', messenger, '--channel', f.input.conversationId, '--at', 'immediate', '--json');
    expect(JSON.parse(immediate.stdout)).toMatchObject({ ok: true, data: { subscriptions: [{ at: 'immediate', timeZone: 'UTC' }] } });
    for (const args of [
      ['channels','subscribe','set',event,'--messenger',messenger,'--channel',f.input.conversationId,'--at','24:01'],
      ['channels','subscribe','set',event,'--messenger',messenger,'--channel',f.input.conversationId,'--at','08:20','--tz','Bad/Zone'],
      ['channels','send-pending','--event',event,'--topic','human.notes'],
      ['channels','send-pending','--event',event,'--date','2026-02-30'],
    ]) expect((await cli(...args)).code).toBe(2);
    const current = await emit('today'); expect(await emit('today')).toBe(current);
    const past = await emit('past', "'2000-01-02'::date");
    expect(await f.db.rows(`select id from brain.channel_dispatches where event_id in ('${archived}','${past}')`)).toEqual([]);
    await f.start();
    await expect.poll(async () => f.db.rows(`select r.status from brain.channel_requests r join brain.channel_dispatches d on d.id=r.id where d.event_id='${current}'`), { timeout: 15000 }).toEqual([{ status: 'sent' }]);
    expect(f.requests.map(r => r.url.split('/').pop())).toEqual(['sendMessage']);
    // 데몬은 프로세스 없는 생산자 attempt를 회수한다. 재방출 멱등은 시작 전 위에서 확인했다.
    expect(JSON.parse((await cli('channels','send-pending','--event',event,'--id',current,'--json')).stdout)).toMatchObject({ data: { count: 0 } });
    const pending = await cli('channels','send-pending','--event',event,'--date','2000-01-02','--json');
    expect(JSON.parse(pending.stdout)).toMatchObject({ ok: true, data: { count: 1 } });
    await expect.poll(async () => f.db.rows(`select r.status from brain.channel_requests r join brain.channel_dispatches d on d.id=r.id where d.event_id='${past}'`), { timeout: 15000 }).toEqual([{ status: 'sent' }]);
    expect(f.requests).toHaveLength(2);
    expect(JSON.parse((await cli('channels','send-pending','--event',event,'--id',past,'--json')).stdout)).toMatchObject({ data: { count: 0 } });
    const remove = await cli('channels','subscribe','remove',event,'--json');
    expect(JSON.parse(remove.stdout)).toMatchObject({ data: { subscriptions: [] } });
    expect(await f.db.rows(`select id from brain.channel_dispatches where event_id='${archived}'`)).toEqual([]);
  } finally {
    await f.stop();
    await f.db.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(() => {});
    await f.close();
  }
}, 45000);
