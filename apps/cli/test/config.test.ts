import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_DATABASE_URL_ENV,
  DEFAULT_TIMEZONE,
  defaultMirrorPath,
  readConfig,
  writeConfig,
} from '../src/config/codec.js';
import { HOME_ENV, configFilePath, configHome, envFilePath } from '../src/config/paths.js';

const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-config-'));
  homes.push(home);
  return home;
}

/** Write the two files by hand, so a test can put anything in them. */
async function given(files: { config?: string; env?: string }): Promise<string> {
  const home = await tempHome();
  if (files.config !== undefined) await writeFile(configFilePath(home), files.config, 'utf8');
  if (files.env !== undefined) await writeFile(envFilePath(home), files.env, 'utf8');
  return home;
}

const VALID_CONFIG = `schema_version = ${String(CONFIG_SCHEMA_VERSION)}\n`;
const URL = 'postgres://postgres:postgres@127.0.0.1:5432/brain';

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('configHome', () => {
  it('uses SECOND_BRAIN_HOME when it is set, for tests and reinstalls', () => {
    expect(configHome({ [HOME_ENV]: '/tmp/elsewhere' })).toBe('/tmp/elsewhere');
  });

  it('falls back to ~/.second_brain (AD-18)', () => {
    expect(configHome({})).toMatch(/\.second_brain$/);
  });

  it('ignores an empty override rather than reading the filesystem root', () => {
    expect(configHome({ [HOME_ENV]: '   ' })).toMatch(/\.second_brain$/);
  });
});

describe('readConfig with a complete folder', () => {
  it('resolves the database url from .env through the configured name', async () => {
    const home = await given({
      config: `${VALID_CONFIG}timezone = "Europe/Berlin"\n\n[database]\nurl_env = "MY_BRAIN_URL"\n`,
      env: `MY_BRAIN_URL="${URL}"\n`,
    });

    const result = await readConfig(home, {});

    expect(result).toEqual({
      ok: true,
      warnings: [],
      config: {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        timezone: 'Europe/Berlin',
        databaseUrlEnv: 'MY_BRAIN_URL',
        databaseUrl: URL,
        mirrorPath: defaultMirrorPath(home),
      },
    });
  });

  it('reads the mirror path the file names', async () => {
    const home = await given({
      config: `${VALID_CONFIG}[mirror]\npath = "/tmp/elsewhere/brain-mirror"\n`,
      env: `${DEFAULT_DATABASE_URL_ENV}="${URL}"\n`,
    });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.mirrorPath).toBe('/tmp/elsewhere/brain-mirror');
    expect(result.warnings).toEqual([]);
  });

  it('defaults the mirror to a folder under the configuration folder', async () => {
    const home = await given({
      config: VALID_CONFIG,
      env: `${DEFAULT_DATABASE_URL_ENV}="${URL}"\n`,
    });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.mirrorPath).toBe(join(home, 'mirror'));
  });

  it('defaults the timezone and the url variable name', async () => {
    const home = await given({
      config: VALID_CONFIG,
      env: `${DEFAULT_DATABASE_URL_ENV}="${URL}"\n`,
    });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.timezone).toBe(DEFAULT_TIMEZONE);
    expect(result.config.databaseUrlEnv).toBe(DEFAULT_DATABASE_URL_ENV);
  });

  it('takes the url from the process environment when .env has none', async () => {
    const home = await given({ config: VALID_CONFIG });

    const result = await readConfig(home, { [DEFAULT_DATABASE_URL_ENV]: URL });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.databaseUrl).toBe(URL);
  });

  it('lets .env win over a stale variable in the process environment', async () => {
    const home = await given({
      config: VALID_CONFIG,
      env: `${DEFAULT_DATABASE_URL_ENV}="${URL}"\n`,
    });

    const result = await readConfig(home, {
      [DEFAULT_DATABASE_URL_ENV]: 'postgres://somewhere/else',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.databaseUrl).toBe(URL);
  });
});

