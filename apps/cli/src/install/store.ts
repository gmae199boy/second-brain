import { chmod, mkdir, open, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import {
  SQLITE_SCHEMA_VERSION,
  runDoctor,
  runSqliteMigrations,
  sqliteStore,
  type DoctorReport,
  type SqliteMigrationResult,
} from 'second_brain';
import { runtimeChecks } from '../doctor/checks.js';
import { systemClock } from '../runtime/clock.js';
import { uuidV7IdGen } from '../runtime/id-gen.js';

/**
 * The installer's side of the local source: the database file, the blob root,
 * and the modes they have to end up at. It is the real filesystem, which is why
 * it sits here and not in `flow.ts` — the flow takes these as dependencies and
 * is testable without a disk.
 */

/** The sidecars SQLite's unix VFS puts beside a database in WAL mode. */
const SIDECARS = ['-wal', '-shm'] as const;

/**
 * The first sixteen bytes of every SQLite database file, the header string of
 * the file format. It is the only way to tell a database from somebody else's
 * file before touching it: `open` tells nothing, because SQLite itself only
 * reads the header when a statement runs.
 */
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1');

/**
 * Whether there is a file here, for the screen that asks before anything is
 * written: "a new database" and "the database you already have" are different
 * sentences, and a person agreeing to an install is owed the right one.
 */
export async function storeFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Why this path must not be used as a database, or `undefined` when it may be.
 *
 * It runs before the `open` and the `chmod` of `prepareStore`, and that order
 * is the point: a text file somebody else owns, pointed at by one mistyped
 * `--store-path`, must come back with its mode and its bytes exactly as they
 * were and with no `-wal` beside it. A file of zero bytes is a new database —
 * that is what `open(path,'a')` leaves behind, so a run interrupted between the
 * two has to be able to carry on.
 *
 * Only a file that is not there may fall through to the rest of `prepareStore`.
 * Anything else that cannot be opened or read — a write-only file, a folder, a
 * mode this user cannot read — is refused here: carrying on would `chmod` and
 * migrate a file this code never managed to look at, which is the one thing the
 * check exists to prevent.
 */
async function notADatabase(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (isMissing(error)) return undefined;
    return `${path}를 읽을 수 없어서 SQLite 데이터베이스인지 확인하지 못했습니다. 아무것도 바꾸지 않았습니다: ${describe(error)}`;
  }
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead === 0) return undefined;
    if (bytesRead === SQLITE_HEADER.length && header.equals(SQLITE_HEADER)) return undefined;
    return `${path}는 SQLite 데이터베이스 파일이 아닙니다. 아무것도 바꾸지 않았습니다 — 다른 경로를 주거나 이 파일을 옮기세요.`;
  } catch (error) {
    return `${path}의 앞부분을 읽을 수 없어서 SQLite 데이터베이스인지 확인하지 못했습니다. 아무것도 바꾸지 않았습니다: ${describe(error)}`;
  } finally {
    await handle.close();
  }
}

/** A file that is not there, as opposed to one that could not be opened. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Create the database file if it is not there and bring it up to the version
 * this build ships.
 *
 * The file is created at mode 0600 **before** the migrations run, and that
 * order is the whole point: SQLite's unix VFS gives `-wal` and `-shm` the
 * permissions of the database file, so a file that starts at 0600 never has a
 * moment in which anyone else could read it or its log. The sidecar `chmod`
 * afterwards is a safety net for files an earlier run left behind at another
 * mode; a sidecar that a clean close removed is not an error.
 *
 * The parent folder is created at 0700 for the same reason: a database under a
 * world-readable folder of our own making is our doing.
 */
export async function prepareStore(path: string): Promise<SqliteMigrationResult> {
  // Before the folder is made, before the file is opened, and above all before
  // the `chmod`: a file that is not a database is somebody else's, and this
  // install has no business changing its mode or writing a log beside it.
  const refused = await notADatabase(path);
  if (refused !== undefined) {
    return { ok: false, code: 'DB_UNAVAILABLE', message: refused };
  }

  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // `a`, so an existing database is opened rather than truncated. The mode
    // only applies to a file this call creates, so tighten it either way: a
    // database left at 0644 by hand is one anybody on the machine can read.
    const handle = await open(path, 'a', 0o600);
    try {
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  } catch (error) {
    // The path is a folder, or the folder cannot be made, or the file cannot be
    // opened. Nothing was migrated, which is what `DB_UNAVAILABLE` says.
    return {
      ok: false,
      code: 'DB_UNAVAILABLE',
      message: `데이터베이스 파일을 만들 수 없습니다: ${describe(error)}`,
    };
  }

  const migrated = await runSqliteMigrations({ path });

  for (const suffix of SIDECARS) {
    try {
      await chmod(`${path}${suffix}`, 0o600);
    } catch {
      // Not there: a clean close removes both, and that is the usual case.
    }
  }

  return migrated;
}

