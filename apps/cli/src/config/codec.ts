import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import type { WarningCode } from 'second_brain';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { configFilePath, envFilePath } from './paths.js';

/**
 * The one place configuration is read and written, installer included (AD-18).
 * `config.toml` holds no key values: a key value lives in `.env` at mode 0600,
 * and until an epic introduces one there is no key to read — which is why this
 * module writes `.env` and no longer reads it.
 *
 * Nothing here runs at import time (AD-3): a command calls `readConfig`, and
 * until it does, no file is touched.
 */

/** Version of the configuration file layout this code understands. */
export const CONFIG_SCHEMA_VERSION = 1;

/** Default display time zone. Only human-readable output uses it (Conventions). */
export const DEFAULT_TIMEZONE = 'Asia/Seoul';

/**
 * The v1 keys, as they are spelled in the file. A story that needs another key
 * adds it here and nowhere else; anything not on this list is reported, never
 * dropped in silence (AD-18).
 */
export const KNOWN_KEYS = [
  'schema_version',
  'timezone',
  'store.path',
  'files.path',
  'mirror.path',
] as const;

/** File name of the default source database, under the configuration folder. */
export const DEFAULT_STORE_FILE = 'brain.db';

/** Folder name of the default file store, under the configuration folder. */
export const DEFAULT_FILES_FOLDER = 'files';

/** Folder name of the default mirror, under the configuration folder. */
export const DEFAULT_MIRROR_FOLDER = 'mirror';

/**
 * Where the source database goes when the file does not say. Relative to the
 * configuration folder, so a second install never writes into the first one's
 * database. Nothing here creates the file: that is the installer's (AD-20).
 */
export function defaultStorePath(home: string): string {
  return join(home, DEFAULT_STORE_FILE);
}

/**
 * Where blobs go when the file does not say. Relative to the configuration
 * folder, for the same reason. Nothing here creates the folder.
 */
export function defaultFilesPath(home: string): string {
  return join(home, DEFAULT_FILES_FOLDER);
}

/**
 * Where the mirror goes when the file does not say. Relative to the
 * configuration folder, so a second install never writes into the first one's
 * mirror. Nothing here creates the folder: that is epic 4's.
 */
export function defaultMirrorPath(home: string): string {
  return join(home, DEFAULT_MIRROR_FOLDER);
}

/** The configuration a command runs with. Flat, resolved, and already checked. */
export interface BrainConfig {
  /** Layout version of the file it came from. Always `CONFIG_SCHEMA_VERSION`. */
  schemaVersion: number;
  /** IANA time zone for human-readable output. */
  timezone: string;
  /** Absolute path of the source database file. Opened, never created (AD-20). */
  storePath: string;
  /** Absolute path of the file store's root. Nothing here creates it (epic 2). */
  filesPath: string;
  /** Absolute path of the mirror folder. Nothing here creates it (epic 4). */
  mirrorPath: string;
}

/** A problem that does not stop the command: it travels in `warnings[]`. */
export interface ConfigWarning {
  code: WarningCode;
  /** One line a human can act on, naming the key. */
  message: string;
}

export type ReadConfigResult =
  | { ok: true; config: BrainConfig; warnings: readonly ConfigWarning[] }
  | {
      ok: false;
      /** Nothing to read: the installer has not run here. */
      code: 'CONFIG_MISSING';
      message: string;
    }
  | {
      ok: false;
      /** There is a file, and it cannot be understood. */
      code: 'CONFIG_INVALID';
      message: string;
    };

/**
 * Read the configuration folder. The TOML must be there and be understandable,
 * and every path it names must be absolute. There is no running without a
 * file: a missing `config.toml` means the installer has not run, and guessing
 * would hide that.
 *
 * `.env` is not read. Every key this version knows is a path or a time zone, so
 * there is nothing in `.env` to resolve — and reading it anyway would let a
 * broken `.env` turn every command into `CONFIG_INVALID` over a file nothing
 * needs yet. The epic that introduces a key puts the reading back.
 */
