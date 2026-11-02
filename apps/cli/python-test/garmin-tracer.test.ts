import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('기본 배송 경로의 Garmin을 잠긴 Python으로 설치하고 연결한다', async () => {
  const fixture = await extHome();
  try {
    const installed = await fixture.run(['ext', 'install', 'garmin', '--json']);
    expect(installed, installed.stderr + installed.stdout).toMatchObject({ code: 0 });
    const python = join(fixture.home, 'extensions', 'garmin', '.venv', 'bin', 'python');
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(fixture.home, 'extensions', 'garmin', 'src', 'health.py'), 'utf8')).toContain('def convert(');
    const { fileURLToPath } = await import('node:url');
    const checker = fileURLToPath(new URL('../../../extensions/garmin/tests/check_health_contract.py', import.meta.url));
    expect(execFileSync(python, [checker], { encoding: 'utf8', env: { ...process.env, BRAIN_HEALTH_MODULE_DIR: join(fixture.home, 'extensions', 'garmin', 'src') } })).toContain('건강 선택 18건, 집계 6건');
    expect(execFileSync(python, ['-c', 'import platform, psycopg; print(platform.python_version(), psycopg.__version__)'], { encoding: 'utf8' }).trim()).toBe('3.14.10 3.3.6');
    const roundtrip = execFileSync(python, ['-c', "import psycopg, sys; c=psycopg.connect(__import__('os').environ['TEST_DATABASE_URL']); r=c.execute('select %s::text, %s::bigint, %s::text', ('한글', 1700000000123, None)).fetchone(); print(r[0], r[1], r[2])"], { encoding: 'utf8', env: { ...process.env, TEST_DATABASE_URL: fixture.db.url } }).trim();
    expect(roundtrip).toBe('한글 1700000000123 None');
    expect(await fixture.ledger('garmin')).toEqual([{ owner: 'garmin', version: 1 }, { owner: 'garmin', version: 2 }, { owner: 'garmin', version: 3 }, { owner: 'garmin', version: 4 }, { owner: 'garmin', version: 5 }, { owner: 'garmin', version: 6 }, { owner: 'garmin', version: 7 }]);
    const status = await fixture.run(['ext', 'status', 'garmin', '--json']);
    expect(status.body.data).toMatchObject({ installed: true, connection: { status: 'connected' }, python_environment: { status: 'succeeded' } });
  } finally { await fixture.cleanup(); }
});

