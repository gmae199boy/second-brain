import { stat } from 'node:fs/promises';
import { BUSY_TIMEOUT_MS, CASE_INSENSITIVE_HOSTS } from '@second-brain/core';
import { sql, type Kysely } from 'kysely';
import { describe, openSqlite } from './connect.js';
import type { SqliteSchema } from './driver.js';

/**
 * The comparison key of a project, and the one thing migration 0005 cannot do
 * on its own: merge the projects that only differ by case before the key
 * becomes `unique` (AD-12).
 *
 * Two halves, deliberately apart. `findSqliteProjectKeyCollisions` is read-only
 * and runs before anything is written, because the installer has to show the
 * groups and ask. `mergeSqliteProjectKeyCollisions` runs inside the migration's
 * own transaction, immediately before 0005's statements, so the merge and the
 * key either both take effect or neither does: a merge that committed on its
 * own would have deleted rows the user agreed to lose in exchange for a key
 * that is not there.
 */

/**
 * The comparison key, as SQL over a `projects` row.
 *
 * `remote_identity` stays the value a person recognises, spelled the way their
 * remote spells it. This is the value that answers "is this the same
 * repository": GitHub and Bitbucket compare an owner and a repository name
 * without case, so `github.com/Owner/Repo` and `github.com/owner/repo` are one
 * repository under two remotes. Every other host, and every local path, keeps
 * its value byte for byte — folding a case-sensitive host would merge two real
 * repositories, which is the worse mistake and cannot be undone.
 *
 * The same expression is spelled in `0005_identity_and_records.sql`, because a
 * migration file cannot import a constant. That the two agree is held by a
 * test: the groups this finds are exactly the groups 0005's `unique` refuses.
 *
 * SQLite's `lower()` folds ASCII and nothing else, which is enough — GitHub and
 * Bitbucket owner and repository names are ASCII.
 *
 * It names the column bare, so it reads the `projects` row of whatever query it
 * is dropped into. The host list belongs to Core; parity with its ASCII key function is tested.
 */
export const PROJECT_IDENTITY_KEY_SQL = `case
            when ${CASE_INSENSITIVE_HOSTS.map((host) => `lower(remote_identity) glob '${host}/*'`).join(' or ')}
              then lower(remote_identity)
            else remote_identity
          end`;

/**
 * The migration that makes the key a column, and `unique`. A database already
 * at this version has no collisions left to find: the key is enforced there,
 * so a pair that collides cannot be in it.
 *
 * It is a literal and not `SQLITE_SCHEMA_VERSION`: the number this module cares
 * about is the version the key arrived in, which stays 5 forever, while the
 * constant moves with every later migration.
 */
const PROJECT_IDENTITY_KEY_VERSION = 5;

/** One project of a colliding group, as a person needs to see it. */
export interface SqliteProjectKeyCollisionProject {
  id: string;
  /** The remote as it is stored, which is what tells the two apart on screen. */
  remoteIdentity: string;
  /** How many sessions point at this project, so the trade is visible. */
  sessions: number;
}

/** One group of projects that 0005 would fold into a single key. */
export interface SqliteProjectKeyCollision {
  identityKey: string;
  /**
   * The projects of the group, by `id`. A UUIDv7 sorts by the moment it was
   * minted, so the first is the oldest — and the one a merge keeps.
   */
  projects: readonly SqliteProjectKeyCollisionProject[];
}

/**
 * What the finder answers. A database that cannot be opened is a value and not
 * an exception, for the reason every other failure here is: the installer has
 * one line to print and an exit code to return (Conventions).
 */
export type FindSqliteProjectKeyCollisionsResult =
  | { ok: true; groups: readonly SqliteProjectKeyCollision[] }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/**
 * The groups of projects that only differ by comparison key, read without
 * writing anything.
 *
 * It creates no file: a path with nothing at it is answered before anything is
 * opened, and `openSqlite` is called without `create` either way — so the
 * folder is left exactly as it was, with no `brain.db`, no `-wal` and no
 * `-shm`. That matters because the installer calls this before it has agreed to
 * make anything.
 *
 * Three states answer with no groups, and they are all the same answer here:
 * no file, no `projects` table, and a database already at version 5, where the
 * key is enforced and so a colliding pair cannot be in it. A file that is there
 * and cannot be opened is the one failure — that is a database problem, and the
 * installer has `prepareStore` to report it with.
 */
export async function findSqliteProjectKeyCollisions(
  path: string,
  options: { busyTimeoutMs?: number } = {},
): Promise<FindSqliteProjectKeyCollisionsResult> {
  // Before the open, because opening is what would otherwise have to decide
  // whether "could not" means "is not there".
  if (!(await isFile(path))) return { ok: true, groups: [] };

  const opened = openSqlite({
    path,
    busyTimeoutMs: options.busyTimeoutMs ?? BUSY_TIMEOUT_MS.command,
  });
  if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
  const connection = opened.connection;

  try {
    if (!(await hasTable(connection.db, 'projects'))) return { ok: true, groups: [] };
    if ((await storedVersion(connection.db)) >= PROJECT_IDENTITY_KEY_VERSION) {
      return { ok: true, groups: [] };
    }
    return { ok: true, groups: await collisionsIn(connection.db) };
  } catch (error) {
    return {
      ok: false,
      code: 'DB_UNAVAILABLE',
      message: `프로젝트 비교 키를 읽을 수 없습니다: ${describe(error)}`,
    };
  } finally {
    await connection.close().catch(() => {});
  }
}

