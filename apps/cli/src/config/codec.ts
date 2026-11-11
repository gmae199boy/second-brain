import { withHomeInstallLock } from '../runtime/install-lock.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { errorLine, isTimeZone, TIMEZONE_SETTING, type WarningCode, type SettingsDependencies, getSetting } from 'second_brain';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { configFilePath, envFilePath } from './paths.js';

/**
 * The one place configuration is read and written, installer included (AD-18).
 * `config.toml` holds machine settings; connection secrets live in `.env` at
 * mode 0600. Telegram 사용자 설정은 DB를 우선하며 `.env`는 fallback이다.
 * URL resolution uses process values before the home `.env`.
 *
 * Nothing here runs at import time (AD-3): a command calls `readConfig`, and
 * until it does, no file is touched.
 */

/** Version of the configuration file layout this code understands. */
export const CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_STORE_URL_ENV = 'BRAIN_DATABASE_URL';

/** Default display time zone. Only human-readable output uses it (Conventions). */
export const DEFAULT_TIMEZONE = TIMEZONE_SETTING.defaultValue;

/**
 * The v1 keys, as they are spelled in the file. A story that needs another key
 * adds it here and nowhere else; anything not on this list is reported, never
 * dropped in silence (AD-18).
 */
export const KNOWN_KEYS = [
  'schema_version',
  'timezone',
  'store.url_env',
  'files.path',
  'mirror.path',
  'update.auto',
] as const;

/** Retired SQLite filename, used only to identify an untouched legacy file. */
export const DEFAULT_STORE_FILE = 'brain.db';

/** Folder name of the default file store, under the configuration folder. */
export const DEFAULT_FILES_FOLDER = 'files';

/** Folder name of the default mirror, under the configuration folder. */
export const DEFAULT_MIRROR_FOLDER = 'mirror';

/**
 * Whether the harness plugin may install a newer app on its own, when the
 * folder does not say. On: the point of the plugin is that a session which
 * carries a newer app installs it without anybody being asked (AD-19), and a
 * default of off would make every install a manual one. Turning it off leaves
 * the plugin check to say `UPDATE_AVAILABLE` instead of acting.
 */
export const DEFAULT_UPDATE_AUTO = true;

