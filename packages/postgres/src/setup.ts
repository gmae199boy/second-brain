import type { ChunkParams } from '@second-brain/core';
import type { Pool } from 'pg';
import { createPool, describe, type ConnectionOptions } from './connect.js';

/**
 * The two writes only the installer makes. They are not part of the Store port
 * and no runtime command calls them: one installs an extension, the other seeds
 * the single row the chunking side reads its rules from, and both belong to the
 * same one-off moment as the migrations (AD-20).
 *
 * Both report an unreachable database as a value, never an exception, so the
 * installer can print a line and carry on deciding (Conventions).
 */

/** What the vector capability looks like after `ensureVectorExtension` ran. */
export interface VectorExtension {
  /** Version installed in this database, or `null` when it is not installed. */
  installed: string | null;
  /** Version the server could install, or `null` when it ships none. */
  available: string | null;
  /**
   * Why it is not installed, in one line. Empty when it is. A server that does
   * not ship the extension, and one that ships it but refuses to install it
   * (no superuser, for instance), both land here: the install is not abandoned
   * over it, doctor simply reports the capability as failing.
   */
  reason: string;
}

export type EnsureVectorResult =
  | ({ ok: true } & VectorExtension)
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/**
 * The chunking rules a fresh install starts with. They live in the row, not in
 * code (AD-15); this is only the value the first row is created with.
 */
export const DEFAULT_CHUNK_PARAMS: ChunkParams = {
  targetChars: 1200,
  overlapMessages: 1,
  splitMessagesOverChars: 2400,
};

export interface EnsureDefaultIndexConfigOptions extends ConnectionOptions {
  /** UUIDv7 for the row, minted by the caller (AD-8). */
  id: string;
}

export type EnsureDefaultIndexConfigResult =
  | {
      ok: true;
      /** The row's id: the one that was passed, or the existing row's. */
      id: string;
      /** False when the row was already there, which a re-run always finds. */
      created: boolean;
    }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

interface VectorRow {
  installed: string | null;
  available: string | null;
}

interface IdRow {
  id: string;
}

/**
 * Install the `vector` extension, if the server has it and this database does
 * not. The first migration deliberately does not do this: it must run against
 * a Postgres without pgvector (AD-15), and the image the installer starts ships
 * the extension without installing it in any database. Switching embedding on
 * is a separate decision; this only makes the capability present, which is what
 * doctor's vector check reports.
 */
export async function ensureVectorExtension(
  options: ConnectionOptions,
): Promise<EnsureVectorResult> {
  const pool = createPool(options);
  try {
    const before = await readVector(pool);
    if (before.installed !== null) {
      return { ok: true, ...before, reason: '' };
    }
    if (before.available === null) {
      return {
        ok: true,
        ...before,
        reason: 'the server does not offer the vector extension',
      };
    }

    try {
      await pool.query('create extension if not exists vector');
    } catch (error) {
      // The server has it and would not install it — a permission, not a
      // connection. Report the capability as absent and let the install finish.
      return { ok: true, ...before, reason: describe(error) };
    }

    const after = await readVector(pool);
    return {
      ok: true,
      ...after,
      reason:
        after.installed === null
          ? 'the extension was created but the server does not report it'
          : '',
    };
  } catch (error) {
    return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) };
  } finally {
    // Best effort: the verdict is already decided.
    await pool.end().catch(() => {});
  }
}

/**
 * Make sure the chunk-only index config of a fresh install is there, exactly
 * once. `on conflict do nothing` over the `(kind, model, dimensions,
 * chunk_params)` key is what makes a second run a no-op: jsonb compares by
 * value, not by the order the keys were written in, so the same parameters
 * always collide with the row that is already there.
 *
 * No embedding row is created. That one arrives the day embedding is switched
 * on, with its model and its width (AD-15).
 */
export async function ensureDefaultIndexConfig(
  options: EnsureDefaultIndexConfigOptions,
): Promise<EnsureDefaultIndexConfigResult> {
  const { id, ...connection } = options;
  const params = JSON.stringify(DEFAULT_CHUNK_PARAMS);

  const pool = createPool(connection);
  let outcome: { id: string; created: boolean } | undefined;
  try {
    const inserted = await pool.query<IdRow>(
      `insert into index_configs (id, kind, model, dimensions, chunk_params)
            values ($1, 'chunk', null, null, $2::jsonb)
       on conflict do nothing
         returning id`,
      [id, params],
    );
    const made = inserted.rows[0];
    if (made !== undefined) {
      outcome = { id: made.id, created: true };
    } else {
      const found = await pool.query<IdRow>(
        `select id
           from index_configs
          where kind = 'chunk'
            and model is null
            and dimensions is null
            and chunk_params = $1::jsonb`,
        [params],
      );
      const row = found.rows[0];
      if (row !== undefined) outcome = { id: row.id, created: false };
    }
  } catch (error) {
    return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) };
  } finally {
    await pool.end().catch(() => {});
  }

  if (outcome === undefined) {
    // The insert was refused and the default row is not there, so the id
    // collided with some other row: a caller that reused an id, which is a bug
    // in the caller and not something to paper over (Conventions).
    throw new Error(`index_configs already holds a row with id ${id}`);
  }
  return { ok: true, ...outcome };
}

async function readVector(pool: Pool): Promise<Omit<VectorExtension, 'reason'>> {
  const probe = await pool.query<VectorRow>(
    `select (select extversion
               from pg_extension
              where extname = 'vector') as installed,
            (select default_version
               from pg_available_extensions
              where name = 'vector') as available`,
  );
  const row = probe.rows[0];
  if (row === undefined) {
    // A single-row select that answers with none is not something to guess at.
    throw new Error('the server answered the vector probe with no rows');
  }
  return { installed: row.installed, available: row.available };
}
