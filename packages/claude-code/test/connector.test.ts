import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectorContract, type ConnectorSubject } from '@second-brain/core/testing';
import { claudeCodeConnector } from '../src/connector.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'brain-connector-'));
  folders.push(dir);
  const target = join(dir, 'settings.json');
  return { dir, target, connector: claudeCodeConnector({ configDir: dir }) };
}
const input = { shimPath: '/unused/bin/brain', pluginRoot: '/plugin' };

async function subject(): Promise<ConnectorSubject> {
  const { target, connector } = await fixture();
  const entries = async (): Promise<string[]> => {
    try {
      const data = JSON.parse(await readFile(target, 'utf8')) as { hooks?: { Stop?: { hooks: { command: string }[] }[] } };
      return data.hooks?.Stop?.flatMap((group) => group.hooks.map((hook) => hook.command)) ?? [];
    } catch { return []; }
  };
  const add = async (command: string) => {
    await writeFile(target, JSON.stringify({ hooks: { Stop: [{ hooks: [...await entries(), command].map((command) => ({ type: 'command', command })) }] } }));
  };
  return { connector, shimPath: input.shimPath, entries, marked: async () => (await entries()).filter((entry) => entry.endsWith('# second-brain')), addForeignEntry: add, addMarkedEntry: () => add('old brain # second-brain') };
}

describe('the plugin connector contract', () => {
  for (const test of connectorContract()) it(test.name, () => test.run(subject));
});

describe('Claude Code settings migration', () => {
  it('removes only marked command hooks and newly empty groups/events, preserving mode and ordering', async () => {
    const { target, connector } = await fixture();
    const foreign = { type: 'command', command: 'echo second-brain' };
    const settings = { permissions: { allow: ['Read'] }, hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'old # second-brain  ' }, foreign] }, { hooks: [{ type: 'command', command: 'old # second-brain' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'old # second-brain' }] }],
      SessionStart: [],
      PreToolUse: [{ hooks: [] }],
    }, tail: true };
    await writeFile(target, JSON.stringify(settings));
    await chmod(target, 0o640);
    expect(await connector.connect(input)).toEqual({ ok: true, target, changed: true });
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ permissions: settings.permissions, hooks: { Stop: [{ matcher: '*', hooks: [foreign] }], SessionStart: [], PreToolUse: [{ hooks: [] }] }, tail: true });
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    const before = await stat(target);
    expect(await connector.connect(input)).toMatchObject({ ok: true, changed: false });
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
  });
  it('does not create missing settings and warns when the plugin has not run', async () => {
    const { target, connector } = await fixture();
    expect(await connector.connect({ ...input, pluginRoot: null })).toEqual({ ok: true, target, changed: false, warnings: ['PLUGIN_NOT_INSTALLED'] });
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['{broken', '[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}', '{"hooks":{"Stop":[{"hooks":"bad"}]}}'])('refuses malformed settings without writing: %s', async (text) => {
    const { target, connector } = await fixture();
    await writeFile(target, text);
    expect(await connector.connect(input)).toMatchObject({ ok: false, code: 'HARNESS_UNREADABLE', message: expect.stringMatching(/[가-힣]/) });
    expect(await readFile(target, 'utf8')).toBe(text);
  });
  it('detect only checks the config folder and leaves unmarked settings byte for byte', async () => {
    const { dir, target, connector } = await fixture();
    const text = '{ "hooks": {"Stop": [{"hooks": [{"type":"command","command":"echo keep"}]}]}, "other": 1 }';
    await writeFile(target, text);
    expect(await connector.detect()).toBe(true);
    expect(await connector.connect(input)).toMatchObject({ ok: true, changed: false });
    expect(await readFile(target, 'utf8')).toBe(text);
    await rm(dir, { recursive: true });
    expect(await connector.detect()).toBe(false);
    await mkdir(dir);
  });
});