/**
 * The legacy SQLite candidate when an old configuration names no file.
 * Nothing opens, moves or creates this path.
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
  timezone?: string;
  /** Presence only: a stale PG file value must never become a runtime setting. */
  fileHasTimezone?: boolean;
  /** Environment variable selecting the PostgreSQL runtime URL. */
  storeUrlEnv: string;
  /** Retired SQLite file candidate, used only for installation guidance. */
  legacySqlitePath: string;
  /** Absolute path of the file store's root. Nothing here creates it (epic 2). */
  filesPath: string;
  /** Absolute path of the mirror folder. Nothing here creates it (epic 4). */
  mirrorPath: string;
  /** Whether the plugin's `SessionStart` may install a newer app (AD-19). */
  updateAuto: boolean;
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
      message: `${configPath}을 TOML로 읽을 수 없습니다: ${errorLine(error)}`,
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

  const storeUrlEnv = (isTable(document.store) ? document.store.url_env : undefined) ?? DEFAULT_STORE_URL_ENV;
  const selectorError = storeUrlEnvError(storeUrlEnv);
  if (selectorError !== undefined) return { ok: false, code: 'CONFIG_INVALID', message: selectorError };
  const filesPath = readPath(configPath, fields, 'files.path', defaultFilesPath(home));
  if (!filesPath.ok) return filesPath.failure;
  const mirrorPath = readPath(configPath, fields, 'mirror.path', defaultMirrorPath(home));
  if (!mirrorPath.ok) return mirrorPath.failure;

  const updateAuto = fields.get('update.auto') ?? DEFAULT_UPDATE_AUTO;
  if (typeof updateAuto !== 'boolean') {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: update.auto는 참거짓 값이어야 하는데 ${kindOf(updateAuto)}입니다`,
    };
  }

  return {
    ok: true,
    config: {
      schemaVersion,
      storeUrlEnv: storeUrlEnv as string,
      fileHasTimezone: Object.hasOwn(document, 'timezone'),
      legacySqlitePath: typeof fields.get('store.path') === 'string' ? fields.get('store.path') as string : defaultStorePath(home),
      filesPath: filesPath.path,
      mirrorPath: mirrorPath.path,
      updateAuto,
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

/**
 * What `<home>` already says, key by key, for the installer.
 *
 * Every field is optional and for the same reason: a value this version cannot
 * use is dropped on its own, with a warning, and the installer falls back to
 * its default for that one key. `readConfig` cannot do this — a command must
 * not run against a configuration it only half understands — but an install is
 * exactly the moment to repair one, and resetting the four keys around the
 * broken one is how a single typo loses a file store nothing asks about (F1).
 */
export interface SetupConfig {
  timezone?: string;
  /** Unvalidated retired value, used only to report a legacy file. */
  legacySqlitePath?: string;
  storeUrlEnv?: string;
  /** Absolute. Nothing asks for it, so a re-run can only keep it. */
  filesPath?: string;
  /** Absolute. A re-run offers it as the default and must never reset it. */
  mirrorPath?: string;
  /** What the folder says about automatic updating. A re-run offers it back. */
  updateAuto?: boolean;
  /**
   * The keys this version does not know, as the document held them, so writing
   * the folder back keeps them rather than dropping them in silence (AD-18).
   */
  extra: Record<string, unknown>;
}

export type ReadSetupConfigResult =
  | {
      ok: true;
      /** `undefined` when there is no `config.toml` at all: a first install. */
      recorded: SetupConfig | undefined;
      warnings: readonly ConfigWarning[];
    }
  | {
      ok: false;
      /** The whole file is unusable, so nothing may be written over it. */
      code: 'CONFIG_INVALID';
      message: string;
    };

/**
 * Read the configuration folder the way the installer has to: value by value.
 *
 * It answers `CONFIG_INVALID` only for the three things that make the whole
 * document unusable — it cannot be read, it is not TOML, it is not a table —
 * and for a `schema_version` that is an integer other than this version's,
 * which may well be a newer layout this build would mangle. An invalid
 * store.url_env also fails: dropping it would select a different database.
 * Everything else is repaired in place: the key is dropped, a `CONFIG_VALUE_RESET` warning names
 * it and what will be written instead, and the install carries on with the
 * other values intact.
 *
 * The checks are `readConfig`'s own, called here rather than copied, so a
 * folder this function accepts a value from is a folder `readConfig` will read
 * that value back out of.
 */
export async function readConfigForSetup(home: string): Promise<ReadSetupConfigResult> {
  const configPath = configFilePath(home);

  const source = await readTextFile(configPath);
  if (source.state === 'missing') return { ok: true, recorded: undefined, warnings: [] };
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
      message: `${configPath}을 TOML로 읽을 수 없습니다: ${errorLine(error)}`,
    };
  }
  if (!isTable(document)) {
    return { ok: false, code: 'CONFIG_INVALID', message: `${configPath}: TOML 테이블이 아닙니다` };
  }

  const fields = flatten(document);
  const warnings: ConfigWarning[] = [...unknownKeyWarnings(configPath, fields)];

  // A version this build does not read is the one value that cannot be
  // repaired: the keys under it may mean something else entirely, so writing
  // this version's layout over it would be this code guessing.
  const schemaVersion = fields.get('schema_version');
  if (
    typeof schemaVersion === 'number' &&
    Number.isInteger(schemaVersion) &&
    schemaVersion !== CONFIG_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: schema_version ${String(schemaVersion)}은 지원하지 않습니다. 이 코드가 읽는 것은 ${String(CONFIG_SCHEMA_VERSION)}입니다.`,
    };
  }
  if (schemaVersion !== CONFIG_SCHEMA_VERSION) {
    warnings.push(
      reset(
        configPath,
        'schema_version',
        schemaVersion,
        String(CONFIG_SCHEMA_VERSION),
      ),
    );
  }

  const recorded: SetupConfig = { extra: unknownKeys(fields), legacySqlitePath: typeof fields.get('store.path') === 'string' ? fields.get('store.path') as string : defaultStorePath(home) };
  const storeUrlEnv = (isTable(document.store) ? document.store.url_env : undefined) ?? DEFAULT_STORE_URL_ENV;
  const selectorError = storeUrlEnvError(storeUrlEnv);
  if (selectorError !== undefined) return { ok: false, code: 'CONFIG_INVALID', message: selectorError };
  if (storeUrlEnv !== undefined) recorded.storeUrlEnv = storeUrlEnv as string;

  const timezone = fields.get('timezone');
  if (timezone !== undefined) {
    if (typeof timezone === 'string' && timezone !== '' && isTimeZone(timezone)) {
      recorded.timezone = timezone;
    } else {
      warnings.push(reset(configPath, 'timezone', timezone, DEFAULT_TIMEZONE));
    }
  }

  for (const [key, field] of [
    ['files.path', 'filesPath'],
    ['mirror.path', 'mirrorPath'],
  ] as const) {
    const value = fields.get(key);
    if (value === undefined) continue;
    const read = readPath(configPath, fields, key, '');
    if (read.ok) {
      recorded[field] = read.path;
      continue;
    }
    warnings.push(reset(configPath, key, value, defaultFor(home, key)));
  }

  const updateAuto = fields.get('update.auto');
  if (updateAuto !== undefined) {
    if (typeof updateAuto === 'boolean') {
      recorded.updateAuto = updateAuto;
    } else {
      warnings.push(reset(configPath, 'update.auto', updateAuto, String(DEFAULT_UPDATE_AUTO)));
    }
  }

  return { ok: true, recorded, warnings };
}