describe('readConfig and a key it does not know', () => {
  it('runs anyway and warns with CONFIG_UNKNOWN_KEY, naming the key', async () => {
    const home = await given({
      config: `${VALID_CONFIG}colour = "x"\n`,
      env: `${DEFAULT_DATABASE_URL_ENV}="${URL}"\n`,
    });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('CONFIG_UNKNOWN_KEY');
    expect(result.warnings[0]?.message).toContain('colour');
  });

  it('names the whole path of a key inside a table', async () => {
    const home = await given({
      config: `${VALID_CONFIG}[database]\nurl_env = "${DEFAULT_DATABASE_URL_ENV}"\nport = 5432\n`,
      env: `${DEFAULT_DATABASE_URL_ENV}="${URL}"\n`,
    });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((warning) => warning.message.includes('database.port'))).toEqual([
      true,
    ]);
  });

  it('says nothing about a known table left empty', async () => {
    const home = await given({
      config: `${VALID_CONFIG}[database]\n`,
      env: `${DEFAULT_DATABASE_URL_ENV}="${URL}"\n`,
    });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });

  it('reports an unknown table that holds nothing, rather than ignoring it', async () => {
    const home = await given({
      config: `${VALID_CONFIG}[colour]\n`,
      env: `${DEFAULT_DATABASE_URL_ENV}="${URL}"\n`,
    });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings[0]?.message).toContain('colour');
  });

  it('warns once per unknown key, in a stable order', async () => {
    const home = await given({
      config: `${VALID_CONFIG}zebra = 1\nalpha = 2\n`,
      env: `${DEFAULT_DATABASE_URL_ENV}="${URL}"\n`,
    });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]?.message).toContain('alpha');
    expect(result.warnings[1]?.message).toContain('zebra');
  });
});

