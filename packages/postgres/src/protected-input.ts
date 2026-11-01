import { sql, type Kysely } from 'kysely';
import type { PgSchema } from './connect.js';

/** 미시작 전이만 닫는다. 시작된 입력의 폐기는 broker ACK가 선행해야 한다. */
export async function closePendingProtectedInputs(held: Kysely<PgSchema>, group: string): Promise<void> {
  const protectedApi = await sql<{ enabled: boolean }>`select session_user='brain_protected_supervisor'
    and to_regprocedure('brain.close_unstarted_protected_input(uuid,uuid,bigint)') is not null as enabled`.execute(held);
  if (!protectedApi.rows[0]?.enabled) return;
  await sql`select pg_advisory_xact_lock(hashtextextended('brain.protected.auth.revoke',0))`.execute(held);
  const pending = await sql<{ id: string; token: string; attempts: number }>`select w.id,w.current_attempt_token as token,w.attempts
    from brain.work_items w join brain.protected_input_launches l on l.work_id=w.id and l.attempt_token=w.current_attempt_token
    where w.hold_group=${group} and w.completed_at is null and l.state='pending'`.execute(held);
  for (const item of pending.rows)
    await sql`select brain.close_unstarted_protected_input(${item.id}::uuid,${item.token}::uuid,${item.attempts}::bigint)`.execute(held);
}
