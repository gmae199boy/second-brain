import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the configuration folder is, when it is not the default one. It is not
 * a configuration key — it says where the keys live, so it cannot itself be
 * read from them. Tests and a second installation on the same machine use it.
 */
export const HOME_ENV = 'SECOND_BRAIN_HOME';

/** Folder name under the user's home directory (AD-18). */
export const DEFAULT_HOME_FOLDER = '.second_brain';

/** The configuration file: no key values, only environment variable names. */
export const CONFIG_FILE = 'config.toml';

/** The key file. Written at mode 0600 by the codec, and never committed. */
export const ENV_FILE = '.env';

/**
 * What a finished install left behind: which commit, which store schema, when,
 * with which node, and from which plugin folder (AD-19). It is not
 * configuration — nobody edits it and the codec never reads it (AD-18) — so it
 * is its own file with its own reader.
 */
export const INSTALLED_FILE = 'installed.json';

/**
 * The install lock, as a folder: `mkdir` is the one atomic "create unless it is
 * there" every filesystem has, and the folder's own mtime is when the lock was
 * taken. The owner is the `pid` file inside it.
 *
 * Both the bootstrap and the shim take this same lock, so the name is a
 * constant on both sides and a test ties the two spellings together.
 */
export const LOCK_FOLDER = 'install.lock';

/** The owner of the lock: one decimal line, the pid that took it. */
export const LOCK_PID_FILE = 'pid';

/**
 * Where the records of a running installation live — a daemon's pid and socket,
 * the heartbeat, the last drain, the last hook per harness, and the plugin
 * record below. None of them goes through the configuration codec (AD-18,
 * AD-19, AD-27, Conventions: 설치·런타임 기록).
 */
export const RUN_FOLDER = 'run';

/**
 * What the last `SessionStart` saw and did: `{plugin_root, app_ref, seen_at}`
 * and the last bootstrap's outcome. The bootstrap writes it, `doctor run`'s
 * `plugin` check reads it, and it is the one record that names the plugin
 * folder a session actually came from — `installed.json` names the folder the
 * last install came from, and the plugin cache keeps one folder per version.
 */
export const PLUGIN_RUN_FILE = 'plugin.json';

/** Where the install's own progress lines go when nobody is watching. */
export const LOG_FOLDER = 'log';

/** The bootstrap's log, appended to with a time header per run. */
export const BOOTSTRAP_LOG_FILE = 'bootstrap.log';

/**
 * The configuration folder for this run. Read from the environment when asked,
 * never at import time (AD-3), so a test can point one child process somewhere
 * else without touching the real folder.
 */
export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HOME_ENV]?.trim();
  if (override !== undefined && override !== '') {
    return override;
  }
  return join(homedir(), DEFAULT_HOME_FOLDER);
}

export function configFilePath(home: string): string {
  return join(home, CONFIG_FILE);
}

export function envFilePath(home: string): string {
  return join(home, ENV_FILE);
}

/** Where this installation's completion record lives. */
export function installedPath(home: string): string {
  return join(home, INSTALLED_FILE);
}

/** The plugin record the last `SessionStart` of this folder left behind. */
export function pluginRunPath(home: string): string {
  return join(home, RUN_FOLDER, PLUGIN_RUN_FILE);
}

/** The install lock of this configuration folder. */
export function lockPath(home: string): string {
  return join(home, LOCK_FOLDER);
}

/** The bootstrap's log file of this configuration folder. */
export function bootstrapLogPath(home: string): string {
  return join(home, LOG_FOLDER, BOOTSTRAP_LOG_FILE);
}
