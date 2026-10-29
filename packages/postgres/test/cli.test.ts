import pg from 'pg';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { TestDatabase } from '@second-brain/test-db';
import { sampleSelfUserInput } from '@second-brain/core/testing';
import { postgresStore } from '../src/index.js';
import { database } from './fixture.js';
const bin=fileURLToPath(new URL('../../../apps/cli/dist/bin.js',import.meta.url));
const fixture=fileURLToPath(new URL('../../claude-code/test/fixtures/two-turns.jsonl',import.meta.url));
const fakeLaunchctl=fileURLToPath(new URL('../../../apps/cli/test/fixtures/fake-launchctl.sh',import.meta.url));
const homes:string[]=[];const databases:TestDatabase[]=[];
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.drop()));await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));});
interface Result { code:number|null; stdout:string; stderr:string }
function run(args:string[],env:NodeJS.ProcessEnv,input=''):Promise<Result>{return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[bin,...args],{env,stdio:['pipe','pipe','pipe']});let stdout='';let stderr='';
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input);
});}
async function world(){
  const home=await mkdtemp(join(tmpdir(),'brain-pg-hook-'));homes.push(home);
  const env:NodeJS.ProcessEnv={...process.env,SECOND_BRAIN_HOME:home,CLAUDE_CONFIG_DIR:join(home,'claude'),SECOND_BRAIN_LAUNCH_AGENTS:join(home,'agents'),SECOND_BRAIN_LAUNCHCTL:fakeLaunchctl,FAKE_LAUNCHCTL_DIR:join(home,'launchctl')};
  delete env.BRAIN_DATABASE_URL;
  await mkdir(join(home,'claude'),{recursive:true});
  const db=await database();databases.push(db);const store=postgresStore({databaseUrl:db.appUrl});
  try{expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);}finally{await store.close();}
  await writeFile(join(home,'config.toml'),'schema_version = 1\n[store]\nurl_env = "BRAIN_DATABASE_URL"\n');
  await writeFile(join(home,'.env'),`BRAIN_DATABASE_URL=${db.appUrl}\n`,{mode:0o600});
  const input=JSON.stringify({session_id:'pg-hook',transcript_path:fixture,hook_event_name:'Stop'});
  return {home,env,db,hook:(override:NodeJS.ProcessEnv={})=>run(['sessions','ingest','claude-code','--json'],{...env,...override},input)};
}
it('collects through the built hook into PG only, replays idempotently and handles two processes',async()=>{
  const kit=await world();const results=await Promise.all([kit.hook(),kit.hook()]);
  const envelopes=results.map(r=>{expect(r.code,r.stderr).toBe(0);return JSON.parse(r.stdout);});
  expect(envelopes.every(r=>r.ok&&!r.data.spooled)).toBe(true);
  const sessions=await kit.db.rows('select workspace_id from brain.sessions');expect(sessions).toEqual([{workspace_id:null}]);
  expect((await kit.db.rows('select * from brain.messages')).length).toBeGreaterThan(0);expect((await kit.db.rows('select * from brain.tool_notes')).length).toBeGreaterThan(0);
  const replay=JSON.parse((await kit.hook()).stdout);expect(replay.data.inserted).toEqual({messages:0,toolNotes:0});
});
it.each(['refused','missing-url','missing-schema','version','session-lock','schema-lock'] as const)('spools the built hook on %s and exits zero',async kind=>{
  const kit=await world();let override:NodeJS.ProcessEnv={};
  let blocker:pg.Client|undefined;
  const locked=kind==='session-lock'||kind==='schema-lock';
  if(locked){blocker=new pg.Client({connectionString:kit.db.url});await blocker.connect();await blocker.query('begin');await blocker.query(`lock table brain.${kind==='session-lock'?'sessions':'schema_migrations'} in access exclusive mode`);}
  try {
  if(kind==='refused')override={BRAIN_DATABASE_URL:'postgresql://brain_app:unavailable@127.0.0.1:1/brain'};
  if(kind==='missing-url')override={BRAIN_DATABASE_URL:''};
  if(kind==='missing-schema')await kit.db.query('drop schema brain cascade');
  if(kind==='version')await kit.db.query('update brain.schema_migrations set version = 7 where owner=$$core$$ and version=(select max(version) from brain.schema_migrations where owner=$$core$$)');
  const result=await kit.hook(override);expect(result.code,result.stderr).toBe(0);const envelope=JSON.parse(result.stdout);
  expect(envelope.ok).toBe(true);expect(envelope.data.spooled).toBe(true);expect(envelope.warnings).toContain('SPOOLED');if(!locked)expect(envelope.warnings).toContain(kind==='version'?'SCHEMA_MISMATCH':'DB_UNAVAILABLE');
  const files=(await readdir(join(kit.home,'spool'))).filter(n=>n.endsWith('.jsonl'));expect(files.length).toBeGreaterThan(0);
  if(locked){const record=JSON.parse((await readFile(join(kit.home,'spool',files[0]!),'utf8')).trim());expect(record.payload.cause).toBe('DB_LOCKED');}
  } finally {if(blocker){await blocker.query('rollback');await blocker.end();}}
});

