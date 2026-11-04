import { createHash } from 'node:crypto';
import { copyFile, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('upgrades legacy 0008 ties without changing old observations', async () => {
  const {postgresStore,runMigrations}=await import('second_brain/postgres');
  const {runDaemon}=await import('../src/daemon/run.js');
  const {systemClock}=await import('../src/runtime/clock.js');
  const {uuidV7IdGen}=await import('../src/runtime/id-gen.js');
  const fixture=await extHome(), ids=uuidV7IdGen(), controller=new AbortController();
  const store=postgresStore({databaseUrl:fixture.db.appUrl});
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const home=await realpath(fixture.home), ext=join(home,'extensions/garmin'), migrations=join(ext,'migrations');
    const migration=join(migrations,'0009_day_publication.sql'), saved=join(home,'0009_day_publication.sql');
    const noticeMigration=join(migrations,'0011_collect_notices.sql'), savedNotice=join(home,'0011_collect_notices.sql');
    // Installation starts on the current bundle. Reconstruct the exact empty
    // 0008 schema and ledger, then run the production migration runner below.
    await fixture.db.query("drop table garmin.collect_notices,garmin.collect_snapshot_items,garmin.collect_snapshots,garmin.body_sources,garmin.body_documents,garmin.body_measurements; drop table garmin.normalize_day_dirty; drop table garmin.normalize_day_revisions; alter table garmin.normalize_items drop column null_materialized; delete from brain.schema_migrations where owner='garmin' and version in (9,10,11)");
    await rename(migration,saved); await rename(noticeMigration,savedNotice);
    expect((await fixture.ledger('garmin')).at(-1)).toEqual({owner:'garmin',version:8});
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests/',import.meta.url));
    await copyFile(join(fixtures,'collect_fixture.py'),join(ext,'collect_fixture.py'));
    await copyFile(join(fixtures,'legacy_upgrade_fixture.py'),join(ext,'legacy_upgrade_fixture.py'));
    const manifestPath=join(ext,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    manifest.work.find((w:any)=>w.kind==='garmin.normalize').entry='legacy_upgrade_fixture.py';
    await writeFile(manifestPath,JSON.stringify(manifest));
    await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify({home,database:new URL(fixture.db.url).pathname.slice(1),host:new URL(fixture.db.url).hostname,port:new URL(fixture.db.url).port}));
    await store.setSetting({key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    daemon=runDaemon({home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const queue=async()=>{
      const id=ids.next(), now=new Date();
      expect(await store.addWork({id,kind:'garmin.normalize',targetKind:'account',targetId:'12345',createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});
      await expect.poll(async()=>(await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    };
    await queue();
    const bases=JSON.parse(await readFile(join(home,'legacy-day-bases.json'),'utf8'));
    const alias=createHash('sha256').update(JSON.stringify([bases['2026-01-01'],'legacy-collision-repair'])).digest('hex');
    const dataset=String((await fixture.db.rows("select dataset from garmin.datasets where account='12345'"))[0]!.dataset);
    const legacy=await fixture.db.rows(`select id::text,import_batch,revision,value,normalization_version,to_char(fetched_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') fetched from brain.health_observations where dataset='${dataset}' and metric='day_summary.steps' order by id`);
    const legacyStates=await fixture.db.rows(`select day::text,revision,normalization_version,fetched_at_ms::text,ok,error_code,normalized_at_ms::text from garmin.normalize_days where dataset='${dataset}' order by day,revision`);
    expect(legacy).toHaveLength(3);
    expect(await fixture.db.rows(`select reason from brain.health_resolution_v1 where dataset='${dataset}' and metric='day_summary.steps' and local_date='2026-01-01'`)).toEqual([{reason:'revision_ambiguous'}]);
    expect(await fixture.db.rows(`select value,revision from brain.health_current_v1 where dataset='${dataset}' and metric='day_summary.steps' and local_date='2026-01-02'`)).toEqual([{value:2222,revision:bases['2026-01-02']}]);
    await rename(saved,migration); await rename(savedNotice,noticeMigration);
    expect(await runMigrations({databaseUrl:fixture.db.url,clock:systemClock,owners:[{owner:'garmin',directory:migrations}]})).toMatchObject({ok:true,applied:['0009_day_publication.sql','0010_runtime_body.sql','0011_collect_notices.sql']});
    expect((await fixture.ledger('garmin')).at(-1)).toEqual({owner:'garmin',version:11});
    expect(await fixture.db.rows(`select ok,null_materialized from garmin.normalize_items where dataset='${dataset}' and key='2025-12-30' and endpoint='rhr_day'`)).toEqual([{ok:true,null_materialized:false}]);
    expect(await fixture.db.rows(`select reason from brain.health_resolution_v1 where dataset='${dataset}' and metric='day_summary.steps' and local_date='2026-01-01'`)).toEqual([{reason:'revision_ambiguous'}]);
    manifest.work.find((w:any)=>w.kind==='garmin.normalize').entry='src/normalize.py';
    await writeFile(manifestPath,JSON.stringify(manifest));
    await queue();
    const current=await fixture.db.rows(`select value,revision,normalization_version,to_char(fetched_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') fetched from brain.health_current_v1 where dataset='${dataset}' and metric='day_summary.steps' and local_date='2026-01-01'`);
    expect(current).toEqual([{value:1111,revision:alias,normalization_version:8,fetched:'2033-05-18 03:33:20.000001'}]);
    expect(await fixture.db.rows(`select value,revision from brain.health_current_v1 where dataset='${dataset}' and metric='day_summary.steps' and local_date='2026-01-02'`)).toEqual([{value:2222,revision:bases['2026-01-02']}]);
    const observations=()=>fixture.db.rows(`select id::text,import_batch,revision,value,normalization_version,to_char(fetched_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') fetched from brain.health_observations where dataset='${dataset}' and metric='day_summary.steps' order by id`);
    const after=await observations(); expect(after).toHaveLength(4);
    expect(after.filter(r=>legacy.some(l=>l.id===r.id))).toEqual(legacy);
    const states=await fixture.db.rows(`select day::text,revision,normalization_version,fetched_at_ms::text,ok,error_code,normalized_at_ms::text from garmin.normalize_days where dataset='${dataset}' and revision in ('${bases['2026-01-01']}','${bases['2026-01-02']}','${bases.other}') order by day,revision`);
    expect(states).toEqual(legacyStates);
    await queue(); expect(await observations()).toEqual(after);
    const sourcePath=join(ext,'src/normalize_store.py');
    await writeFile(sourcePath,(await readFile(sourcePath,'utf8')).replace('NORMALIZATION_VERSION = 8','NORMALIZATION_VERSION = 9'));
    await fixture.db.query('insert into brain.health_supported_versions values (9)');
    await queue();
    expect(await fixture.db.rows(`select value,revision,normalization_version,to_char(fetched_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') fetched from brain.health_current_v1 where dataset='${dataset}' and metric='day_summary.steps' and local_date='2026-01-01'`)).toEqual([{...current[0],normalization_version:9}]);
    const allVersions=await observations();
    expect(allVersions.filter(r=>legacy.some(l=>l.id===r.id))).toEqual(legacy);
    expect(allVersions.filter(r=>r.revision===alias).map(r=>r.fetched)).toEqual([current[0]!.fetched,current[0]!.fetched]);
    await queue(); expect(await observations()).toEqual(allVersions);
  } finally {controller.abort(); await daemon; await store.close(); await fixture.cleanup();}
},180000);
