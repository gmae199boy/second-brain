import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_TIMEZONE,
  defaultFilesPath,
  defaultMirrorPath,
  defaultStorePath,
  readConfig,
  readConfigForSetup,
  writeConfig,
} from '../src/config/codec.js';
import { HOME_ENV, configFilePath, configHome, envFilePath } from '../src/config/paths.js';
import { assertKoreanLine } from './language.js';

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
  it('reads the three paths and the time zone the file names', async () => {
    const home = await given({
      config: `${VALID_CONFIG}timezone = "Europe/Berlin"\n\n[store]\npath = "/tmp/elsewhere/brain.db"\n\n[files]\npath = "/tmp/elsewhere/files"\n\n[mirror]\npath = "/tmp/elsewhere/brain-mirror"\n`,
    });

    const result = await readConfig(home);

    expect(result).toEqual({
      ok: true,
      warnings: [],
      config: {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        timezone: 'Europe/Berlin',
        storePath: '/tmp/elsewhere/brain.db',
        filesPath: '/tmp/elsewhere/files',
        mirrorPath: '/tmp/elsewhere/brain-mirror',
      },
    });
  });

  it('defaults all three paths under the configuration folder', async () => {
    const home = await given({ config: VALID_CONFIG });

    const result = await readConfig(home);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.storePath).toBe(join(home, 'brain.db'));
    expect(result.config.filesPath).toBe(join(home, 'files'));
    expect(result.config.mirrorPath).toBe(join(home, 'mirror'));
    expect([
      defaultStorePath(home),
      defaultFilesPath(home),
      defaultMirrorPath(home),
    ]).toEqual([join(home, 'brain.db'), join(home, 'files'), join(home, 'mirror')]);
  });

  it('defaults the timezone', async () => {
    const home = await given({ config: VALID_CONFIG });

    const result = await readConfig(home);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.timezone).toBe(DEFAULT_TIMEZONE);
  });

  it('reads a folder whose .env cannot be parsed at all, because it reads none', async () => {
    // Every key this version knows is a path or a time zone, so there is
    // nothing in `.env` to resolve — and a broken one must not block a command
    // over a file nothing needs yet.
    const home = await given({ config: VALID_CONFIG, env: 'this is not = = an env file\n' });

    const result = await readConfig(home);

    expect(result.ok).toBe(true);
  });
});

describe('readConfig and a key it does not know', () => {
  it('runs anyway and warns with CONFIG_UNKNOWN_KEY, naming the key', async () => {
    const home = await given({ config: `${VALID_CONFIG}colour = "x"\n` });

    const result = await readConfig(home);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('CONFIG_UNKNOWN_KEY');
    expect(result.warnings[0]?.message).toContain('colour');
    assertKoreanLine(result.warnings[0]?.message ?? '', { label: 'CONFIG_UNKNOWN_KEY' });
  });

  it('warns about the url_env an earlier layout wrote, rather than dropping it', async () => {
    const home = await given({
      config: `${VALID_CONFIG}[database]\nurl_env = "SECOND_BRAIN_DATABASE_URL"\n`,
    });

    const result = await readConfig(home);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((warning) => warning.code)).toEqual(['CONFIG_UNKNOWN_KEY']);
    expect(result.warnings[0]?.message).toContain('database.url_env');
  });

  it('names the whole path of a key inside a table', async () => {
    const home = await given({
      config: `${VALID_CONFIG}[store]\npath = "/tmp/brain.db"\nport = 5432\n`,
    });

    const result = await readConfig(home);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((warning) => warning.message.includes('store.port'))).toEqual([
      true,
    ]);
  });

  it.each(['store', 'files', 'mirror'])('says nothing about an empty [%s]', async (table) => {
    const home = await given({ config: `${VALID_CONFIG}[${table}]\n` });

    const result = await readConfig(home);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });

  it('reports an unknown table that holds nothing, rather than ignoring it', async () => {
    const home = await given({ config: `${VALID_CONFIG}[colour]\n` });

    const result = await readConfig(home);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings[0]?.message).toContain('colour');
  });

  it('warns once per unknown key, in a stable order', async () => {
    const home = await given({ config: `${VALID_CONFIG}zebra = 1\nalpha = 2\n` });

    const result = await readConfig(home);

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

    const result = await readConfig(home);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIG_MISSING');
    expect(result.message).toContain('config.toml');
    assertKoreanLine(result.message, { label: 'CONFIG_MISSING' });
  });

  it.each([
    ['broken TOML', 'schema_version = =\n'],
    ['no schema_version', 'timezone = "Asia/Seoul"\n'],
    ['a schema_version that is not an integer', 'schema_version = "1"\n'],
    ['an unsupported schema_version', 'schema_version = 99\n'],
    ['a timezone of the wrong type', `${VALID_CONFIG}timezone = 9\n`],
    ['a timezone no machine knows', `${VALID_CONFIG}timezone = "Nowhere/Nope"\n`],
    // A relative path would be a different place for every working directory a
    // command happens to be started from, so a hook and the user would not be
    // looking at the same database.
    ['a relative store path', `${VALID_CONFIG}[store]\npath = "brain.db"\n`],
    ['a store path of the wrong type', `${VALID_CONFIG}[store]\npath = 7\n`],
    ['an empty store path', `${VALID_CONFIG}[store]\npath = ""\n`],
    ['a relative files path', `${VALID_CONFIG}[files]\npath = "files"\n`],
    ['a files path of the wrong type', `${VALID_CONFIG}[files]\npath = 7\n`],
    ['an empty files path', `${VALID_CONFIG}[files]\npath = ""\n`],
    ['a relative mirror path', `${VALID_CONFIG}[mirror]\npath = "notes/mirror"\n`],
    ['a mirror path of the wrong type', `${VALID_CONFIG}[mirror]\npath = 7\n`],
    ['an empty mirror path', `${VALID_CONFIG}[mirror]\npath = ""\n`],
  ])('reports CONFIG_INVALID for %s', async (_name, config) => {
    const home = await given({ config });

    const result = await readConfig(home);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIG_INVALID');
    expect(result.message.split('\n')).toHaveLength(1);
    // Every branch of the codec's refusal, in one place: the message is the
    // one thing a person reads, so it is Korean whichever key was wrong
    // (Conventions, output language 2026-10-16).
    assertKoreanLine(result.message, { label: 'CONFIG_INVALID' });
  });

  it('names the key in the message for a relative path', async () => {
    const home = await given({ config: `${VALID_CONFIG}[store]\npath = "brain.db"\n` });

    const result = await readConfig(home);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('store.path');
    expect(result.message).toContain('절대 경로여야 합니다');
  });

  it('reports CONFIG_INVALID when config.toml is a directory, not a file', async () => {
    const home = await tempHome();
    await mkdir(configFilePath(home));

    const result = await readConfig(home);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIG_INVALID');
    assertKoreanLine(result.message, { label: 'CONFIG_INVALID' });
  });
});

