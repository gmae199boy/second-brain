import { sql, type Kysely } from 'kysely';
import { databaseFailure, type PgConnection, type PgSchema } from './connect.js';
export type WriteResult<T> = { ok: true; value: T } | ReturnType<typeof databaseFailure>;
/** All runtime writes commit together; an interrupted commit is safe to replay. */
export async function withWrite<T>(connection: PgConnection, work: (held: Kysely<PgSchema>) => Promise<T>, key?: string): Promise<WriteResult<T>> {
  try {
    const value = await connection.db.transaction().execute(async held => {
      if (key !== undefined) await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(held);
      return work(held);
    });
    return { ok: true, value };
  } catch (error) { return databaseFailure(error); }
}
