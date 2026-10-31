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
        const found = await sql<{ work_item_id: string | null; status: string }>`select work_item_id,status from brain.channel_requests
          where id=${input.requestId} for update`.execute(held);
        if (found.rows[0]?.work_item_id !== input.workItemId) return 'lost' as const;
        const valid = await sql<{ valid: boolean }>`select brain.attempt_is_current(${input.workItemId}::uuid,${input.attemptToken}::uuid) as valid`.execute(held);
        if (!valid.rows[0]?.valid) return 'lost' as const;
        if (found.rows[0].status === 'sent') return 'sent' as const;
        const existing = await sql`select 1 from brain.channel_attempt_results where request_id=${input.requestId} and attempt_token=${input.attemptToken}`.execute(held);
        if (existing.rows.length) return 'already' as const;
        await sql`insert into brain.channel_gates(request_id,work_item_id,attempt_token,created_at)
          values (${input.requestId},${input.workItemId},${input.attemptToken},${input.now.toISOString()}) on conflict do nothing`.execute(held);
        await sql`insert into brain.channel_attempt_results(request_id,work_item_id,attempt_token,created_at,outcome)
          values (${input.requestId},${input.workItemId},${input.attemptToken},${input.now.toISOString()},null)`.execute(held);
        return 'won' as const;
      });
      return result.ok ? { ok: true, outcome: result.value } : result;
    },
    async recoverChannelAttempt(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const written = await withWrite(opened.connection, async held => {
        const valid = await sql<{ outcome: string | null }>`select a.outcome from brain.work_items w join brain.work_attempts a on a.token=w.current_attempt_token and a.work_item_id=w.id
          where w.id=${input.workItemId} and w.kind='channel_send' and w.target_id=${input.requestId} and w.current_attempt_token=${input.attemptToken} and w.completed_at is null and (a.outcome is null or a.outcome='unknown') for share of w,a`.execute(held);
        if (!valid.rows[0]) return { outcome: 'lost' as const };
        if (valid.rows[0].outcome === null) await sql`update brain.channel_attempt_results set outcome='unknown',error_code='INTERRUPTED',retryable=true,finished_at=${input.now.toISOString()}
          where request_id=${input.requestId} and work_item_id=${input.workItemId} and attempt_token=${input.attemptToken} and outcome is null`.execute(held);
        const read = await sql<{ outcome: 'sent' | 'unknown' | 'definite_failed' | null; external_message_id: string | null; error_code: string | null; retryable: boolean | null; retry_after_ms: string | null }>`select outcome,external_message_id,error_code,retryable,retry_after_ms from brain.channel_attempt_results
          where request_id=${input.requestId} and work_item_id=${input.workItemId} and attempt_token=${input.attemptToken}`.execute(held);
        const row = read.rows[0];
        const result = !row ? null : row.outcome === null ? { outcome: 'unknown' as const, code: 'INTERRUPTED', retryable: true } : row.outcome === 'sent' ? { outcome: 'sent' as const, externalMessageId: row.external_message_id } :
          { outcome: row.outcome, code: row.error_code!, retryable: row.retryable!, ...(row.retry_after_ms === null ? {} : { retryAfterMs: Number(row.retry_after_ms) }) };
        return { outcome: 'ready' as const, result };
      });
      return written.ok ? { ok: true, ...written.value } : written;
    },
    async finishChannelAttempt(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const result = await withWrite(opened.connection, async held => {
        const found = await sql<{ work_item_id: string | null; status: string }>`select work_item_id,status from brain.channel_requests where id=${input.requestId} for update`.execute(held);
        if (found.rows[0]?.work_item_id !== input.workItemId || found.rows[0].status === 'sent') return 'lost' as const;
        const valid = await sql<{ valid: boolean }>`select brain.attempt_is_current(${input.workItemId}::uuid,${input.attemptToken}::uuid) as valid`.execute(held);
        if (!valid.rows[0]?.valid) return 'lost' as const;
        const value = 'result' in input ? input.result : { outcome: 'sent' as const, externalMessageId: input.externalMessageId };
        const changed = await sql`update brain.channel_attempt_results set outcome=${value.outcome},
          external_message_id=${value.outcome === 'sent' ? value.externalMessageId : null},
          error_code=${value.outcome === 'sent' ? null : value.code}, retryable=${value.outcome === 'sent' ? null : value.retryable},
          retry_after_ms=${value.outcome === 'sent' ? null : value.retryAfterMs ?? null}, finished_at=${input.now.toISOString()}
          where request_id=${input.requestId} and work_item_id=${input.workItemId} and attempt_token=${input.attemptToken} and outcome is null returning request_id`.execute(held);
        if (!changed.rows.length) return 'lost' as const;
        if (value.outcome === 'sent') await sql`update brain.channel_requests set status='sent',external_message_id=${value.externalMessageId} where id=${input.requestId}`.execute(held);
        return 'done' as const;
      });
      return result.ok ? { ok: true, outcome: result.value } : result;
    },
  };
}