describe('readConfig and a folder it cannot use', () => {
  it('reports CONFIG_MISSING when there is no config.toml', async () => {
    const home = await tempHome();

    const result = await readConfig(home, { [DEFAULT_DATABASE_URL_ENV]: URL });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIG_MISSING');
    expect(result.message).toContain('config.toml');
  });

  it('reports CONFIG_MISSING when the named variable is set nowhere', async () => {
    const home = await given({ config: VALID_CONFIG });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIG_MISSING');
    expect(result.message).toContain(DEFAULT_DATABASE_URL_ENV);
  });

  it('reports CONFIG_MISSING for a url_env that names a prototype member', async () => {
    // "constructor" is on `Object.prototype`, so a plain lookup would hand back
    // a function and the command would die on a type error instead of saying
    // what is wrong.
    const home = await given({
      config: `${VALID_CONFIG}[database]\nurl_env = "constructor"\n`,
    });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIG_MISSING');
    expect(result.message).toContain('constructor');
  });

  it('reports CONFIG_MISSING when the variable is set to whitespace', async () => {
    const home = await given({
      config: VALID_CONFIG,
      env: `${DEFAULT_DATABASE_URL_ENV}="   "\n`,
    });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIG_MISSING');
  });

  it.each([
    ['broken TOML', 'schema_version = =\n'],
    ['no schema_version', 'timezone = "Asia/Seoul"\n'],
    ['a schema_version that is not an integer', 'schema_version = "1"\n'],
    ['an unsupported schema_version', 'schema_version = 99\n'],
    ['a timezone of the wrong type', `${VALID_CONFIG}timezone = 9\n`],
    ['a timezone no machine knows', `${VALID_CONFIG}timezone = "Nowhere/Nope"\n`],
    [
      'a url_env that is not a variable name',
      `${VALID_CONFIG}[database]\nurl_env = "not a name"\n`,
    ],
    // A relative mirror path would be a different folder for every working
    // directory a command happens to be started from.
    ['a relative mirror path', `${VALID_CONFIG}[mirror]\npath = "notes/mirror"\n`],
    ['a mirror path of the wrong type', `${VALID_CONFIG}[mirror]\npath = 7\n`],
    ['an empty mirror path', `${VALID_CONFIG}[mirror]\npath = ""\n`],
  ])('reports CONFIG_INVALID for %s', async (_name, config) => {
    const home = await given({ config, env: `${DEFAULT_DATABASE_URL_ENV}="${URL}"\n` });

    const result = await readConfig(home, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIG_INVALID');
    expect(result.message.split('\n')).toHaveLength(1);
  });

  it('reports CONFIG_INVALID when config.toml is a directory, not a file', async () => {
    const home = await tempHome();
    await mkdir(configFilePath(home));

    const result = await readConfig(home, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIG_INVALID');
  });
});

describe('writeConfig', () => {
  it('round-trips through readConfig and leaves .env at mode 0600', async () => {
    const home = await tempHome();

    await writeConfig(home, {
      timezone: 'Europe/Berlin',
      databaseUrlEnv: 'MY_BRAIN_URL',
      databaseUrl: URL,
      mirrorPath: '/tmp/elsewhere/brain-mirror',
    });
    const result = await readConfig(home, {});

    expect(result).toEqual({
      ok: true,
      warnings: [],
      config: {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        timezone: 'Europe/Berlin',
        databaseUrlEnv: 'MY_BRAIN_URL',
        databaseUrl: URL,
        mirrorPath: '/tmp/elsewhere/brain-mirror',
      },
    });

    const mode = (await stat(envFilePath(home))).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('creates the folder when it is not there yet', async () => {
    const parent = await tempHome();
    const home = join(parent, 'nested', 'second_brain');

    await writeConfig(home, { databaseUrl: URL });

    const result = await readConfig(home, {});
    expect(result.ok).toBe(true);
  });

  it('writes no key value into config.toml (AD-18)', async () => {
    const home = await tempHome();

    await writeConfig(home, { databaseUrl: URL });

    const document = await readFile(configFilePath(home), 'utf8');
    expect(document).not.toContain(URL);
    expect(document).toContain(DEFAULT_DATABASE_URL_ENV);
  });

  it('tightens the mode of a .env that already existed too loosely', async () => {
    const home = await tempHome();
    await writeFile(envFilePath(home), 'OTHER="x"\n', 'utf8');
    await chmod(envFilePath(home), 0o644);

    await writeConfig(home, { databaseUrl: URL });

    const mode = (await stat(envFilePath(home))).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('keeps variables another story already put in .env', async () => {
    const home = await tempHome();
    await writeConfig(home, { databaseUrl: URL });
    await writeFile(envFilePath(home), `${await readFile(envFilePath(home), 'utf8')}OTHER="kept"\n`);

    await writeConfig(home, { databaseUrl: 'postgres://postgres@127.0.0.1:5432/other' });

    const text = await readFile(envFilePath(home), 'utf8');
    expect(text).toContain('OTHER="kept"');
    expect(text).toContain('other');
  });

  it('round-trips a url whose password needs quoting', async () => {
    const home = await tempHome();
    const awkward = 'postgres://postgres:p%40ss%20w#rd@127.0.0.1:5432/brain';

    await writeConfig(home, { databaseUrl: awkward });
    const result = await readConfig(home, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.databaseUrl).toBe(awkward);
  });

  it('refuses a value .env cannot represent instead of recording another one', async () => {
    const home = await tempHome();

    await expect(writeConfig(home, { databaseUrl: `both '" quotes` })).rejects.toThrow(/quote/);

    // Nothing was written, so the folder is absent rather than half made: a
    // config.toml with no .env reads back as CONFIG_MISSING.
    expect(existsSync(configFilePath(home))).toBe(false);
    expect(existsSync(envFilePath(home))).toBe(false);
  });

  it('refuses a url_env that is not a variable name', async () => {
    const home = await tempHome();

    await expect(
      writeConfig(home, { databaseUrlEnv: 'not a name', databaseUrl: URL }),
    ).rejects.toThrow(/environment variable name/);
  });

  it('refuses a timezone it would then refuse to read back', async () => {
    const home = await tempHome();

    await expect(
      writeConfig(home, { timezone: 'Nowhere/Nope', databaseUrl: URL }),
    ).rejects.toThrow(/time zone/);
  });

  it('refuses a relative mirror path, which it would refuse to read back', async () => {
    const home = await tempHome();

    await expect(
      writeConfig(home, { mirrorPath: 'notes/mirror', databaseUrl: URL }),
    ).rejects.toThrow(/absolute path/);
    expect(existsSync(configFilePath(home))).toBe(false);
  });

  it('writes the default mirror path when it is given none', async () => {
    const home = await tempHome();

    await writeConfig(home, { databaseUrl: URL });

    const document = await readFile(configFilePath(home), 'utf8');
    expect(document).toContain(`path = "${join(home, 'mirror')}"`);
  });
});
