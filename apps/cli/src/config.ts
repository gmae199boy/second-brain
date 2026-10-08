/**
 * Temporary configuration reader: the environment variable only. Story 4
 * replaces this with the `config.toml` codec. Reading happens when a command
 * calls this, never at import time (AD-3).
 */
export type ConfigResult =
  | { ok: true; databaseUrl: string }
  | { ok: false; code: 'CONFIG_MISSING'; message: string };

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl === '') {
    return {
      ok: false,
      code: 'CONFIG_MISSING',
      message: 'DATABASE_URL is not set. Set it to the Postgres URL of your brain.',
    };
  }
  return { ok: true, databaseUrl };
}
