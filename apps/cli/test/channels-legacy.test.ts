import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { handoffChannelRequests } from 'second_brain';
import { channelFixture } from './channel-fixture.js';

function child(): ChildProcess {
  return fork(fileURLToPath(new URL('./fixtures/channel/handoff-child.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
}
async function message(process: ChildProcess): Promise<any> {
  const [value] = await once(process, 'message'); return value;
}
async function kill(process: ChildProcess) {
  const closed = once(process, 'close'); process.kill('SIGKILL');
  const [code, signal] = await closed; expect(code).toBeNull(); expect(signal).toBe('SIGKILL');
}

it('legacy 중복과 충돌을 보존하고 두 실제 종료 경계 뒤 같은 대화의 요청을 인계한다', async () => {
  const f = await channelFixture();
  const admin = new pg.Client({ connectionString: f.db.url });
  const children: ChildProcess[] = [];
  try {
    await admin.connect();
    const common = { conversationId: f.input.conversationId, source: 'garmin', dataset: 'dataset-a', importBatch: 'batch-a', localDate: '2026-10-31', at: new Date('2026-10-31T00:00:00Z') };
    const notification = { ...common, id: f.ids.next(), type: 'notification' as const, originalTable: 'notifications', originalKey: 'n1', event: 'steps', detail: '' };
    const delivery = { ...common, id: f.ids.next(), type: 'delivery' as const, originalTable: 'deliveries', originalKey: 'd1', originalId: 'd1', kind: 'telegram', event: null, ok: false, reason: 'offline' };
    for (const item of [notification, delivery]) {
      expect(await f.store.insertChannelLegacy(item)).toMatchObject({ ok: true, created: true, record: { externalMessageId: null, body: null, metadataMissing: true, resendEligible: false, conversationId: f.input.conversationId } });
      expect(await f.store.insertChannelLegacy({ ...item, id: f.ids.next(), importBatch: 'batch-b' })).toMatchObject({ ok: true, created: false, record: { importBatch: 'batch-a' } });
      expect(await f.store.insertChannelLegacy({ ...item, id: f.ids.next(), dataset: 'dataset-b' })).toMatchObject({ ok: true, created: true });
      expect(await f.store.insertChannelLegacy({ ...item, event: 'changed' })).toMatchObject({ ok: false, code: 'LEGACY_CONFLICT' });
      expect(await f.store.readChannelLegacy(item)).toMatchObject({ ok: true, record: item });
    }
    const original = { ...notification, id:f.ids.next(), dataset:'a\0b', originalKey:'k\0x', event:'e\0x', detail:'d\0x' };
    expect(await f.store.insertChannelLegacy(original)).toMatchObject({ok:true,created:true,record:original});
    expect(await f.store.insertChannelLegacy({...original,id:f.ids.next()})).toMatchObject({ok:true,created:false,record:original});
    expect(await f.store.readChannelLegacy(original)).toMatchObject({ok:true,record:original});
    expect(await handoffChannelRequests(f.store, { now: f.now }, f.ids)).toEqual({ ok: true, count: 0 });
    expect(f.requests).toEqual([]);
    expect(await f.db.rows("select id from brain.work_items where kind='channel_send'")).toEqual([]);

    const producer = child(); children.push(producer);
    producer.send!({ operation: 'insert', databaseUrl: f.db.appUrl, input: f.input });
    expect(await message(producer)).toMatchObject({ stage: 'inserted', result: { ok: true, created: true } });
    const producerBackend = (await admin.query("select pid from pg_stat_activity where datname=current_database() and state='idle' and query like 'insert into brain.channel_requests%'")).rows[0]?.pid;
    expect(producerBackend).toBeTypeOf('number');
    await kill(producer);
    await expect.poll(async () => (await admin.query('select pid from pg_stat_activity where pid=$1', [producerBackend])).rowCount, { timeout: 10000 }).toBe(0);
    expect(await f.store.listUnhandedChannelRequests()).toEqual({ ok: true, requestIds: [f.input.id] });

    // 일감 삽입 후 요청 표식 직전에서 트랜잭션을 멈춘다.
    await admin.query(`create function brain.test_handoff_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(153153); return new; end $$;
      create trigger test_handoff_barrier before update of work_item_id on brain.channel_requests for each row execute function brain.test_handoff_barrier()`);
    await admin.query('select pg_advisory_lock(153153)');
    const worker = child(); children.push(worker);
    const workId = f.ids.next();
    worker.send!({ operation: 'handoff', databaseUrl: f.db.appUrl, requestId: f.input.id, workId, now: f.now() });
    expect(await message(worker)).toMatchObject({ stage: 'starting' });
    let backend = 0;
    await expect.poll(async () => {
      const result = await admin.query("select pid from pg_stat_activity where datname=current_database() and wait_event='advisory' and query like 'update brain.channel_requests%'");
      backend = result.rows[0]?.pid ?? 0; return backend;
    }, { timeout: 10000 }).not.toBe(0);
    expect(await f.db.rows("select id from brain.work_items where kind='channel_send'")).toEqual([]);
    expect(await f.db.rows(`select work_item_id from brain.channel_requests where id='${f.input.id}'`)).toEqual([{ work_item_id: null }]);
    await kill(worker);
    await expect.poll(async () => (await admin.query('select pid from pg_stat_activity where pid=$1', [backend])).rowCount, { timeout: 10000 }).toBe(0);
    await admin.query('select pg_advisory_unlock(153153)');
    expect(await f.db.rows("select id from brain.work_items where kind='channel_send'")).toEqual([]);
    expect(await f.db.rows(`select work_item_id from brain.channel_requests where id='${f.input.id}'`)).toEqual([{ work_item_id: null }]);
    const restarted = child(); children.push(restarted);
    restarted.send!({ operation: 'handoff', databaseUrl: f.db.appUrl, requestId: f.input.id, workId, now: f.now() });
    expect(await message(restarted)).toMatchObject({ stage: 'starting' });
    expect(await message(restarted)).toMatchObject({ stage: 'handed', result: { ok: true, workItemId: workId } });
    await once(restarted, 'close');
    expect(await f.db.rows("select id from brain.work_items where kind='channel_send'")).toEqual([{ id: workId }]);
    expect(await f.store.readChannelRequest(f.input.id)).toMatchObject({ request: { id: f.input.id, conversationId: notification.conversationId, workItemId: workId }, conversation: { id: notification.conversationId } });
    expect(await f.store.handoffChannelRequest({ requestId: f.input.id, workId: f.ids.next(), now: f.now() })).toEqual({ ok: true, workItemId: workId });
    expect(f.requests).toEqual([]);
  } finally {
    for (const process of children) if (process.exitCode === null && process.signalCode === null) await kill(process);
    await admin.query('select pg_advisory_unlock(153153)').catch(() => {});
    await admin.end(); await f.close();
  }
}, 30000);