/**
 * One value that was dropped: the key, what it said, and the default for that
 * key.
 *
 * It names the default as the default and not as what will be written, because
 * it is not always what is written: a flag or an answer typed into the question wins over it, and a warning that promised the default
 * would be used would be a warning the next line contradicts.
 */
function reset(
  configPath: string,
  key: string,
  value: unknown,
  instead: string,
): ConfigWarning {
  // An absent value has no kind to name and nothing to discard, and
  // `kindOf(undefined)` would put "undefined" into a sentence a person reads.
  const said =
    value === undefined
      ? `${key} 키가 없습니다`
      : `${key}는 ${kindOf(value)}입니다. 쓸 수 없으므로 버립니다`;
  return {
    code: 'CONFIG_VALUE_RESET',
    message: `${configPath}: ${said}. 기본값은 "${instead}"입니다`,
  };
}

/** What this install writes for one path key when the file's value is unusable. */
function defaultFor(home: string, key: 'files.path' | 'mirror.path'): string {
  if (key === 'files.path') return defaultFilesPath(home);
  return defaultMirrorPath(home);
}

/**
 * The keys this version does not know, back in the shape the document had
 * them: `[database] url_env` comes out as `{ database: { url_env } }`, so
 * `writeConfig` can render it again without knowing anything about it.
 */
function unknownKeys(fields: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const key of unknownKeyNames(fields)) {
    if (key === 'store.path') continue;
    const parts = key.split('.');
    const last = parts.pop();
    if (last === undefined) continue;
    let table = extra;
    for (const part of parts) {
      const next = table[part];
      if (!isTable(next)) {
        const made: Record<string, unknown> = {};
        table[part] = made;
        table = made;
        continue;
      }
      table = next;
    }
    table[last] = fields.get(key);
  }
  return extra;
}

/** What `writeConfig` records. Everything left out keeps its default. */
export interface WriteConfigInput {
  timezone?: string;
  /** Left out means `DEFAULT_STORE_URL_ENV`. */
  storeUrlEnv?: string;
  /** Absolute. Left out means `defaultFilesPath(home)`, as reading does. */
  filesPath?: string;
  /** Absolute. Left out means `defaultMirrorPath(home)`, as reading does. */
  mirrorPath?: string;
  /** Left out means `DEFAULT_UPDATE_AUTO`, as reading does. */
  updateAuto?: boolean;
  /**
   * Keys this version does not know, as `readConfigForSetup` read them back.
   * They are rendered again exactly as they came, and a known key wins over
   * one of these: a configuration is never quietly shortened (AD-18).
   */
  extra?: Record<string, unknown>;
}

