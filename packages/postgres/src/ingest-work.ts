import type { AddWorkInput, WorkStore } from '@second-brain/core';
import { sql, type Kysely } from 'kysely';
import { describe, type PgConnect, type PgSchema } from './connect.js';
/** Identity work belongs to session creation's transaction, never a separate queue verb. */
export async function ensureWork(held: Kysely<PgSchema>, input: AddWorkInput): Promise<void> {
  await sql`insert into brain.work_items (id, kind, target_kind, target_id, created_at, attempts, next_attempt_at)
    values (${input.id}, ${input.kind}, ${input.targetKind}, ${input.targetId}, ${input.createdAt.toISOString()}, 0, ${input.nextAttemptAt.toISOString()})
    on conflict (kind, target_kind, target_id) where completed_at is null do nothing`.execute(held);
}

/** Folder scans read open targets without taking a write lock. */
export function postgresOpenWorkStore(connect: PgConnect): Pick<WorkStore, 'listOpenWorkTargets'> {
  return {
    async listOpenWorkTargets(query) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const read = await sql<{ target_kind: string; target_id: string }>`
          select target_kind, target_id from brain.work_items
           where kind = ${query.kind} and completed_at is null`.execute(opened.connection.db);
        return { ok: true, targets: read.rows.map(row => ({ targetKind: row.target_kind, targetId: row.target_id })) };
      } catch (error) { return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) }; }
    },
  };
}
