import { CHANNEL_REQUEST_TARGET, CHANNEL_SEND_KIND, type ChannelStore, type ChannelRequest } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';
import { ensureWork } from './work.js';

const columns = sql`id, conversation_id as "conversationId", producer, producer_result_id as "producerResultId",
  purpose, revision, body as text, created_at as "createdAt", work_item_id as "workItemId", status,
  external_message_id as "externalMessageId"`;
function request(row: ChannelRequest): ChannelRequest {
  return { ...row, createdAt: new Date(row.createdAt) };
}
export function postgresChannelStore(connect: PgConnect): ChannelStore {
  return {
    async ensureChannel(input) {
      try {
        const opened = connect();
        if (!opened.ok) throw Error(opened.message);
        const result = await sql<typeof input>`insert into brain.channels(id,kind,bot_ref)
          values (${input.id},${input.kind},${input.botRef}) on conflict(id) do update set id=excluded.id
          returning id,kind,bot_ref as "botRef"`.execute(opened.connection.db);
        return { ok: true, channel: result.rows[0]! };
      } catch (error) { return databaseFailure(error); }
    },
    async ensureChannelConversation(input) {
      try {
        const opened = connect();
        if (!opened.ok) throw Error(opened.message);
        const result = await sql<typeof input>`insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref)
          values (${input.id},${input.channelId},${input.externalRef},${input.threadRef})
          on conflict(id) do update set id=excluded.id
          returning id,channel_id as "channelId",external_ref as "externalRef",thread_ref as "threadRef"`.execute(opened.connection.db);
        return { ok: true, conversation: result.rows[0]! };
      } catch (error) { return databaseFailure(error); }
    },
    async createChannelRequest(input) {
      try {
        const opened = connect();
        if (!opened.ok) throw Error(opened.message);
        const result = await sql<ChannelRequest>`insert into brain.channel_requests
          (id,conversation_id,producer,producer_result_id,purpose,revision,body,created_at)
          values (${input.id},${input.conversationId},${input.producer},${input.producerResultId},${input.purpose},${input.revision},${input.text},${input.createdAt.toISOString()})
          on conflict do nothing returning ${columns}`.execute(opened.connection.db);
        if (result.rows[0]) return { ok: true, created: true, request: request(result.rows[0]) };
        const found = await sql<ChannelRequest>`select ${columns} from brain.channel_requests
          where producer_result_id=${input.producerResultId} and conversation_id=${input.conversationId}
            and purpose=${input.purpose} and revision is not distinct from ${input.revision}`.execute(opened.connection.db);
        if (!found.rows[0]) throw Error('요청 ID 충돌');
        return { ok: true, created: false, request: request(found.rows[0]) };
      } catch (error) { return databaseFailure(error); }
    },
    async readChannelRequest(id) {
      try {
        const opened = connect();
        if (!opened.ok) throw Error(opened.message);
        const result = await sql<ChannelRequest>`select ${columns} from brain.channel_requests where id=${id}`.execute(opened.connection.db);
        if (!result.rows[0]) return { ok: true, request: null, channel: null, conversation: null };
        const row = request(result.rows[0]);
        const found = await sql<{ id: string; channelId: string; externalRef: string; threadRef: string | null; kind: string; botRef: string }>`
          select v.id,v.channel_id as "channelId",v.external_ref as "externalRef",v.thread_ref as "threadRef",
                 c.kind,c.bot_ref as "botRef" from brain.channel_conversations v
          join brain.channels c on c.id=v.channel_id where v.id=${row.conversationId}`.execute(opened.connection.db);
        const value = found.rows[0]!;
        return { ok: true, request: row,
          conversation: { id: value.id, channelId: value.channelId, externalRef: value.externalRef, threadRef: value.threadRef },
          channel: { id: value.channelId, kind: value.kind, botRef: value.botRef } };
      } catch (error) { return databaseFailure(error); }
    },
    async listUnhandedChannelRequests() {
      try {
        const opened = connect();
        if (!opened.ok) throw Error(opened.message);
        const result = await sql<{ id: string }>`select id from brain.channel_requests
          where work_item_id is null order by created_at,id`.execute(opened.connection.db);
        return { ok: true, requestIds: result.rows.map(row => row.id) };
      } catch (error) { return databaseFailure(error); }
    },
    async handoffChannelRequest(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const result = await withWrite(opened.connection, async held => {
        const found = await sql<{ work_item_id: string | null }>`select work_item_id from brain.channel_requests
          where id=${input.requestId} for update`.execute(held);
        if (!found.rows[0]) return null;
        if (found.rows[0].work_item_id) return found.rows[0].work_item_id;
        const work = await ensureWork(held, { id: input.workId, kind: CHANNEL_SEND_KIND,
          targetKind: CHANNEL_REQUEST_TARGET, targetId: input.requestId, createdAt: input.now, nextAttemptAt: input.now });
        await sql`update brain.channel_requests set work_item_id=${work.row.id} where id=${input.requestId}`.execute(held);
        return work.row.id;
      });
      return result.ok ? { ok: true, workItemId: result.value } : result;
    },
    async gateChannelAttempt(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const result = await withWrite(opened.connection, async held => {
        const found = await sql<{ work_item_id: string | null }>`select work_item_id from brain.channel_requests
          where id=${input.requestId} for update`.execute(held);
        if (found.rows[0]?.work_item_id !== input.workItemId) return 'lost' as const;
        const valid = await sql<{ valid: boolean }>`select brain.attempt_is_current(${input.workItemId}::uuid,${input.attemptToken}::uuid) as valid`.execute(held);
        if (!valid.rows[0]?.valid) return 'lost' as const;
        const inserted = await sql`insert into brain.channel_gates(request_id,work_item_id,attempt_token,created_at)
          values (${input.requestId},${input.workItemId},${input.attemptToken},${input.now.toISOString()})
          on conflict do nothing returning request_id`.execute(held);
        return inserted.rows.length ? 'won' as const : 'already' as const;
      });
      return result.ok ? { ok: true, outcome: result.value } : result;
    },
    async finishChannelAttempt(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const result = await withWrite(opened.connection, async held => {
        const gate = await sql<{ request_id: string }>`select request_id from brain.channel_gates
          where request_id=${input.requestId} and work_item_id=${input.workItemId} and attempt_token=${input.attemptToken}`.execute(held);
        if (!gate.rows[0]) return 'lost' as const;
        const valid = await sql<{ valid: boolean }>`select brain.attempt_is_current(${input.workItemId}::uuid,${input.attemptToken}::uuid) as valid`.execute(held);
        if (!valid.rows[0]?.valid) return 'lost' as const;
        const inserted = await sql`insert into brain.channel_attempt_results(request_id,work_item_id,attempt_token,external_message_id,created_at)
          values (${input.requestId},${input.workItemId},${input.attemptToken},${input.externalMessageId},${input.now.toISOString()})
          on conflict do nothing returning request_id`.execute(held);
        if (!inserted.rows.length) return 'lost' as const;
        await sql`update brain.channel_requests set status='sent',external_message_id=${input.externalMessageId} where id=${input.requestId}`.execute(held);
        return 'done' as const;
      });
      return result.ok ? { ok: true, outcome: result.value } : result;
    },
  };
}
