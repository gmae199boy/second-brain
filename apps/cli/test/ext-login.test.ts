import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { extHome } from './ext-fixture.js';
const tty = vi.hoisted(() => ({ enabled: false }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => tty.enabled && args[0] === '/dev/tty' ? Promise.resolve({ close: async () => {} }) : actual.open(...args) };
});
import { extLoginCommand, launchTerminal } from '../src/commands/ext-login.js';

describe('terminal extension login', () => {
  it('rejects non-terminal input before opening the store', async () => {
    expect(extLoginCommand.standalone).toBe(true);
    if (extLoginCommand.standalone !== true) throw new Error('wrong command');
    const result = await extLoginCommand.run({ args: ['garmin'], env: {}, options: {}, clock: {} as never, stdin: async () => '', recordHookArrival: async () => {} });
    expect(result).toMatchObject({ ok: false, code: 'LOGIN_REQUIRED' });
  });
  it('accepts only a declared final error code from a child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'login-test-'));
    const entry = join(dir, 'entry.mjs');
    try {
      await writeFile(entry, "process.exit(0);\n");
      expect(await launchTerminal(process.execPath, entry, {}, ['RATE_LIMITED'])).toMatchObject({ status: 0 });
      await writeFile(entry, "console.error('RATE_LIMITED'); process.exit(1);\n");
      expect(await launchTerminal(process.execPath, entry, {}, ['RATE_LIMITED'])).toEqual({ status: 1, code: 'RATE_LIMITED' });
      await writeFile(entry, "console.error('private response'); process.exit(1);\n");
      expect(await launchTerminal(process.execPath, entry, {}, ['RATE_LIMITED'])).toEqual({ status: 1, code: 'LOGIN_REQUIRED' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

it('terminal login requires self and passes scope-aware snapshot to the child', async () => {
  const { mkdir, readFile, access } = await import('node:fs/promises');
  const fixture = await extHome(), directory = join(fixture.home, 'extensions', 'testext');
  const streams = [process.stdin, process.stdout, process.stderr];
  const descriptors = streams.map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ name: 'testext', version: '1', core: 1, abi: 1, migrations: 'migrations', connection_check: { runtime: 'node', entry: 'check.mjs' }, auth: { kind: 'testext.login', execution: 'supervised', runtime: 'node', entry: 'login.mjs' }, settings: [{ key: 'testext.global', type: 'string', required: ['auth'], scope: 'global' }] }));
    await writeFile(join(directory, 'login.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.BRAIN_EXTENSION_HOME+'/login-snapshot',process.env.BRAIN_SETTINGS_SNAPSHOT);\n");
    await fixture.db.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('testext','1',now(),true,now()); insert into brain.settings(user_id,key,value,updated_at) values (null,'testext.global','global',now()),((select id from brain.users where is_self=1),'testext.global','user',now())");
    const selfId = (await fixture.db.rows('select id from brain.users where is_self=1'))[0]!.id;
    await fixture.db.query('update brain.users set is_self=0 where is_self=1');
    tty.enabled = true; for (const stream of streams) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
    if (!extLoginCommand.standalone) throw Error('wrong command');
    const context = { args: ['testext'], env: fixture.env, options: {}, clock: {} as never, stdin: async () => '', recordHookArrival: async () => {} };
    expect(await extLoginCommand.run(context)).toMatchObject({ ok: false, code: 'USER_MISSING' });
    expect(await access(join(directory, 'login-snapshot')).then(() => true, () => false)).toBe(false);
    const gateOwner = '12345678-1234-1234-1234-123456789abc';
    await fixture.db.query(`insert into brain.extension_quiesce(name,owner,started_at) values ('testext','${gateOwner}',now())`);
    expect(await extLoginCommand.run(context)).toMatchObject({ok:false,code:'DB_LOCKED',message:expect.stringContaining('중단된 확장 설치')});
    expect(await access(join(directory, 'login-snapshot')).then(() => true, () => false)).toBe(false);
    await fixture.db.query("delete from brain.extension_quiesce where name='testext'");
    const progress = {name:'testext',packageDigest:'a'.repeat(64),result:null,failedStage:null,lastFailure:null,stages:{},authWorkId:null,scheduleIds:[],replacement:{owner:gateOwner,fromVersion:'1',at:'2026-10-29T00:00:00.000Z'}};
    await fixture.db.query(`insert into brain.extension_install_progress(name,revision,progress) values ('testext',1,'${JSON.stringify(progress)}'::jsonb)`);
    expect(await extLoginCommand.run(context)).toMatchObject({ok:false,code:'EXTENSION_REPLACEMENT_REQUIRED'});
    await fixture.db.query("update brain.extension_install_progress set progress=jsonb_set(progress - 'replacement', '{unknown}', 'true'::jsonb) where name='testext'");
    expect(await extLoginCommand.run(context)).toMatchObject({ok:false,code:'USER_MISSING'});
    await fixture.db.query(`update brain.users set is_self=1 where id='${selfId}'`);
    expect(await extLoginCommand.run(context)).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(join(directory, 'login-snapshot'), 'utf8'))).toMatchObject({ user_id: selfId, values: { 'testext.global': 'global' } });
  } finally {
    tty.enabled = false;
    streams.forEach((stream, index) => { const descriptor = descriptors[index]; if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else Reflect.deleteProperty(stream, 'isTTY'); });
    await fixture.cleanup();
  }
}, 60000);
