import { it } from 'vitest';
import { extensionQuiesceContract } from '../../core/src/testing/contracts/extension-quiesce.js';
import { subject } from './fixture.js';
for (const c of extensionQuiesceContract()) it(c.name, () => c.run(subject));

it('직접 지정한 과거 hold group도 차단하고 발화·claim과 gate 획득은 직렬화한다', async () => {
  const { expect } = await import('vitest');
  const pg = await import('pg'); const { database, clock } = await import('./fixture.js'); const { postgresStore } = await import('../src/index.js');
  const db = await database(), store = postgresStore({databaseUrl:db.appUrl});
  const admin = new pg.default.Client({connectionString:db.url}); await admin.connect();
  const owner = '00000000-0000-7000-8000-000000000090', now = clock.now();
  try {
    await store.recordExtensionInstall({name:'testext',version:'1',now,workKinds:['testext.job']});
    await store.addWork({id:'00000000-0000-7000-8000-000000000001',kind:'testext.job',targetKind:'probe',targetId:'a',createdAt:now,nextAttemptAt:now});
    await admin.query("update brain.work_items set hold_group='custom' where kind='testext.job'");
    await admin.query('begin'); await admin.query('lock table brain.extension_quiesce in share mode');
    let entered = false; const pending = store.beginExtensionQuiesce({name:'testext',owner,now}).then(result => {entered=true;return result;});
    await new Promise(resolve => setTimeout(resolve,100)); expect(entered).toBe(false);
    await admin.query('commit'); expect(await pending).toEqual({ok:true,acquired:true});
    expect(await store.claimSupervisedWork({now,claimedBy:'worker',kinds:['testext.job'],attemptToken:'00000000-0000-7000-8000-000000000002'})).toMatchObject({ok:true,item:null});
  } finally { await admin.query('rollback').catch(()=>{}); await admin.end(); await store.close(); await db.drop(); }
});

it('실행 중 자식의 종료와 DB 정산이 확인될 때까지 quiesce를 완료하지 않는다', async () => {
  const { expect } = await import('vitest'); const { spawn } = await import('node:child_process');
  const { quiesceExtension } = await import('@second-brain/core'); const { database, clock } = await import('./fixture.js'); const { postgresStore } = await import('../src/index.js');
  const db = await database(), store = postgresStore({databaseUrl:db.appUrl}), now=clock.now();
  const id='00000000-0000-7000-8000-000000000001', token='00000000-0000-7000-8000-000000000002', owner='00000000-0000-7000-8000-000000000003';
  const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0), 600)'],{stdio:'ignore'}); const exit=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  try {
    await store.recordExtensionInstall({name:'testext',version:'1',now,workKinds:['testext.job']});
    await store.addWork({id,kind:'testext.job',targetKind:'probe',targetId:'a',createdAt:now,nextAttemptAt:now});
    expect(await store.claimSupervisedWork({now,claimedBy:'worker',kinds:['testext.job'],attemptToken:token})).toMatchObject({ok:true,item:{id}});
    let finished=false; const pending=quiesceExtension(store,{sleep:(ms,signal)=>new Promise<void>(resolve=>{const t=setTimeout(resolve,ms);signal.addEventListener('abort',()=>{clearTimeout(t);resolve();},{once:true});})},{name:'testext',owner,now}).then(r=>{finished=true;return r;});
    await new Promise(resolve=>setTimeout(resolve,150)); expect(finished).toBe(false); expect(child.exitCode).toBeNull();
    await exit; expect(finished).toBe(false);
    expect(await store.settleSupervisedAttempt({id,attemptToken:token,now,outcome:'died'})).toMatchObject({ok:true});
    expect(await pending).toEqual({ok:true});
    expect(await store.endExtensionQuiesce({name:'testext',owner})).toEqual({ok:true,released:true});
  } finally { if(child.exitCode===null)child.kill('SIGKILL'); await store.close(); await db.drop(); }
},10000);

it('34→35는 package registry와 기존 사용자 설정을 보존한다', async () => {
  const { expect } = await import('vitest'); const { database, clock } = await import('./fixture.js'); const { runMigrations } = await import('../src/index.js');
  const db = await database(false);
  try {
    expect(await runMigrations({databaseUrl:db.url,clock,coreMaxVersion:34})).toMatchObject({ok:true,to:34});
    await db.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at,package_digest,plugin_version) values ('testext','1.0.0',now(),false,now(),repeat('a',64),'2.0.0')");
    const before = await db.rows("select * from brain.extensions where name='testext'");
    expect(await runMigrations({databaseUrl:db.url,clock})).toMatchObject({ok:true,from:34,to:38});
    expect(await db.rows("select * from brain.extensions where name='testext'")).toEqual(before);
    expect(await db.rows('select * from brain.extension_quiesce')).toEqual([]);
  } finally { await db.drop(); }
});