/**
 * Fold every colliding group into its oldest project, and answer how many
 * groups were folded.
 *
 * It takes the `held` handle of the caller's write transaction and nothing
 * else: it is called from inside `withWrite`, where `connection.db` would wait
 * on a connection the transaction is holding and hang for good (see
 * `withWrite`). The groups are read again in here rather than passed in,
 * because what has to be merged is what the database says now — the finder ran
 * before the lock was taken, and a group that arrived in between is a group
 * 0005 would still refuse.
 *
 * What a merge does, per losing project (Boundaries): a worktree whose path the
 * winner also has gives up its sessions to the winner's row and is deleted, and
 * the kept row's `removed_at` is null when either side's is null and the later
 * of the two otherwise — a folder one checkout still has is not gone. A path the
 * winner does not have simply changes project. Then everything else that
 * pointed at the loser — `sessions.project_id` and
 * `log_entries.apply_project_id`, which are the only other references
 * `projects` has — moves across, and the row goes.
 */
export async function mergeSqliteProjectKeyCollisions(
  held: Kysely<SqliteSchema>,
): Promise<number> {
  const groups = await collisionsIn(held);
  for (const group of groups) {
    const [winner, ...losers] = group.projects;
    // Not reachable: a group is only a group with two or more projects in it.
    if (winner === undefined) continue;
    for (const loser of losers) {
      await mergeOneProject(held, winner.id, loser.id);
    }
  }
  return groups.length;
}

/** One losing project folded into the winner, references first and row last. */
async function mergeOneProject(
  held: Kysely<SqliteSchema>,
  winnerId: string,
  loserId: string,
): Promise<void> {
  const worktrees = await sql<{ id: string; path: string; removed_at: string | null }>`
    select id, path, removed_at from worktrees where project_id = ${loserId} order by id
  `.execute(held);

  for (const worktree of worktrees.rows) {
    const kept = await sql<{ id: string; removed_at: string | null }>`
      select id, removed_at from worktrees
       where project_id = ${winnerId} and path = ${worktree.path}
    `.execute(held);
    const keptRow = kept.rows[0];

    if (keptRow === undefined) {
      // The winner has never seen this folder, so the row keeps its id and its
      // sessions and only changes project. `unique (project_id, path)` is safe
      // because the select above is what says the pair is free.
      await sql`
        update worktrees set project_id = ${winnerId} where id = ${worktree.id}
      `.execute(held);
      continue;
    }

    // The same folder under both projects is one checkout seen twice, so the
    // sessions move and the duplicate row goes.
    await sql`
      update sessions set worktree_id = ${keptRow.id} where worktree_id = ${worktree.id}
    `.execute(held);
    // Canonical instants sort lexicographically, so `>` is "later" (AD-13).
    const removedAt =
      keptRow.removed_at === null || worktree.removed_at === null
        ? null
        : keptRow.removed_at > worktree.removed_at
          ? keptRow.removed_at
          : worktree.removed_at;
    await sql`
      update worktrees set removed_at = ${removedAt} where id = ${keptRow.id}
    `.execute(held);
    await sql`delete from worktrees where id = ${worktree.id}`.execute(held);
  }

  await sql`
    update sessions set project_id = ${winnerId} where project_id = ${loserId}
  `.execute(held);
  await sql`
    update log_entries set apply_project_id = ${winnerId} where apply_project_id = ${loserId}
  `.execute(held);
  await sql`delete from projects where id = ${loserId}`.execute(held);
}

/**
 * Every project with its comparison key and its session count, grouped by the
 * key, with the groups of one dropped.
 *
 * Ordered by the key and then by `id`, which is both halves of the promised
 * order and what lets the grouping be a single walk: the rows of one key arrive
 * together, oldest first.
 */
async function collisionsIn(
  db: Kysely<SqliteSchema>,
): Promise<readonly SqliteProjectKeyCollision[]> {
  const found = await sql<{
    id: string;
    remote_identity: string;
    identity_key: string;
    sessions: number;
  }>`
    select p.id as id,
           p.remote_identity as remote_identity,
           ${sql.raw(PROJECT_IDENTITY_KEY_SQL)} as identity_key,
           (select count(*) from sessions s where s.project_id = p.id) as sessions
      from projects p
     order by identity_key, p.id
  `.execute(db);

  const groups: { identityKey: string; projects: SqliteProjectKeyCollisionProject[] }[] = [];
  for (const row of found.rows) {
    const project = {
      id: row.id,
      remoteIdentity: row.remote_identity,
      sessions: row.sessions,
    };
    const last = groups.at(-1);
    if (last !== undefined && last.identityKey === row.identity_key) {
      last.projects.push(project);
      continue;
    }
    groups.push({ identityKey: row.identity_key, projects: [project] });
  }
  return groups.filter((group) => group.projects.length > 1);
}

/** Whether there is a file here at all. A folder is not one. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Whether a table is there, which is how an older schema is told apart. */
async function hasTable(db: Kysely<SqliteSchema>, name: string): Promise<boolean> {
  const present = await sql<{ name: string }>`
    select name from sqlite_master where type = 'table' and name = ${name}
  `.execute(db);
  return present.rows.length > 0;
}

/** The stored schema version, or `0` when the table is not there yet. */
async function storedVersion(db: Kysely<SqliteSchema>): Promise<number> {
  if (!(await hasTable(db, 'schema_version'))) return 0;
  const stored = await sql<{ version: number }>`select version from schema_version`.execute(db);
  return stored.rows[0]?.version ?? 0;
}
