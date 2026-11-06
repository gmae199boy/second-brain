import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile, chmod, copyFile, lstat, readlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, createConnection, type Socket } from 'node:net';
import pg from 'pg';
import { afterEach, beforeAll, afterAll, expect, it } from 'vitest';
import { createIsolatedTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { database, clock } from '../../../packages/postgres/test/fixture.js';
import { runMigrations } from '../../../packages/postgres/src/index.js';
import { installPostgres } from '../../../apps/cli/dist/install/postgres.js';
import { homeResources } from '../../../apps/cli/dist/config/resources.js';
import { postgresSecrets } from '../../../apps/cli/dist/config/codec.js';
import { renderPostgresCompose } from '../../../apps/cli/dist/install/postgres.js';
const rootRepo = fileURLToPath(new URL('../../../', import.meta.url));
const homes: string[] = [], databases: TestDatabase[] = [];
let root: string, bare: string, oldRef: string, targetRef: string, divergedRef: string;
const children = new Set<ChildProcess>();
// Retain ownership independently of the leader's lifetime until absence.
const processGroups = new Set<number>();
const ptyGroupReceipts = new Set<string>();
const cleanups = new Set<() => Promise<void>>();
function groupState(pgid:number): {present:boolean; live:boolean; leader:boolean} {
 const ps=spawnSync('ps',['-axo','pid=,pgid=,uid=,state='],{encoding:'utf8',timeout:15000});
 if(ps.status!==0 || ps.error) throw Error('시험 프로세스 목록을 확인하지 못했습니다');
 const rows=ps.stdout.trim().split('\n').filter(Boolean).map(line=>{
  const m=/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s*$/.exec(line);
  if(!m) throw Error('시험 프로세스 목록 형식이 불명확합니다');
  return {pid:Number(m[1]),pgid:Number(m[2]),uid:Number(m[3]),state:m[4]!};
 }).filter(row=>row.pgid===pgid);
 if(rows.some(row=>row.uid!==process.geteuid?.())) throw Error('시험 프로세스 그룹 소유자가 불명확합니다');
 const live=rows.some(row=>!row.state.startsWith('Z'));
 if(live) {try {process.kill(-pgid,0);} catch(error) {if((error as NodeJS.ErrnoException).code==='ESRCH') throw Error('시험 프로세스 그룹 관측이 바뀌었습니다');throw error;}}
 return {present:rows.length>0,live,leader:rows.some(row=>row.pid===pgid)};
}
function groupPresent(pgid:number):boolean {return groupState(pgid).present;}
async function stopGroup(pgid:number):Promise<void> {
 for(const signal of ['SIGTERM','SIGKILL'] as const) {
  const state=groupState(pgid);
  if(!state.present) {processGroups.delete(pgid);return;}
  // A reaped leader cannot pin the numeric group identity; never signal an
  // unidentifiable group. Zombies need reaping, not another signal.
  if(state.live) {
   const leader=[...children].find(child=>child.pid===pgid && child.exitCode===null && child.signalCode===null);
   if(!state.leader || !leader) throw Error('시험 프로세스 그룹 리더의 소유권을 확인할 수 없습니다');
   try {process.kill(-pgid,signal);} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH') throw error;}
  }
  const until=Date.now()+(signal==='SIGTERM'?8000:3000);
  while(Date.now()<until) {if(!groupPresent(pgid)) {processGroups.delete(pgid);return;} await new Promise(resolve=>setTimeout(resolve,50));}
 }
 if(groupPresent(pgid)) throw Error(`시험 프로세스 그룹 ${pgid} 정리 실패`);
 processGroups.delete(pgid);
}
async function collectPtyGroup(receipt:string):Promise<boolean> {
 let contents:string;
 try {contents=await readFile(receipt,'utf8');} catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') {ptyGroupReceipts.delete(receipt);return false;} throw error;}
 const pgid=Number(contents);
 if(!Number.isSafeInteger(pgid) || pgid<1) throw Error('잘못된 PTY 그룹 영수증');
 processGroups.add(pgid);
 const remained=groupPresent(pgid);
 if(remained) await stopGroup(pgid); else processGroups.delete(pgid);
 await rm(receipt);ptyGroupReceipts.delete(receipt);
 return remained;
}
const git = (...args: string[]) => execFileSync('git', args, {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
beforeAll(async () => {
 root = await mkdtemp(join(await realpath(tmpdir()),'brain-bootstrap-pty-'));
 const work=join(root,'work');
 oldRef='09947d23761699d6ab9132e891355da67de254c4';
 git('clone','-q','--no-hardlinks','--no-checkout',rootRepo,work);
 git('-C',work,'checkout','-q','-B','fixture-target','HEAD');
 const files=git('-C',rootRepo,'ls-files','-co','--exclude-standard','-z').split('\0').filter(Boolean);
 for(const path of files) { const source=join(rootRepo,path), target=join(work,path); let stat; try {stat=await lstat(source);} catch {await rm(target,{recursive:true,force:true});continue;} await mkdir(dirname(target),{recursive:true}); await rm(target,{recursive:true,force:true}); if(stat.isSymbolicLink()) await symlink(await readlink(source),target); else if(stat.isFile()) await copyFile(source,target); }
 git('-C',work,'add','-A');
 git('-C',work,'-c','user.email=test@example.invalid','-c','user.name=fixture','commit','--allow-empty','-q','-m','target'); targetRef=git('-C',work,'rev-parse','HEAD');
 expect(git('-C',work,'rev-parse',`${oldRef}^{tree}`)).not.toBe(git('-C',work,'rev-parse',`${targetRef}^{tree}`));
 git('-C',work,'merge-base','--is-ancestor',oldRef,targetRef);
 divergedRef=git('-C',work,'-c','user.email=test@example.invalid','-c','user.name=fixture','commit-tree',`${targetRef}^{tree}`,'-m','unrelated');
 bare=join(root,'repository.git'); git('init','-q','--bare','-b','main',bare); git('-C',work,'push','-q',bare,`${targetRef}:refs/heads/main`); git('-C',work,'push','-q',bare,`${divergedRef}:refs/heads/diverged`);
},900000);
afterEach(async () => {
 const failures: unknown[]=[];
 for(const pgid of [...processGroups]) try {await stopGroup(pgid);} catch(e) {failures.push(e);}
 for(const receipt of [...ptyGroupReceipts]) try {await collectPtyGroup(receipt);} catch(e) {failures.push(e);}
 if(failures.length) throw new AggregateError(failures,'시험 프로세스 정리 실패: DB와 home을 보존합니다');
 children.clear();
 for(const cleanup of [...cleanups]) try {await cleanup();} catch(e) {failures.push(e);}
 if(failures.length) throw new AggregateError(failures,'시험 연결 정리 실패: DB와 home을 보존합니다');
 for(const db of databases.splice(0)) { try { const id=db.fixtureContainer?.id; expect(id).toBeDefined(); await db.drop(); expect(db.fixtureDatabaseDropped).toBe(true); expect(db.fixtureContainerRemoved).toBe(true); const absent=spawnSync('docker',['inspect',id!],{encoding:'utf8',timeout:15000}); expect(absent.status).toBe(1);expect(absent.stderr.toLowerCase()).toMatch(/no such (object|container)/); } catch(e) {failures.push(e);} }
 for(const home of homes.splice(0)) try {await rm(home,{recursive:true,force:true});} catch(e) {failures.push(e);}
 if(failures.length) throw new AggregateError(failures,'시험 자원 정리 실패');
});
afterAll(async()=>{if(root && processGroups.size===0 && ptyGroupReceipts.size===0 && cleanups.size===0 && databases.length===0 && homes.length===0) await rm(root,{recursive:true,force:true});});
async function world(name: 'garmin' | 'oldext', schema = 27) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'brain-retired-')); homes.push(home);
  const db = await database(false, createIsolatedTestDatabase); databases.push(db);
  const databaseName = new URL(db.url).pathname.slice(1);
  await db.query(`alter database "${databaseName}" owner to brain_owner`);
  expect(await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: schema })).toMatchObject({ok:true});
  const dir = join(home, 'extensions', name), migrations = join(dir, 'migrations');
  await mkdir(migrations, {recursive:true}); await mkdir(join(home, 'run'), {recursive:true});
  const fixture = await readFile(new URL('../../../packages/core/fixtures/extensions/legacy-garmin-1.0.0-manifest.json', import.meta.url), 'utf8');
  await writeFile(join(dir, 'manifest.json'), name === 'garmin' ? fixture : fixture.replaceAll('garmin', name));
  // Public migration bytes from revision 09947d2; ledger is synthetic and contains no health data.
  const source = fileURLToPath(new URL('../../../packages/postgres/test/fixtures/legacy-garmin-migrations/', import.meta.url));
  await cp(source, migrations, {recursive:true});
  for (const file of await readdir(migrations)) {
    const original = await readFile(join(migrations,file), 'utf8');
    const body = name === 'garmin' ? original : original.replaceAll('garmin',name);
    await writeFile(join(migrations,file),body);
    const hash = createHash('sha256').update(body).digest('hex');
    await db.query(`insert into brain.schema_migrations(owner,version,name,checksum,applied_at) values ('${name}',${Number(file.slice(0,4))},'${file}','${hash}',now())`);
  }
  await db.query(`insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('${name}','1.0.0',now(),false,now()); insert into brain.work_hold_groups values ('extension:${name}',now())`);
  const build = JSON.parse(await readFile(new URL('../../../apps/cli/dist/build.json', import.meta.url),'utf8'));
  const installed = {commit: build.commit === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40), schema_version:schema,node:process.execPath,plugin_root:null,installed_at:'2026-01-01T00:00:00Z'};
  await writeFile(join(home,'installed.json'),JSON.stringify(installed));
  const runner = async (request: {args: readonly string[]}) => request.args[0] === 'volume' ? {ok:false as const,stdout:'',stderr:'no such volume',message:'missing'} : {ok:true as const,stdout:'',stderr:''};
  const env: NodeJS.ProcessEnv = {...process.env, SECOND_BRAIN_HOME:home}; delete env.SECOND_BRAIN_INSTALL_LOCK_OWNER;
  const options = {home,urlEnv:'BRAIN_DATABASE_URL',env,clock,runner,secrets:{adminUrl:db.url,appPassword:'brain-test-app'},databaseName};
  const install = () => installPostgres({...options,confirmOffline:async r => r.challenge});
  return {home, db, dir, build, installed, install, options};
}

