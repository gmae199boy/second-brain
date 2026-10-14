import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import type { WarningCode } from 'second_brain';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { configFilePath, envFilePath } from './paths.js';

/**
 * The one place configuration is read and written, installer included (AD-18).
 * `config.toml` holds no key values, only the name of the environment variable
 * that carries each one; the values themselves live in `.env` at mode 0600.
 *
 * Nothing here runs at import time (AD-3): a command calls `readConfig`, and
 * until it does, no file is touched.
 */

/** Version of the configuration file layout this code understands. */
export const CONFIG_SCHEMA_VERSION = 1;

/** Default display time zone. Only human-readable output uses it (Conventions). */
export const DEFAULT_TIMEZONE = 'Asia/Seoul';

/** Default name of the variable that carries the Postgres URL. */
export const DEFAULT_DATABASE_URL_ENV = 'SECOND_BRAIN_DATABASE_URL';

/**
 * The v1 keys, as they are spelled in the file. A story that needs another key
 * adds it here and nowhere else; anything not on this list is reported, never
 * dropped in silence (AD-18).
 */
export const KNOWN_KEYS = [
  'schema_version',
  'timezone',
  'database.url_env',
  'mirror.path',
] as const;

/** Folder name of the default mirror, under the configuration folder. */
export const DEFAULT_MIRROR_FOLDER = 'mirror';

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
  /** Name of the variable that carries the Postgres URL. */
  databaseUrlEnv: string;
  /** The Postgres URL itself, from `.env` or, failing that, the process. */
  databaseUrl: string;
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
      /** Nothing to read, or nothing in it to reach the database with. */
      code: 'CONFIG_MISSING';
      message: string;
    }
  | {
      ok: false;
      /** There is a file, and it cannot be understood. */
      code: 'CONFIG_INVALID';
      message: string;
    };

/** An environment variable name, which is all a TOML key may name (AD-18). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Read the configuration folder. Order of business: the TOML must be there and
 * be understandable, then `.env` is overlaid on the process environment, and
 * only then is the Postgres URL resolved. There is no default URL and no
 * running without a file: a missing `config.toml` means the installer has not
 * run, and guessing would hide that.
 */
export async function readConfig(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadConfigResult> {
  const configPath = configFilePath(home);

  const source = await readTextFile(configPath);
  if (source.state === 'missing') {
    return {
      ok: false,
      code: 'CONFIG_MISSING',
      message: `${configPath} does not exist. Run the installer, or \`brain setup run\`.`,
    };
  }
  if (source.state === 'unreadable') {
    return { ok: false, code: 'CONFIG_INVALID', message: `${configPath}: ${source.message}` };
  }

  let document: unknown;
  try {
    document = parseToml(source.text);
  } catch (error) {
    return { ok: false, code: 'CONFIG_INVALID', message: `${configPath}: ${oneLine(error)}` };
  }
  if (!isTable(document)) {
    return { ok: false, code: 'CONFIG_INVALID', message: `${configPath}: not a TOML table` };
  }

  const fields = flatten(document);
  const warnings = unknownKeyWarnings(configPath, fields);

  const schemaVersion = fields.get('schema_version');
  if (schemaVersion === undefined) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: no schema_version. Expected schema_version = ${String(CONFIG_SCHEMA_VERSION)}.`,
    };
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: schema_version must be an integer, got ${kindOf(schemaVersion)}`,
    };
  }
  if (schemaVersion !== CONFIG_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: schema_version ${String(schemaVersion)} is not supported; this code reads ${String(CONFIG_SCHEMA_VERSION)}.`,
    };
  }

  const timezone = fields.get('timezone') ?? DEFAULT_TIMEZONE;
  if (typeof timezone !== 'string' || timezone === '') {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: timezone must be a non-empty string, got ${kindOf(timezone)}`,
    };
  }
  if (!isTimeZone(timezone)) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: timezone "${timezone}" is not a time zone this machine knows`,
    };
  }

  const databaseUrlEnv = fields.get('database.url_env') ?? DEFAULT_DATABASE_URL_ENV;
  if (typeof databaseUrlEnv !== 'string' || !ENV_NAME.test(databaseUrlEnv)) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: database.url_env must be an environment variable name, got ${kindOf(databaseUrlEnv)}`,
    };
  }

  const mirrorPath = fields.get('mirror.path') ?? defaultMirrorPath(home);
  if (typeof mirrorPath !== 'string' || mirrorPath === '') {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: mirror.path must be a non-empty string, got ${kindOf(mirrorPath)}`,
    };
  }
  // Absolute only. A relative path would mean a different folder for every
  // working directory a command happens to be started from, so the mirror a
  // hook writes and the mirror the user greps would not be the same one.
  if (!isAbsolute(mirrorPath)) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: `${configPath}: mirror.path "${mirrorPath}" must be an absolute path`,
    };
  }

  const envPath = envFilePath(home);
  const dotenv = await readTextFile(envPath);
  if (dotenv.state === 'unreadable') {
    return { ok: false, code: 'CONFIG_INVALID', message: `${envPath}: ${dotenv.message}` };
  }
  let values: Record<string, string | undefined> = {};
  if (dotenv.state === 'read') {
    try {
      values = parseEnv(dotenv.text);
    } catch (error) {
      return { ok: false, code: 'CONFIG_INVALID', message: `${envPath}: ${oneLine(error)}` };
    }
  }

  // `.env` wins: it is the file the installer wrote, and a stale variable left
  // in a shell must not quietly point a command at another brain. Only own
  // properties count, or a `url_env` of "constructor" would read a member of
  // `Object.prototype` and the command would die on a type error instead of
  // reporting a configuration problem.
  const databaseUrl = (own(values, databaseUrlEnv) ?? own(env, databaseUrlEnv))?.trim();
  if (databaseUrl === undefined || databaseUrl === '') {
    return {
      ok: false,
      code: 'CONFIG_MISSING',
      message: `${databaseUrlEnv} is set neither in ${envPath} nor in the environment. Run \`brain setup run\`.`,
    };
  }

  return {
    ok: true,
    config: { schemaVersion, timezone, databaseUrlEnv, databaseUrl, mirrorPath },
    warnings,
  };
}