/** What `writeConfig` did. A failure is a value, never an exception. */
export type WriteConfigResult =
  | { ok: true }
  | { ok: false; code: 'CONFIG_INVALID'; message: string };

/**
 * Write the configuration folder, creating it when needed. `.env` keeps the
 * variables already in it, so re-running the installer does not drop a key some
 * later story put there, and it ends up at mode 0600 whether it was just
 * created or already existed — there is no key to write into it yet, and the
 * mode rule has to hold before there is one rather than after.
 */
async function writeConfigUnlocked(
  home: string,
  input: WriteConfigInput,
): Promise<WriteConfigResult> {
  const selectorError = storeUrlEnvError(input.storeUrlEnv);
  if (selectorError !== undefined) return { ok: false, code: 'CONFIG_INVALID', message: selectorError };
  const filesPath = input.filesPath ?? defaultFilesPath(home);
  const mirrorPath = input.mirrorPath ?? defaultMirrorPath(home);
  // The same checks `readConfig` makes, made here as well: a folder this codec
  // wrote must be one it can read back. A value, not an exception: the
  // installer has a line to print and an exit code to answer with, and a
  // throw from here would reach the terminal as a stack (Conventions).
  for (const [key, path] of [
    ['files.path', filesPath],
    ['mirror.path', mirrorPath],
  ] as const) {
    if (!isAbsolute(path)) {
      return {
        ok: false,
        code: 'CONFIG_INVALID',
        message: `${key} "${path}"는 절대 경로여야 합니다`,
      };
    }
  }

  const envPath = envFilePath(home);
  let document: string;
  let lines: string[];
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });

    const existing = await readTextFile(envPath);
    if(existing.state==='unreadable') throw new Error('비밀 파일을 읽을 수 없습니다');
    const values: Record<string, string | undefined> =
      existing.state === 'read' ? { ...parseEnv(existing.text) } : {};

    // Both files are rendered before either is written, so a value `.env`
    // cannot represent fails with nothing written rather than leaving half a
    // folder behind for `readConfig` to call incomplete.
    const rendered = merged(
        {
          schema_version: CONFIG_SCHEMA_VERSION,
          store: { url_env: input.storeUrlEnv ?? DEFAULT_STORE_URL_ENV },
          files: { path: filesPath },
          mirror: { path: mirrorPath },
          update: { auto: input.updateAuto ?? DEFAULT_UPDATE_AUTO },
        },
        input.extra ?? {},
      );
    delete rendered.timezone;
    if (isTable(rendered.store)) delete rendered.store.path;
    document = stringifyToml(rendered);
    lines = [];
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const quoted = quote(value);
      if (quoted === undefined) {
        return {
          ok: false,
          code: 'CONFIG_INVALID',
          message: `${name}에 작은따옴표와 큰따옴표가 다 들어 있어서 .env로 나타낼 수 없습니다`,
        };
      }
      lines.push(`${name}=${quoted}`);
    }
  } catch (error) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${home}에 설정을 쓸 수 없습니다: ${errorLine(error)}`,
    };
  }

  try {
    await writeFile(
      configFilePath(home),
      `# Personal Brain 설정. 키 값은 여기가 아니라 .env에 있습니다.\n${document}\n`,
      'utf8',
    );
    await writeEnv(
      envPath,
      `# brain이 쓴 파일입니다. 키 값은 config.toml이 아니라 여기에 있고, 저장소에는 들어가지 않습니다.\n${lines.join('\n')}\n`,
    );
  } catch (error) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${home}에 설정을 쓸 수 없습니다: ${errorLine(error)}`,
    };
  }

  return { ok: true };
}

/**
 * This version's keys, plus the ones it does not know, as one document. A known
 * key wins: a `[store] path` the installer just chose is not overwritten by
 * whatever the file happened to hold under the same name, and a table is merged
 * rather than replaced so `[store] extra` survives beside `[store] path`.
 */
function merged(
  known: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const document: Record<string, unknown> = { ...known };
  for (const [key, value] of Object.entries(extra)) {
    const mine = document[key];
    if (isTable(mine) && isTable(value)) {
      document[key] = merged(mine, value);
      continue;
    }
    // A known key wins, so an unknown one of the same name is dropped — which
    // only happens for a scalar written where this version keeps a table.
    if (mine !== undefined) continue;
    document[key] = value;
  }
  return document;
}

/**
 * `.env` as Node reads it has no escape syntax, so a value is quoted with
 * whichever quote it does not contain. A value holding both cannot be written
 * back faithfully — `undefined` says so — and a codec that cannot round-trip a
 * value must say so rather than record something else.
 */
function quote(value: string): string | undefined {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return undefined;
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
    return { state: 'unreadable', message: errorLine(error) };
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

/**
 * Every key of the document this version does not know, in the document's own
 * order. One list, because the warning that names them and the record that
 * carries them through a write have to agree about which keys those are: a key
 * reported and then dropped is the silent loss AD-18 forbids.
 */
function unknownKeyNames(fields: ReadonlyMap<string, unknown>): readonly string[] {
  const known = new Set<string>(KNOWN_KEYS);
  // A table that only holds known keys is known even when it is empty, so an
  // untouched `[store]` is not reported as a key nobody recognises.
  const isKnown = (key: string): boolean =>
    known.has(key) || KNOWN_KEYS.some((candidate) => candidate.startsWith(`${key}.`));

  // Retired store.path is consumed only as a legacy candidate and never rewritten.
  return [...fields.keys()].filter((key) => key !== 'store.path' && !isKnown(key));
}

function unknownKeyWarnings(
  configPath: string,
  fields: ReadonlyMap<string, unknown>,
): readonly ConfigWarning[] {
  // Neutral about what becomes of it, because the two readers do different
  // things with it and both read this sentence: a command does not use the key,
  // and the installer writes it straight back rather than dropping it (AD-18).
  return [...unknownKeyNames(fields)].sort().map((key) => ({
    code: 'CONFIG_UNKNOWN_KEY' as const,
    message: `${configPath}: 이 버전이 모르는 키 "${key}"가 있습니다. 쓰지는 않고 그대로 둡니다`,
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

function storeUrlEnvError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return 'store.url_env는 환경 변수 이름이어야 합니다';
  }
  if (value === 'BRAIN_APP_PASSWORD' || value === 'BRAIN_POSTGRES_PASSWORD') {
    return 'store.url_env에 PostgreSQL 비밀번호용 환경 변수 이름을 사용할 수 없습니다';
  }
  return undefined;
}

/** Resolve secrets only when called: the process environment takes precedence, even when empty. */
export async function resolveStoreUrl(home: string, name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (env[name] !== undefined) return env[name]?.trim() || undefined;
  try { return parseEnv(await readFile(envFilePath(home), 'utf8'))[name]?.trim() || undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function postgresSecretsUnlocked(home: string, port: number, urlEnv: string): Promise<{ adminUrl: string; appPassword: string }> {
  const selectorError = storeUrlEnvError(urlEnv);
  if (selectorError !== undefined) throw new Error(selectorError);
  const { randomBytes } = await import('node:crypto');
  let values: Record<string, string> = {};
  try { values = Object.fromEntries(Object.entries(parseEnv(await readFile(envFilePath(home), 'utf8'))).filter((entry): entry is [string, string] => entry[1] !== undefined)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  values['BRAIN_POSTGRES_PASSWORD'] ||= randomBytes(24).toString('hex');
  values['BRAIN_APP_PASSWORD'] ||= randomBytes(24).toString('hex');
  values[urlEnv] = `postgresql://brain_app:${encodeURIComponent(values['BRAIN_APP_PASSWORD'])}@127.0.0.1:${port}/brain`;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const text = Object.entries(values).sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => {
    const quoted = quote(value); if (quoted === undefined) throw new Error(`${key}: .env로 쓸 수 없습니다`);
    return `${key}=${quoted}`;
  }).join('\n') + '\n';
  await writeEnv(envFilePath(home), text);
  return { adminUrl: `postgresql://postgres:${encodeURIComponent(values['BRAIN_POSTGRES_PASSWORD'])}@127.0.0.1:${port}/postgres`, appPassword: values['BRAIN_APP_PASSWORD'] };
}

