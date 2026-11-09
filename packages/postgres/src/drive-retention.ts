import { sql, type Kysely } from 'kysely';
import type { PgSchema } from './connect.js';

/** Same advisory key as the session lock held across local delete/disconnect I/O. */
export async function lockDriveRetention(db:Kysely<PgSchema>):Promise<boolean> {
  await sql`select pg_advisory_xact_lock(hashtextextended('brain:drive-delete-disconnect',0))`.execute(db);
  const pending=await sql`select work_id from brain.drive_delete_barriers limit 1`.execute(db);
  if(pending.rows.length)return false;
  await sql`select id from brain.sources where kind='drive' order by id for update`.execute(db);
  return true;
}
/** Always read the self user's current effective DB setting after the barrier. */
export async function currentDriveRetentionDays(db:Kysely<PgSchema>):Promise<number> {
  const row=(await sql<{value:string}>`select value from brain.settings where key='drive.keep_local_days' and (user_id is null or user_id=(select id from brain.users where is_self=1 limit 1)) order by user_id nulls last limit 1`.execute(db)).rows[0];
  const raw=row?.value??'30';if(!/^(0|[1-9][0-9]*)$/.test(raw)||Number(raw)>100_000_000)throw new Error('보관 기간이 유효하지 않습니다');
  return Number(raw);
}
export async function recalculateDriveRetention(db:Kysely<PgSchema>):Promise<void> {
  const days=await currentDriveRetentionDays(db);
  await sql`update brain.drive_retention set due_at=verified_at + ${days} * interval '1 day'`.execute(db);
  await sql`update brain.work_items w set next_attempt_at=r.due_at from brain.drive_retention r where w.kind='drive_local_delete' and w.target_kind='file_location' and w.target_id=r.local_location_id::text and w.completed_at is null and w.cancel_requested_at is null`.execute(db);
}