it.each(['core', 'supervised', 'fire'] as const)('실제 %s 트랜잭션과 gate는 양쪽 선행 순서에서 직렬화된다', async operation => {
  const { expect } = await import('vitest'); const pg = await import('pg');
  const { database, clock } = await import('./fixture.js'); const { postgresStore } = await import('../src/index.js');
  const { sampleSelfUserInput } = await import('../../core/src/testing/fixtures.js');
  for (const first of ['operation', 'gate'] as const) {
    const db = await database(), store = postgresStore({ databaseUrl: db.appUrl }), gateStore = postgresStore({ databaseUrl: db.appUrl });
    const blocker = new pg.default.Client({ connectionString: db.url }); await blocker.connect();
    const pending: Promise<unknown>[] = [];
    const now = clock.now(), id = '00000000-0000-7000-8000-000000000001', token = '00000000-0000-7000-8000-000000000002', owner = '00000000-0000-7000-8000-000000000003';
    try {
      const self = await store.ensureSelfUser(sampleSelfUserInput()); if (!self.ok) throw new Error(self.message);
      expect((await store.recordExtensionInstall({ name:'testext', version:'1', now, workKinds:['testext.job'] })).ok).toBe(true);
      const work = { id, kind:'testext.job', targetKind:'probe', targetId:'a', createdAt:now, nextAttemptAt:now };
      if (operation !== 'fire') {
        expect((await store.addWork(work)).ok).toBe(true);
        await db.query(`update brain.work_items set execution_class='${operation === 'core' ? 'core' : 'supervised'}' where id='${id}'`);
      } else {
        expect((await store.addSchedule({ id, kind:'testext.job', holdGroup:'custom', targetKind:'probe', targetId:'a', triggerKind:'cron', cronExpr:'0 9 * * *', runAt:null, triggerUpdatedAt:null, timeZone:'UTC', timeZoneSource:'fixed', intervalSeconds:null, extension:'testext', scheduleKey:'key', userId:self.user.id, enabled:true, removedAt:null, nextRunAt:now, lastRunAt:null, createdAt:now })).ok).toBe(true);
      }
      // Block inside the production transaction after it has acquired its
      // table lock, then start the competing production transaction.
      const table = first === 'gate' ? 'extension_quiesce' : operation === 'fire' ? 'schedules' : 'work_items';
      const event = first === 'gate' ? 'insert' : 'update';
      await db.query(`create function brain.race_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(987654321); return new; end $$; create trigger race_barrier before ${event} on brain.${table} for each row execute function brain.race_barrier()`);
      await blocker.query('select pg_advisory_lock(987654321)');
      const gate = () => gateStore.beginExtensionQuiesce({ name:'testext', owner, now });
      const run = () => operation === 'core' ? store.claimWork({ now, claimedBy:'worker', kinds:['testext.job'] }) : operation === 'supervised' ? store.claimSupervisedWork({ now, claimedBy:'worker', kinds:['testext.job'], attemptToken:token }) : store.fireSchedule({ scheduleId:id, expectedTriggerKind:'cron', expectedTimeZone:'UTC', expectedCronExpr:'0 9 * * *', expectedNextRunAt:now, nextRunAt:new Date(now.getTime()+60000), now, occurrences:[{ occurrenceAt:now, status:'pending' }], work:{ ...work, id:'00000000-0000-7000-8000-000000000004' } });
      const leading = first === 'gate' ? gate() : run(); pending.push(leading);
      await expect.poll(async () => (await db.rows("select count(*)::int as n from pg_locks where locktype='advisory' and objid=987654321 and not granted"))[0]?.n, { timeout:10000 }).toBe(1);
      let completed = false; const trailing = (first === 'gate' ? run() : gate()).then(value => { completed = true; return value; });
      pending.push(trailing);
      await expect.poll(async () => (await db.rows("select count(*)::int as n from pg_locks where relation='brain.extension_quiesce'::regclass and not granted"))[0]?.n, { timeout:10000 }).toBeGreaterThan(0);
      expect(completed).toBe(false); await blocker.query('select pg_advisory_unlock(987654321)');
      const [lead, trail] = await Promise.all([leading, trailing]); expect(lead.ok).toBe(true); expect(trail.ok).toBe(true);
      const result = first === 'gate' ? trail : lead;
      if (operation === 'fire') expect(result).toMatchObject({ ok:true, fired:first === 'operation' });
      else expect(result).toMatchObject({ ok:true, item:first === 'operation' ? expect.objectContaining({ id }) : null });
      expect((await db.rows('select count(*)::int as n from brain.schedule_occurrences'))[0]!.n).toBe(operation === 'fire' && first === 'operation' ? 1 : 0);
      expect((await db.rows('select count(*)::int as n from brain.work_items'))[0]!.n).toBe(operation === 'fire' ? (first === 'operation' ? 1 : 0) : 1);
      const stopped = await store.readExtensionQuiesce('testext'); expect(stopped).toMatchObject({ ok:true, owner, running:operation !== 'fire' && first === 'operation' ? 1 : 0 });
    } finally { await blocker.query('select pg_advisory_unlock_all()').catch(()=>{}); await Promise.allSettled(pending); await blocker.end(); await store.close(); await gateStore.close(); await db.drop(); }
  }
}, 60000);
