#!/bin/sh
# 임시 홈에서 setup → hook → 컨테이너 재생성 → 장애 spool을 검증합니다.
# 기본은 볼륨과 재실행에 필요한 임시 홈을 보존합니다. --delete-volume으로만 삭제합니다.
set -eu
cd "$(dirname "$0")/../.."
exec node --input-type=module - "$@" <<'JS'
import assert from 'node:assert/strict';
import { CONNECT_TIMEOUT_MS } from './packages/core/dist/index.js';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { homeResources } from './apps/cli/dist/config/resources.js';
import { composeArgs, systemCommandRunner } from './apps/cli/dist/runtime/command-runner.js';
import { resolveStoreUrl } from './apps/cli/dist/config/codec.js';
const args = process.argv.slice(2);
assert(args.every(a => a === '--delete-volume'), '사용법: sh tooling/dev/pg-tracer.sh [--delete-volume]');
const removeVolume = args.includes('--delete-volume');
const repo = process.cwd();
const home = await mkdtemp(join(tmpdir(), 'brain-pg-tracer-'));
const r = homeResources(home);
assert.notEqual(r.project, 'second-brain'); assert.notEqual(r.volume, 'second-brain-pg');
assert(![54320,54329].includes(r.port));
const env = { ...process.env, SECOND_BRAIN_HOME: home, SECOND_BRAIN_LAUNCH_AGENTS: join(home,'agents'), CLAUDE_CONFIG_DIR: join(home,'claude') };
delete env.BRAIN_DATABASE_URL;
await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
await mkdir(env.SECOND_BRAIN_LAUNCH_AGENTS, { recursive: true });
await writeFile(join(home,'config.toml'), '[store]\nurl_env = "BRAIN_DATABASE_URL"\n');
const bin = resolve('apps/cli/dist/bin.js');
async function command(command, args, timeoutMs = 120000) {
  const result = await systemCommandRunner({ command, args, env, timeoutMs });
  assert(result.ok, `${command}: ${result.stderr || result.message}`); return result.stdout;
}
async function compose(args) { return command('docker', composeArgs(home,args)); }
async function cli(args, input = '') {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[bin,...args],{ env, stdio:['pipe','pipe','pipe'] });
    let stdout=''; let stderr=''; child.stdout.on('data',b=>stdout+=b); child.stderr.on('data',b=>stderr+=b);
    child.on('error',reject); child.on('close',code=> { try { assert.equal(code,0,`${args.join(' ')}: ${stderr}\n${stdout}`); resolve(JSON.parse(stdout)); } catch(error) { reject(error); } });
    child.stdin.end(input);
  });
}
async function listening() {
  return new Promise(resolve => { const socket = createConnection({host:'127.0.0.1',port:54320}); const done = yes => { socket.destroy(); resolve(yes); }; socket.setTimeout(500,()=>done(false)); socket.on('connect',()=>done(true)); socket.on('error',()=>done(false)); });
}
async function defaults() {
  const projects = JSON.parse(await command('docker',['compose','ls','-a','--format','json']));
  const volumes = (await command('docker',['volume','ls','--format','{{.Name}}'])).trim().split('\n');
  return { project:projects.some(p=>p.Name==='second-brain'), volume:volumes.includes('second-brain-pg'), listener:await listening() };
}
const beforeDefaults = await defaults();
let started = false;
try {
  const setup = await cli(['setup','run','--yes','--json']);
  started = true; assert.equal(setup.ok,true); assert.equal(setup.data.postgres.schema_version,1);
  assert.equal((await stat(join(home,'.env'))).mode & 0o777,0o600);
  assert.equal(setup.data.timezone,'Asia/Seoul');
  const doctor = await cli(['doctor','run','--json']);
  for (const id of ['orbstack','container','db','writable','pg_trgm','schema-version']) assert(doctor.data.checks.some(check=>check.id===id && check.status==='ok'), id);
  const setting = await cli(['config','set','timezone','America/New_York','--json']);
  assert.equal(setting.data.value,'America/New_York');
  const settingBefore = (await cli(['config','get','timezone','--json'])).data;
  assert.equal(settingBefore.source,'db');
  const secrets = await readFile(join(home,'.env'),'utf8');
  const again = await cli(['setup','run','--yes','--json']);
  assert.equal(again.data.postgres.compose_started,false); assert.deepEqual(again.data.postgres.applied,[]); assert.equal(again.data.postgres.owner_created,false);
  assert.equal(await readFile(join(home,'.env'),'utf8'),secrets);
  assert.equal(again.data.timezone,'America/New_York');
  assert(!/^[ \t]*timezone[ \t]*=/m.test(await readFile(join(home,'config.toml'),'utf8')));
  assert.deepEqual((await cli(['config','get','timezone','--json'])).data,settingBefore);
  console.log('setup 성공: 비밀번호 재사용, 두 번째 마이그레이션 적용 0건');
  const payload = JSON.stringify({ session_id:'pg-tracer', transcript_path:resolve('packages/claude-code/test/fixtures/two-turns.jsonl'), hook_event_name:'Stop' });
  const first = await cli(['sessions','ingest','claude-code','--json'],payload);
  assert.equal(first.data.spooled,false); assert(first.data.inserted.messages>0);
  const replay = await cli(['sessions','ingest','claude-code','--json'],payload);
  assert.deepEqual(replay.data.inserted,{messages:0,toolNotes:0});
  const { default:pg } = await import(createRequire(join(repo,'packages/postgres/package.json')).resolve('pg'));
  async function rows() {
    const client = new pg.Client({connectionString:await resolveStoreUrl(home,'BRAIN_DATABASE_URL',env)}); await client.connect();
    try {
      const migrations = (await client.query('select owner,version,checksum from brain.schema_migrations')).rows;
      assert(migrations.some(m=>m.owner==='core' && m.version===1 && /^[a-f0-9]{64}$/.test(m.checksum)));
      const sessions=(await client.query('select id,workspace_id,started_at,ingested_at from brain.sessions order by id')).rows;
      assert.equal(sessions.length,1); assert.equal(sessions[0].workspace_id,null);
      const messages=(await client.query('select id,occurred_at,body from brain.messages order by id')).rows;
      const notes=(await client.query('select id,target from brain.tool_notes order by id')).rows;
      assert(messages.length>0); assert(notes.length>0); return {sessions,messages,notes};
    } finally { await client.end(); }
  }
  const before = await rows(); console.log(JSON.stringify(before,null,2));
  await compose(['down']); await compose(['up','-d','--wait']);
  assert.deepEqual(await rows(),before); console.log('재생성 전후 ID·시각·본문 diff 없음');
  assert.deepEqual((await cli(['config','get','timezone','--json'])).data,settingBefore);
  const afterRecreate = await cli(['setup','run','--yes','--json']);
  assert.equal(afterRecreate.data.timezone,'America/New_York');
  assert(!/^[ \t]*timezone[ \t]*=/m.test(await readFile(join(home,'config.toml'),'utf8')));
  assert.deepEqual((await cli(['config','get','timezone','--json'])).data,settingBefore);
  console.log('시간대 설정: 컨테이너 재생성·setup 재실행 뒤 값과 수정 시각 보존');
  // 데몬은 티켓 9 전까지 SQLite를 써서 spool을 SQLite로 되넣는다
  const stopped = await cli(['daemon','stop','--json']); assert.equal(stopped.ok,true);
  await compose(['stop']);
  const offlinePayload = JSON.stringify({ session_id:'pg-tracer-offline', transcript_path:resolve('packages/claude-code/test/fixtures/two-turns.jsonl'), hook_event_name:'Stop' });
  const offlineStarted = Date.now();
  const offline = await cli(['sessions','ingest','claude-code','--json'],offlinePayload);
  assert(Date.now() - offlineStarted < CONNECT_TIMEOUT_MS.turn + 3000);
  assert.equal(offline.data.spooled,true); assert(offline.warnings.includes('SPOOLED'));
  assert((await readdir(join(home,'spool'))).some(n=>n.endsWith('.jsonl')));
  console.log('PG 중단 hook: 연결 시간 한도 안에 exit 0, SPOOLED 및 spool 파일 확인');
  await compose(['up','-d','--wait']);
  const drained = await cli(['queue','drain','--json']); assert.equal(drained.ok,true);
  const recovered = new pg.Client({connectionString:await resolveStoreUrl(home,'BRAIN_DATABASE_URL',env)}); await recovered.connect();
  try {
    const sessions = await recovered.query("select id from brain.sessions where harness='claude-code' and harness_session_id='pg-tracer-offline'");
    assert.equal(sessions.rows.length,1);
    const messages = await recovered.query('select id from brain.messages where session_id=$1',[sessions.rows[0].id]);
    assert(messages.rows.length>0);
  } finally { await recovered.end(); }
  assert(!(await readdir(join(home,'spool'))).some(n=>n.endsWith('.jsonl')||n.endsWith('.claiming')));
  console.log('PG 복구 drain: 중단 중 세션·메시지 저장, spool 비움 확인');
  assert.deepEqual(await defaults(),beforeDefaults);
  console.log(`기본 홈 자원 변화 없음: ${JSON.stringify(beforeDefaults)}`);
} finally {
  await cli(['setup','uninstall','--json']).catch(error=>{ console.error(error.message); process.exitCode=1; });
  // setup이 중간에 실패해도 이 임시 홈의 컨테이너만 정리합니다.
  if (started || await stat(join(home,'postgres/compose.yaml')).catch(()=>false)) await compose(removeVolume?['down','--volumes']:['down']);
  if(removeVolume) { await rm(home,{recursive:true,force:true}); console.log('정리 완료: 임시 홈·컨테이너·명시한 볼륨 삭제'); }
  else console.log(`정리 완료: 컨테이너·LaunchAgent 제거, 볼륨 ${r.volume} 및 재실행용 홈 ${home} 보존 (--delete-volume으로만 볼륨 삭제)`);
}
JS
