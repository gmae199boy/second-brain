import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STORE_URL_ENV, DEFAULT_UPDATE_AUTO, KNOWN_KEYS, postgresSecrets, readConfig, readConfigForSetup, resolveStoreUrl, writeConfig } from '../src/config/codec.js';
import { HOME_ENV, configFilePath, configHome, envFilePath } from '../src/config/paths.js';
import { tempHomes } from './temp-home.js';
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});
const temporary = tempHomes();
afterEach(async () => { vi.mocked(writeFile).mockRestore(); vi.mocked(rename).mockRestore(); await temporary.cleanup(); });
async function given(config?: string, env?: string) {
  const home = await temporary.create('brain-config-');
  if (config !== undefined) await writeFile(join(home, 'config.toml'), config);
  if (env !== undefined) await writeFile(join(home, '.env'), env);
  return home;
}
describe('configHome', () => {
  it('uses SECOND_BRAIN_HOME when it is set, for tests and reinstalls', () => {
    expect(configHome({ [HOME_ENV]: '/tmp/elsewhere' })).toBe('/tmp/elsewhere');
  });

  it('falls back to ~/.second_brain (AD-18)', () => {
    expect(configHome({})).toMatch(/\.second_brain$/);
  });

  it('ignores an empty override rather than reading the filesystem root', () => {
    expect(configHome({ [HOME_ENV]: '   ' })).toBe(configHome({}));
  });
});