/** What `writeConfig` records. Everything left out keeps its default. */
export interface WriteConfigInput {
  timezone?: string;
  databaseUrlEnv?: string;
  /** Written to `.env` under the resolved name, never into the TOML (AD-18). */
  databaseUrl?: string;
  /** Absolute. Left out means `defaultMirrorPath(home)`, as reading does. */
  mirrorPath?: string;
}

/**
 * Write the configuration folder, creating it when needed. `.env` keeps the
 * variables already in it, so re-running the installer does not drop a key some
 * later story put there, and it ends up at mode 0600 whether it was just
 * created or already existed.
 */
export async function writeConfig(home: string, input: WriteConfigInput): Promise<void> {
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const databaseUrlEnv = input.databaseUrlEnv ?? DEFAULT_DATABASE_URL_ENV;
  const mirrorPath = input.mirrorPath ?? defaultMirrorPath(home);
  // The same checks `readConfig` makes, made here as well: a folder this codec
  // wrote must be one it can read back.
  if (!ENV_NAME.test(databaseUrlEnv)) {
    throw new Error(`${databaseUrlEnv} is not an environment variable name`);
  }
  if (!isTimeZone(timezone)) {
    throw new Error(`${timezone} is not a time zone this machine knows`);
  }
  if (!isAbsolute(mirrorPath)) {
    throw new Error(`${mirrorPath} is not an absolute path`);
  }

  await mkdir(home, { recursive: true, mode: 0o700 });

  const envPath = envFilePath(home);
  const existing = await readTextFile(envPath);
  const values: Record<string, string | undefined> =
    existing.state === 'read' ? { ...parseEnv(existing.text) } : {};
  if (input.databaseUrl !== undefined) {
    values[databaseUrlEnv] = input.databaseUrl;
  }

  // Both files are rendered before either is written, so a value `.env` cannot
  // represent fails with nothing written rather than leaving half a folder
  // behind for `readConfig` to call incomplete.
  const document = stringifyToml({
    schema_version: CONFIG_SCHEMA_VERSION,
    timezone,
    database: { url_env: databaseUrlEnv },
    mirror: { path: mirrorPath },
  });
  const lines = Object.entries(values).flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}=${quote(name, value)}`],
  );

  await writeFile(
    configFilePath(home),
    `# Personal Brain configuration. No keys here — key values live in .env.\n${document}\n`,
    'utf8',
  );
  // The mode is set at creation, so the secret is never briefly world-readable.
  await writeFile(
    envPath,
    `# Written by brain. Keys live here, not in config.toml, and not in the repository.\n${lines.join('\n')}\n`,
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

/**
 * The variable's own value, or `undefined`. A name the configuration supplies
 * is untrusted, so an inherited member of `Object.prototype` must never pass
 * for a value.
 */
function own(values: Record<string, string | undefined>, name: string): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

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
  // untouched `[database]` is not reported as a key nobody recognises.
  const isKnown = (key: string): boolean =>
    known.has(key) || KNOWN_KEYS.some((candidate) => candidate.startsWith(`${key}.`));

  return [...fields.keys()]
    .filter((key) => !isKnown(key))
    .sort()
    .map((key) => ({
      code: 'CONFIG_UNKNOWN_KEY' as const,
      message: `${configPath}: ignoring unknown key "${key}"`,
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
  return text.split('\n')[0]?.trim() ?? 'unknown error';
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Date) return 'a date';
  if (typeof value === 'object') return 'a table';
  if (typeof value === 'string') return `the string "${value}"`;
  return `the ${typeof value} ${String(value)}`;
}