it('합성 snapshot과 문서를 실제 감독자로 이전하고 재실행한다', async () => {
  const { writeFile, mkdir, readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { postgresStore } = await import('second_brain/postgres');
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome(), controller = new AbortController(), ids = uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  let sends = 0;
  const server = createServer((_request, response) => { sends++; response.writeHead(200); response.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  try {
    const installed = await fixture.run(['ext', 'install', 'garmin', '--json']);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    const snapshot = join(fixture.home,'snapshot.sqlite'), document = join(fixture.home,'report.md'), staging = join(fixture.home,'extensions/garmin/staging');
    const python = join(fixture.home,'extensions/garmin/.venv/bin/python');
    execFileSync(python, [fileURLToPath(new URL('../../../extensions/garmin/tests/fixtures.py', import.meta.url)), snapshot, '15']);
    await writeFile(document, '# 합성 보고서\n\n기록 본문입니다.\n'); await mkdir(staging, { recursive: true });
    const snapshotHash = hash(await readFile(snapshot)), documentHash = hash(await readFile(document));
    for (const [key,value] of Object.entries({ 'garmin.snapshot_path': snapshot, 'garmin.legacy_path': document, 'garmin.staging_path': staging, 'garmin.artifact_root': fixture.home, 'garmin.dataset': 'synthetic' })) {
      expect(await store.setSetting({ key, value, updatedAt: new Date() })).toMatchObject({ ok: true });
    }
    daemon = runDaemon({ home: fixture.home, env: fixture.env, clock: systemClock, idGen: ids, signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25, channelTestEndpoint: endpoint } });
    const runImport = async () => {
      const id = ids.next(), now = new Date();
      expect(await store.addWork({ id,kind:'garmin.import',targetKind:'import',targetId:'synthetic',createdAt:now,nextAttemptAt:now })).toMatchObject({ok:true});
      await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome, { timeout: 20000 }).toBe('succeeded');
    };
    await runImport();
    await expect.poll(async () => Number((await fixture.db.rows("select count(*)::int as n from brain.document_extractions where status='ok'"))[0]?.n), { timeout: 20000 }).toBe(1);
    expect(await fixture.db.rows("select definition->>'unit' as unit, definition->'mappings'->0->>'factor' as factor from brain.health_catalog_v1 where metric='daily_metric.steps'")).toEqual([{unit:'count',factor:'1'}]);
    expect(await fixture.db.rows('select source,dataset,metric,value,unit from brain.health_current_v1')).toMatchObject([{source:'garmin',dataset:'synthetic',metric:'steps',value:1234,unit:'count'}]);
    expect(await store.imports.readHealth()).toMatchObject({ ok: true, rows: [{ source: 'garmin', dataset: 'synthetic', value: 1234, time_zone: 'Asia/Seoul', time_zone_missing: false }] });
    await store.setSetting({key:'timezone',value:'America/New_York',updatedAt:new Date()});
    expect(await fixture.db.rows("select local_date::text,time_zone from brain.health_current_v1 where dataset='synthetic'")).toEqual([{local_date:'2026-01-01',time_zone:'Asia/Seoul'}]);
    expect(await store.imports.readAnalyses()).toMatchObject({ ok: true, rows: [{ source: 'garmin', dataset: 'synthetic' }] });
    const rawResult = await store.imports.readRaw({ source: 'garmin', rawViews: ['raw_records'] });
    expect(rawResult).toMatchObject({ok:true,extensionEnabled:true});
    const raw = rawResult.ok ? rawResult.rows : [];
    expect(await store.imports.readRaw({source:'missingext',rawViews:['raw_records']})).toMatchObject({ok:false,code:'IMPORT_VIEW_INVALID'});
    const disabled = await fixture.run(['ext','disable','garmin','--json']);
    expect(disabled.code, disabled.stdout + disabled.stderr).toBe(0);
    expect(await store.imports.readRaw({source:'garmin',rawViews:['raw_records']})).toEqual({ok:true,extensionEnabled:false,rows:raw});
    const heldId=ids.next(), heldNow=new Date();
    expect(await store.addWork({id:heldId,kind:'garmin.import',targetKind:'import',targetId:'held',holdGroup:'extension:garmin',createdAt:heldNow,nextAttemptAt:heldNow})).toMatchObject({ok:true});
    expect(await store.claimSupervisedWork({now:new Date(),claimedBy:'test',kinds:['garmin.import'],attemptToken:ids.next()})).toMatchObject({ok:true,item:null});
    expect((await fixture.db.rows(`select attempts,completed_at from brain.work_items where id='${heldId}'`))[0]).toMatchObject({attempts:0,completed_at:null});
    await fixture.db.query(`delete from brain.work_items where id='${heldId}'`);
    const enabled=await fixture.run(['ext','enable','garmin','--json']); expect(enabled.code,enabled.stdout+enabled.stderr).toBe(0);
    expect(await store.imports.readRaw({source:'garmin',rawViews:['raw_records']})).toEqual({ok:true,extensionEnabled:true,rows:raw});
    expect(await fixture.db.rows('select fetched_at_ms::text,checked_at_ms::text,library_version from garmin.raw_payloads')).toEqual([{fetched_at_ms:'1700000000123',checked_at_ms:'1700000000456',library_version:'test-1'}]);
    expect(raw).toMatchObject([{source:'garmin',account:'12345',key:'day/2026-01-01',body:'{"userProfileId": 12345, "한글": null, "order": [2,1]}'}]);
    const locations = await fixture.db.rows('select l.locator from brain.analyses a join brain.file_request_results r on r.request_id=a.file_request_id join brain.files f on f.id=r.file_id join brain.file_locations l on l.id=f.home_location_id');
    expect(locations).toHaveLength(1);
    expect(await readFile(join(fixture.home,'files',locations[0]!.locator),'utf8')).toBe(await readFile(document,'utf8'));
    await runImport();
    for (const table of ['garmin.raw_payloads','garmin.import_mapping','brain.health_observations','brain.analyses','brain.file_requests','brain.files']) {
      const n = Number((await fixture.db.rows(`select count(*)::int as n from ${table}`))[0]?.n);
      expect(n).toBe(table === 'garmin.import_mapping' ? 4 : 1);
    }
    expect(hash(await readFile(snapshot))).toBe(snapshotHash);
    expect(hash(await readFile(document))).toBe(documentHash);
    expect(sends).toBe(0);
    await writeFile(document, '# 다른 본문\n');
    const conflictId = ids.next(), conflictNow = new Date();
    await store.addWork({ id: conflictId,kind:'garmin.import',targetKind:'import',targetId:'synthetic',createdAt:conflictNow,nextAttemptAt:conflictNow });
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${conflictId}'`))[0]?.outcome, { timeout: 20000 }).toBe('failed');
    const conflict = await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${conflictId}'`);
    expect(conflict).toMatchObject([{error_code:'IMPORT_CONFLICT'}]);
    expect(await readFile(join(fixture.home,'files',locations[0]!.locator),'utf8')).toBe('# 합성 보고서\n\n기록 본문입니다.\n');
    await writeFile(document, '# 합성 보고서\n\n기록 본문입니다.\n');
    await store.setSetting({key:'garmin.dataset',value:'other-confirmed',updatedAt:new Date()});
    const duplicateId = ids.next(), duplicateNow = new Date();
    await store.addWork({id:duplicateId,kind:'garmin.import',targetKind:'import',targetId:'duplicate',createdAt:duplicateNow,nextAttemptAt:duplicateNow});
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${duplicateId}'`))[0]?.outcome, {timeout:20000}).toBe('succeeded');
    expect(hash(await readFile(snapshot))).toBe(snapshotHash);
    expect(await fixture.db.rows('select body from garmin.raw_records')).toEqual([{body:'{"userProfileId": 12345, "한글": null, "order": [2,1]}'},{body:'{"userProfileId": 12345, "한글": null, "order": [2,1]}'}]);
    const snapshot10 = join(fixture.home,'schema10.sqlite');
    execFileSync(python, [fileURLToPath(new URL('../../../extensions/garmin/tests/fixtures.py', import.meta.url)), snapshot10, '10']);
    execFileSync(python, ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"update raw_response set raw='null'\"); c.execute('update daily_metric set steps=null'); c.execute(\"delete from meta where key='timezone'\"); c.commit()",snapshot10]);
    await writeFile(document, '# 합성 보고서\n\n기록 본문입니다.\n');
    for (const [key,value] of Object.entries({'garmin.snapshot_path':snapshot10,'garmin.dataset':'unknown'})) await store.setSetting({key,value,updatedAt:new Date()});
    await runImport();
    expect(await fixture.db.rows("select account,account_confirmed,normalization_version,value,time_zone,time_zone_missing from brain.health_observations where dataset='unknown'")).toEqual([{account:null,account_confirmed:false,normalization_version:2,value:null,time_zone:null,time_zone_missing:true}]);
    expect(await fixture.db.rows("select dataset from brain.health_current_v1 where dataset='unknown'")).toEqual([]);
    const unknownHash = hash(await readFile(snapshot10));
    await store.setSetting({key:'garmin.dataset',value:'unknown-other',updatedAt:new Date()});
    const unknownId=ids.next(), unknownNow=new Date();
    await store.addWork({id:unknownId,kind:'garmin.import',targetKind:'import',targetId:'unknown-other',createdAt:unknownNow,nextAttemptAt:unknownNow});
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${unknownId}'`))[0]?.outcome, {timeout:20000}).toBe('succeeded');
    expect(hash(await readFile(snapshot10))).toBe(unknownHash);
    expect(await fixture.db.rows("select body from garmin.raw_records where account is null")).toEqual([{body:'null'},{body:'null'}]);

    execFileSync(python, ['-c', "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); c.execute('update raw_response set raw=?,key=?',(json.dumps({'userProfileId':1}),'2026-01-03')); c.execute('insert into raw_response values (?,?,?,?,?,?,?)',('day','2026-01-02','other',json.dumps({'userProfileId':2}),1700000000123,1700000000456,'test')); c.execute('update daily_metric set day_key=?',('2026-01-03',)); c.commit()",snapshot10]);
    await store.setSetting({key:'garmin.dataset',value:'mixed',updatedAt:new Date()});
    await runImport();
    expect(await fixture.db.rows("select account,account_confirmed from brain.health_observations where dataset='mixed'")).toEqual([{account:null,account_confirmed:false}]);
    expect(await fixture.db.rows("select dataset from brain.health_current_v1 where dataset='mixed'")).toEqual([]);
    execFileSync(python, ['-c', "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); c.execute('delete from raw_response'); c.execute('insert into raw_response values (?,?,?,?,?,?,?)',('day','2026-01-04','user_summary',json.dumps({'userProfileId':12345}),1700000000123,1700000000456,'test')); c.execute('update daily_metric set day_key=?',('2026-01-04',)); c.commit()",snapshot10]);
    await store.setSetting({key:'garmin.dataset',value:'no-zone',updatedAt:new Date()});
    await runImport();
    expect(await fixture.db.rows("select account,time_zone,time_zone_missing,local_date::text from brain.health_observations where dataset='no-zone'")).toEqual([{account:'12345',time_zone:null,time_zone_missing:true,local_date:'2026-01-04'}]);
    expect(await fixture.db.rows("select * from brain.health_current_v1 where dataset='no-zone'")).toEqual([]);
    execFileSync(python, ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"insert into meta(key,value) values ('timezone','Not/AZone')\"); c.commit()",snapshot10]);
    await store.setSetting({key:'garmin.dataset',value:'invalid-zone',updatedAt:new Date()});
    const invalidId=ids.next(),invalidNow=new Date();
    await store.addWork({id:invalidId,kind:'garmin.import',targetKind:'import',targetId:'invalid-zone',createdAt:invalidNow,nextAttemptAt:invalidNow});
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${invalidId}'`))[0]?.outcome,{timeout:20000}).toBe('failed');
    expect(await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${invalidId}'`)).toMatchObject([{error_code:'IMPORT_INVALID'}]);
    execFileSync(python, ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"delete from meta where key='timezone'\"); c.commit()",snapshot10]);
    await store.setSetting({key:'garmin.artifact_root',value:staging,updatedAt:new Date()});
    const outsideId=ids.next(),outsideNow=new Date();
    await store.addWork({id:outsideId,kind:'garmin.import',targetKind:'import',targetId:'outside',createdAt:outsideNow,nextAttemptAt:outsideNow});
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${outsideId}'`))[0]?.outcome,{timeout:20000}).toBe('failed');
    expect(await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${outsideId}'`)).toMatchObject([{error_code:'IMPORT_INVALID'}]);
    expect(Number((await fixture.db.rows("select count(*)::int as n from brain.health_observations where substring(id::text,15,1)<>'7'"))[0]?.n)).toBe(0);
    expect(Number((await fixture.db.rows("select count(*)::int as n from brain.channel_requests"))[0]?.n)).toBe(0);
    expect(Number((await fixture.db.rows("select count(*)::int as n from brain.work_items where kind='channel_send'"))[0]?.n)).toBe(0);
    expect(sends).toBe(0);
  } finally { controller.abort(); await daemon; await store.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await fixture.cleanup(); }
});