describe('writeConfig', () => {
  it('round-trips through readConfig and leaves .env at mode 0600', async () => {
    const home = await tempHome();

    await writeConfig(home, {
      timezone: 'Europe/Berlin',
      storePath: '/tmp/elsewhere/brain.db',
      filesPath: '/tmp/elsewhere/files',
      mirrorPath: '/tmp/elsewhere/brain-mirror',
    });
    const result = await readConfig(home);

    expect(result).toEqual({
      ok: true,
      warnings: [],
      config: {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        timezone: 'Europe/Berlin',
        storePath: '/tmp/elsewhere/brain.db',
        filesPath: '/tmp/elsewhere/files',
        mirrorPath: '/tmp/elsewhere/brain-mirror',
      },
    });

    const mode = (await stat(envFilePath(home))).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('creates the folder when it is not there yet', async () => {
    const parent = await tempHome();
    const home = join(parent, 'nested', 'second_brain');

    await writeConfig(home, {});

    const result = await readConfig(home);
    expect(result.ok).toBe(true);
  });

  it('writes the defaults when it is given none', async () => {
    const home = await tempHome();

    await writeConfig(home, {});

    const document = await readFile(configFilePath(home), 'utf8');
    expect(document).toContain(`path = "${join(home, 'brain.db')}"`);
    expect(document).toContain(`path = "${join(home, 'files')}"`);
    expect(document).toContain(`path = "${join(home, 'mirror')}"`);
  });

  it('tightens the mode of a .env that already existed too loosely', async () => {
    const home = await tempHome();
    await writeFile(envFilePath(home), 'OTHER="x"\n', 'utf8');
    await chmod(envFilePath(home), 0o644);

    await writeConfig(home, {});

    const mode = (await stat(envFilePath(home))).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('keeps variables another story already put in .env', async () => {
    const home = await tempHome();
    await writeConfig(home, {});
    await writeFile(envFilePath(home), `${await readFile(envFilePath(home), 'utf8')}OTHER="kept"\n`);

    await writeConfig(home, { timezone: 'Europe/Berlin' });

    const text = await readFile(envFilePath(home), 'utf8');
    expect(text).toContain('OTHER="kept"');
  });

  it('writes no path into .env (AD-18 cuts the other way too)', async () => {
    const home = await tempHome();

    await writeConfig(home, { storePath: '/tmp/elsewhere/brain.db' });

    const text = await readFile(envFilePath(home), 'utf8');
    expect(text).not.toContain('/tmp/elsewhere/brain.db');
  });

  it('refuses a timezone it would then refuse to read back, as a value', async () => {
    const home = await tempHome();

    const result = await writeConfig(home, { timezone: 'Nowhere/Nope' });

    // A value and not a throw: the installer has a line to print and an exit
    // code to answer with, and a stack trace is neither (F5).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIG_INVALID');
    assertKoreanLine(result.message, { label: 'writeConfig timezone' });
    expect(existsSync(configFilePath(home))).toBe(false);
  });

  it.each([
    ['storePath', { storePath: 'brain.db' }],
    ['filesPath', { filesPath: 'files' }],
    ['mirrorPath', { mirrorPath: 'notes/mirror' }],
  ])('refuses a relative %s, which it would refuse to read back', async (_name, input) => {
    const home = await tempHome();

    const result = await writeConfig(home, input);

    expect(result).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
    if (result.ok) return;
    expect(result.message).toContain('절대 경로');
    expect(existsSync(configFilePath(home))).toBe(false);
  });

  it('refuses a .env value it cannot represent, and writes neither file', async () => {
    const home = await tempHome();
    // Unquoted, so Node reads the rest of the line: a value holding both an
    // apostrophe and a double quote is one `.env` cannot be written back from.
    await writeFile(envFilePath(home), 'BOTH=it\'s "x"\n', 'utf8');

    const result = await writeConfig(home, {});

    // `.env` as Node reads it has no escape syntax, so a value holding both
    // quotes cannot be round-tripped. Saying so beats recording something else.
    expect(result).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
    if (result.ok) return;
    expect(result.message).toContain('BOTH');
    expect(existsSync(configFilePath(home))).toBe(false);
  });

  it('writes the keys this version does not know back, under the ones it does', async () => {
    const home = await tempHome();

    const result = await writeConfig(home, {
      extra: { database: { url_env: 'X' }, store: { extra: 1 }, colour: 'red' },
    });

    expect(result).toEqual({ ok: true });
    const document = await readFile(configFilePath(home), 'utf8');
    expect(document).toContain('url_env = "X"');
    expect(document).toContain('extra = 1');
    expect(document).toContain('colour = "red"');
    // The table this version owns keeps its own key beside the unknown one.
    expect(document).toContain(`path = "${defaultStorePath(home)}"`);
  });

  it('lets a known key win over an unknown one of the same name', async () => {
    const home = await tempHome();

    await writeConfig(home, {
      storePath: '/tmp/chosen/brain.db',
      extra: { store: { path: '/tmp/stale/brain.db' }, timezone: 'Nowhere/Nope' },
    });

    const document = await readFile(configFilePath(home), 'utf8');
    expect(document).toContain('path = "/tmp/chosen/brain.db"');
    expect(document).not.toContain('/tmp/stale/brain.db');
    expect(document).not.toContain('Nowhere/Nope');
  });
});

describe('readConfigForSetup', () => {
  it('says nothing is recorded when there is no file, rather than failing', async () => {
    const home = await tempHome();

    expect(await readConfigForSetup(home)).toEqual({
      ok: true,
      recorded: undefined,
      warnings: [],
    });
  });

  it('reads every value a complete folder holds', async () => {
    const home = await tempHome();
    await writeConfig(home, {
      timezone: 'Europe/Berlin',
      storePath: '/tmp/a/brain.db',
      filesPath: '/tmp/a/files',
      mirrorPath: '/tmp/a/mirror',
    });

    const read = await readConfigForSetup(home);

    expect(read).toEqual({
      ok: true,
      recorded: {
        timezone: 'Europe/Berlin',
        storePath: '/tmp/a/brain.db',
        filesPath: '/tmp/a/files',
        mirrorPath: '/tmp/a/mirror',
        extra: {},
      },
      warnings: [],
    });
  });

  it('drops only the value it cannot use, and names it', async () => {
    const home = await given({
      config: [
        `schema_version = ${String(CONFIG_SCHEMA_VERSION)}`,
        'timezone = "Europe/Berlin"',
        '[store]',
        'path = "brain.db"',
        '[files]',
        'path = "/tmp/a/files"',
        '[mirror]',
        'path = "/tmp/a/mirror"',
        '',
      ].join('\n'),
    });

    const read = await readConfigForSetup(home);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The relative store path is gone; the three values beside it are not.
    expect(read.recorded).toEqual({
      timezone: 'Europe/Berlin',
      filesPath: '/tmp/a/files',
      mirrorPath: '/tmp/a/mirror',
      extra: {},
    });
    expect(read.warnings.map((warning) => warning.code)).toEqual(['CONFIG_VALUE_RESET']);
    expect(read.warnings[0]?.message).toContain('store.path');
    // The default, named as the default: a `--store-path` flag or a typed
    // answer wins over it, so a message promising it would be used would be
    // one the next line contradicts.
    expect(read.warnings[0]?.message).toContain(`기본값은 "${defaultStorePath(home)}"입니다`);
    assertKoreanLine(read.warnings[0]?.message ?? '', { label: 'reset warning' });
  });

  it.each([
    ['a time zone this machine does not know', 'timezone = "Nowhere/Nope"', 'timezone'],
    ['a store path that is a number', '[store]\npath = 7', 'store.path'],
    ['an empty files path', '[files]\npath = ""', 'files.path'],
  ])('resets %s on its own', async (_what, lines, key) => {
    const home = await given({
      config: `schema_version = ${String(CONFIG_SCHEMA_VERSION)}\n${lines}\n`,
    });

    const read = await readConfigForSetup(home);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.warnings.map((warning) => warning.code)).toEqual(['CONFIG_VALUE_RESET']);
    expect(read.warnings[0]?.message).toContain(key);
  });

  it.each([
    ['no schema_version at all', 'timezone = "Asia/Seoul"\n'],
    ['a schema_version that is not an integer', 'schema_version = "1"\n'],
  ])('warns and writes version 1 for %s', async (_what, config) => {
    const home = await given({ config });

    const read = await readConfigForSetup(home);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.warnings.map((warning) => warning.code)).toContain('CONFIG_VALUE_RESET');
    const said = read.warnings.find((warning) => warning.message.includes('schema_version'));
    expect(said).toBeDefined();
    // A value that is not there has no kind to name, and `undefined` is not a
    // word in a sentence a person reads.
    expect(said?.message).not.toContain('undefined');
    expect(said?.message).toContain('기본값은 "1"입니다');
    assertKoreanLine(said?.message ?? '', { label: 'schema_version reset' });
  });

  it('keeps the keys it does not know, and warns about each of them', async () => {
    const home = await given({
      config: [
        `schema_version = ${String(CONFIG_SCHEMA_VERSION)}`,
        '[database]',
        'url_env = "X"',
        '[store]',
        `path = "/tmp/a/brain.db"`,
        'extra = 1',
        '',
      ].join('\n'),
    });

    const read = await readConfigForSetup(home);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // In the shape the document had them, so writing the folder back renders
    // them again without this version knowing anything about them (F2).
    expect(read.recorded?.extra).toEqual({ database: { url_env: 'X' }, store: { extra: 1 } });
    expect(read.warnings.map((warning) => warning.code)).toEqual([
      'CONFIG_UNKNOWN_KEY',
      'CONFIG_UNKNOWN_KEY',
    ]);
  });

  it.each([
    ['a document that is not TOML', 'this is not toml\n'],
    ['a schema_version from a newer layout', 'schema_version = 2\n'],
  ])('refuses %s, so the install writes nothing over it', async (_what, config) => {
    const home = await given({ config });

    const read = await readConfigForSetup(home);

    expect(read).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
    if (read.ok) return;
    assertKoreanLine(read.message, { label: 'readConfigForSetup refusal' });
  });

  it('round-trips the whole folder, unknown keys and all', async () => {
    const home = await given({
      config: [
        `schema_version = ${String(CONFIG_SCHEMA_VERSION)}`,
        'timezone = "Europe/Berlin"',
        '[store]',
        'path = "/tmp/a/brain.db"',
        'extra = 1',
        '[files]',
        'path = "/tmp/a/files"',
        '[mirror]',
        'path = "/tmp/a/mirror"',
        '[database]',
        'url_env = "X"',
        '',
      ].join('\n'),
    });

    const first = await readConfigForSetup(home);
    expect(first.ok).toBe(true);
    if (!first.ok || first.recorded === undefined) return;
    expect(await writeConfig(home, { ...first.recorded })).toEqual({ ok: true });
    const once = await readFile(configFilePath(home), 'utf8');

    const again = await readConfigForSetup(home);
    expect(again.ok).toBe(true);
    if (!again.ok || again.recorded === undefined) return;
    expect(await writeConfig(home, { ...again.recorded })).toEqual({ ok: true });

    // Byte for byte: a re-run that reordered or dropped a key would be a
    // folder nobody could keep by hand.
    expect(await readFile(configFilePath(home), 'utf8')).toBe(once);
    expect(once).toContain('url_env = "X"');
    expect(once).toContain('extra = 1');
    // And `readConfig` reads back what this wrote, which is the whole point of
    // sharing the checks.
    expect((await readConfig(home)).ok).toBe(true);
  });
});