it('collects parser-accepted NUL text through the hook and reads back the original bytes', async () => {
  const kit = await world();
  const transcript = join(kit.home, 'nul.jsonl');
  const body = 'before\u0000after';
  await writeFile(transcript, JSON.stringify({ type: 'user', uuid: 'nul-message', timestamp: '2026-10-28T00:00:00.000Z',
    message: { role: 'user', content: body } }) + '\n');
  const payload = JSON.stringify({ session_id: 'pg-nul', transcript_path: transcript, hook_event_name: 'Stop' });
  const hook = () => run(['sessions', 'ingest', 'claude-code', '--json'], kit.env, payload);
  const first = await hook();
  expect(first.code, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, data: { spooled: false, inserted: { messages: 1 } } });
  expect(await kit.db.rows('select body, body_raw from brain.messages'))
    .toEqual([{ body: 'before\ufffdafter', body_raw: Buffer.from(body) }]);
  const store = postgresStore({ databaseUrl: kit.db.appUrl });
  try {
    expect(await store.readSession('claude-code:pg-nul')).toMatchObject({ ok: true, messages: [{ body }] });
  } finally { await store.close(); }
  expect(JSON.parse((await hook()).stdout)).toMatchObject({ ok: true, data: { inserted: { messages: 0, toolNotes: 0 } } });
});

it('reads defaults, persists normalized config across processes and rejects invalid changes without spool', async () => {
  const kit = await world();
  const config = (args: string[], env = kit.env) => run(['config', ...args, '--json'], env);
  const first = await config(['get', 'timezone']);
  expect(first.code, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, data: { key: 'timezone', value: 'Asia/Seoul', source: 'default', updated_at: null } });
  const written = await config(['set', 'timezone', 'america/new_york']);
  expect(written.code, written.stderr).toBe(0);
  const value = JSON.parse(written.stdout).data;
  expect(value).toMatchObject({ key: 'timezone', value: 'America/New_York', source: 'db', updated_at: expect.any(String) });
  expect(JSON.parse((await config(['get', 'timezone'])).stdout).data).toEqual(value);
  const before = await kit.db.rows('select * from brain.settings');
  for (const args of [['set','timezone','Mars/Base'], ['set','timezone','+09:00'], ['set','timezone',''], ['get','nope'], ['set','garmin.x','1']]) {
    const result = await config(args);
    expect(result.code, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'CONFIG_INVALID' } });
  }
  expect(await kit.db.rows('select * from brain.settings')).toEqual(before);
  for (const verb of ['get', 'set']) {
    const result = await config([verb, 'timezone', ...(verb === 'set' ? ['Asia/Seoul'] : [])], { ...kit.env, BRAIN_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/brain' });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'DB_UNAVAILABLE' } });
  }
  expect((await readdir(join(kit.home, 'spool')).catch(() => [])).filter(name => name.endsWith('.jsonl'))).toEqual([]);
});
it('uses the default selector and preserves schema mismatch errors', async () => {
  const kit = await world();
  await kit.db.query('update brain.schema_migrations set version = 7 where owner=$$core$$ and version=(select max(version) from brain.schema_migrations where owner=$$core$$)');
  expect(JSON.parse((await run(['config','get','timezone','--json'],kit.env)).stdout)).toMatchObject({ ok:false,error:{code:'SCHEMA_MISMATCH'} });
  const config = await readFile(join(kit.home, 'config.toml'), 'utf8');
  await writeFile(join(kit.home, 'config.toml'), config.replace('url_env = "BRAIN_DATABASE_URL"', ''));
  const result = await run(['config','get','timezone','--json'],kit.env);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok:false,error:{code:'SCHEMA_MISMATCH'} });
});

