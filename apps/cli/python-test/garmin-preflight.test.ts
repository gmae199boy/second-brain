import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat, mkdir, symlink, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('합성 capture를 공용 명령과 실제 감독자로 읽고 계약 자료를 보존한다', async () => {
  const fixture = await extHome(), controller = new AbortController();
  const { postgresStore } = await import('second_brain/postgres');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed = await fixture.run(['ext', 'install', 'garmin', '--json']);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    const python = join(fixture.home, 'extensions/garmin/.venv/bin/python');
    const fixtureModule = fileURLToPath(new URL('../../../extensions/garmin/tests', import.meta.url));
    const checker = execFileSync(python, [join(fixtureModule, 'check_preflight.py')], {encoding:'utf8'}).trim();
    expect(checker).toBe('합성 reader와 충돌 집계 성공'); console.log(`check_preflight.py: ${checker}`);
    const capture = join(fixture.home, 'capture'); await mkdir(capture);
    execFileSync(python, ['-c', "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from fixtures import five_candidates,capture_manifest; root=Path(sys.argv[2]); capture_manifest(root,five_candidates(root))", fixtureModule, capture]);
    const snapshots = ['D1','D2','D3','D4','D5'].map(role => join(capture, `${role}.db`));
    const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
    const before = await Promise.all(snapshots.map(hash));
    const tables = ['garmin.datasets', 'garmin.import_batches', 'garmin.import_mapping', 'garmin.raw_payloads', 'brain.file_requests'];
    const contract = async () => Promise.all(tables.map(table => fixture.db.rows(`select coalesce(json_agg(t order by t::text)::text,'[]') as contents from ${table} t`)));
    const prior = await contract();
    await store.setSetting({ userId:'01940000-0000-7000-8000-00000000000a', key: 'garmin.capture_manifest', value: await realpath(join(capture, 'manifest.json')), updatedAt: new Date() });
    daemon = runDaemon({ home: fixture.home, env: fixture.env, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25 } });
    const run = await fixture.run(['ext', 'run', 'garmin', 'import-preflight', '--json']);
    const errors = await fixture.db.rows("select error_code,stderr from brain.work_attempts order by started_at");
    const readiness = run.body.data?.work_id ? JSON.parse(await readFile(join(fixture.home, 'extensions/garmin/reports', run.body.data.work_id, 'private.json'), 'utf8')).readiness?.catalog : undefined;
    expect(run.code, run.stdout + run.stderr + JSON.stringify(errors) + JSON.stringify(readiness)).toBe(0);
    expect(run.body.data).toMatchObject({ status: 'completed', report: { counts: { datasets: 5, raw_response_conflicts: 1, raw_conflict_keys: 1, raw_metadata_conflict_keys: 1, unselected_keys: 0, unconfirmed_accounts: 2, expected_preservation_candidates: 21, expected_dataset_candidates: 5, expected_mapping_candidates: 21, expected_file_requests: 0 }, checks: { total_insert_known: false, source_unchanged: true, core_ready: true, extension_ready: true, role_ready: true, attempt_current: true } } });
    const id = run.body.data.work_id as string;
    const report = join(fixture.home, 'extensions/garmin/reports', id);
    const privateText = await readFile(join(report, 'private.json'), 'utf8');
    expect(privateText).toContain('12345');
    const detail = JSON.parse(privateText);
    expect(detail.unit_risks).toEqual([]);
    expect(detail.risks).toEqual(['원래 NULL의 결측 원인은 복원할 수 없음', '원본 단위와 정규화 버전을 별도로 검증해야 함']);
    expect(detail.datasets.D1.tables.daily_metric.null_counts.steps).toBe(0);
    expect(detail.authority_order).toEqual(['D2','D1','D4','D5','D3']);
    expect(detail.tables.raw_response).toMatchObject({ union:2, conflicts:1, raw_conflicts:1, metadata_conflicts:1, only:{D5:1}, pairs:{
      'D2:D4':{overlap:1,conflicts:1,left_only:0,right_only:0,raw_conflicts:1,metadata_conflicts:1},
      'D2:D5':{raw_conflicts:0,metadata_conflicts:1} } });
    expect(detail.tables.raw_response.authority_v1[0].selected).toBe('D2');
    expect(detail.tables.daily_metric.conflicts).toBe(1);
    expect(detail.tables.day_summary.pairs['D2:D1']).toBeNull();
    expect(detail.tables.auth_event).toMatchObject({dataset_local:true,only:{D3:1}});
    expect(detail.datasets.D1.tables.raw_response).toMatchObject({count:1,range:{min:'2026-01-01'}});
    expect(detail.datasets.D3.tables.raw_response.count).toBe(0);
    expect(detail.datasets.D5.tables.raw_response.count).toBe(2);
    expect([detail.datasets.D1.account.confirmed,detail.datasets.D3.account.confirmed,detail.datasets.D5.account.confirmed]).toEqual([true,false,false]);
    expect(detail.datasets.D1.tables.day_summary.null_counts.body).toBe(1);
    expect(detail.unsupported).toEqual(expect.arrayContaining([expect.objectContaining({table:'day_summary',columns:expect.arrayContaining(['extra'])})]));
    expect((await stat(report)).mode & 0o777).toBe(0o700);
    expect((await stat(join(report, 'private.json'))).mode & 0o777).toBe(0o600);
    for (const secret of ['12345', '2026-01-01', fixture.home, '한글']) expect(run.stdout).not.toContain(secret);
    const attempts = await fixture.db.rows(`select error_code,stderr from brain.work_attempts where work_item_id='${id}'`);
    for (const secret of ['12345', '2026-01-01', fixture.home, '한글']) expect(JSON.stringify(attempts)).not.toContain(secret);
    expect(await Promise.all(snapshots.map(hash))).toEqual(before);
    expect(await contract()).toEqual(prior);
    // Exercise the three distinct conflict kinds through the installed supervisor,
    // as well as through the independent direct checker.
    const conflictCapture = join(fixture.home, 'capture-conflicts'); await mkdir(conflictCapture);
    const conflictSetup = `import sqlite3,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from fixtures import five_candidates,capture_manifest
root=Path(sys.argv[2]); paths=five_candidates(root)
for role in ('D1','D2'):
 with sqlite3.connect(paths[role]) as conn:
  for key,body,checked in [('body','a' if role=='D1' else 'b',1),('metadata','a',1 if role=='D1' else 2),('both','a' if role=='D1' else 'b',1 if role=='D1' else 2)]:
   conn.execute('insert into raw_response values (?,?,?,?,?,?,?)',('day',key,'test',body,1,checked,'test'))
capture_manifest(root,paths)`;
    execFileSync(python, ['-c', conflictSetup, fixtureModule, conflictCapture]);
    await store.setSetting({ userId:'01940000-0000-7000-8000-00000000000a', key:'garmin.capture_manifest', value:await realpath(join(conflictCapture,'manifest.json')), updatedAt:new Date() });
    const conflictRun = await fixture.run(['ext','run','garmin','import-preflight','--json']);
    expect(conflictRun.code, conflictRun.stdout + conflictRun.stderr).toBe(0);
    const conflictDetail = JSON.parse(await readFile(join(fixture.home,'extensions/garmin/reports',conflictRun.body.data.work_id,'private.json'),'utf8'));
    expect(conflictDetail.tables.raw_response.pairs['D2:D1']).toMatchObject({raw_conflicts:2,metadata_conflicts:2,conflicts:3});
    await store.setSetting({ userId:'01940000-0000-7000-8000-00000000000a', key:'garmin.capture_manifest', value:await realpath(join(capture,'manifest.json')), updatedAt:new Date() });
    const textResult = await fixture.run(['ext','run','garmin','import-preflight']);
    expect(textResult.code, textResult.stdout + textResult.stderr).toBe(0);
    expect(textResult.stdout).toContain('raw_response_conflicts: 1');
    for (const secret of ['12345', '2026-01-01', fixture.home, '한글']) expect(textResult.stdout).not.toContain(secret);
    execFileSync(python, ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('pragma user_version=9'); c.commit()", snapshots[0]!]);
    const unsupported = await fixture.run(['ext','run','garmin','import-preflight','--json']);
    expect(unsupported.code).not.toBe(0);
    expect(await fixture.db.rows("select error_code from brain.work_attempts order by started_at desc limit 1")).toEqual([{error_code:'PREFLIGHT_SCHEMA_UNSUPPORTED'}]);
    execFileSync(python, ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('pragma user_version=15'); c.commit()", snapshots[0]!]);
    const latestVersion = (await fixture.db.rows("select max(version)::int as version from brain.schema_migrations where owner='garmin'"))[0]!.version as number;
    const futureVersion = latestVersion + 1;
    await fixture.db.query(`update brain.schema_migrations set version=${futureVersion} where owner='garmin' and version=${latestVersion}`);
    try {
      const unready = await fixture.run(['ext','run','garmin','import-preflight','--json']);
      expect(unready.code, unready.stdout + unready.stderr).not.toBe(0);
      expect(unready.body.data).toMatchObject({status:'failed',report:{checks:{extension_ready:false}}});
      expect(await fixture.db.rows("select error_code from brain.work_attempts order by started_at desc limit 1")).toEqual([{error_code:'EXTENSION_REPORT_NOT_READY'}]);
    } finally { await fixture.db.query(`update brain.schema_migrations set version=${latestVersion} where owner='garmin' and version=${futureVersion}`); }
    const roleCases = [
      { alter: 'revoke execute on function brain.extension_predecessor_results(uuid,uuid) from brain_ext_garmin', restore: 'grant execute on function brain.extension_predecessor_results(uuid,uuid) to brain_ext_garmin', key: 'predecessor_execute', publicKey: 'role_ready' },
      { alter: 'revoke execute on function brain.extension_channel_conversation_valid(uuid,uuid,uuid) from brain_ext_garmin', restore: 'grant execute on function brain.extension_channel_conversation_valid(uuid,uuid,uuid) to brain_ext_garmin', key: 'conversation_execute', publicKey: 'role_ready' },
      { alter: 'grant execute on function brain.redacted_text(text,jsonb) to brain_ext_garmin', restore: 'revoke execute on function brain.redacted_text(text,jsonb) from brain_ext_garmin', key: 'no_excess_functions', publicKey: 'role_ready' },
      { alter: 'revoke insert(metadata) on brain.file_requests from brain_ext_garmin', restore: 'grant insert(metadata) on brain.file_requests to brain_ext_garmin', key: 'required_inserts', publicKey: 'role_ready' },
      { alter: 'grant select on brain.file_requests to brain_ext_garmin', restore: 'revoke select on brain.file_requests from brain_ext_garmin', key: 'no_excess_tables', publicKey: 'role_ready' },
      { alter: 'grant brain_app to brain_ext_garmin', restore: 'revoke brain_app from brain_ext_garmin', key: 'membership_absent', publicKey: 'role_ready' },
      { alter: 'revoke execute on function brain.attempt_is_current(uuid,uuid) from public, brain_ext_garmin; grant execute on function brain.attempt_is_current(uuid,uuid) to brain_app', restore: 'grant execute on function brain.attempt_is_current(uuid,uuid) to public, brain_ext_garmin; revoke execute on function brain.attempt_is_current(uuid,uuid) from brain_app', key: 'attempt_execute', publicKey: 'attempt_current' },
    ];
    for (const scenario of roleCases) {
      await fixture.db.query(scenario.alter);
      try {
        const failed = await fixture.run(['ext','run','garmin','import-preflight','--json']);
        expect(failed.code, scenario.key + failed.stdout + failed.stderr).not.toBe(0);
        expect(failed.body.data?.report?.checks?.[scenario.publicKey], scenario.key + failed.stdout).toBe(false);
        const failureId = failed.body.data.work_id as string;
        const detail = JSON.parse(await readFile(join(fixture.home, 'extensions/garmin/reports', failureId, 'private.json'), 'utf8'));
        expect(detail.readiness.catalog[scenario.key], scenario.key).toBe(false);
        expect(await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${failureId}'`)).toEqual([{error_code:'EXTENSION_REPORT_NOT_READY'}]);
        for (const secret of ['12345', '2026-01-01', fixture.home, '한글']) expect(failed.stdout).not.toContain(secret);
      } finally { await fixture.db.query(scenario.restore); }
    }
    const restoredRole = await fixture.run(['ext','run','garmin','import-preflight','--json']);
    expect(restoredRole.code, restoredRole.stdout + restoredRole.stderr).toBe(0);
    const missing = await fixture.run(['ext','run','garmin','not-declared','--json']); expect(missing.code).not.toBe(0);
    const disabled = await fixture.run(['ext','disable','garmin','--json']); expect(disabled.code).toBe(0);
    const rejected = await fixture.run(['ext','run','garmin','import-preflight','--json']); expect(rejected.code).not.toBe(0);
    const enabled = await fixture.run(['ext','enable','garmin','--json']); expect(enabled.code).toBe(0);
    controller.abort(); if (daemon) { await daemon; daemon = undefined; }
    await writeFile(join(fixture.home, 'extensions/garmin/reinstall-marker.txt'), '합성 변경');
    const reinstalled = await fixture.run(['ext','install','garmin','--json']); expect(reinstalled.code, reinstalled.stdout + reinstalled.stderr).toBe(0);
    expect(await readFile(join(report, 'private.json'), 'utf8')).toBe(privateText);
    await expect(stat(join(fixture.home, 'extensions/garmin/reinstall-marker.txt'))).rejects.toMatchObject({code:'ENOENT'});
    const link = join(fixture.home, 'extensions/garmin/reports', '00000000-0000-7000-8000-000000000001');
    await symlink(capture, link);
    const safeHome = await realpath(join(fixture.home, 'extensions/garmin'));
    const escaped = execFileSync(python, ['-c', "import sys; sys.path.insert(0,sys.argv[1]+'/src'); from reports import write_reports; import json;\ntry: write_reports(sys.argv[1],sys.argv[2],{},{}); print('unsafe')\nexcept OSError: print('rejected')", safeHome, '00000000-0000-7000-8000-000000000001'], {encoding:'utf8'});
    expect(escaped.trim()).toBe('rejected');
  } finally { controller.abort(); if (daemon) await daemon; await store.close(); await fixture.cleanup(); }
});