async function realLegacyWorld(name:'garmin'|'oldext') {
  const k = await world(name), role = `brain_ext_${name}`;
  const existing = await k.db.rows(`select 1 from pg_roles where rolname='${role}'`);
  if (existing.length) throw Error('다른 DB의 확장 역할을 보존합니다');
  await k.db.query(`create role "${role}" login password '${'a'.repeat(48)}'; comment on role "${role}" is 'second-brain extension:${k.options.databaseName}'; create schema "${name}" authorization brain_owner; grant usage,create on schema "${name}" to "${role}"; delete from brain.schema_migrations where owner='${name}'`);
  expect(await runMigrations({databaseUrl:k.db.url,clock,owners:[{owner:name,directory:join(k.dir,'migrations')}]})).toMatchObject({ok:true});
  const user=randomUUID(), session=randomUUID(), message=randomUUID(), file=randomUUID(), channel=randomUUID(), conversation=randomUUID(), schedule=randomUUID(), work=randomUUID(), attempt=randomUUID();
  await k.db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',0,now());
    insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('${session}','synthetic','session','${user}','test',now(),'import');
    insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ('${message}','${session}','message','user','synthetic',now());
    insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','sha256:${'a'.repeat(64)}',1,now());
    insert into brain.channels(id,kind,bot_ref) values ('${channel}','telegram','synthetic');
    insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref) values ('${conversation}','${channel}','synthetic','thread');
    insert into brain.settings(key,value,updated_at) values ('${name}.synthetic','preserve',now());
    insert into brain.schedules(id,kind,target_kind,target_id,next_run_at,created_at,local_time,time_zone,hold_group) values ('${schedule}','${name}.synthetic','probe','synthetic',now(),now(),'09:30','UTC','extension:${name}');
    insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,completed_at,execution_class,hold_group,outcome) values ('${work}','${name}.synthetic','probe','synthetic',now(),now(),now(),'supervised','extension:${name}','succeeded');
    insert into brain.work_attempts(token,work_item_id,started_at,finished_at,outcome) values ('${attempt}','${work}',now(),now(),'succeeded');
    insert into brain.schedule_successes values ('${schedule}','2026-01-02','UTC','${work}','2026-01-01T00:00:00Z');
    insert into ${name}.datasets(dataset,account,account_confirmed) values ('synthetic','account',true);
    insert into ${name}.import_batches values ('synthetic-batch','synthetic',now());
    insert into ${name}.raw_payloads values ('synthetic','synthetic-batch','account','day','synthetic-key','synthetic-endpoint',1,2,'synthetic','{\"synthetic\":true}');
    update ${name}.raw_payloads set body_raw=decode('0001ff','hex'), body_encoding='utf-8' where dataset='synthetic';
    insert into ${name}.import_mapping values ('synthetic','synthetic-table','synthetic-key','synthetic-kind','${message}','${createHash('sha256').update(Buffer.from('0001ff','hex')).digest('hex')}','synthetic-batch');
    insert into ${name}.preserved_rows(id,dataset,original_table,original_key,values_json) values ('${randomUUID()}','synthetic','synthetic-table','synthetic-key','{"synthetic":true}');
    insert into ${name}.import_provenance values ('synthetic','synthetic-table','synthetic-key','synthetic-metric','synthetic-reason');
    insert into ${name}.artifact_inventory(dataset,artifact_key,batch,category,metadata,metadata_raw) values ('synthetic','synthetic-artifact','synthetic-batch','synthetic','{\"synthetic\":true}',decode('0001ff','hex'));
    insert into ${name}.collect_state values ('synthetic','account','2020-01-01','synthetic-endpoint','synthetic-revision',1);
    insert into ${name}.normalize_items values ('synthetic','day','synthetic-key','synthetic-endpoint','synthetic-revision',1,1,true,null,2)`);
  return {...k, ids:{user,session,message,file,channel,conversation,schedule,work,attempt}};
}

const durableTables = ['datasets','import_batches','raw_payloads','import_mapping','artifact_inventory','preserved_rows'] as const;
const retiredTables = ['import_provenance','collect_state','normalize_items'] as const;
async function preserved(k: Awaited<ReturnType<typeof realLegacyWorld>>, name:'garmin'|'oldext', includeRetired = true) {
  const {ids} = k;
  const isModern = (await k.db.rows("select to_regclass('brain.schedule_occurrences') is not null as present"))[0]?.present;
  const accounting = isModern
    ? await k.db.rows(`select schedule_id,occurrence_at,time_zone,status,work_id,recorded_at from brain.schedule_occurrences where schedule_id='${ids.schedule}' order by occurrence_at`)
    : await k.db.rows(`select su.schedule_id,(su.local_date+s.local_time::time) at time zone su.time_zone as occurrence_at,su.time_zone,'done'::text as status,su.work_id,su.recorded_at from brain.schedule_successes su join brain.schedules s on s.id=su.schedule_id where su.schedule_id='${ids.schedule}'`);
  const facts = {
    accounting,
    users:await k.db.rows(`select id,name,is_self,created_at from brain.users where id='${ids.user}'`),
    sessions:await k.db.rows(`select * from brain.sessions where id='${ids.session}'`), messages:await k.db.rows(`select * from brain.messages where id='${ids.message}'`),
    files:await k.db.rows(`select * from brain.files where id='${ids.file}'`),channels:await k.db.rows(`select * from brain.channels where id='${ids.channel}'`),
    conversations:await k.db.rows(`select id,channel_id,external_ref,thread_ref from brain.channel_conversations where id='${ids.conversation}'`),
    settings:await k.db.rows(`select key,value,updated_at from brain.settings where key='${name}.synthetic'`),
    schedules:await k.db.rows(`select id,kind,target_kind,target_id,next_run_at,created_at,time_zone,hold_group from brain.schedules where id='${ids.schedule}'`),
    work:await k.db.rows(`select id,kind,target_kind,target_id,created_at,next_attempt_at,completed_at,execution_class,hold_group,outcome from brain.work_items where id='${ids.work}'`),
    attempts:await k.db.rows(`select token,work_item_id,started_at,finished_at,outcome from brain.work_attempts where token='${ids.attempt}'`),
    extension:await Promise.all([...durableTables,...(includeRetired ? retiredTables : [])].map(async table => {
      const rows = await k.db.rows(`select * from ${name}.${table} where dataset='synthetic'`);
      expect(rows,`${name}.${table} 합성 데이터`).toHaveLength(1); return rows;
    })),
  };
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}


const ptyProgram = String.raw`import os,pty,select,subprocess,sys,time,re,json,fcntl,termios,signal,struct,errno
mode,node,bootstrap,ref,plugin,stale=sys.argv[1:]
m,s=pty.openpty(); fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',40,500,0,0))
def session():
 os.setsid(); fcntl.ioctl(0,termios.TIOCSCTTY,0)
