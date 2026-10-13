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
