import { CHANNEL_REQUEST_TARGET, CHANNEL_SEND_KIND, type ChannelStore, type ChannelRequest, type ChannelLegacyInput, type ChannelLegacyRecord } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';
import { ensureWork } from './work.js';
import { datasetRef, originalText, projectText } from './original-text.js';

const columns = sql`id, conversation_id as "conversationId", producer, producer_result_id as "producerResultId",
  purpose, revision, body as text, created_at as "createdAt", work_item_id as "workItemId", status,
  external_message_id as "externalMessageId", bundle`;
function request(row: ChannelRequest): ChannelRequest {
  const { bundle, ...rest } = row;
  return { ...rest, createdAt: new Date(row.createdAt), ...(bundle == null ? {} : { bundle }) };
}
function legacyOriginal(r: ChannelLegacyInput | ChannelLegacyRecord): string {
  return JSON.stringify(r.type === 'notification' ? [r.localDate, r.event, r.detail, r.at.toISOString()] : [r.originalId, r.localDate, r.kind, r.event, r.ok, r.reason, r.at.toISOString()]);
}
export function postgresChannelStore(connect: PgConnect): ChannelStore {
  const statuses = async (id?: string) => {
    const opened = connect(); if (!opened.ok) throw Error(opened.message);
    const rows = await sql<import('@second-brain/core').ChannelPublicStatus>`
      select r.id, false as legacy, r.created_at as "createdAt",
        case when r.status='sent' then 'sent' else coalesce(a.outcome,'pending') end as delivery,
        case when r.work_item_id is null then 'unhanded' when w.completed_at is null and w.current_attempt_token is not null then 'running' when w.completed_at is null then 'waiting' else 'closed' end as "workState",
        (select count(*)::int from brain.channel_attempt_results x where x.request_id=r.id) as attempts,
        case when w.completed_at is null then w.next_attempt_at else null end as "nextAttemptAt",
        (select count(*)::int from brain.failures f where f.target_kind='channel_request' and f.target_id=r.id::text and f.stage='channel_send' and f.resolved_at is null) as "unresolvedFailures",
        (r.status <> 'sent' and w.completed_at is not null and (a.outcome in ('unknown','definite_failed') or exists
          (select 1 from brain.failures f where f.target_kind='channel_request' and f.target_id=r.id::text and f.stage='channel_send' and f.resolved_at is null))) as "resendEligible"
      from brain.channel_requests r left join brain.work_items w on w.id=r.work_item_id
      left join lateral (select outcome from brain.channel_attempt_results x where x.request_id=r.id order by x.sequence desc limit 1) a on true
      where (${id ?? null}::uuid is null or r.id=${id ?? null}::uuid)
      union all
      select id,true,at,'legacy','legacy',0,null,0,false from brain.channel_legacy_notifications where (${id ?? null}::uuid is null or id=${id ?? null}::uuid)
      union all
      select id,true,at,'legacy','legacy',0,null,0,false from brain.channel_legacy_deliveries where (${id ?? null}::uuid is null or id=${id ?? null}::uuid)
      order by "createdAt" desc,id`.execute(opened.connection.db);
    return rows.rows.map(row => ({ ...row, createdAt: new Date(row.createdAt), nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt) : null, resendEligible: row.resendEligible ?? false }));
  };
  return {
    async listChannelStatuses() { try { return { ok: true, requests: await statuses() }; } catch (error) { return databaseFailure(error); } },
    async readChannelStatus(id) { try { return { ok: true, request: (await statuses(id))[0] ?? null }; } catch (error) { return databaseFailure(error); } },
    async resendChannelRequest(input) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const result = await withWrite(opened.connection, async held => {
        const found = await sql<{status: string; work_item_id: string | null; completed_at: Date | null; outcome: string | null; failed: boolean}>`
          select r.status,r.work_item_id,w.completed_at,
            (select a.outcome from brain.channel_attempt_results a where a.request_id=r.id order by a.sequence desc limit 1) as outcome,
            exists(select 1 from brain.failures f where f.target_kind='channel_request' and f.target_id=r.id::text and f.stage='channel_send' and f.resolved_at is null) as failed
          from brain.channel_requests r left join brain.work_items w on w.id=r.work_item_id where r.id=${input.requestId} for update of r`.execute(held);
        const row = found.rows[0];
        if (!row) {
          const legacy = await sql`select id from brain.channel_legacy_notifications where id=${input.requestId} union all select id from brain.channel_legacy_deliveries where id=${input.requestId}`.execute(held);
          return { ok: false as const, code: legacy.rows.length ? 'CHANNEL_LEGACY_NOT_RESENDABLE' as const : 'CHANNEL_REQUEST_NOT_FOUND' as const, message: '요청을 재전송할 수 없습니다' };
        }
        if (row.status === 'sent') return { ok: false as const, code: 'CHANNEL_ALREADY_SENT' as const, message: '이미 발신했습니다' };
        if (!row.work_item_id || !row.completed_at) return { ok: false as const, code: 'CHANNEL_REQUEST_IN_PROGRESS' as const, message: '요청이 진행 중입니다' };
        if (!row.failed && row.outcome !== 'unknown' && row.outcome !== 'definite_failed') return { ok: false as const, code: 'CHANNEL_NOT_RESENDABLE' as const, message: '재전송할 수 없는 요청입니다' };
        const work = await ensureWork(held, { id: input.workId, kind: CHANNEL_SEND_KIND, targetKind: CHANNEL_REQUEST_TARGET, targetId: input.requestId, createdAt: input.now, nextAttemptAt: input.now });
        if (!work.created) return { ok: false as const, code: 'CHANNEL_REQUEST_IN_PROGRESS' as const, message: '요청이 진행 중입니다' };
        await sql`update brain.channel_requests set work_item_id=${work.row.id} where id=${input.requestId}`.execute(held);
        return { ok: true as const, workItemId: work.row.id };
      });
      return result.ok ? result.value : result;
    },
    async insertChannelLegacy(input) {
      try {
        const opened = connect(); if (!opened.ok) throw Error(opened.message);
        const db = opened.connection.db;
        const dataset = datasetRef(input.dataset), label = projectText(dataset === input.dataset ? null : input.dataset);
        const originalKey = datasetRef(input.originalKey), keyLabel = projectText(originalKey === input.originalKey ? null : input.originalKey);
        const localDate = projectText(input.localDate), event = projectText(input.event);
        const common = sql`${input.id},${input.conversationId},${input.source},${dataset},${input.originalTable},${originalKey},${input.importBatch}`;
        const pair = (v: [string | null, Buffer | null, string | null]) => sql`${v[0]},${v[1]},${v[2]}`;
        const result = input.type === 'notification'
          ? await sql`insert into brain.channel_legacy_notifications (id,conversation_id,source,dataset,original_table,original_key,import_batch,dataset_label,dataset_label_raw,dataset_label_encoding,original_key_label,original_key_label_raw,original_key_label_encoding,local_date,local_date_raw,local_date_encoding,event,event_raw,event_encoding,detail,detail_raw,detail_encoding,at)
              values (${common},${pair(label)},${pair(keyLabel)},${pair(localDate)},${pair(event)},${pair(projectText(input.detail))},${input.at.toISOString()}) on conflict (dataset,original_table,original_key) do nothing returning id`.execute(db)
          : await sql`insert into brain.channel_legacy_deliveries (id,conversation_id,source,dataset,original_table,original_key,import_batch,dataset_label,dataset_label_raw,dataset_label_encoding,original_key_label,original_key_label_raw,original_key_label_encoding,original_id,original_id_raw,original_id_encoding,local_date,local_date_raw,local_date_encoding,kind,kind_raw,kind_encoding,event,event_raw,event_encoding,ok,reason,reason_raw,reason_encoding,at)
              values (${common},${pair(label)},${pair(keyLabel)},${pair(projectText(input.originalId))},${pair(localDate)},${pair(projectText(input.kind))},${pair(event)},${input.ok},${pair(projectText(input.reason))},${input.at.toISOString()}) on conflict (dataset,original_table,original_key) do nothing returning id`.execute(db);
        const read = await this.readChannelLegacy(input);
        if (!read.ok) return read;
        if (!read.record) throw Error('legacy 조회 실패');
        if (legacyOriginal(input) !== legacyOriginal(read.record)) return { ok: false, code: 'LEGACY_CONFLICT', message: 'legacy 원문 충돌' };
        return { ok: true, created: result.rows.length > 0, record: read.record };
      } catch (error) { return databaseFailure(error); }
    },
    async readChannelLegacy(input) {
      try {
        const opened = connect(); if (!opened.ok) throw Error(opened.message);
        const common = sql`id,conversation_id as "conversationId",source,dataset,dataset_label,dataset_label_raw,dataset_label_encoding,original_table as "originalTable",original_key as "originalKey",original_key_label,original_key_label_raw,original_key_label_encoding,import_batch as "importBatch",local_date,event,at,external_message_id as "externalMessageId",body,metadata_missing as "metadataMissing",resend_eligible as "resendEligible",local_date_raw,local_date_encoding,event_raw,event_encoding`;
        const where = sql`dataset=${datasetRef(input.dataset)} and original_table=${input.originalTable} and original_key=${datasetRef(input.originalKey)}`;
        const result = input.type === 'notification'
          ? await sql<Record<string, unknown>>`select ${common},detail,detail_raw,detail_encoding from brain.channel_legacy_notifications where ${where}`.execute(opened.connection.db)
          : await sql<Record<string, unknown>>`select ${common},original_id,original_id_raw,original_id_encoding,kind,kind_raw,kind_encoding,ok,reason,reason_raw,reason_encoding from brain.channel_legacy_deliveries where ${where}`.execute(opened.connection.db);
        const row = result.rows[0];
        if (!row) return { ok: true, record: null };
        const field = (key: string) => originalText(row[key], row[key + '_raw'], row[key + '_encoding']);
        const commonDto = { id: row.id, conversationId: row.conversationId, source: row.source, dataset: row.dataset_label == null ? row.dataset : field('dataset_label'),
          originalTable: row.originalTable, originalKey: row.original_key_label == null ? row.originalKey : field('original_key_label'), importBatch: row.importBatch,
          localDate: field('local_date'), event: field('event'), at: new Date(row.at as Date),
          externalMessageId: row.externalMessageId, body: row.body, metadataMissing: row.metadataMissing, resendEligible: row.resendEligible };
        const record = input.type === 'notification' ? { ...commonDto, type: input.type, detail: field('detail') }
          : { ...commonDto, type: input.type, originalId: field('original_id'), kind: field('kind'), ok: row.ok, reason: field('reason') };
        return { ok: true, record: record as ChannelLegacyRecord };
      } catch (error) { return databaseFailure(error); }
    },
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
          (id,conversation_id,producer,producer_result_id,purpose,revision,body,created_at,bundle)
          values (${input.id},${input.conversationId},${input.producer},${input.producerResultId},${input.purpose},${input.revision},${input.text},${input.createdAt.toISOString()},${input.bundle ? JSON.stringify(input.bundle) : null}::jsonb)
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
    async listChannelItemResults(requestId) {
      try {
        const opened = connect(); if (!opened.ok) throw Error(opened.message);
        const rows = await sql<{ index: number; result: import('@second-brain/core').ChannelAttemptResult }>`select item_index as index,result from brain.channel_item_results where request_id=${requestId} order by item_index`.execute(opened.connection.db);
        return { ok: true, items: rows.rows };
      } catch (error) { return databaseFailure(error); }
    },
    async recordChannelItemResult(input) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const written = await withWrite(opened.connection, async held => {
        const valid = await sql<{ valid: boolean }>`select brain.attempt_is_current(${input.workItemId}::uuid,${input.attemptToken}::uuid) as valid`.execute(held);
        if (!valid.rows[0]?.valid) return 'lost' as const;
        const result = await sql`insert into brain.channel_item_results(request_id,item_index,work_item_id,attempt_token,result,updated_at)
          select r.id,${input.index},${input.workItemId},${input.attemptToken},${JSON.stringify(input.result)}::jsonb,${input.now.toISOString()} from brain.channel_requests r
          join brain.channel_attempt_results a on a.request_id=r.id and a.work_item_id=${input.workItemId} and a.attempt_token=${input.attemptToken} and a.outcome is null
          where r.id=${input.requestId} and r.work_item_id=${input.workItemId} and r.status='pending' and r.bundle is not null and ${input.index} >= 0 and ${input.index} < jsonb_array_length(r.bundle->'albums')+2
          on conflict(request_id,item_index) do update set work_item_id=excluded.work_item_id,attempt_token=excluded.attempt_token,result=excluded.result,updated_at=excluded.updated_at
          where brain.channel_item_results.result->>'outcome' <> 'sent' returning request_id`.execute(held);
        return result.rows.length ? 'done' as const : 'lost' as const;
      });
      return written.ok ? { ok: true, outcome: written.value } : written;
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
        const complete = await sql<{ result: import('@second-brain/core').ChannelAttemptResult }>`select last.result from brain.channel_requests r
          join brain.channel_item_results last on last.request_id=r.id and last.item_index=jsonb_array_length(r.bundle->'albums')+1
          where r.id=${input.requestId} and r.work_item_id=${input.workItemId} and r.bundle is not null and r.status='pending'
            and (select count(*) from brain.channel_item_results i where i.request_id=r.id and i.result->>'outcome'='sent')=jsonb_array_length(r.bundle->'albums')+2
            and last.result->>'outcome'='sent'`.execute(held);
        const final = complete.rows[0]?.result;
        if (final?.outcome === 'sent') {
          const updated = await sql`update brain.channel_attempt_results set outcome='sent',external_message_id=${final.externalMessageId},finished_at=${input.now.toISOString()}
            where request_id=${input.requestId} and work_item_id=${input.workItemId} and attempt_token=${input.attemptToken} and outcome is null returning request_id`.execute(held);
          if (updated.rows.length) {
            await sql`update brain.channel_requests set status='sent',external_message_id=${final.externalMessageId} where id=${input.requestId}`.execute(held);
            return { outcome: 'ready' as const, result: final };
          }
        }
        const failures = await sql<{ result: import('@second-brain/core').ChannelAttemptResult }>`select i.result from brain.channel_item_results i
          join brain.channel_requests r on r.id=i.request_id and r.work_item_id=i.work_item_id
          where i.request_id=${input.requestId} and i.work_item_id=${input.workItemId} and i.attempt_token=${input.attemptToken}
            and r.status='pending' and r.bundle is not null and i.result->>'outcome' in ('unknown','definite_failed') order by i.item_index limit 1`.execute(held);
        const failure = failures.rows[0]?.result;
        if (failure && failure.outcome !== 'sent') {
          const updated = await sql`update brain.channel_attempt_results set outcome=${failure.outcome},error_code=${failure.code},retryable=${failure.retryable},retry_after_ms=${failure.retryAfterMs ?? null},finished_at=${input.now.toISOString()}
            where request_id=${input.requestId} and work_item_id=${input.workItemId} and attempt_token=${input.attemptToken} and outcome is null returning request_id`.execute(held);
          if (updated.rows.length) return { outcome: 'ready' as const, result: failure };
        }
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
