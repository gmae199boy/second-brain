import pg from 'pg';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
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
  const installed=await run(['setup','run','--yes','--json'],env);expect(installed.code,installed.stdout+installed.stderr).toBe(0);
  const db=await database();databases.push(db);const store=postgresStore({databaseUrl:db.appUrl});
  try{expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);}finally{await store.close();}
  // setup above intentionally exercises the unchanged default SQLite path.
  const config=await readFile(join(home,'config.toml'),'utf8');await writeFile(join(home,'config.toml'),config.replace('[store]','[store]\nurl_env = "BRAIN_DATABASE_URL"'));
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
  const sqlite=new DatabaseSync(join(kit.home,'brain.db'),{readOnly:true});try{expect(sqlite.prepare('select count(*) as n from sessions').get()).toEqual({n:0});}finally{sqlite.close();}
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
  if(kind==='version')await kit.db.query('update brain.schema_migrations set version=2');
  const result=await kit.hook(override);expect(result.code,result.stderr).toBe(0);const envelope=JSON.parse(result.stdout);
  expect(envelope.ok).toBe(true);expect(envelope.data.spooled).toBe(true);expect(envelope.warnings).toContain('SPOOLED');if(!locked)expect(envelope.warnings).toContain(kind==='version'?'SCHEMA_MISMATCH':'DB_UNAVAILABLE');
  const files=(await readdir(join(kit.home,'spool'))).filter(n=>n.endsWith('.jsonl'));expect(files.length).toBeGreaterThan(0);
  if(locked){const record=JSON.parse((await readFile(join(kit.home,'spool',files[0]!),'utf8')).trim());expect(record.payload.cause).toBe('DB_LOCKED');}
  } finally {if(blocker){await blocker.query('rollback');await blocker.end();}}
});