it('같은 basename의 문서가 본문에 관계없이 서로 다른 상대 키와 staging을 가진다', async () => {
  const { writeFile, mkdir, readFile, readdir, copyFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { fileURLToPath } = await import('node:url');
  const { postgresStore } = await import('second_brain/postgres');
  const { extensionDatabaseUrl } = await import('../src/config/codec.js');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome(), controller = new AbortController(), ids = uuidV7IdGen();
  const store = postgresStore({databaseUrl: fixture.db.appUrl});
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed = await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    const snapshot=join(fixture.home,'snapshot.sqlite'), staging=join(fixture.home,'extensions/garmin/staging');
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python');
    execFileSync(python,[fileURLToPath(new URL('../../../extensions/garmin/tests/fixtures.py', import.meta.url)),snapshot,'15']);
    execFileSync(python,['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executemany('insert into raw_response values (?,?,?,?,?,?,?)',[('activity','000','other','{}',1,2,'x'),('day','2025-01-01','user_summary','{}',3,4,'x'),('day','2026-01-01','other','{}',5,6,'x')]); c.commit()",snapshot]);
    await mkdir(staging,{recursive:true});
    const roots=['one','two','three','four'];
    const docs=roots.map(root=>join(fixture.home,root,'report.md'));
    for (const [index,doc] of docs.entries()) { await mkdir(join(fixture.home,roots[index]!),{recursive:true}); await writeFile(doc,index<2 ? '# 같은 합성 본문\n' : `# 다른 합성 본문 ${index}\n`); }
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl);
    const missing = join(fixture.home, 'missing.sqlite'); await copyFile(snapshot, missing);
    execFileSync(python,['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"delete from raw_response where scope='day' and key='2026-01-01' and endpoint='user_summary'\"); c.commit()",missing]);
    const missingHash = createHash('sha256').update(await readFile(missing)).digest('hex');
    const missingId=ids.next(), missingToken=ids.next(), missingNow=new Date();
    expect(await store.addWork({id:missingId,kind:'garmin.import',targetKind:'import',targetId:'missing',createdAt:missingNow,nextAttemptAt:missingNow})).toMatchObject({ok:true});
    expect(await store.claimSupervisedWork({now:missingNow,claimedBy:'test',kinds:['garmin.import'],attemptToken:missingToken})).toMatchObject({ok:true,item:{id:missingId},attemptToken:missingToken});
    const missingSettings=JSON.stringify({version:1,extension:'garmin',values:{'garmin.snapshot_path':missing,'garmin.legacy_path':docs[0],'garmin.staging_path':staging,'garmin.artifact_root':fixture.home,'garmin.dataset':'missing'}});
    const rejected=spawnSync(python,[join(fixture.home,'extensions/garmin/src/import.py')],{encoding:'utf8',env:{...process.env,BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:missingId,BRAIN_ATTEMPT_TOKEN:missingToken,BRAIN_SETTINGS_SNAPSHOT:missingSettings}});
    expect(rejected.status).toBe(1); expect(JSON.parse(rejected.stdout)).toMatchObject({code:'IMPORT_INVALID',retryable:false});
    expect(createHash('sha256').update(await readFile(missing)).digest('hex')).toBe(missingHash);
    expect(await fixture.db.rows('select * from garmin.raw_payloads')).toEqual([]);
    expect(await fixture.db.rows('select * from brain.health_observations')).toEqual([]);
    expect(await fixture.db.rows('select * from brain.file_requests')).toEqual([]);
    expect(await readdir(staging)).toEqual([]);
    await store.finishSupervisedWork({id:missingId,attemptToken:missingToken,now:new Date(),outcome:'failed'});
    for (const [index,doc] of docs.entries()) {
      const id=ids.next(),token=ids.next(),now=new Date();
      await store.addWork({id,kind:'garmin.import',targetKind:'import',targetId:String(index),createdAt:now,nextAttemptAt:now});
      expect(await store.claimSupervisedWork({now,claimedBy:'test',kinds:['garmin.import'],attemptToken:token})).toMatchObject({ok:true,item:{id},attemptToken:token});
      const snapshotSettings = JSON.stringify({version:1,extension:'garmin',values:{'garmin.snapshot_path':snapshot,'garmin.legacy_path':doc,'garmin.staging_path':staging,'garmin.artifact_root':fixture.home,'garmin.dataset':'same'}});
      const output=execFileSync(python,[join(fixture.home,'extensions/garmin/src/import.py')],{encoding:'utf8',env:{...process.env,BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:id,BRAIN_ATTEMPT_TOKEN:token,BRAIN_SETTINGS_SNAPSHOT:snapshotSettings}});
      expect(JSON.parse(output)).toMatchObject({type:'result'});
      expect(await store.finishSupervisedWork({id,attemptToken:token,now:new Date(),outcome:'succeeded'})).toMatchObject({ok:true});
    }
    expect((await readdir(staging)).length).toBe(4);
    const sourceBody = '{"userProfileId": 12345, "한글": null, "order": [2,1]}';
    expect(await fixture.db.rows("select scope,original_key,endpoint,body from garmin.raw_payloads")).toEqual([{scope:'day',original_key:'2026-01-01',endpoint:'user_summary',body:sourceBody}]);
    expect(await fixture.db.rows("select revision,extract(epoch from fetched_at)*1000 as fetched_ms from brain.health_observations")).toMatchObject([{revision:createHash('sha256').update(sourceBody).digest('hex'),fetched_ms:'1700000000123.000000'}]);
    expect(await fixture.db.rows('select distinct locator from brain.file_requests')).toHaveLength(4);
    const requestsBefore = await fixture.db.rows('select id, locator from brain.file_requests order by id');
    const mappingsBefore = await fixture.db.rows('select * from garmin.import_mapping order by original_key');
    const bytesBefore = await Promise.all(requestsBefore.map(row => readFile(join(staging, row.locator))));
    const same = await fixture.run(['ext','install','garmin','--json']);
    expect(same.code, same.stdout + same.stderr).toBe(0);
    // 설치된 패키지를 바꿔 실제 설치기의 교체 경로를 실행한다.
    const check = join(fixture.home,'extensions/garmin/src/check.py');
    await writeFile(check, (await readFile(check, 'utf8')) + '\n# 교체 확인\n');
    const replaced = await fixture.run(['ext','install','garmin','--json']);
    expect(replaced.code, replaced.stdout + replaced.stderr).toBe(0);
    expect(await readFile(check, 'utf8')).not.toContain('교체 확인');
    expect(await fixture.db.rows('select id, locator from brain.file_requests order by id')).toEqual(requestsBefore);
    expect(await fixture.db.rows('select * from garmin.import_mapping order by original_key')).toEqual(mappingsBefore);
    expect(await Promise.all(requestsBefore.map(row => readFile(join(staging, row.locator))))).toEqual(bytesBefore);
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    await expect.poll(async () => Number((await fixture.db.rows('select count(*)::int as n from brain.file_request_results where file_id is not null'))[0]?.n),{timeout:20000}).toBe(4);
    const files=await fixture.db.rows('select a.original_key,l.locator from brain.analyses a join brain.file_request_results r on r.request_id=a.file_request_id join brain.files f on f.id=r.file_id join brain.file_locations l on l.id=f.home_location_id order by a.original_key');
    expect(files).toHaveLength(4);
    expect(files.map(file=>file.original_key).sort()).toEqual(roots.map(root=>`${root}/report.md`).sort());
    for (const file of files) expect(await readFile(join(fixture.home,'files',file.locator),'utf8')).toBe(await readFile(join(fixture.home,file.original_key),'utf8'));
    const requestKeys=await fixture.db.rows('select request_key from brain.file_requests');
    expect(new Set(requestKeys.map(row=>row.request_key)).size).toBe(4);
    for (const row of requestKeys) expect(JSON.parse(row.request_key)).toEqual(['same',expect.stringMatching(/\/report\.md$/)]);
    // 데몬이 반입을 마친 뒤 완전히 종료되어 수동 claim을 빼앗지 못하게 한다.
    controller.abort();
    expect(await daemon).toEqual({ok:true});
    daemon=undefined;
    const pg = (await import('pg')).default, locker=new pg.Client({connectionString:fixture.db.url});
    const lockId=ids.next(),lockToken=ids.next(),lockNow=new Date();
    expect(await store.addWork({id:lockId,kind:'garmin.import',targetKind:'import',targetId:'lock',createdAt:lockNow,nextAttemptAt:lockNow})).toMatchObject({ok:true});
    expect(await store.claimSupervisedWork({now:lockNow,claimedBy:'test',kinds:['garmin.import'],attemptToken:lockToken})).toMatchObject({ok:true,item:{id:lockId},attemptToken:lockToken});
    const settings=JSON.stringify({version:1,extension:'garmin',values:{'garmin.snapshot_path':snapshot,'garmin.legacy_path':docs[0],'garmin.staging_path':staging,'garmin.artifact_root':fixture.home,'garmin.dataset':'same'}});
    const lockEnv={...process.env,BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:lockId,BRAIN_ATTEMPT_TOKEN:lockToken,BRAIN_SETTINGS_SNAPSHOT:settings};
    await locker.connect();
    try {
      await locker.query('begin'); await locker.query("update garmin.datasets set account=account where dataset='same'");
      const started=Date.now();
      const blocked=spawnSync(python,[join(fixture.home,'extensions/garmin/src/import.py')],{encoding:'utf8',timeout:5000,env:lockEnv});
      expect(blocked.status).toBe(1); expect(JSON.parse(blocked.stdout)).toMatchObject({type:'error',code:'IMPORT_INVALID',retryable:true});
      expect(Date.now()-started).toBeLessThan(4500);
    } finally {await locker.query('rollback'); await locker.end();}
    const resumed=spawnSync(python,[join(fixture.home,'extensions/garmin/src/import.py')],{encoding:'utf8',timeout:5000,env:lockEnv});
    expect(resumed.status).toBe(0); expect(JSON.parse(resumed.stdout)).toMatchObject({type:'result'});
    const staleDoc=join(fixture.home,'stale.md'); await writeFile(staleDoc,'# 다른 요청\n');
    const staleSettings=JSON.stringify({version:1,extension:'garmin',values:{'garmin.snapshot_path':snapshot,'garmin.legacy_path':staleDoc,'garmin.staging_path':staging,'garmin.artifact_root':fixture.home,'garmin.dataset':'same'}});
    const stale=spawnSync(python,[join(fixture.home,'extensions/garmin/src/import.py')],{encoding:'utf8',timeout:5000,env:{...lockEnv,BRAIN_ATTEMPT_TOKEN:ids.next(),BRAIN_SETTINGS_SNAPSHOT:staleSettings}});
    expect(stale.status).toBe(1); expect(JSON.parse(stale.stdout)).toMatchObject({type:'error',code:'IMPORT_INVALID',retryable:false});
    await writeFile(docs[0]!, '# 충돌 본문\n');
    const conflict=spawnSync(python,[join(fixture.home,'extensions/garmin/src/import.py')],{encoding:'utf8',timeout:5000,env:lockEnv});
    expect(conflict.status).toBe(1); expect(JSON.parse(conflict.stdout)).toMatchObject({type:'error',code:'IMPORT_CONFLICT',retryable:false});
    const outsideSettings=JSON.stringify({version:1,extension:'garmin',values:{'garmin.snapshot_path':snapshot,'garmin.legacy_path':docs[0],'garmin.staging_path':staging,'garmin.artifact_root':staging,'garmin.dataset':'same'}});
    const outside=spawnSync(python,[join(fixture.home,'extensions/garmin/src/import.py')],{encoding:'utf8',timeout:5000,env:{...lockEnv,BRAIN_SETTINGS_SNAPSHOT:outsideSettings}});
    expect(outside.status).toBe(1); expect(JSON.parse(outside.stdout)).toMatchObject({type:'error',code:'IMPORT_INVALID',retryable:false});



  } finally { controller.abort(); await daemon; await store.close(); await fixture.cleanup(); }
});

it('콜론을 포함한 dataset과 상대 경로는 요청 키에서 섞이지 않는다', async () => {
  const { mkdir,writeFile }=await import('node:fs/promises');
  const { fileURLToPath }=await import('node:url');
  const { postgresStore }=await import('second_brain/postgres');
  const { extensionDatabaseUrl }=await import('../src/config/codec.js');
  const { uuidV7IdGen }=await import('../src/runtime/id-gen.js');
  const fixture=await extHome(),ids=uuidV7IdGen(),store=postgresStore({databaseUrl:fixture.db.appUrl});
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), staging=join(fixture.home,'extensions/garmin/staging'); await mkdir(staging,{recursive:true});
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl);
    const pairs=[{dataset:'a:b',key:'c',raw:'2026-01-01'},{dataset:'a',key:'b:c',raw:'2026-01-02'}];
    for (const [index,pair] of pairs.entries()) {
      const snapshot=join(fixture.home,`snap${index}.sqlite`),doc=join(fixture.home,pair.key);
      execFileSync(python,[fileURLToPath(new URL('../../../extensions/garmin/tests/fixtures.py', import.meta.url)),snapshot,'15']);
      execFileSync(python,['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('update raw_response set key=?',(sys.argv[2],)); c.execute('update daily_metric set day_key=?',(sys.argv[2],)); c.commit()",snapshot,pair.raw]);
      await writeFile(doc,'# 합성 내용\n');
      const id=ids.next(),token=ids.next(),now=new Date(); await store.addWork({id,kind:'garmin.import',targetKind:'import',targetId:String(index),createdAt:now,nextAttemptAt:now});
      await store.claimSupervisedWork({now,claimedBy:'test',kinds:['garmin.import'],attemptToken:token});
      const settings=JSON.stringify({version:1,extension:'garmin',values:{'garmin.snapshot_path':snapshot,'garmin.legacy_path':doc,'garmin.staging_path':staging,'garmin.artifact_root':fixture.home,'garmin.dataset':pair.dataset}});
      const output=execFileSync(python,[join(fixture.home,'extensions/garmin/src/import.py')],{encoding:'utf8',env:{...process.env,BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:id,BRAIN_ATTEMPT_TOKEN:token,BRAIN_SETTINGS_SNAPSHOT:settings}});
      expect(JSON.parse(output)).toMatchObject({type:'result'});
      await store.finishSupervisedWork({id,attemptToken:token,now:new Date(),outcome:'succeeded'});
    }
    const rows=await fixture.db.rows('select request_key from brain.file_requests order by request_key');
    expect(rows).toHaveLength(2);
    expect(rows.map(row=>JSON.parse(row.request_key)).sort()).toEqual(pairs.map(pair=>[pair.dataset,pair.key]).sort());
  } finally {await store.close(); await fixture.cleanup();}
});

it.each([{encoding:'UTF-8',dataset:'trace\0data'},{encoding:'UTF-16le',dataset:'trace-compat'}])('tracer가 $encoding 원문과 기존 mapping을 대조한다', async ({encoding,dataset}) => {
  const { access, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { postgresStore } = await import('second_brain/postgres');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const { extensionDatabaseUrl } = await import('../src/config/codec.js');
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), ids=uuidV7IdGen();
  try {
    expect((await fixture.run(['ext','install','garmin','--json'])).code).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), snapshot=join(fixture.home,'trace.sqlite');
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c',"import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from fixtures import create; create(Path(sys.argv[2]),15,sys.argv[3])",fixtures,snapshot,encoding]);
    execFileSync(python,['-c',`import sqlite3,sys,json
with sqlite3.connect(sys.argv[1]) as db:
 body='body\\u0000end' if sys.argv[2]=='UTF-8' else '기존 원문'
 account='a\\u0000b' if sys.argv[2]=='UTF-8' else '12345'
 db.execute('update raw_response set raw=?',(body,))
 db.execute('insert into raw_response values (?,?,?,?,?,?,?)',('day','2026-01-01','other',json.dumps({'userProfileId':account}),1,2,'test'))`,snapshot,encoding]);
    const document=join(fixture.home,'report.md'), staging=join(fixture.home,'staging');
    await writeFile(document,'합성');
    const id=ids.next(),token=ids.next(),now=new Date();
    await store.addWork({id,kind:'garmin.import',targetKind:'import',targetId:'nul',createdAt:now,nextAttemptAt:now});
    await store.claimSupervisedWork({now,claimedBy:'test',kinds:['garmin.import'],attemptToken:token});
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl);
    const settings=JSON.stringify({version:1,extension:'garmin',values:{'garmin.snapshot_path':snapshot,'garmin.legacy_path':document,'garmin.staging_path':staging,'garmin.artifact_root':fixture.home,'garmin.dataset':dataset}});
    const env={...process.env,BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:id,BRAIN_ATTEMPT_TOKEN:token,BRAIN_SETTINGS_SNAPSHOT:settings};
    const entry=join(fixture.home,'extensions/garmin/src/import.py');
    const run=()=>execFileSync(python,[entry],{encoding:'utf8',env});
    const stale=spawnSync(python,[entry],{encoding:'utf8',env:{...env,BRAIN_ATTEMPT_TOKEN:ids.next()}});
    expect(stale.status).toBe(1); await expect(access(staging)).rejects.toThrow();
    await fixture.db.query('grant select on brain.health_observations to brain_ext_garmin');
    expect(spawnSync(python,[entry],{encoding:'utf8',env}).status).toBe(1);
    await expect(access(staging)).rejects.toThrow();
    await fixture.db.query('revoke select on brain.health_observations from brain_ext_garmin');
    expect(run()).toContain('"type": "result"');
    await fixture.db.query('grant select on brain.health_observations to brain_ext_garmin');
    expect(spawnSync(python,[entry],{encoding:'utf8',env}).status).toBe(1);
    await fixture.db.query('revoke select on brain.health_observations from brain_ext_garmin');
    const priorHash=execFileSync(python,['-c',"import hashlib,json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); raw=hashlib.sha256(db.execute(\"select raw from raw_response where endpoint='user_summary'\").fetchone()[0].encode()).hexdigest(); print(hashlib.sha256(json.dumps([{'day_key':'2026-01-01','steps':1234},2,raw,'Asia/Seoul'],ensure_ascii=False,sort_keys=True).encode()).hexdigest())",snapshot],{encoding:'utf8'}).trim();
    expect(await fixture.db.rows("select content_hash from garmin.import_mapping where target_kind='health'")).toEqual([{content_hash:priorHash}]);
    if (encoding === 'UTF-16le') {
      const legacyExpected=JSON.parse(execFileSync(python,['-c',`import sqlite3,sys,json,hashlib
digest=lambda b:hashlib.sha256(b).hexdigest()
with sqlite3.connect(sys.argv[1]) as db:
 db.row_factory=sqlite3.Row
 raw=dict(db.execute("select scope,key,endpoint,raw,fetched_at,checked_at,library_version from raw_response where scope='day' and key='2026-01-01' and endpoint='user_summary'").fetchone())
 revision=digest(raw['raw'].encode('utf-8')); batch=digest((sys.argv[2]+revision+digest('합성'.encode())).encode())
 print(json.dumps({'rawHash':digest(json.dumps(raw,ensure_ascii=False,sort_keys=True).encode()),'revision':revision,'batch':batch}))`,snapshot,dataset],{encoding:'utf8'}));
      expect(await fixture.db.rows("select content_hash from garmin.import_mapping where target_kind='raw'")).toEqual([{content_hash:legacyExpected.rawHash}]);
      expect(await fixture.db.rows('select revision,import_batch,normalization_version,time_zone from brain.health_observations')).toEqual([{revision:legacyExpected.revision,import_batch:legacyExpected.batch,normalization_version:2,time_zone:'Asia/Seoul'}]);
      expect(await fixture.db.rows('select batch from garmin.raw_payloads')).toEqual([{batch:legacyExpected.batch}]);
      const previousTargets=await fixture.db.rows('select target_kind,target_id,content_hash from garmin.import_mapping order by target_kind');
      await fixture.db.query('update garmin.raw_payloads set raw_identity=null,account_raw=null,account_encoding=null,scope_raw=null,scope_encoding=null,original_key_raw=null,original_key_encoding=null,endpoint_raw=null,endpoint_encoding=null,library_version_raw=null,library_version_encoding=null,body_raw=null,body_encoding=null');
      expect(run()).toContain('"type": "result"');
      expect(await fixture.db.rows('select target_kind,target_id,content_hash from garmin.import_mapping order by target_kind')).toEqual(previousTargets);
      expect(await fixture.db.rows('select batch from garmin.raw_payloads')).toEqual([{batch:legacyExpected.batch}]);
      expect(await fixture.db.rows('select body_encoding,body_raw from garmin.raw_payloads')).toEqual([{body_encoding:'utf-16le',body_raw:Buffer.from('기존 원문','utf16le')}]);
    }
    await fixture.db.query(`update garmin.import_mapping set content_hash='${priorHash}' where target_kind='health'`);
    const targets = await fixture.db.rows('select id from brain.analyses union all select id from brain.file_requests union all select id from brain.health_observations order by id');
    await fixture.db.query('delete from garmin.raw_payloads');
    await fixture.db.query('alter table brain.analyses disable trigger import_immutable; delete from brain.analyses; alter table brain.analyses enable trigger import_immutable');
    await fixture.db.query('alter table brain.file_requests disable trigger import_immutable; delete from brain.file_requests; alter table brain.file_requests enable trigger import_immutable');
    await fixture.db.query('alter table brain.health_observations disable trigger import_immutable; delete from brain.health_observations; alter table brain.health_observations enable trigger import_immutable');
    expect(run()).toContain('"type": "result"');
    expect(await fixture.db.rows('select (select count(*)::int from brain.analyses) as analyses,(select count(*)::int from brain.file_requests) as files,(select count(*)::int from brain.health_observations) as health')).toEqual([{analyses:1,files:1,health:1}]);
    expect(await fixture.db.rows('select id from brain.analyses union all select id from brain.file_requests union all select id from brain.health_observations order by id')).toEqual(targets);
    const raw=await store.imports.readRaw({source:'garmin',rawViews:['raw_records_v2']});
    expect(raw.ok && raw.rows).toContainEqual(expect.objectContaining({dataset,account:encoding==='UTF-8'?'a\0b':'12345',body:encoding==='UTF-8'?'body\0end':'기존 원문'}));
  } finally { await store.close(); await fixture.cleanup(); }
});