args=[node,bootstrap,'--interactive-ref','--ref',ref,'--yes','--plugin-root',plugin]+(['--json'] if mode=='json' else [])
p=subprocess.Popen(args,stdin=s,stdout=s,stderr=s,preexec_fn=session,env=os.environ); os.close(s)
with open(os.environ['BRAIN_TEST_PTY_GROUP_RECEIPT'],'x') as f:
 f.write(str(p.pid)); f.flush(); os.fsync(f.fileno())
def group_state():
 rows=subprocess.check_output(['ps','-axo','pid=,pgid=,uid=,state='],text=True).splitlines()
 members=[]
 for line in rows:
  fields=line.split()
  if len(fields)!=4 or not all(x.isdigit() for x in fields[:2]) or not re.fullmatch(r'-?\d+',fields[2]): raise RuntimeError('invalid process list')
  pid,pgid,uid=map(int,fields[:3])
  if pgid==p.pid: members.append((pid,uid,fields[3]))
 if any(uid!=os.geteuid() for _,uid,_ in members): raise RuntimeError('unknown PTY group owner')
 live=any(not state.startswith('Z') for _,_,state in members)
 if live: os.killpg(p.pid,0) # EPERM and identity races remain failures.
 return bool(members),live
def wait_group_absent():
 end=time.monotonic()+3
 while True:
  present,_=group_state()
  if not present: return
  if time.monotonic()>end: raise RuntimeError('PTY process group still present')
  time.sleep(.05)
def stop(*_):
 try: os.killpg(p.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: p.wait(timeout=2)
 except subprocess.TimeoutExpired:
  try: os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  p.wait()
 wait_group_absent()
 sys.exit(99)
signal.signal(signal.SIGTERM,stop)
out=b''; answered=False; challenge=''; prompts=set(); deadline=time.monotonic()+600; timedout=False; pty_closed=False; interrupted_fence=None; interrupted_owner=None
while p.poll() is None and time.monotonic()<deadline:
 r,_,_=select.select([m],[],[],.2)
 if not r: continue
 try: chunk=os.read(m,65536)
 except OSError as e:
  if e.errno!=errno.EIO: raise
  pty_closed=True; break
 if not chunk: pty_closed=True; break
 out+=chunk; clean=re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]',b'',out)
 for prompt in ['미러를 어디에 둘까요?','임베딩을 켤까요?','자동 업데이트를 켤까요?','시간대를 무엇으로 할까요?','이 brain을 어떤 하네스에 연결할까요?']:
  key=prompt.encode()
  if key in clean and key not in prompts: prompts.add(key); os.write(m,b'\r')
 match=re.search('확인 [^\r\n]+ [0-9a-f]{40} [0-9a-f]{40} [0-9a-f-]{36}'.encode(),clean)
 if not answered and match and b'> ' in clean:
  answered=True; challenge=match.group(0).decode()
  if mode=='interrupt':
   home=os.environ['SECOND_BRAIN_HOME']
   with open(os.path.join(home,'run','daemon.pid')) as f: interrupted_fence=f.read()
   with open(os.path.join(home,'install.lock','owner')) as f: interrupted_owner=f.read()
   os.killpg(p.pid,signal.SIGTERM)
  elif mode=='cancel': os.write(m,b'\x03')
  elif mode=='mutate':
   path=os.path.join(os.environ['SECOND_BRAIN_HOME'],'extensions','garmin','manifest.json')
   with open(path) as f: doc=json.load(f)
   doc['synthetic_during_confirmation']=True
   with open(path,'w') as f: json.dump(doc,f)
   os.write(m,match.group(0)+b'\n')
  else: os.write(m,b'\x04' if mode=='eof' else (b'wrong\n' if mode=='wrong' else (stale.encode()+b'\n' if mode=='stale' else match.group(0)+b'\n')))
if pty_closed and p.poll() is None:
 try: p.wait(timeout=max(0,min(2,deadline-time.monotonic())))
 except subprocess.TimeoutExpired:
  if time.monotonic()<deadline: raise RuntimeError('PTY closed but owned leader did not exit')
if p.poll() is None and time.monotonic()>=deadline:
 timedout=True
 try: os.killpg(p.pid,signal.SIGKILL)
 except ProcessLookupError: pass
p.wait()
wait_group_absent()
while True:
 try:
  r,_,_=select.select([m],[],[],0)
  if not r: break
  chunk=os.read(m,65536)
  if not chunk: break
  out+=chunk
 except OSError: break
