import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { sampleSelfUserInput } from '@second-brain/core/testing';
import { database, clock } from './fixture.js';
import { postgresStore, provisionExtension, runMigrations } from '../src/index.js';

async function fixture() {
  const db = await database(), store = postgresStore({ databaseUrl: db.appUrl });
  const admin = new pg.Client({ connectionString: db.url });
  const name = 'x' + randomBytes(5).toString('hex'), password = randomBytes(24).toString('hex'), role = 'brain_ext_' + name;
  await admin.connect();
  await store.ensureSelfUser(sampleSelfUserInput());
  await provisionExtension(db.url, name, password);
  await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values($1,'1',now(),true,now())", [name]);
  const kind = name + '.report', work = randomUUID(), attempt = randomUUID(), m = randomUUID(), c = randomUUID();
  await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values($1,$2)', [name, kind]);
  await store.addWork({ id: work, kind, targetKind: 'report', targetId: 'synthetic', createdAt: clock.now(), nextAttemptAt: clock.now() });
  await store.claimSupervisedWork({ now: clock.now(), kinds: [kind], claimedBy: 'test', attemptToken: attempt });
  await store.ensureChannel({ id: m, kind: 'telegram', botRef: 'synthetic' });
  await store.ensureChannelConversation({ id: c, channelId: m, userId: sampleSelfUserInput().id, externalRef: 'synthetic', threadRef: null });
  const url = new URL(db.url); url.username = role; url.password = password;
  const client = new pg.Client({ connectionString: url.toString() }); await client.connect();
  const event = name + '.report.completed';
  const today = (await admin.query("select (now() at time zone 'Asia/Seoul')::date::text as day")).rows[0].day as string;
  const emit = async (key: string, day = today, token = attempt) => (await client.query('select brain.extension_event_emit($1,$2,$3,$4,$5::date,$6,$7,$8,$9::jsonb) as id', [work, token, event, key, day, 'rev', 'summary', null, null])).rows[0].id as string;
  const subscribe = (at = 'immediate', timeZone?: string) => store.channelControl!.subscribe({ action: 'set', event, messengerId: m, channelId: c, at, timeZone });
  // 고정 시각 정책은 운영 시계와 무관한 합성 이벤트로 검사한다. 실제 방출 ABI는 emit으로 별도 검사한다.
  const insert = async (at: string, day = at.slice(0, 10), requested = false) => {
    const id = randomUUID();
    await admin.query('insert into brain.result_events(id,event,semantic_key,producer,subject_date,revision,body,created_at,requested,source_work_item_id,source_attempt_token) values($1::uuid,$2,$1::text,$3,$4,\'rev\',\'summary\',$5,$6,$7,$8)', [id, event, name, day, at, requested, work, attempt]);
    return id;
  };
  const dispatch = async (id: string) => (await admin.query('select id,state,send_at,subscription_id,direct_conversation_id from brain.channel_dispatches where event_id=$1', [id])).rows;
  return { db, store, admin, client, name, role, password, kind, event, work, attempt, m, c, today, emit, subscribe, insert, dispatch,
    async close() { await client.end(); await store.close(); await admin.query(`drop owned by "${role}"; drop role "${role}"`); await admin.end(); await db.drop(); } };
}

it('이벤트는 미구독·과거를 보관하고 다음 당일 결과만 접수하며 재방출은 멱등이다', async () => {
  const f = await fixture();
  try {
    const archived = await f.emit('unsubscribed');
    expect(await f.dispatch(archived)).toEqual([]);
    expect(await f.subscribe()).toMatchObject({ ok: true, subscriptions: [{ event: f.event, at: 'immediate', timeZone: 'Asia/Seoul', timeZoneSource: 'user' }] });
    expect(await f.emit('unsubscribed')).toBe(archived);
    expect(await f.dispatch(archived)).toEqual([]);
    const current = await f.emit('today');
    expect(await f.dispatch(current)).toMatchObject([{ state: 'queued', send_at: null, direct_conversation_id: f.c }]);
    expect(await f.emit('today')).toBe(current);
    expect(await f.dispatch(current)).toHaveLength(1);
    const past = await f.emit('past', '2000-01-02');
    expect(await f.dispatch(past)).toEqual([]);
    expect(await f.store.channelControl!.health()).toMatchObject({ ok: true, subscriptions: 1, archivedEvents: 2 });
    expect(await f.store.channelControl!.sendPending({ event: f.event, date: '2000-01-02', now: clock.now() })).toEqual({ ok: true, count: 1 });
    expect(await f.store.channelControl!.sendPending({ event: f.event, id: past, now: clock.now() })).toEqual({ ok: true, count: 0 });
    expect(await f.dispatch(past)).toMatchObject([{ state: 'queued' }]);
    expect(await f.dispatch(archived)).toEqual([]);
    expect(await f.store.channelControl!.sendPending({ event: f.event, id: archived, now: clock.now() })).toEqual({ ok: true, count: 1 });
    expect(await f.store.channelControl!.subscribe({ action: 'remove', event: f.event })).toEqual({ ok: true, subscriptions: [] });
    expect(await f.dispatch(await f.emit('removed'))).toEqual([]);
  } finally { await f.close(); }
});