it('spools the built hook within the turn connect budget when the database never answers', async () => {
  const { createServer } = await import('node:net');
  const { CONNECT_TIMEOUT_MS } = await import('@second-brain/core');
  const sockets = new Set<import('node:net').Socket>();
  const listener = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('no listener port');
  try {
    const kit = await world();
    const started = Date.now();
    const result = await kit.hook({ BRAIN_DATABASE_URL: `postgresql://unused@127.0.0.1:${address.port}/unavailable` });
    expect(Date.now() - started).toBeLessThan(CONNECT_TIMEOUT_MS.turn + 3000);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { spooled: true }, warnings: expect.arrayContaining(['SPOOLED', 'DB_UNAVAILABLE']) });
    expect((await readdir(join(kit.home, 'spool'))).filter(n => n.endsWith('.jsonl'))).toHaveLength(1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
});

it('drains the spooled hook into PG once the database is back', async () => {
  const kit = await world();
  expect(JSON.parse((await kit.hook({ BRAIN_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unavailable' })).stdout).data.spooled).toBe(true);
  const drained = await run(['queue', 'drain', '--json'], kit.env);
  expect(drained.code, drained.stdout + drained.stderr).toBe(0);
  expect(JSON.parse(drained.stdout).ok).toBe(true);
  expect(await kit.db.rows("select harness_session_id from brain.sessions")).toEqual([{ harness_session_id: 'pg-hook' }]);
  expect((await kit.db.rows('select * from brain.messages')).length).toBeGreaterThan(0);
  expect((await readdir(join(kit.home, 'spool'))).filter(n => n.endsWith('.jsonl') || n.endsWith('.claiming'))).toEqual([]);
});

it('opportunistically drains the spooled hook into PG after failures list', async () => {
  const kit = await world();
  expect(JSON.parse((await kit.hook({ BRAIN_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unavailable' })).stdout).data.spooled).toBe(true);
  const drained = await run(['failures', 'list', '--json'], kit.env);
  expect(drained.code, drained.stdout + drained.stderr).toBe(0);
  expect(JSON.parse(drained.stdout).ok).toBe(true);
  expect(await kit.db.rows("select harness_session_id from brain.sessions")).toEqual([{ harness_session_id: 'pg-hook' }]);
  expect((await kit.db.rows('select * from brain.messages')).length).toBeGreaterThan(0);
  expect((await readdir(join(kit.home, 'spool'))).filter(n => n.endsWith('.jsonl') || n.endsWith('.claiming'))).toEqual([]);
});

it('answers commands with DB_UNAVAILABLE without the brain schema and SCHEMA_MISMATCH on another core version', async () => {
  const kit = await world();
  await kit.db.query("insert into brain.schema_migrations(owner,version,name,checksum,applied_at) values ('garmin',99,'extension','a','2026-01-01T00:00:00Z')");
  expect((await run(['queue','drain','--json'], kit.env)).code).toBe(0);
  await kit.db.query("update brain.schema_migrations set version = 7 where owner=$$core$$ and version=(select max(version) from brain.schema_migrations where owner=$$core$$)");
  const mismatch = await run(['queue','drain','--json'], kit.env);
  expect(mismatch.code).toBe(1);
  expect(JSON.parse(mismatch.stdout)).toMatchObject({ ok: false, error: { code: 'SCHEMA_MISMATCH', message: expect.stringContaining('core') } });
  expect(JSON.parse(mismatch.stdout).error.message).toMatch(/7.*6/);
  await kit.db.query('drop schema brain cascade');
  for (const args of [['queue','drain'], ['failures','list']]) {
    const result = await run([...args, '--json'], kit.env);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'DB_UNAVAILABLE' } });
  }
});

it('reads and writes PG with the default selector when the store table is absent', async () => {
  const kit = await world();
  await writeFile(join(kit.home, 'config.toml'), 'schema_version=1\n');
  const env = { ...kit.env, BRAIN_DATABASE_URL: kit.db.appUrl };
  const written = await run(['config', 'set', 'timezone', 'Europe/Berlin', '--json'], env);
  expect(written.code, written.stderr + written.stdout).toBe(0);
  expect(await kit.db.rows("select value from brain.settings where key='timezone'"))
    .toEqual([{ value: 'Europe/Berlin' }]);
  expect(JSON.parse((await kit.hook(env)).stdout)).toMatchObject({ ok: true, data: { spooled: false } });
  expect(await kit.db.rows('select harness_session_id from brain.sessions'))
    .toEqual([{ harness_session_id: 'pg-hook' }]);
  expect(await readdir(kit.home)).not.toContain('brain.db');
});