os.close(m); print(json.dumps({'code':p.returncode,'pid':p.pid,'answered':answered,'timeout':timedout,'challenge':challenge,'groupGone':True,'interruptedFence':interrupted_fence,'interruptedOwner':interrupted_owner,'output':out.decode('utf8','replace')}))`;

type Result = {code:number; pid:number; answered:boolean; timeout:boolean; challenge:string; groupGone:boolean; interruptedFence:string|null; interruptedOwner:string|null; output:string};
async function processRun(command:string,args:string[],env:NodeJS.ProcessEnv):Promise<{code:number|null;signal:NodeJS.Signals|null;out:string}> {
 return new Promise((resolve,reject)=>{
  const receipt=command==='python3' && args[1]===ptyProgram ? join(env.SECOND_BRAIN_HOME!,`pty-group-${randomUUID()}`) : undefined;
  if(receipt) ptyGroupReceipts.add(receipt);
  const child=spawn(command,args,{env:receipt ? {...env,BRAIN_TEST_PTY_GROUP_RECEIPT:receipt} : env,stdio:['ignore','pipe','pipe'],detached:true}); children.add(child);
  if(child.pid) processGroups.add(child.pid);
  let out=''; let timedOut=false; let stopping:Promise<void>|undefined;
  const timer=setTimeout(()=>{timedOut=true;if(child.pid) {stopping=stopGroup(child.pid);void stopping.catch(()=>{});}},650000);
  child.stdout.on('data',b=>out+=String(b)); child.stderr.on('data',b=>out+=String(b));
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('close',(code,signal)=>{clearTimeout(timer);children.delete(child);void (async()=>{
   if(stopping) await stopping;
   if(child.pid && groupPresent(child.pid)) {await stopGroup(child.pid);throw Error('시험 프로세스 그룹에 자손이 남았습니다');}
   if(child.pid) processGroups.delete(child.pid);
   if(receipt && await collectPtyGroup(receipt)) throw Error('PTY 프로세스 그룹에 자손이 남았습니다');
   if(timedOut) throw Error('시험 프로세스 시간 초과');
   return {code,signal,out};
  })().then(resolve,reject);});
 });
}
async function fixture() {
 const k=await realLegacyWorld('garmin');
 const app=join(k.home,'app'); git('clone','-q',`file://${bare}`,app); git('-C',app,'checkout','-q','--detach',oldRef);
 await writeFile(join(k.home,'installed.json'),JSON.stringify({...k.installed,commit:oldRef}));
 const fixtureAdmin=new URL(k.db.url); fixtureAdmin.pathname='/postgres'; const admin=new pg.Client({connectionString:fixtureAdmin.toString()});
 const dbName=k.options.databaseName; let connected=false, renamed=false; let proxy:ReturnType<typeof createServer> | undefined; const sockets=new Set<Socket>();
 const close=async()=>{if(processGroups.size || ptyGroupReceipts.size) throw Error('시험 프로세스 그룹 종료 전 fixture를 보존합니다'); for(const socket of sockets) socket.destroy(); if(proxy?.listening) await new Promise<void>(resolve=>proxy!.close(()=>resolve())); if(renamed) {await admin.query(`alter database brain rename to "${dbName}"`);renamed=false; const restored=await admin.query('select datname from pg_database where datname = $1',[dbName]);expect(restored.rowCount).toBe(1);} if(connected) {await admin.end();connected=false;} cleanups.delete(close);};
 cleanups.add(close); try {await admin.connect();connected=true;} catch(error) {await admin.end().catch(()=>{});throw error;}
 await admin.query(`alter database "${dbName}" rename to brain`); renamed=true;
 const liveUrl=new URL(k.db.url); liveUrl.pathname='/brain';
 const liveDb={...k.db, rows:async (sql:string)=>{const c=new pg.Client({connectionString:liveUrl.toString()}); await c.connect(); try{return (await c.query(sql)).rows;}finally{await c.end();}}, query:async(sql:string)=>{const c=new pg.Client({connectionString:liveUrl.toString()}); await c.connect();try{await c.query(sql);}finally{await c.end();}}};
 const live={...k,db:liveDb};
 proxy=createServer(incoming=>{const outgoing=createConnection({host:fixtureAdmin.hostname,port:Number(fixtureAdmin.port)}); sockets.add(incoming);sockets.add(outgoing); incoming.on('close',()=>sockets.delete(incoming));outgoing.on('close',()=>sockets.delete(outgoing));incoming.on('error',()=>outgoing.destroy());outgoing.on('error',()=>incoming.destroy());incoming.pipe(outgoing).pipe(incoming);});
 await new Promise<void>((resolve,reject)=>{proxy!.once('error',reject);proxy!.listen(homeResources(k.home).port,'127.0.0.1',()=>resolve());});
 const bin=join(k.home,'fake-bin'); await mkdir(bin);
 await writeFile(join(bin,'orb'),'#!/bin/sh\necho Running\n');
 await writeFile(join(bin,'docker'),`#!/bin/sh\ncase "$1 $2" in\n 'context show') echo orbstack ;;\n 'version --format') echo 29 ;;\n 'volume inspect') echo 'no such volume' >&2; exit 1 ;;\n 'ps -a') echo '{"Labels":"com.docker.compose.service=postgres","State":"running","Status":"Up (healthy)"}' ;;\n *) exit 0 ;;\nesac\n`);
 await chmod(join(bin,'orb'),0o755); await chmod(join(bin,'docker'),0o755);
 await writeFile(join(k.home,'.env'),`BRAIN_POSTGRES_PASSWORD="brain-fixture-test"\nBRAIN_APP_PASSWORD="brain-test-app"\nBRAIN_EXT_GARMIN_PASSWORD="${'a'.repeat(48)}"\n`);
 await writeFile(join(k.home,'config.toml'),'schema_version=1\n[store]\nurl_env="BRAIN_DATABASE_URL"\n');
 await postgresSecrets(k.home,homeResources(k.home).port,'BRAIN_DATABASE_URL'); await mkdir(join(k.home,'postgres')); await writeFile(join(k.home,'postgres/compose.yaml'),renderPostgresCompose(k.home));
 const env:NodeJS.ProcessEnv={...process.env,HOME:k.home,SECOND_BRAIN_HOME:k.home,SECOND_BRAIN_REPO:`file://${bare}`,PATH:`${bin}:${process.env.PATH ?? ''}`,CLAUDE_CONFIG_DIR:join(k.home,'claude'),SECOND_BRAIN_LAUNCH_AGENTS:join(k.home,'agents'),SECOND_BRAIN_LAUNCHCTL:join(rootRepo,'apps/cli/test/fixtures/fake-launchctl.sh'),FAKE_LAUNCHCTL_DIR:join(k.home,'launchctl'),BRAIN_DATABASE_URL:`postgres://brain_app:brain-test-app@127.0.0.1:${homeResources(k.home).port}/brain`};
 delete env.DOCKER_HOST; delete env.SECOND_BRAIN_INSTALL_LOCK_OWNER; delete env.SECOND_BRAIN_STAGED_APP; delete env.SECOND_BRAIN_PREVIOUS_APP_HEAD; delete env.NODE_OPTIONS;
 const plugin=join(k.home,'plugin'); await cp(join(rootRepo,'plugin'),plugin,{recursive:true}); await writeFile(join(plugin,'app-ref'),`${targetRef}\n`);
 const bootstrap=join(plugin,'bootstrap.mjs');
 const tty=async(mode:string,ref=targetRef,stale=''):Promise<Result>=>{const run=await processRun('python3',['-c',ptyProgram,mode,process.execPath,bootstrap,ref,plugin,stale],env); expect(run.code,run.out).toBe(0); const result=JSON.parse(run.out) as Result; expect(result.timeout,result.output).toBe(false);expect(result.groupGone,result.output).toBe(true); return result;};
 const plain=async(args:string[])=>processRun(process.execPath,[bootstrap,...args],env);
 return {...live,app,env,plugin,tty,plain,close};
}