/**
 * What `prepareSelfUser` found or made, or why it could not. A failure is a
 * value for the same reason the store's is: the flow has one line to print and
 * an exit code to return.
 */
export type SelfUserResult =
  | {
      ok: true;
      /** The owner's name, for the line the install prints. */
      name: string;
      /** Whether this run is the one that recorded it. */
      created: boolean;
    }
  | { ok: false; code: string; message: string };

/**
 * Record who this brain belongs to, if nobody is recorded yet (AD-12).
 *
 * It is an install step and not a migration because SQL can do neither half of
 * it: a migration cannot read an operating system user name and cannot mint a
 * UUIDv7. It runs straight after the migrations, because the `users` table
 * arrives with one, and before anything can ingest, because `sessions.user_id`
 * is a foreign key into it.
 *
 * An owner that is already there is left exactly as it is — same id, same name.
 * A database carried from another machine keeps the person it was made for, and
 * what to do about a name that no longer matches the machine is epic 5's
 * (Boundaries).
 */
export async function prepareSelfUser(path: string): Promise<SelfUserResult> {
  const store = sqliteStore({ path });
  try {
    const ensured = await store.ensureSelfUser({
      id: uuidV7IdGen().next(),
      // The account the installer is running as. `userInfo` throws on a user
      // with no passwd entry, which the catch below turns into a line.
      name: userInfo().username,
      createdAt: systemClock.now(),
    });
    if (!ensured.ok) return ensured;
    return { ok: true, name: ensured.user.name, created: ensured.created };
  } catch (error) {
    return {
      ok: false,
      code: 'DB_UNAVAILABLE',
      message: `주인을 기록할 수 없습니다: ${describe(error)}`,
    };
  } finally {
    await store.close();
  }
}

/**
 * What `prepareFilesRoot` did, or why it could not. A failure is a value for
 * the same reason the store's is: the flow has one line to print and an exit
 * code to return, and a path that is already an ordinary file — `--store-path
 * <home>/files` on an earlier run, say — must not come out as a stack trace.
 */
export type FilesRootResult =
  | {
      ok: true;
      /** The folder, as it was asked for. */
      path: string;
      /** Whether this call is the one that made it. */
      created: boolean;
    }
  | { ok: false; code: 'FILES_UNAVAILABLE'; message: string };

/**
 * The file store's root, at mode 0700. An existing folder is tightened rather
 * than left as it was found: the blobs under it are the originals of everything
 * the brain ingested, so "somebody already made this one readable" is not a
 * reason to leave it that way (NFR-1). Nothing is written into it here — the
 * `FileStore` port and the blob writes are epic 2's.
 */
export async function prepareFilesRoot(path: string): Promise<FilesRootResult> {
  try {
    const made = await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    // `mkdir` with `recursive` answers with the first directory it created, and
    // with `undefined` when there was nothing to create.
    return { ok: true, path, created: made !== undefined };
  } catch (error) {
    return {
      ok: false,
      code: 'FILES_UNAVAILABLE',
      message: `파일 저장소 루트를 만들 수 없습니다: ${describe(error)}`,
    };
  }
}

/**
 * Doctor against a file the installer chose, not one the configuration names:
 * the installer runs outside the dispatcher, so it builds its own store rather
 * than reading back a folder it may not have written yet.
 *
 * The runtime checks are the dispatcher's own list, over the home being
 * installed — so the last line of an install is the same report
 * `brain doctor run` gives, and a check added to that list is a check the
 * installer runs too.
 */
export async function doctorAt(home: string, path: string): Promise<DoctorReport> {
  const store = sqliteStore({ path });
  try {
    return await runDoctor(store, {
      schemaVersion: SQLITE_SCHEMA_VERSION,
      checks: runtimeChecks({ home }),
    });
  } finally {
    await store.close();
  }
}

/** Whatever went wrong, in one non-empty line (Conventions: no silent failure). */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code: unknown = (error as { code?: unknown }).code;
  const candidates = [error.message, typeof code === 'string' ? code : '', error.name];
  return candidates.find((candidate) => candidate !== '') ?? '알 수 없는 오류';
}