describe('PG configuration', () => {
  it.each(['writeConfig', 'postgresSecrets'] as const)('atomically replaces an existing .env at 0600 through %s', async writer => {
    const home = await given('schema_version=1', 'KEEP="original"\n');
    const path = envFilePath(home);
    await chmod(path, 0o644);
    const before = await stat(path);

    if (writer === 'writeConfig') expect(await writeConfig(home, {})).toEqual({ ok: true });
    else expect(await postgresSecrets(home, 23456, DEFAULT_STORE_URL_ENV)).toMatchObject({ appPassword: expect.any(String) });

    const after = await stat(path);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toContain('KEEP="original"');
    expect((await readdir(home)).sort()).toEqual(['.env', 'config.toml']);
  });

  it.each([
    ['writeConfig', 'write'], ['writeConfig', 'rename'],
    ['postgresSecrets', 'write'], ['postgresSecrets', 'rename'],
  ] as const)('preserves the original .env and cleans temporary files when %s fails during %s', async (writer, stage) => {
    const home = await given('schema_version=1', 'KEEP="original"\n');
    const path = envFilePath(home);
    const before = await readFile(path);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    if (stage === 'rename') vi.mocked(rename).mockRejectedValueOnce(new Error('rename failed'));
    else vi.mocked(writeFile).mockImplementation(async (target, content, options) => {
      if (String(target).startsWith(`${path}.`)) {
        await actual.writeFile(target, 'partial', options);
        throw new Error('write failed');
      }
      return actual.writeFile(target, content, options);
    });

    if (writer === 'writeConfig') expect(await writeConfig(home, {})).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
    else await expect(postgresSecrets(home, 23456, DEFAULT_STORE_URL_ENV)).rejects.toThrow(`${stage} failed`);

    expect(await readFile(path)).toEqual(before);
    expect((await readdir(home)).sort()).toEqual(['.env', 'config.toml']);
  });

  it.each([
    ['""', ''],
    ['"NOT-A-NAME"', 'NOT-A-NAME'],
    ['42', 42],
    ['[]', []],
    ['{ nested = "value" }', { nested: 'value' }],
    ['"BRAIN_APP_PASSWORD"', 'BRAIN_APP_PASSWORD'],
    ['"BRAIN_POSTGRES_PASSWORD"', 'BRAIN_POSTGRES_PASSWORD'],
  ])('rejects invalid or reserved PG selectors consistently without changing files: %s', async (selector, value) => {
    const home = await given(`schema_version=1\n[store]\nurl_env=${selector}\n`, 'KEEP="original"\n');
    const configBefore = await readFile(configFilePath(home));
    const envBefore = await readFile(envFilePath(home));

    expect(await readConfig(home)).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
    expect(await readConfigForSetup(home)).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
    expect(await writeConfig(home, { storeUrlEnv: value as string })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
    await expect(postgresSecrets(home, 23456, value as string)).rejects.toThrow('store.url_env');

    expect(await readFile(configFilePath(home))).toEqual(configBefore);
    expect(await readFile(envFilePath(home))).toEqual(envBefore);
  });

  it('refuses a .env value it cannot represent, and leaves both files byte for byte', async () => {
    const home = await given('schema_version=1\n', 'BOTH=it\'s "x"\n');
    const configBefore = await readFile(configFilePath(home));
    const envBefore = await readFile(envFilePath(home));

    const result = await writeConfig(home, {});

    expect(result).toMatchObject({ ok: false, code: 'CONFIG_INVALID', message: expect.stringContaining('BOTH') });
    expect(await readFile(configFilePath(home))).toEqual(configBefore);
    expect(await readFile(envFilePath(home))).toEqual(envBefore);
  });

  it.each(['schema_version=1\n', 'schema_version=1\n[store]\n', 'schema_version=1\n[store]\npath="rel"\n', 'schema_version=1\n[store]\npath=42\n'])('defaults the selector without validating a legacy path: %s', async text => {
    const home = await given(text);
    const result = await readConfig(home);
    expect(result).toMatchObject({ ok: true, config: { storeUrlEnv: DEFAULT_STORE_URL_ENV, filesPath: join(home, 'files'), mirrorPath: join(home, 'mirror'), updateAuto: true } });
    if (result.ok) expect(result.config).not.toHaveProperty('storePath');
    expect(KNOWN_KEYS).not.toContain('store.path');
  });
  it('retains a legacy path only as an untouched file candidate', async () => {
    const home = await given('schema_version=1\n[store]\npath="rel"\n');
    expect(await readConfigForSetup(home)).toMatchObject({ ok: true, warnings: [], recorded: { legacySqlitePath: 'rel', storeUrlEnv: DEFAULT_STORE_URL_ENV, extra: {} } });
  });
  it('uses PG timezone rules even without a selector', async () => {
    const home = await given('schema_version=1\ntimezone="invalid-zone"\n');
    expect(await readConfig(home)).toMatchObject({ ok: true, config: { fileHasTimezone: true } });
    const read = await readConfig(home);
    if (read.ok) expect(read.config).not.toHaveProperty('timezone');
  });
  it.each(['', 'bad-name', '9NAME', 1, [], {}])('rejects invalid selectors %j on both reading paths', async value => {
    const encoded = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
    const home = await given(`schema_version=1\n[store]\nurl_env=${encoded}\n`);
    expect((await readConfig(home)).ok).toBe(false);
    expect((await readConfigForSetup(home)).ok).toBe(false);
  });
  it.each(['BRAIN_DATABASE_URL', 'CUSTOM_DB', '_PRIVATE'])('accepts selector %s', async selector => {
    const home = await given(`schema_version=1\n[store]\nurl_env="${selector}"\n`);
    expect(await readConfig(home)).toMatchObject({ ok: true, config: { storeUrlEnv: selector } });
  });
  it.each(['', 'schema_version=2', 'schema_version="1"', 'schema_version=1.5', 'broken = ['])('rejects invalid configuration %s', async config => {
    expect(await readConfig(await given(config))).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
  });
  it('requires a configuration file for ordinary commands', async () => {
    const home = await given();
    expect(await readConfig(home)).toMatchObject({ ok: false, code: 'CONFIG_MISSING' });
    expect(await readConfigForSetup(home)).toEqual({ ok: true, recorded: undefined, warnings: [] });
  });
  it.each(['files', 'mirror'])('validates %s paths', async table => {
    for (const value of ['"relative"', '""', '42']) {
      const home = await given(`schema_version=1\n[${table}]\npath=${value}`);
      expect(await readConfig(home)).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
      expect(await readConfigForSetup(home)).toMatchObject({ ok: true, warnings: [expect.objectContaining({ code: 'CONFIG_VALUE_RESET' })] });
    }
  });
  it('warns about unknown values and preserves them on setup rewrite', async () => {
    const home = await given('schema_version=1\n[other]\ncolour="blue"\n[store]\npath="old.db"\n');
    const read = await readConfigForSetup(home);
    expect(read).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.objectContaining({ code: 'CONFIG_UNKNOWN_KEY' })]) });
    if (!read.ok) return;
    expect(await writeConfig(home, { extra: read.recorded?.extra })).toEqual({ ok: true });
    const text = await readFile(join(home, 'config.toml'), 'utf8');
    expect(text).toContain('colour = "blue"');
    expect(text).not.toContain('old.db');
    expect(text).toContain('url_env = "BRAIN_DATABASE_URL"');
  });
  it('rewrites all known paths, drops file timezone and legacy store.path even from extras, and preserves secrets at 0600', async () => {
    const home = await given('schema_version=1', 'TOKEN="secret"\n');
    await chmod(join(home, '.env'), 0o644);
    expect(await writeConfig(home, { storeUrlEnv: 'CUSTOM_DB', filesPath: '/tmp/files', mirrorPath: '/tmp/mirror', updateAuto: false, timezone: 'Europe/Berlin', extra: { store: { path: '/old.db' }, timezone: 'bad' } })).toEqual({ ok: true });
    const text = await readFile(join(home, 'config.toml'), 'utf8');
    expect(text).not.toMatch(/timezone|old.db|secret/);
    expect(await readConfig(home)).toMatchObject({ ok: true, config: { storeUrlEnv: 'CUSTOM_DB', filesPath: '/tmp/files', mirrorPath: '/tmp/mirror', updateAuto: false } });
    expect((await stat(join(home, '.env'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(home, '.env'), 'utf8')).toContain('secret');
  });
  it.each(['filesPath', 'mirrorPath'] as const)('refuses relative %s on write', async key => {
    expect(await writeConfig(await given(), { [key]: 'relative' })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
  });
  it('keeps setup values individually and repairs malformed values', async () => {
    const home = await given('schema_version=1\ntimezone="Europe/Berlin"\n[files]\npath="/tmp/files"\n[update]\nauto="no"');
    expect(await readConfigForSetup(home)).toMatchObject({ ok: true, recorded: { timezone: 'Europe/Berlin', filesPath: '/tmp/files' }, warnings: [expect.objectContaining({ code: 'CONFIG_VALUE_RESET' })] });
  });
});
describe('[update] auto', () => {
  it('defaults to on, because that is what a plugin is for', async () => {
    const home = await given('schema_version=1\n');
    expect(await readConfig(home)).toMatchObject({ ok: true, config: { updateAuto: true } });
    expect(DEFAULT_UPDATE_AUTO).toBe(true);
  });

  it('is CONFIG_INVALID for a command when it is not a boolean', async () => {
    const home = await given('schema_version=1\n[update]\nauto="yes"\n');
    expect(await readConfig(home)).toMatchObject({ ok: false, code: 'CONFIG_INVALID', message: expect.stringContaining('update.auto') });
  });

  it('is written, and read back, both ways round', async () => {
    const home = await given();
    for (const auto of [true, false]) {
      expect(await writeConfig(home, { updateAuto: auto })).toEqual({ ok: true });
      expect(await readConfig(home)).toMatchObject({ ok: true, config: { updateAuto: auto } });
      expect(await readConfigForSetup(home)).toMatchObject({ ok: true, recorded: { updateAuto: auto } });
    }
  });
});

describe('URL resolution', () => {
  it('prefers process values and lets an explicitly empty value suppress .env', async () => {
    const home = await given('schema_version=1', 'CUSTOM_DB=postgresql://file/brain\n');
    expect(await resolveStoreUrl(home, 'CUSTOM_DB', { CUSTOM_DB: 'postgresql://process/brain' })).toBe('postgresql://process/brain');
    expect(await resolveStoreUrl(home, 'CUSTOM_DB', { CUSTOM_DB: '' })).toBeUndefined();
    expect(await resolveStoreUrl(home, 'CUSTOM_DB', {})).toBe('postgresql://file/brain');
    expect(await resolveStoreUrl(home, 'MISSING', {})).toBeUndefined();
  });
});
