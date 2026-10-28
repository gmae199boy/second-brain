import type { AddWorkInput } from '@second-brain/core';
import { sql, type Kysely } from 'kysely';
import type { PgSchema } from './connect.js';
/** Identity work belongs to session creation's transaction, never a separate queue verb. */
export async function ensureWork(held: Kysely<PgSchema>, input: AddWorkInput): Promise<void> {
  await sql`insert into brain.work_items (id, kind, target_kind, target_id, created_at, attempts, next_attempt_at)
    values (${input.id}, ${input.kind}, ${input.targetKind}, ${input.targetId}, ${input.createdAt.toISOString()}, 0, ${input.nextAttemptAt.toISOString()})
    on conflict (kind, target_kind, target_id) where completed_at is null do nothing`.execute(held);
}