/** Replace secrets only after the complete private file is ready on the same filesystem. */
async function writeEnv(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

/** Extension DDL uses the runtime endpoint and the existing private admin password. */
export async function extensionAdminUrl(home: string, runtimeUrl: string, env: NodeJS.ProcessEnv): Promise<string> {
  const password = await resolveStoreUrl(home, 'BRAIN_POSTGRES_PASSWORD', env);
  if (!password) throw new Error('PostgreSQL 관리 비밀번호가 없습니다');
  const url = new URL(runtimeUrl);
  url.searchParams.delete('user'); url.searchParams.delete('password');
  url.username = 'postgres'; url.password = password;
  return url.toString();
}

function extensionPasswordKey(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(name) || /^(core|brain|public|pg_)/.test(name)) throw new Error('잘못된 확장 이름');
  return `BRAIN_EXT_${name.toUpperCase()}_PASSWORD`;
}
/** 클러스터 잠금 안에서 확장 비밀번호를 생성하거나 기존 값을 보존한다. */
async function ensureExtensionPasswordUnlocked(home: string, name: string): Promise<string> {
  const key = extensionPasswordKey(name);
  let values: Record<string, string> = {};
  try { values = Object.fromEntries(Object.entries(parseEnv(await readFile(envFilePath(home), 'utf8'))).filter((entry): entry is [string, string] => entry[1] !== undefined)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!values[key]) {
    const { randomBytes } = await import('node:crypto');
    values[key] = randomBytes(24).toString('hex');
    const lines = Object.entries(values).map(([k, v]) => { const q = quote(v); if (q === undefined) throw new Error('비밀 파일을 쓸 수 없습니다'); return `${k}=${q}`; });
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeEnv(envFilePath(home), lines.join('\n') + '\n');
  }
  await chmod(envFilePath(home), 0o600);
  return values[key];
}
export async function extensionDatabaseUrl(home: string, name: string, runtimeUrl: string): Promise<string> {
  const values = parseEnv(await readFile(envFilePath(home), 'utf8'));
  const password = values[extensionPasswordKey(name)];
  if (!password || !/^[a-f0-9]{48}$/.test(password)) throw new Error('확장 자격 증명이 없습니다');
  const url = new URL(runtimeUrl);
  url.searchParams.delete('user'); url.searchParams.delete('password');
  url.username = `brain_ext_${name}`; url.password = password;
  return url.toString();
}

/** DB 사용자 설정을 우선하고 키별 미설정 값만 기존 환경에서 읽는다. */
export async function resolveTelegramConfig(home: string, env: NodeJS.ProcessEnv, settings?: SettingsDependencies): Promise<{ token: string; chatId: string } | null> {
  const read = async (key: string, envKey: string): Promise<string | undefined> => {
    if (settings) {
      const result = await getSetting(settings, { key });
      if (!result.ok) throw new Error('Telegram DB 설정을 읽을 수 없습니다');
      if (result.value) return result.value;
    }
    return resolveStoreUrl(home, envKey, env);
  };
  const [token, chatId] = await Promise.all([
    read('telegram.bot_token', 'BRAIN_TELEGRAM_BOT_TOKEN'),
    read('telegram.chat_id', 'BRAIN_TELEGRAM_CHAT_ID'),
  ]);
  return token && chatId ? { token, chatId } : null;
}

/** Serializes every codec .env read-modify-write across processes. An abandoned
 * lock is never guessed stale: the operator must confirm the owner is gone. */
class DirectoryLockUnavailable extends Error { constructor(readonly lockName:string){super('비밀 파일 잠금을 확보할 수 없습니다');} }
export class DriveRefreshLockUnavailable extends Error {}
async function withDirectoryLock<T>(home:string, name:string, run:()=>Promise<T>):Promise<T> {
  await mkdir(home,{recursive:true,mode:0o700});
  const lock=join(home,name), owner=`${process.pid}:${randomUUID()}`;
  let acquired=false;
  for(let attempt=0;attempt<100;attempt++) {
    try {await mkdir(lock,{mode:0o700});acquired=true;break;}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await new Promise(resolve=>setTimeout(resolve,50));}
  }
  if(!acquired)throw new DirectoryLockUnavailable(name);
  try {
    // A failed owner write leaves the lock for explicit recovery.
    await writeFile(join(lock,'owner'),owner,{encoding:'utf8',mode:0o600,flag:'wx'});
    try {return await run();}
    finally {if(await readFile(join(lock,'owner'),'utf8').catch(()=>null)===owner)await rm(lock,{recursive:true,force:true});}
  } catch(error) {throw error;}
}
async function withEnvMutation<T>(home:string,run:()=>Promise<T>):Promise<T>{return withDirectoryLock(home,'secrets.lock',run);}
export async function withDriveConnectionLock<T>(home:string,run:()=>Promise<T>):Promise<T>{return withDirectoryLock(home,'.drive-connection.lock',run);}
/** Refresh is serialized across processes, but never holds the disconnect lock. */
export async function withDriveRefreshLock<T>(home:string,run:()=>Promise<T>):Promise<T>{try{return await withDirectoryLock(home,'.drive-refresh.lock',run);}catch(error){if(error instanceof DirectoryLockUnavailable&&error.lockName==='.drive-refresh.lock')throw new DriveRefreshLockUnavailable();throw error;}}
export async function writeConfig(home:string,input:WriteConfigInput):Promise<WriteConfigResult> {
  try{return await withEnvMutation(home,()=>writeConfigUnlocked(home,input));}
  catch{return {ok:false,code:'CONFIG_INVALID',message:'비밀 파일을 안전하게 갱신할 수 없습니다'};}
}
export async function postgresSecrets(home:string,port:number,urlEnv:string) {return withEnvMutation(home,()=>postgresSecretsUnlocked(home,port,urlEnv));}
export async function ensureExtensionPassword(home:string,name:string) {return withEnvMutation(home,()=>ensureExtensionPasswordUnlocked(home,name));}
export interface DriveCredentials {clientId:string;clientSecret:string;refreshToken:string;session?:string}
const driveKeys=['BRAIN_DRIVE_CLIENT_ID','BRAIN_DRIVE_CLIENT_SECRET','BRAIN_DRIVE_REFRESH_TOKEN'] as const;
/** File-only: inherited environment variables cannot resurrect a deleted token. */
export async function readDriveCredentials(home:string):Promise<DriveCredentials|null> {
  let values:Record<string,string|undefined>;
  try {values=parseEnv(await readFile(envFilePath(home),'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('Drive 비밀 파일을 읽을 수 없습니다');}
  const [clientId,clientSecret,refreshToken]=driveKeys.map(k=>values[k]);
  return clientId&&clientSecret&&refreshToken?{clientId,clientSecret,refreshToken,...(values.BRAIN_DRIVE_SESSION?{session:values.BRAIN_DRIVE_SESSION}:{})}:null;
}
/** Read client registration before first consent; never consult process.env. */
export async function readDriveClient(home:string):Promise<{clientId:string;clientSecret:string}|null> {
  try {const values=parseEnv(await readFile(envFilePath(home),'utf8'));const clientId=values.BRAIN_DRIVE_CLIENT_ID,clientSecret=values.BRAIN_DRIVE_CLIENT_SECRET;return clientId&&clientSecret?{clientId,clientSecret}:null;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('Drive 비밀 파일을 읽을 수 없습니다');}
}
async function mutateDriveSecrets(home:string, update:(values:Record<string,string>)=>void):Promise<void> {
  await withEnvMutation(home,async()=>{
    let values:Record<string,string>={};
    try {values=Object.fromEntries(Object.entries(parseEnv(await readFile(envFilePath(home),'utf8'))).filter((entry):entry is [string,string]=>entry[1]!==undefined));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    update(values);
    const lines=Object.entries(values).map(([key,value])=>{const q=quote(value);if(q===undefined||/[\r\n]/.test(value))throw new Error('비밀 파일을 안전하게 쓸 수 없습니다');return `${key}=${q}`;});
    await writeEnv(envFilePath(home),lines.join('\n')+'\n');
  });
}
export async function saveDriveCredentials(home:string,credentials:DriveCredentials):Promise<void> {
  if(!credentials.clientId||!credentials.clientSecret||!credentials.refreshToken)throw new Error('Drive 자격 증명이 올바르지 않습니다');
  await mutateDriveSecrets(home,values=>{values.BRAIN_DRIVE_CLIENT_ID=credentials.clientId;values.BRAIN_DRIVE_CLIENT_SECRET=credentials.clientSecret;values.BRAIN_DRIVE_REFRESH_TOKEN=credentials.refreshToken;values.BRAIN_DRIVE_SESSION=randomUUID();});
}
/** Caller must already hold the connection lock across the DB transition. */
export async function deleteDriveRefreshTokenUnderLock(home:string):Promise<void> {await mutateDriveSecrets(home,values=>{delete values.BRAIN_DRIVE_REFRESH_TOKEN;delete values.BRAIN_DRIVE_SESSION;});}
export async function deleteDriveRefreshToken(home:string):Promise<void> {await withDriveConnectionLock(home,()=>deleteDriveRefreshTokenUnderLock(home));}
/** A refresh response may never restore credentials removed by disconnect. */
export async function rotateDriveRefreshToken(home:string, previous:DriveCredentials, next:string):Promise<boolean> {
  let updated=false;
  await mutateDriveSecrets(home,values=>{
    if(values.BRAIN_DRIVE_CLIENT_ID!==previous.clientId||values.BRAIN_DRIVE_CLIENT_SECRET!==previous.clientSecret||values.BRAIN_DRIVE_REFRESH_TOKEN!==previous.refreshToken||values.BRAIN_DRIVE_SESSION!==previous.session)return;
    values.BRAIN_DRIVE_REFRESH_TOKEN=next;updated=true;
  });
  return updated;
}
/** Publish a consent result only if the client registration is unchanged. */
export async function saveDriveRefreshForClient(home:string,client:{clientId:string;clientSecret:string},refreshToken:string):Promise<boolean> {
  if(!refreshToken)throw new Error('Drive 자격 증명이 올바르지 않습니다');
  let saved=false;
  await mutateDriveSecrets(home,values=>{
    if(values.BRAIN_DRIVE_CLIENT_ID!==client.clientId||values.BRAIN_DRIVE_CLIENT_SECRET!==client.clientSecret)return;
    values.BRAIN_DRIVE_REFRESH_TOKEN=refreshToken;values.BRAIN_DRIVE_SESSION=randomUUID();saved=true;
  });
  return saved;
}

/** 설치 선택은 bootstrap도 읽는 파일에 둔다. DB 설정과 별개이며 읽기·쓰기를 직렬화한다. */
export async function setInstallChoice(home: string, key: 'mirror.path' | 'update.auto', value: string): Promise<WriteConfigResult> {
  if (key === 'mirror.path' ? !isAbsolute(value) : !['true', 'false'].includes(value)) return { ok: false, code: 'CONFIG_INVALID', message: '설치 설정 값이 올바르지 않습니다' };
  try {
    return await withHomeInstallLock(home, () => withEnvMutation(home, async () => {
      const strict = await readConfig(home);
      if (!strict.ok) return { ok: false as const, code: 'CONFIG_INVALID' as const, message: strict.message };
      const document = parseToml(await readFile(configFilePath(home), 'utf8'));
      const [section, field] = key.split('.') as [string, string];
      const table = document[section];
      document[section] = { ...(isTable(table) ? table : {}), [field]: key === 'mirror.path' ? value : value === 'true' };
      await writeEnv(configFilePath(home), stringifyToml(document));
      return { ok: true as const };
    }));
  } catch { return { ok: false, code: 'CONFIG_INVALID', message: '설치 설정 파일을 바꿀 수 없습니다. 잠금과 파일 권한을 확인하세요' }; }
}