export async function readConfig(home: string): Promise<ReadConfigResult> {
  const configPath = configFilePath(home);

  const source = await readTextFile(configPath);
  if (source.state === 'missing') {
    return {
      ok: false,
      code: 'CONFIG_MISSING',
      message: `${configPath}이 없습니다. 설치기나 \`brain setup run\`을 실행하세요.`,
    };
  }
  if (source.state === 'unreadable') {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}을 읽을 수 없습니다: ${source.message}`,
    };
  }

  let document: unknown;
  try {
    document = parseToml(source.text);
  } catch (error) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}을 TOML로 읽을 수 없습니다: ${oneLine(error)}`,
    };
  }
  if (!isTable(document)) {
    return { ok: false, code: 'CONFIG_INVALID', message: `${configPath}: TOML 테이블이 아닙니다` };
  }

  const fields = flatten(document);
  const warnings = unknownKeyWarnings(configPath, fields);

  const schemaVersion = fields.get('schema_version');
  if (schemaVersion === undefined) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: schema_version이 없습니다. schema_version = ${String(CONFIG_SCHEMA_VERSION)}이어야 합니다.`,
    };
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: schema_version은 정수여야 하는데 ${kindOf(schemaVersion)}입니다`,
    };
  }
  if (schemaVersion !== CONFIG_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: schema_version ${String(schemaVersion)}은 지원하지 않습니다. 이 코드가 읽는 것은 ${String(CONFIG_SCHEMA_VERSION)}입니다.`,
    };
  }

  const timezone = fields.get('timezone') ?? DEFAULT_TIMEZONE;
  if (typeof timezone !== 'string' || timezone === '') {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: timezone은 비어 있지 않은 문자열이어야 하는데 ${kindOf(timezone)}입니다`,
    };
  }
  if (!isTimeZone(timezone)) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: timezone "${timezone}"은 이 기계가 아는 시간대가 아닙니다`,
    };
  }

  const storePath = readPath(configPath, fields, 'store.path', defaultStorePath(home));
  if (!storePath.ok) return storePath.failure;
  const filesPath = readPath(configPath, fields, 'files.path', defaultFilesPath(home));
  if (!filesPath.ok) return filesPath.failure;
  const mirrorPath = readPath(configPath, fields, 'mirror.path', defaultMirrorPath(home));
  if (!mirrorPath.ok) return mirrorPath.failure;

  return {
    ok: true,
    config: {
      schemaVersion,
      timezone,
      storePath: storePath.path,
      filesPath: filesPath.path,
      mirrorPath: mirrorPath.path,
    },
    warnings,
  };
}

/**
 * One path key, checked the same way as the others.
 *
 * Absolute only. A relative path would mean a different place for every working
 * directory a command happens to be started from, so the database a hook writes
 * and the database the user greps would not be the same one.
 */
function readPath(
  configPath: string,
  fields: ReadonlyMap<string, unknown>,
  key: string,
  fallback: string,
): { ok: true; path: string } | { ok: false; failure: ReadConfigResult } {
  const value = fields.get(key) ?? fallback;
  if (typeof value !== 'string' || value === '') {
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'CONFIG_INVALID',
        message: `${configPath}: ${key}는 비어 있지 않은 문자열이어야 하는데 ${kindOf(value)}입니다`,
      },
    };
  }
  if (!isAbsolute(value)) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'CONFIG_INVALID',
        message: `${configPath}: ${key} "${value}"는 절대 경로여야 합니다`,
      },
    };
  }
  return { ok: true, path: value };
}

/** What `writeConfig` records. Everything left out keeps its default. */
export interface WriteConfigInput {
  timezone?: string;
  /** Absolute. Left out means `defaultStorePath(home)`, as reading does. */
  storePath?: string;
  /** Absolute. Left out means `defaultFilesPath(home)`, as reading does. */
  filesPath?: string;
  /** Absolute. Left out means `defaultMirrorPath(home)`, as reading does. */
  mirrorPath?: string;
}

/**
 * Write the configuration folder, creating it when needed. `.env` keeps the
 * variables already in it, so re-running the installer does not drop a key some
 * later story put there, and it ends up at mode 0600 whether it was just
 * created or already existed — there is no key to write into it yet, and the
 * mode rule has to hold before there is one rather than after.
 */
export async function writeConfig(home: string, input: WriteConfigInput): Promise<void> {
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const storePath = input.storePath ?? defaultStorePath(home);
  const filesPath = input.filesPath ?? defaultFilesPath(home);
  const mirrorPath = input.mirrorPath ?? defaultMirrorPath(home);
  // The same checks `readConfig` makes, made here as well: a folder this codec
  // wrote must be one it can read back.
  if (!isTimeZone(timezone)) {
    throw new Error(`${timezone} is not a time zone this machine knows`);
  }
  for (const [key, path] of [
    ['store.path', storePath],
    ['files.path', filesPath],
    ['mirror.path', mirrorPath],
  ] as const) {
    if (!isAbsolute(path)) {
      throw new Error(`${key} ${path} is not an absolute path`);
    }
  }

  await mkdir(home, { recursive: true, mode: 0o700 });

  const envPath = envFilePath(home);
  const existing = await readTextFile(envPath);
  const values: Record<string, string | undefined> =
    existing.state === 'read' ? { ...parseEnv(existing.text) } : {};

  // Both files are rendered before either is written, so a value `.env` cannot
  // represent fails with nothing written rather than leaving half a folder
  // behind for `readConfig` to call incomplete.
  const document = stringifyToml({
    schema_version: CONFIG_SCHEMA_VERSION,
    timezone,
    store: { path: storePath },
    files: { path: filesPath },
    mirror: { path: mirrorPath },
  });
  const lines = Object.entries(values).flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}=${quote(name, value)}`],
  );

  await writeFile(
    configFilePath(home),
    `# Personal Brain 설정. 키 값은 여기가 아니라 .env에 있습니다.\n${document}\n`,
    'utf8',
  );
  // The mode is set at creation, so a secret is never briefly world-readable.
  await writeFile(
    envPath,
    `# brain이 쓴 파일입니다. 키 값은 config.toml이 아니라 여기에 있고, 저장소에는 들어가지 않습니다.\n${lines.join('\n')}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  // `writeFile`'s mode only applies to a file it creates, so tighten an
  // existing one too.
  await chmod(envPath, 0o600);
}

/**
 * `.env` as Node reads it has no escape syntax, so a value is quoted with
 * whichever quote it does not contain. A value holding both cannot be written
 * back faithfully, and a codec that cannot round-trip a value must say so
 * rather than record something else.
 */
function quote(name: string, value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new Error(
    `${name} holds both a single and a double quote, which .env cannot represent`,
  );
}

type TextFile =
  | { state: 'read'; text: string }
  | { state: 'missing' }
  | { state: 'unreadable'; message: string };

/** A file that is not there is a state, not a failure; anything else is. */
async function readTextFile(path: string): Promise<TextFile> {
  try {
    return { state: 'read', text: await readFile(path, 'utf8') };
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
      return { state: 'missing' };
    }
    return { state: 'unreadable', message: oneLine(error) };
  }
}

/** Every key of the document as a dotted path, so one table covers them all. */
function flatten(table: Record<string, unknown>, prefix = ''): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  for (const [key, value] of Object.entries(table)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isTable(value)) {
      for (const [inner, innerValue] of flatten(value, path)) {
        fields.set(inner, innerValue);
      }
      // Record the empty table too, so `[colour]` with nothing in it is still
      // reported as a key this version does not know.
      if (Object.keys(value).length === 0) fields.set(path, value);
      continue;
    }
    fields.set(path, value);
  }
  return fields;
}

function unknownKeyWarnings(
  configPath: string,
  fields: ReadonlyMap<string, unknown>,
): readonly ConfigWarning[] {
  const known = new Set<string>(KNOWN_KEYS);
  // A table that only holds known keys is known even when it is empty, so an
  // untouched `[store]` is not reported as a key nobody recognises.
  const isKnown = (key: string): boolean =>
    known.has(key) || KNOWN_KEYS.some((candidate) => candidate.startsWith(`${key}.`));

  return [...fields.keys()]
    .filter((key) => !isKnown(key))
    .sort()
    .map((key) => ({
      code: 'CONFIG_UNKNOWN_KEY' as const,
      message: `${configPath}: 모르는 키 "${key}"를 무시합니다`,
    }));
}

/**
 * A TOML table, as opposed to an array, a scalar, or a temporal. Every temporal
 * `smol-toml` produces — offset datetime, local datetime, date, time — is a
 * `Date` subclass, so one check covers them all and none is walked into.
 */
function isTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The first line of whatever went wrong, so a message stays one line. */
function oneLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.trim() ?? '알 수 없는 오류';
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '배열';
  if (value instanceof Date) return '날짜';
  if (typeof value === 'object') return '테이블';
  if (typeof value === 'string') return `문자열 "${value}"`;
  if (typeof value === 'number') return `숫자 ${String(value)}`;
  if (typeof value === 'boolean') return `참거짓 값 ${String(value)}`;
  // TOML has no other kind of value, so this is a document `smol-toml` would
  // not have produced; name it rather than print the JavaScript type's name.
  return `알 수 없는 종류의 값 ${String(value)}`;
}