it('M1–M6: detached 옛 Garmin을 실제 bootstrap과 PTY로 안전하게 갱신한다', async () => {
 const k=await fixture();
 try {
  expect(await readFile(join(k.plugin,'app-ref'),'utf8')).toBe(`${targetRef}\n`);
  const baseline=await preserved(k,'garmin');
  const ledger=await k.db.rows("select * from brain.schema_migrations where owner='garmin' order by version");
  const coreBefore=await k.db.rows("select version,name,checksum,applied_at from brain.schema_migrations where owner='core' order by version");expect(coreBefore).toHaveLength(27);
  const oldRecord=await readFile(join(k.home,'installed.json'),'utf8');
  const oldManifest=await readFile(join(k.dir,'manifest.json'));
  const unchanged=async()=>{expect(await preserved(k,'garmin')).toBe(baseline); expect(await k.db.rows("select * from brain.schema_migrations where owner='garmin' order by version")).toEqual(ledger);expect(await readFile(join(k.home,'installed.json'),'utf8')).toBe(oldRecord);expect(git('-C',k.app,'rev-parse','HEAD')).toBe(oldRef);expect(await readFile(join(k.dir,'manifest.json'))).toEqual(oldManifest);};
  // M2: every rejection reaches the installer, and a timeout can never count as a rejection.
  for(const mode of ['wrong','eof','cancel']) {
   const denied=await k.tty(mode); expect(denied.code,denied.output).toBe(1); if(mode!=='cancel') expect(denied.output).toContain('DB_LOCKED');
   expect(denied.answered,denied.output).toBe(true); await unchanged();
  }
  const json=await k.tty('json');expect(json.code,json.output).toBe(2);expect(json.output).toContain('USAGE:');expect(json.output).toContain('--json');expect(json.answered).toBe(false);expect(json.challenge).toBe('');await unchanged();
  const firstChallenge=await k.tty('wrong');expect(firstChallenge.code,firstChallenge.output).toBe(1);expect(firstChallenge.challenge).not.toBe('');
  const staleAttempt=await k.tty('stale',targetRef,firstChallenge.challenge);expect(staleAttempt.code,staleAttempt.output).toBe(1);expect(staleAttempt.challenge).not.toBe(firstChallenge.challenge);expect(staleAttempt.output).toContain('DB_LOCKED');await unchanged();
  try {const changed=await k.tty('mutate');expect(changed.answered,changed.output).toBe(true);expect(changed.code,changed.output).toBe(1);expect(changed.output).toContain('DB_LOCKED');}
  finally {await writeFile(join(k.dir,'manifest.json'),oldManifest);} await unchanged();
  const noTty=await k.plain(['--interactive-ref','--ref',targetRef,'--yes']); expect(noTty.signal).toBeNull();expect(noTty.code,noTty.out).toBe(1);expect(noTty.out).toContain('DB_LOCKED');await unchanged();
  const hook=await k.plain(['--ref',targetRef,'--yes']);expect(hook.signal).toBeNull();expect(hook.code).toBe(1);expect(hook.out.trim().split('\n')).toHaveLength(1);expect(JSON.parse(hook.out).systemMessage).toBeTruthy();expect(await readFile(join(k.home,'log/bootstrap.log'),'utf8')).toContain('DB_LOCKED');await unchanged();
  // M3: a live process owns the daemon fence. The test process is only a synthetic owner.
  const daemon=join(k.home,'run/daemon.pid');await writeFile(daemon,JSON.stringify({pid:process.pid,boot_at:new Date().toISOString(),started_at:new Date().toISOString(),commit:oldRef}));
  const fenced=await k.tty('correct');expect(fenced.code,fenced.output).toBe(1);expect(fenced.output).toContain('DB_LOCKED');expect(fenced.answered).toBe(false);await unchanged();await rm(daemon);
  // Each legacy prerequisite is isolated from the others and restored before the next case.
  const extraWork=randomUUID(), extraAttempt=randomUUID();
  const cases: {name:string; setup:string; undo:string}[]=[
   {name:'enabled',setup:"update brain.extensions set enabled=true where name='garmin'",undo:"update brain.extensions set enabled=false where name='garmin'"},
   {name:'hold',setup:"update brain.work_hold_groups set name='extension:garmin-temporary' where name='extension:garmin'",undo:"update brain.work_hold_groups set name='extension:garmin' where name='extension:garmin-temporary'"},
   {name:'unheld schedule',setup:`update brain.schedules set hold_group=null where id='${k.ids.schedule}'`,undo:`update brain.schedules set hold_group='extension:garmin' where id='${k.ids.schedule}'`},
   {name:'unheld work',setup:`insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class) values ('${extraWork}','garmin.pending','probe','extra',now(),now(),'supervised')`,undo:`delete from brain.work_items where id='${extraWork}'`},
   {name:'running',setup:`insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,hold_group,claimed_at,claim_expires_at,claimed_by) values ('${extraWork}','garmin.pending','probe','extra',now(),now(),'supervised','extension:garmin',now(),now()+interval '1 hour','synthetic')`,undo:`delete from brain.work_items where id='${extraWork}'`},
   {name:'open attempt',setup:`insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,hold_group) values ('${extraWork}','garmin.pending','probe','extra',now(),now(),'supervised','extension:garmin'); insert into brain.work_attempts(token,work_item_id,started_at) values ('${extraAttempt}','${extraWork}',now())`,undo:`delete from brain.work_attempts where token='${extraAttempt}'; delete from brain.work_items where id='${extraWork}'`},
  ];
  for(const scenario of cases) {
   await k.db.query(scenario.setup);
   const beforeRows=await k.db.rows("select row from (select to_jsonb(e) as row from brain.extensions e where name='garmin' union all select to_jsonb(h) from brain.work_hold_groups h) records order by row::text");
   const beforeWork=await k.db.rows("select * from brain.work_items order by id");const beforeAttempts=await k.db.rows("select * from brain.work_attempts order by token");const beforeFacts=await preserved(k,'garmin');
   try {const denied=await k.tty('correct');expect(denied.code,`${scenario.name}: ${denied.output}`).toBe(1);expect(denied.answered).toBe(false);expect(denied.output).toContain('DB_LOCKED');expect(await preserved(k,'garmin')).toBe(beforeFacts);expect(await k.db.rows("select row from (select to_jsonb(e) as row from brain.extensions e where name='garmin' union all select to_jsonb(h) from brain.work_hold_groups h) records order by row::text")).toEqual(beforeRows);expect(await k.db.rows("select * from brain.work_items order by id")).toEqual(beforeWork);expect(await k.db.rows("select * from brain.work_attempts order by token")).toEqual(beforeAttempts);}
   finally {await k.db.query(scenario.undo);} await unchanged();
  }
  // M4: missing object and dirty clone fail without running the installer.
  const missing=await k.tty('correct','f'.repeat(40));expect(missing.code,missing.output).toBe(1);expect(missing.answered).toBe(false);await unchanged();
  const diverged=await k.tty('correct',divergedRef);expect(diverged.code,diverged.output).toBe(1);expect(diverged.answered).toBe(false);await unchanged();
  await writeFile(join(k.app,'dirty-fixture'),'dirty');const dirty=await k.tty('correct');expect(dirty.code,dirty.output).toBe(1);expect(dirty.answered).toBe(false);await rm(join(k.app,'dirty-fixture'));await unchanged();
  git('-C',k.app,'remote','set-url','origin','file:///nonmatching-synthetic-repository');
  try {const wrongRepo=await k.tty('correct');expect(wrongRepo.code,wrongRepo.output).toBe(1);expect(wrongRepo.answered).toBe(false);await unchanged();}
  finally {git('-C',k.app,'remote','set-url','origin',`file://${bare}`);}
  const migration=join(k.dir,'migrations',(await readdir(join(k.dir,'migrations'))).sort()[0]!);const migrationBytes=await readFile(migration);
  try {await writeFile(migration,'tampered');const invalid=await k.tty('correct');expect(invalid.code,invalid.output).toBe(1);expect(invalid.output).toContain('DB_LOCKED');expect(invalid.answered).toBe(false);}
  finally {await writeFile(migration,migrationBytes);} await unchanged();
  const lock=join(k.home,'install.lock');await mkdir(lock);await writeFile(join(lock,'owner'),'777 another-owner\n');await writeFile(join(lock,'pid'),'777\n');
  const contenderReceipt=join(k.home,`pty-group-${randomUUID()}`);ptyGroupReceipts.add(contenderReceipt);
  const contender=spawn('python3',['-c',ptyProgram,'correct',process.execPath,join(k.plugin,'bootstrap.mjs'),targetRef,k.plugin,''],{env:{...k.env,BRAIN_TEST_PTY_GROUP_RECEIPT:contenderReceipt},stdio:['ignore','pipe','pipe'],detached:true});children.add(contender);if(contender.pid) processGroups.add(contender.pid);let contenderOutput='';contender.stdout.on('data',b=>contenderOutput+=String(b));contender.stderr.on('data',b=>contenderOutput+=String(b));
  try {await new Promise(resolve=>setTimeout(resolve,1500));expect(contender.exitCode).toBeNull();expect(await readFile(join(lock,'owner'),'utf8')).toBe('777 another-owner\n');await unchanged();}
  finally {const closed=new Promise<number|null>(resolve=>contender.once('close',code=>resolve(code)));contender.kill('SIGTERM');const code=await closed;children.delete(contender);if(contender.pid) {const remained=groupPresent(contender.pid);if(remained) await stopGroup(contender.pid);else processGroups.delete(contender.pid);expect(remained).toBe(false);} expect(await collectPtyGroup(contenderReceipt)).toBe(false);expect(code,contenderOutput).toBe(99);await rm(lock,{recursive:true});}
  expect(contenderOutput).not.toContain('확인 ');
  // A failed target build must leave the original app intact; the next supported attempt rebuilds it.
  const pnpm=execFileSync('which',['pnpm'],{encoding:'utf8'}).trim();const wrapper=join(k.home,'fake-bin/pnpm');
  await writeFile(wrapper,`#!/bin/sh\nif [ "$1" = build ]; then echo synthetic-build-failure >&2; exit 42; fi\nexec '${pnpm}' "$@"\n`);await chmod(wrapper,0o755);
  try {const failedBuild=await k.tty('correct');expect(failedBuild.code,failedBuild.output).toBe(1);expect(failedBuild.output).toContain('synthetic-build-failure');expect(failedBuild.answered).toBe(false);await unchanged();}
  finally {await rm(wrapper);}
  // M5: terminate at the current challenge, then follow the documented stale lock recovery only after the entire PTY process group exits.
  const interrupted=await k.tty('interrupt');expect(interrupted.answered,interrupted.output).toBe(true);expect(interrupted.code).not.toBe(0);expect(interrupted.groupGone).toBe(true);await unchanged();
  expect(interrupted.interruptedOwner).toMatch(new RegExp(`^${interrupted.pid} `));
  const interruptedFence=JSON.parse(interrupted.interruptedFence!) as {pid:number;boot_at:string;commit:string};
  expect(interruptedFence.pid).toBeGreaterThan(0);expect(interruptedFence.pid).not.toBe(interrupted.pid);expect(interruptedFence.boot_at).toBe('9999-01-01T00:00:00.000Z');expect(interruptedFence.commit).toBe(targetRef);
  expect(processGroups.size).toBe(0);expect(ptyGroupReceipts.size).toBe(0);
  try {process.kill(interruptedFence.pid,0);throw Error('중단된 설치기가 아직 존재합니다');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH') throw error;}
  const interruptedFencePath=join(k.home,'run/daemon.pid');expect(await readFile(interruptedFencePath,'utf8')).toBe(interrupted.interruptedFence);await rm(interruptedFencePath);
  expect(await readFile(join(k.home,'install.lock/owner'),'utf8')).toBe(interrupted.interruptedOwner);
  await rm(join(k.home,'install.lock'),{recursive:true,force:true});
  // A real progress-write failure leaves a journal and gate owned by the same attempt.
  await k.db.query(`create sequence brain.e2_progress_receipt; create function brain.e2_reject_progress() returns trigger language plpgsql security definer set search_path = pg_catalog, brain as $$ begin perform nextval('brain.e2_progress_receipt'); raise exception 'R2V3_SYNTHETIC_PROGRESS_FAILURE'; end $$; create trigger e2_reject_progress before insert on brain.extension_install_progress for each row execute function brain.e2_reject_progress()`);
  const failed=await k.tty('correct');expect(failed.answered,failed.output).toBe(true);expect(failed.code,failed.output).toBe(2);expect(failed.output).toContain('DB_UNAVAILABLE: R2V3_SYNTHETIC_PROGRESS_FAILURE');
  expect(await k.db.rows('select is_called from brain.e2_progress_receipt')).toEqual([{is_called:true}]);
  const journal=JSON.parse(await readFile(join(k.home,'run/bootstrap-extension-migrations.json'),'utf8')) as {owner:string};
  const gateBefore=await k.db.rows("select owner from brain.extension_quiesce where name='garmin'");expect(gateBefore).toEqual([{owner:journal.owner}]);
  expect(await preserved(k,'garmin')).toBe(baseline);expect(await k.db.rows("select * from brain.schema_migrations where owner='garmin' order by version")).toEqual(ledger);
  expect(git('-C',k.app,'rev-parse','HEAD')).toBe(targetRef);expect(git('-C',join(k.home,'.app-previous'),'rev-parse','HEAD')).toBe(oldRef);
  const failedMarker=JSON.parse(await readFile(join(k.home,'.app-promotion.json'),'utf8')) as {owner:string;target:string};
  const failedJournal=JSON.parse(await readFile(join(k.home,'run/bootstrap-extension-migrations.json'),'utf8')) as {promotionOwner:string};expect(failedMarker.owner).toBe(failedJournal.promotionOwner);expect(failedMarker.target).toBe(targetRef);
  await k.db.query('drop trigger e2_reject_progress on brain.extension_install_progress; drop function brain.e2_reject_progress(); drop sequence brain.e2_progress_receipt');
  // M1: the current challenge is read from this attempt, never supplied by the caller.
  const accepted=await k.tty('correct');expect(accepted.answered,accepted.output).toBe(true);expect(accepted.code,accepted.output).toBe(0);
  expect(await preserved(k,'garmin')).toBe(baseline);expect(await k.db.rows("select * from brain.schema_migrations where owner='garmin' order by version")).toEqual(ledger);
  const coreAfter=await k.db.rows("select version,name,checksum,applied_at from brain.schema_migrations where owner='core' order by version");expect(coreAfter.slice(0,coreBefore.length)).toEqual(coreBefore);expect(coreAfter.length).toBeGreaterThan(coreBefore.length);expect(coreAfter.map(row=>row.version)).toEqual(coreAfter.map((_,i)=>i+1));
  expect(git('-C',k.app,'rev-parse','HEAD')).toBe(targetRef);expect(JSON.parse(await readFile(join(k.home,'installed.json'),'utf8'))).toMatchObject({commit:targetRef,plugin_root:k.plugin});
  expect(await k.db.rows("select enabled from brain.extensions where name='garmin'")).toEqual([{enabled:false}]);expect(await k.db.rows("select name from brain.work_hold_groups where name='extension:garmin'")).toHaveLength(1);
  expect(await k.db.rows("select owner from brain.extension_quiesce where name='garmin'")).toEqual(gateBefore);
  expect((await k.db.rows("select progress from brain.extension_install_progress where name='garmin'"))[0]?.progress).toMatchObject({replacement:{owner:journal.owner}});
  const cli=await processRun(join(k.home,'bin/brain'),['ext','enable','garmin','--json'],k.env);expect(cli.code,cli.out).not.toBe(0);expect(cli.out).toContain('EXTENSION_REPLACEMENT_REQUIRED');
  // M6: the same explicit ref can be retried and the normal hook remains quiet.
  const retry=await k.tty('correct');expect(retry.code,retry.output).toBe(0);
  const hookAgain=await k.plain(['--ref',targetRef,'--yes','--plugin-root',k.plugin]);expect(hookAgain.code).toBe(0);expect(hookAgain.out).toBe('');const pluginRecord=JSON.parse(await readFile(join(k.home,'run/plugin.json'),'utf8'));expect(pluginRecord).toMatchObject({plugin_root:k.plugin,app_ref:targetRef});
 } finally {await k.close();}
}, 3600000);

it('M5: 승격 직후 중단한 실제 bootstrap을 같은 명령으로 복구한다', async () => {
 const k=await fixture();
 try {
  const before=await preserved(k,'garmin');
  const ledger=await k.db.rows("select * from brain.schema_migrations where owner='garmin' order by version");
  const coreBefore=await k.db.rows("select version,name,checksum,applied_at from brain.schema_migrations where owner='core' order by version");
  const installedBefore=await readFile(join(k.home,'installed.json'),'utf8');
  const injector=join(k.home,'stop-after-promotion.cjs');
  const receiptPath=join(k.home,'promotion-kill-receipt.json'), fencePath=join(k.home,'run/daemon.pid');
  await writeFile(injector, `const fs = require('node:fs'); const {syncBuiltinESMExports} = require('node:module'); const path = require('node:path'); const original = fs.promises.rename; fs.promises.rename = async function(from,to) { const result = await original.call(this,from,to); if (path.basename(String(from)) === '.app-next' && path.basename(String(to)) === 'app') { const home=process.env.SECOND_BRAIN_HOME; fs.writeFileSync(${JSON.stringify(receiptPath)},JSON.stringify({pid:process.pid,signal:'SIGKILL',from:String(from),to:String(to),fence:fs.readFileSync(path.join(home,'run/daemon.pid'),'utf8'),marker:fs.readFileSync(path.join(home,'.app-promotion.json'),'utf8'),journal:fs.readFileSync(path.join(home,'run/bootstrap-extension-migrations.json'),'utf8')})); process.kill(process.pid, 'SIGKILL'); } return result; }; syncBuiltinESMExports();\n`);
  k.env.NODE_OPTIONS=`--require=${injector}`;
  const interrupted=await k.tty('correct'); expect(interrupted.answered,interrupted.output).toBe(true);expect(interrupted.code,interrupted.output).toBe(1);expect(interrupted.groupGone).toBe(true);
  delete k.env.NODE_OPTIONS;
  const receipt=JSON.parse(await readFile(receiptPath,'utf8')) as {pid:number;signal:string;from:string;to:string;fence:string;marker:string;journal:string};
  const markerText=await readFile(join(k.home,'.app-promotion.json'),'utf8'), journalText=await readFile(join(k.home,'run/bootstrap-extension-migrations.json'),'utf8'), fenceText=await readFile(fencePath,'utf8');
  const marker=JSON.parse(markerText) as {target:string;owner:string};
  const journal=JSON.parse(journalText) as {owner:string;promotionOwner:string;commit:string};
  const fence=JSON.parse(fenceText) as {pid:number;boot_at:string;commit:string};
  expect(receipt).toMatchObject({signal:'SIGKILL',from:join(k.home,'.app-next'),to:k.app,fence:fenceText,marker:markerText,journal:journalText});
  expect(receipt.pid).toBe(fence.pid);expect(receipt.pid).not.toBe(interrupted.pid);expect(fence.boot_at).toBe('9999-01-01T00:00:00.000Z');expect(fence.commit).toBe(targetRef);
  expect(marker.owner.startsWith(`${interrupted.pid} `)).toBe(true);expect(journal.commit).toBe(targetRef);
  expect(marker.target).toBe(targetRef);expect(marker.owner).toBe(journal.promotionOwner);
  expect(git('-C',k.app,'rev-parse','HEAD')).toBe(targetRef);
  expect(await preserved(k,'garmin')).toBe(before);expect(await k.db.rows("select * from brain.schema_migrations where owner='garmin' order by version")).toEqual(ledger);
  expect(await readFile(join(k.home,'installed.json'),'utf8')).toBe(installedBefore);
  const gateBefore=await k.db.rows("select to_regclass('brain.extension_quiesce')::text as gate");
  // A dead PID alone is insufficient: the supported retry must preserve the fence.
  const denied=await k.tty('correct');expect(denied.code,denied.output).toBe(1);expect(denied.output).toContain('DB_LOCKED');expect(denied.answered).toBe(false);expect(await readFile(fencePath,'utf8')).toBe(fenceText);
  expect(await readFile(join(k.home,'.app-promotion.json'),'utf8')).toBe(markerText);expect(await readFile(join(k.home,'run/bootstrap-extension-migrations.json'),'utf8')).toBe(journalText);
  expect(await k.db.rows("select to_regclass('brain.extension_quiesce')::text as gate")).toEqual(gateBefore);
  // This fixture blocks all other entrants and has observed both process groups gone.
  expect(processGroups.size).toBe(0);expect(ptyGroupReceipts.size).toBe(0);
  try {process.kill(receipt.pid,0);throw Error('중단된 설치기가 아직 존재합니다');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH') throw error;}
  expect(await readFile(fencePath,'utf8')).toBe(receipt.fence);await rm(fencePath);
  const resumed=await k.tty('correct');expect(resumed.answered,resumed.output).toBe(true);expect(resumed.code,resumed.output).toBe(0);expect(resumed.challenge).not.toBe(interrupted.challenge);
  expect(await k.db.rows("select owner from brain.extension_quiesce where name='garmin'")).toEqual([{owner:journal.owner}]);
  expect(JSON.parse(await readFile(join(k.home,'installed.json'),'utf8')).commit).toBe(targetRef);
  expect(await preserved(k,'garmin')).toBe(before);expect(await k.db.rows("select * from brain.schema_migrations where owner='garmin' order by version")).toEqual(ledger);
  const coreAfter=await k.db.rows("select version,name,checksum,applied_at from brain.schema_migrations where owner='core' order by version");expect(coreAfter.slice(0,coreBefore.length)).toEqual(coreBefore);
  await expect(readFile(join(k.home,'.app-promotion.json'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(lstat(join(k.home,'.app-previous'))).rejects.toMatchObject({code:'ENOENT'});
 } finally {delete k.env.NODE_OPTIONS;await k.close();}
}, 1800000);

it('M5: PG 완료 후 설치 기록 전 중단은 새 확인과 같은 gate owner로 이어간다', async () => {
 const k=await fixture();
 try {
  const before=await preserved(k,'garmin');const oldRecord=await readFile(join(k.home,'installed.json'),'utf8');
  const beforeExt=await k.db.rows("select * from brain.schema_migrations where owner='garmin' order by version");
  const beforeCore=await k.db.rows("select version,name,checksum,applied_at from brain.schema_migrations where owner='core' order by version");
  const injector=join(k.home,'stop-before-record.cjs');
  const receipt=join(k.home,'installed-rename-receipt.json');
  await writeFile(injector,`const fs=require('node:fs'),path=require('node:path'),{syncBuiltinESMExports}=require('node:module');const original=fs.promises.rename;fs.promises.rename=async function(from,to){if(path.basename(String(to))==='installed.json'){fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({from:String(from),to:String(to),pid:process.pid,signal:'SIGKILL'}));process.kill(process.pid,'SIGKILL')}return original.call(this,from,to)};syncBuiltinESMExports();\n`);
  k.env.NODE_OPTIONS=`--require=${injector}`;const stopped=await k.tty('correct');delete k.env.NODE_OPTIONS;
  expect(stopped.code,stopped.output).toBe(1);expect(stopped.answered).toBe(true);expect(stopped.groupGone).toBe(true);
  const killed=JSON.parse(await readFile(receipt,'utf8')) as {from:string;to:string;pid:number;signal:string};expect(killed.to).toBe(join(k.home,'installed.json'));expect(dirname(killed.from)).toBe(k.home);expect(killed.pid).toBeGreaterThan(0);expect(killed.pid).not.toBe(stopped.pid);expect(killed.signal).toBe('SIGKILL');
  expect(await readFile(join(k.home,'installed.json'),'utf8')).toBe(oldRecord);
  const marker=JSON.parse(await readFile(join(k.home,'.app-promotion.json'),'utf8')) as {owner:string;previousHead:string};
  const journal=JSON.parse(await readFile(join(k.home,'run/bootstrap-extension-migrations.json'),'utf8')) as {owner:string;promotionOwner:string;previousHead:string};
  expect(journal.promotionOwner).toBe(marker.owner);expect(journal.previousHead).toBe(oldRef);expect(marker.previousHead).toBe(oldRef);
  expect(git('-C',k.app,'rev-parse','HEAD')).toBe(targetRef);expect(git('-C',join(k.home,'.app-previous'),'rev-parse','HEAD')).toBe(oldRef);
  expect(await k.db.rows("select owner from brain.extension_quiesce where name='garmin'")).toEqual([{owner:journal.owner}]);
  const core=await k.db.rows("select version,name,checksum,applied_at from brain.schema_migrations where owner='core' order by version");expect(core.slice(0,beforeCore.length)).toEqual(beforeCore);expect(core.length).toBeGreaterThan(beforeCore.length);
  expect(await preserved(k,'garmin')).toBe(before);expect(await k.db.rows("select * from brain.schema_migrations where owner='garmin' order by version")).toEqual(beforeExt);
  const resumed=await k.tty('correct');expect(resumed.code,resumed.output).toBe(0);expect(resumed.answered).toBe(true);expect(resumed.challenge).not.toBe(stopped.challenge);
  expect(await k.db.rows("select owner from brain.extension_quiesce where name='garmin'")).toEqual([{owner:journal.owner}]);
  expect(await preserved(k,'garmin')).toBe(before);expect(await k.db.rows("select * from brain.schema_migrations where owner='garmin' order by version")).toEqual(beforeExt);
  expect(JSON.parse(await readFile(join(k.home,'installed.json'),'utf8'))).toMatchObject({commit:targetRef,plugin_root:k.plugin});
 } finally {delete k.env.NODE_OPTIONS;await k.close();}
},1800000);

it('M5: 완료 기록 뒤 cleanup 중단은 변경된 backup을 보존하고 복원 뒤 재개한다', async () => {
 const k=await fixture();
 try {
  const before=await preserved(k,'garmin'), backup=join(k.home,'.app-previous');
  const injector=join(k.home,'stop-before-cleanup.cjs');
  await writeFile(injector,`const fs=require('node:fs'),path=require('node:path');const original=fs.rmSync;fs.rmSync=function(target,...args){if(String(target).includes(path.sep+'.app-previous'+path.sep)) process.kill(process.pid,'SIGKILL');return original.call(this,target,...args)};\n`);
  k.env.NODE_OPTIONS=`--require=${injector}`;const stopped=await k.tty('correct');delete k.env.NODE_OPTIONS;
  expect(stopped.code,stopped.output).not.toBe(0);expect(stopped.answered).toBe(true);expect(stopped.groupGone).toBe(true);
  expect(JSON.parse(await readFile(join(k.home,'installed.json'),'utf8'))).toMatchObject({commit:targetRef,plugin_root:k.plugin});
  expect(git('-C',backup,'rev-parse','HEAD')).toBe(oldRef);expect(await preserved(k,'garmin')).toBe(before);
  // The group termination is observed before applying the documented stale-lock recovery.
  await rm(join(k.home,'install.lock'),{recursive:true,force:true});
  const changed=join(backup,'synthetic-local-change');await writeFile(changed,'preserve');
  const refused=await k.tty('correct');expect(refused.code,refused.output).toBe(1);expect(refused.answered).toBe(false);expect(await readFile(changed,'utf8')).toBe('preserve');
  expect(await preserved(k,'garmin')).toBe(before);await rm(changed);
  const resumed=await k.tty('correct');expect(resumed.code,resumed.output).toBe(0);
  await expect(lstat(backup)).rejects.toMatchObject({code:'ENOENT'});await expect(lstat(join(k.home,'.app-promotion.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await preserved(k,'garmin')).toBe(before);
 } finally {delete k.env.NODE_OPTIONS;await k.close();}
},1800000);

it.each(['README.md', '.git/config'])('M5: 부분 삭제된 %s backup은 새 변경을 보존하고 지원 명령으로 정리한다', async missing => {
 const k=await fixture();
 try {
  const before=await preserved(k,'garmin'), backup=join(k.home,'.app-previous');
  const injector=join(k.home,'stop-during-cleanup.cjs');
  const receipt=join(k.home,'partial-cleanup-receipt.json');
  await writeFile(injector,`const fs=require('node:fs'),path=require('node:path');const original=fs.rmSync;fs.rmSync=function(target,...args){if(String(target).includes(path.sep+'.app-previous'+path.sep)){const removed=path.join(${JSON.stringify(backup)},${JSON.stringify(missing)});original.call(this,removed,{force:true});fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({target:String(target),removed,pid:process.pid,signal:'SIGKILL'}));process.kill(process.pid,'SIGKILL')}return original.call(this,target,...args)};\n`);
  k.env.NODE_OPTIONS=`--require=${injector}`;const stopped=await k.tty('correct');delete k.env.NODE_OPTIONS;
  expect(stopped.code,stopped.output).toBe(-9);expect(stopped.answered).toBe(true);expect(stopped.groupGone).toBe(true);
  const killed=JSON.parse(await readFile(receipt,'utf8')) as {target:string;removed:string;pid:number;signal:string};expect(killed.target.startsWith(`${backup}/`)).toBe(true);expect(killed.removed).toBe(join(backup,missing));expect(killed.pid).toBe(stopped.pid);expect(killed.signal).toBe('SIGKILL');
  expect(JSON.parse(await readFile(join(k.home,'.app-promotion.json'),'utf8'))).toMatchObject({cleanup:true});
  await expect(lstat(join(backup,missing))).rejects.toMatchObject({code:'ENOENT'});
  await rm(join(k.home,'install.lock'),{recursive:true,force:true});
  const added=join(backup,'synthetic-local-change');await writeFile(added,'preserve');
  const refused=await k.tty('correct');expect(refused.code,refused.output).toBe(1);expect(await readFile(added,'utf8')).toBe('preserve');
  await rm(added);const resumed=await k.tty('correct');expect(resumed.code,resumed.output).toBe(0);
  await expect(lstat(backup)).rejects.toMatchObject({code:'ENOENT'});await expect(lstat(join(k.home,'.app-promotion.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await preserved(k,'garmin')).toBe(before);
 } finally {delete k.env.NODE_OPTIONS;await k.close();}
},1800000);