it('현지 시각 전은 당일 예약, 같거나 이후는 즉시이며 기존 예약은 구독 변경·제거와 독립이다', async () => {
  const f = await fixture();
  try {
    await f.subscribe('08:20', 'Asia/Seoul');
    const before = await f.insert('2026-11-10T23:10:00Z', '2026-11-11');
    const row = (await f.dispatch(before))[0]!;
    expect(row).toMatchObject({ state: 'scheduled', send_at: new Date('2026-11-10T23:20:00Z') });
    const status = await f.store.readChannelStatus(row.id);
    expect(status).toMatchObject({ request: { delivery: 'scheduled', nextAttemptAt: new Date('2026-11-10T23:20:00Z') } });
    for (const at of ['2026-11-10T23:20:00Z', '2026-11-10T23:21:00Z']) {
      expect(await f.dispatch(await f.insert(at, '2026-11-11'))).toMatchObject([{ state: 'queued', send_at: null }]);
    }
    expect(await f.dispatch(await f.insert('2026-11-10T23:10:00Z', '2026-11-10'))).toEqual([]);
    await f.subscribe('09:30', 'UTC');
    expect((await f.dispatch(before))[0]).toEqual(row);
    expect(await f.dispatch(await f.insert('2026-11-11T09:00:00Z'))).toMatchObject([{ send_at: new Date('2026-11-11T09:30:00Z') }]);
    await f.store.channelControl!.subscribe({ action: 'remove', event: f.event });
    await f.store.settleSupervisedAttempt({ id: f.work, attemptToken: f.attempt, now: clock.now(), outcome: 'died' });
    expect(await f.store.listUnhandedChannelRequests(new Date('2026-11-10T23:19:59Z'))).toMatchObject({ ok: true });
    expect(await f.store.readChannelStatus(row.id)).toMatchObject({ request: { delivery: 'scheduled' } });
    expect(await f.store.listUnhandedChannelRequests(new Date('2026-11-10T23:20:00Z'))).toMatchObject({ ok: true, requestIds: expect.arrayContaining([row.id]) });
    expect(await f.store.readChannelRequest(row.id)).toMatchObject({ request: { text: 'summary' }, conversation: { id: f.c } });
  } finally { await f.close(); }
});

it('사용자 timezone은 이후 접수에 적용하고 immediate 해제는 새 예약을 만들지 않는다', async () => {
  const f = await fixture();
  try {
    await f.subscribe('08:20');
    await f.store.setSetting({ userId: sampleSelfUserInput().id, key: 'timezone', value: 'America/New_York', updatedAt: clock.now() });
    expect(await f.store.channelControl!.subscribe({ action: 'list' })).toMatchObject({ subscriptions: [{ timeZone: 'America/New_York', timeZoneSource: 'user' }] });
    const winter = await f.insert('2026-11-11T13:10:00Z');
    const summer = await f.insert('2026-07-11T12:10:00Z');
    expect(await f.dispatch(winter)).toMatchObject([{ send_at: new Date('2026-11-11T13:20:00Z') }]);
    expect(await f.dispatch(summer)).toMatchObject([{ send_at: new Date('2026-07-11T12:20:00Z') }]);
    await f.subscribe();
    expect(await f.dispatch(await f.insert('2026-11-11T13:10:00Z'))).toMatchObject([{ state: 'queued', send_at: null }]);
    expect(await f.dispatch(winter)).toMatchObject([{ state: 'scheduled', send_at: new Date('2026-11-11T13:20:00Z') }]);
  } finally { await f.close(); }
});

it('수동 ext run만 core 출처를 고정하며 과거 결과도 요청으로 접수한다', async () => {
  const f = await fixture();
  try {
    await f.subscribe();
    const manualWork = randomUUID(), manualAttempt = randomUUID();
    expect(await f.store.enqueueExtensionWork!({ name: f.name, version: '1', work: { id: manualWork, kind: f.kind, targetKind: 'report', targetId: 'manual', createdAt: clock.now(), nextAttemptAt: clock.now() } })).toMatchObject({ ok: true, state: 'queued' });
    await f.store.claimSupervisedWork({ now: clock.now(), kinds: [f.kind], claimedBy: 'manual', attemptToken: manualAttempt });
    const result = await f.client.query('select brain.extension_event_emit($1,$2,$3,$4,$5::date,null,$6,null,null) as id', [manualWork, manualAttempt, f.event, 'manual', '2000-01-01', 'summary']);
    const id = result.rows[0].id;
    expect(await f.dispatch(id)).toMatchObject([{ state: 'queued' }]);
    expect((await f.admin.query('select requested from brain.result_events where id=$1', [id])).rows).toEqual([{ requested: true }]);
    expect(await f.dispatch(await f.emit('automatic-past', '2000-01-01'))).toEqual([]);
  } finally { await f.close(); }
});

