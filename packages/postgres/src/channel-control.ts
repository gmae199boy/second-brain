import { randomUUID } from 'node:crypto';
import { ensureWork } from './work.js';
import type { ChannelControlStore } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';

function privateFailure(error: unknown) { const failure = databaseFailure(error); return { ...failure, message: '채널 저장소 작업을 완료할 수 없습니다' }; }

export function postgresChannelControl(connect: PgConnect): ChannelControlStore {
  const db = () => { const opened = connect(); if (!opened.ok) throw Error(opened.message); return opened.connection; };
  const routes = () => sql<import('@second-brain/core').ChannelRoute>`select r.topic,c.channel_id as "messengerId",r.conversation_id as "channelId" from brain.channel_routes r join brain.channel_conversations c on c.id=r.conversation_id order by r.topic`.execute(db().db);
  return {
    async inventory() {
      try {
        const messengers = await sql<{ messengerId: string; name: string | null; kind: string; configured: boolean }>`select c.id as "messengerId",n.name,c.kind,(x.messenger_id is not null) as configured from brain.channels c left join brain.messenger_aliases n on n.messenger_id=c.id left join brain.messenger_credentials x on x.messenger_id=c.id order by c.id`.execute(db().db);
        const channels = await sql<{ messengerId: string; channelId: string; name: string | null }>`select c.channel_id as "messengerId",c.id as "channelId",n.name from brain.channel_conversations c left join brain.channel_aliases n on n.conversation_id=c.id order by c.channel_id,c.id`.execute(db().db);
        return { ok: true, messengers: messengers.rows, channels: channels.rows };
      } catch (error) { return privateFailure(error); }
    },
    async configureMessenger(input) {
      try {
        const result = await withWrite(db(), async held => {
          await sql`insert into brain.channels(id,kind,bot_ref) values(${input.messengerId},${input.kind},'messenger:'||${input.messengerId}) on conflict(id) do update set kind=excluded.kind`.execute(held);
          await sql`insert into brain.messenger_credentials(messenger_id,bot_token) values(${input.messengerId},${input.token}) on conflict(messenger_id) do update set bot_token=excluded.bot_token`.execute(held);
          if (input.name) await sql`insert into brain.messenger_aliases(messenger_id,name) values(${input.messengerId},${input.name}) on conflict(messenger_id) do update set name=excluded.name`.execute(held);
          return { ok: true as const, messengerId: input.messengerId };
        });
        return result.ok ? result.value : { ...result, message: '채널 저장소 작업을 완료할 수 없습니다' };
      } catch (error) { return privateFailure(error); }
    },
    async configureChannel(input) {
      try {
        const written = await withWrite(db(), async held => {
          const result = await sql<{ messengerId: string }>`insert into brain.channel_conversations(id,channel_id,user_id,external_ref,thread_ref)
            select ${input.channelId},c.id,${input.userId},${input.chatId},${input.threadId ?? null} from brain.channels c left join brain.messenger_aliases n on n.messenger_id=c.id where (c.id::text=${input.messengerId} or n.name=${input.messengerId})
            on conflict(id) do update set external_ref=excluded.external_ref,thread_ref=excluded.thread_ref
            where brain.channel_conversations.channel_id=excluded.channel_id and brain.channel_conversations.user_id=excluded.user_id returning channel_id as "messengerId"`.execute(held);
          if (!result.rows.length) return { ok: false as const, code: 'INVALID_ARGUMENT', message: '메신저가 없거나 채널 소유권이 다릅니다' };
          const messengerId = result.rows[0]!.messengerId;
          if (input.name) await sql`insert into brain.channel_aliases(conversation_id,messenger_id,name) values(${input.channelId},${messengerId},${input.name}) on conflict(conversation_id) do update set name=excluded.name`.execute(held);
          return { ok: true as const, messengerId, channelId: input.channelId };
        });
        return written.ok ? written.value : { ...written, message: '채널 저장소 작업을 완료할 수 없습니다' };
      } catch (error) { return privateFailure(error); }
    },
    async credentials(messengerId) {
      try { const result = await sql<{ token: string }>`select bot_token as token from brain.messenger_credentials where messenger_id=${messengerId}`.execute(db().db); return { ok: true, token: result.rows[0]?.token ?? null }; }
      catch (error) { return privateFailure(error); }
    },
    async route(input) {
      try {
        if (input.action === 'set') {
          const result = await sql`insert into brain.channel_routes(topic,conversation_id) select ${input.topic!},c.id from brain.channel_conversations c join brain.users u on u.id=c.user_id join brain.channels m on m.id=c.channel_id left join brain.messenger_aliases mn on mn.messenger_id=m.id left join brain.channel_aliases cn on cn.conversation_id=c.id where (m.id::text=${input.messengerId!} or mn.name=${input.messengerId!}) and (c.id::text=${input.channelId!} or cn.name=${input.channelId!}) and u.is_self=1 on conflict(topic) do update set conversation_id=excluded.conversation_id returning topic`.execute(db().db);
          if (!result.rows.length) return { ok: false, code: 'INVALID_ARGUMENT', message: '자기 사용자의 대화가 없습니다' };
        } else if (input.action === 'remove') await sql`delete from brain.channel_routes where topic=${input.topic!}`.execute(db().db);
        return { ok: true, routes: (await routes()).rows };
      } catch (error) { return privateFailure(error); }
    },
    async subscribe(input) {
      try {
        if (input.action === 'set') {
          const result = await sql`insert into brain.channel_subscriptions(event,conversation_id,deliver_at,time_zone)
            select ${input.event!},c.id,${input.at === 'immediate' ? null : input.at ?? null},${input.timeZone ?? null}
            from brain.channel_conversations c join brain.users u on u.id=c.user_id join brain.channels m on m.id=c.channel_id
            left join brain.messenger_aliases mn on mn.messenger_id=m.id left join brain.channel_aliases cn on cn.conversation_id=c.id
            where (m.id::text=${input.messengerId!} or mn.name=${input.messengerId!}) and (c.id::text=${input.channelId!} or cn.name=${input.channelId!}) and u.is_self=1
            on conflict(event) do update set conversation_id=excluded.conversation_id,deliver_at=excluded.deliver_at,time_zone=excluded.time_zone returning id`.execute(db().db);
          if (!result.rows.length) return { ok: false, code: 'INVALID_ARGUMENT', message: '자기 사용자의 대화가 없습니다' };
        } else if (input.action === 'remove') await sql`delete from brain.channel_subscriptions where event=${input.event!}`.execute(db().db);
        const result = await sql<import('@second-brain/core').ChannelSubscription>`select s.id,s.event,c.channel_id as "messengerId",c.id as "channelId",
          coalesce(s.deliver_at,'immediate') as at,brain.subscription_zone(s.id) as "timeZone",
          case when s.time_zone is null then 'user' else 'subscription' end as "timeZoneSource"
          from brain.channel_subscriptions s join brain.channel_conversations c on c.id=s.conversation_id order by s.event`.execute(db().db);
        return { ok: true, subscriptions: result.rows };
      } catch (error) { return privateFailure(error); }
    },
    async send(input) {
      try {
        const result = await withWrite(db(), async held => {
          let destination: string | null = null;
          if (!input.topic) {
            const target = await sql<{ id: string }>`select c.id from brain.channel_conversations c join brain.channels m on m.id=c.channel_id left join brain.messenger_aliases mn on mn.messenger_id=m.id left join brain.channel_aliases cn on cn.conversation_id=c.id join brain.users u on u.id=c.user_id
              where (m.id::text=${input.messengerId!} or mn.name=${input.messengerId!}) and (c.id::text=${input.channelId!} or cn.name=${input.channelId!}) and u.is_self=1`.execute(held);
            destination = target.rows[0]?.id ?? null;
            if (!destination) return { ok: false as const, code: 'INVALID_ARGUMENT', message: '지정한 메신저에 채널이 없습니다' };
          }
          const added = await sql<{ id: string }>`insert into brain.channel_dispatches(id,topic,semantic_key,producer,purpose,body,bundle,direct_conversation_id,send_at,created_at,state)
            values(${input.id},${input.topic ?? 'direct:' + destination},${input.key},'core','message',${input.text},${input.bundle ? JSON.stringify(input.bundle) : null}::jsonb,${destination},${input.sendAt?.toISOString() ?? null},${input.now.toISOString()},'scheduled')
            on conflict(topic,semantic_key) do update set semantic_key=excluded.semantic_key returning id`.execute(held);
          const id = added.rows[0]!.id;
          if (!input.sendAt) await sql`select brain.route_channel_dispatch(${id}::uuid,${input.now.toISOString()}::timestamptz)`.execute(held);
          return { ok: true as const, id };
        });
        return result.ok ? result.value : { ...result, message: '채널 저장소 작업을 완료할 수 없습니다' };
      } catch (error) { return privateFailure(error); }
    },
    async sendPending(input) {
      try {
        const result = await withWrite(db(), async held => {
          let created = 0;
          if (input.event) {
            const events = await sql<{ id: string }>`select id from brain.result_events where event=${input.event}
              and (${input.date ?? null}::date is null or subject_date=${input.date ?? null}::date)
              and (${input.id ?? null}::uuid is null or id=${input.id ?? null}::uuid)
              order by created_at,id`.execute(held);
            for (const event of events.rows) {
              const sent = await sql<{ count: number }>`select brain.dispatch_result_event(${event.id}::uuid,${input.now.toISOString()}::timestamptz,true) as count`.execute(held);
              created += sent.rows[0]!.count;
            }
            // 기존 요청의 닫힌 실패 재개는 topic과 동일한 경로를 따른다.
          }
          const pending = await sql<{ id: string }>`select id from brain.channel_dispatches where topic=${input.topic ?? input.event!} and state='unrouted'
            and (${input.id ?? null}::uuid is null or (case when ${input.event ?? null}::text is null then id else event_id end)=${input.id ?? null}::uuid)
            and (${input.date ?? null}::date is null or (case when ${input.event ?? null}::text is null then (created_at at time zone 'UTC')::date else (select subject_date from brain.result_events e where e.id=event_id) end)=${input.date ?? null}::date)
            order by created_at,id for update`.execute(held);
          let count = created;
          for (const row of pending.rows) { const routed = await sql<{ routed: boolean }>`select brain.route_channel_dispatch(${row.id}::uuid,${input.now.toISOString()}::timestamptz,true) as routed`.execute(held); if (routed.rows[0]?.routed) count++; }
          // Closed failures are operator retries; waiting/running/sent rows remain untouched.
          const failed = await sql<{ id: string }>`select r.id from brain.channel_dispatches d join brain.channel_requests r on r.id=d.id join brain.work_items w on w.id=r.work_item_id
            where d.topic=${input.topic ?? input.event!} and d.state='queued' and r.status='pending' and w.completed_at is not null
              and (${input.id ?? null}::uuid is null or (case when ${input.event ?? null}::text is null then r.id else d.event_id end)=${input.id ?? null}::uuid)
              and (${input.date ?? null}::date is null or (case when ${input.event ?? null}::text is null then (d.created_at at time zone 'UTC')::date else (select subject_date from brain.result_events e where e.id=d.event_id) end)=${input.date ?? null}::date)
              and (exists(select 1 from brain.channel_attempt_results a where a.request_id=r.id and a.outcome in ('unknown','definite_failed'))
                or exists(select 1 from brain.failures f where f.target_kind='channel_request' and f.target_id=r.id::text and f.stage='channel_send' and f.resolved_at is null))
            order by r.id for update of r`.execute(held);
          for (const row of failed.rows) {
            const work = await ensureWork(held, { id: randomUUID(), kind: 'channel_send', targetKind: 'channel_request', targetId: row.id, createdAt: input.now, nextAttemptAt: input.now });
            if (work.created) { await sql`update brain.channel_requests set work_item_id=${work.row.id} where id=${row.id}`.execute(held); count++; }
          }
          return { ok: true as const, count };
        });
        return result.ok ? result.value : { ...result, message: '채널 저장소 작업을 완료할 수 없습니다' };
      } catch (error) { return privateFailure(error); }
    },
    async health() {
      try {
        const result = await sql<{ channels: number; configured: number; routes: number; unrouted: number; scheduled: number; subscriptions: number; archivedEvents: number }>`select
          (select count(*)::int from brain.channels) as channels,(select count(*)::int from brain.messenger_credentials) as configured,
          (select count(*)::int from brain.channel_routes) as routes,(select count(*)::int from brain.channel_dispatches where state='unrouted') as unrouted,
          (select count(*)::int from brain.channel_dispatches where state='scheduled') as scheduled,
          (select count(*)::int from brain.channel_subscriptions) as subscriptions,
          (select count(*)::int from brain.result_events e where not exists(select 1 from brain.channel_dispatches d where d.event_id=e.id)) as "archivedEvents"`.execute(db().db);
        return { ok: true, ...result.rows[0]! };
      } catch (error) { return privateFailure(error); }
    },
  };
}