it('확장 이벤트 ABI는 소유 attempt·접두사·파일 권한을 제한하고 직접 표 접근을 거부한다', async () => {
  const f = await fixture();
  try {
    for (const table of ['result_events', 'channel_subscriptions', 'work_manual_requests', 'channel_dispatches']) {
      await expect(f.client.query(`select * from brain.${table}`)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(f.emit('stale', f.today, randomUUID())).rejects.toMatchObject({ code: '42501' });
    const sql = 'select brain.extension_event_emit($1,$2,$3,$4,$5::date,null,$6,$7,$8::jsonb)';
    await expect(f.client.query(sql, [f.work, f.attempt, 'other.report.completed', 'key', f.today, 'summary', null, null])).rejects.toMatchObject({ code: '42501' });
    await expect(f.client.query(sql, [f.work, f.attempt, f.event, 'file', f.today, 'summary', randomUUID(), '[]'])).rejects.toThrow('invalid document');
    await expect(f.client.query(sql, [f.work, f.attempt, f.event, 'albums', f.today, 'summary', null, '[]'])).rejects.toThrow('invalid bundle');
    await expect(f.client.query('select brain.dispatch_result_event($1,now())', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await provisionExtension(f.db.url, f.name, f.password);
  } finally { await f.close(); }
});

it('Garmin 경로 두 개만 immediate 구독으로 이행하고 기존 요청과 나머지 경로는 보존한다', async () => {
  const db = await database(false), admin = new pg.Client({ connectionString: db.url });
  let store: ReturnType<typeof postgresStore> | undefined;
  try {
    await admin.connect();
    expect(await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: 46 })).toMatchObject({ ok: true, to: 46 });
    store = postgresStore({ databaseUrl: db.appUrl }); await store.ensureSelfUser(sampleSelfUserInput());
    const m = randomUUID(), c = randomUUID();
    await store.ensureChannel({ id: m, kind: 'telegram', botRef: 'synthetic' });
    await store.ensureChannelConversation({ id: c, channelId: m, userId: sampleSelfUserInput().id, externalRef: 'synthetic', threadRef: null });
    const held = ['garmin.report', 'garmin.period_report'].map(topic => ({ topic, id: randomUUID() }));
    for (const item of held) {
      expect(await store.channelControl!.send({ id: item.id, topic: item.topic, key: 'held', text: 'summary', now: clock.now() })).toMatchObject({ ok: true });
      expect(await store.readChannelStatus(item.id)).toMatchObject({ request: { delivery: 'unrouted' } });
    }
    for (const topic of ['garmin.report', 'garmin.period_report', 'human.notes']) await store.channelControl!.route({ action: 'set', topic, messengerId: m, channelId: c });
    const request = randomUUID();
    await store.channelControl!.send({ id: request, topic: 'garmin.report', key: 'existing', text: 'summary', now: clock.now(), sendAt: new Date('2099-01-01T00:00:00Z') });
    expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, to: 47 });
    expect(await store.channelControl!.subscribe({ action: 'list' })).toMatchObject({ subscriptions: [{ event: 'garmin.period_report.completed', at: 'immediate' }, { event: 'garmin.report.completed', at: 'immediate' }] });
    expect(await store.channelControl!.route({ action: 'list' })).toMatchObject({ routes: [{ topic: 'human.notes' }] });
    expect(await store.readChannelStatus(request)).toMatchObject({ request: { delivery: 'scheduled', nextAttemptAt: new Date('2099-01-01T00:00:00Z') } });
    expect((await admin.query('select * from brain.result_events')).rows).toEqual([]);
    for (const item of held) {
      expect(await store.readChannelRequest(item.id)).toMatchObject({ request: null });
      expect(await store.readChannelStatus(item.id)).toMatchObject({ request: { delivery: 'unrouted' } });
      expect(await store.channelControl!.sendPending({ topic: item.topic, id: item.id, now: clock.now() })).toEqual({ ok: true, count: 1 });
      expect(await store.readChannelRequest(item.id)).toMatchObject({ conversation: { id: c } });
      expect(await store.channelControl!.sendPending({ topic: item.topic, id: item.id, now: clock.now() })).toEqual({ ok: true, count: 0 });
    }
  } finally { await store?.close(); await admin.end(); await db.drop(); }
});
