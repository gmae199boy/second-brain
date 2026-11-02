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
    const capture = join(fixture.home, 'capture'); await mkdir(capture);
    execFileSync(python, ['-c', "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from fixtures import five_candidates,capture_manifest; root=Path(sys.argv[2]); capture_manifest(root,five_candidates(root))", fixtureModule, capture]);
    const snapshots = ['D1','D2','D3','D4','D5'].map(role => join(capture, `${role}.db`));
    const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
    const before = await Promise.all(snapshots.map(hash));
    const tables = ['garmin.datasets', 'garmin.import_batches', 'garmin.import_mapping', 'garmin.raw_payloads', 'brain.health_observations', 'brain.analyses', 'brain.file_requests'];
    const contract = async () => Promise.all(tables.map(table => fixture.db.rows(`select coalesce(json_agg(t order by t::text)::text,'[]') as contents from ${table} t`)));
    const prior = await contract();
    await store.setSetting({ key: 'garmin.capture_manifest', value: await realpath(join(capture, 'manifest.json')), updatedAt: new Date() });
    daemon = runDaemon({ home: fixture.home, env: fixture.env, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25 } });
    const run = await fixture.run(['ext', 'run', 'garmin', 'import-preflight', '--json']);
    const errors = await fixture.db.rows("select error_code,stderr from brain.work_attempts order by started_at");
    expect(run.code, run.stdout + run.stderr + JSON.stringify(errors)).toBe(0);
    expect(run.body.data).toMatchObject({ status: 'completed', report: { counts: { datasets: 5, raw_response_conflicts: 1, raw_conflict_keys: 1, raw_metadata_conflict_keys: 1, unselected_keys: 0, unconfirmed_accounts: 2, expected_preservation_candidates: 21, expected_dataset_candidates: 5, expected_mapping_candidates: 21, expected_file_requests: 0 }, checks: { total_insert_known: false, source_unchanged: true, core_ready: true, extension_ready: true, role_ready: true, attempt_current: true } } });
    const id = run.body.data.work_id as string;
    const report = join(fixture.home, 'extensions/garmin/reports', id);
    const privateText = await readFile(join(report, 'private.json'), 'utf8');
    expect(privateText).toContain('12345');
    expect((await stat(report)).mode & 0o777).toBe(0o700);
    expect((await stat(join(report, 'private.json'))).mode & 0o777).toBe(0o600);
    for (const secret of ['12345', '2026-01-01', fixture.home, '한글']) expect(run.stdout).not.toContain(secret);
    const attempts = await fixture.db.rows(`select error_code,stderr from brain.work_attempts where work_item_id='${id}'`);
    for (const secret of ['12345', '2026-01-01', fixture.home, '한글']) expect(JSON.stringify(attempts)).not.toContain(secret);
    expect(await Promise.all(snapshots.map(hash))).toEqual(before);
    expect(await contract()).toEqual(prior);
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
      { alter: 'revoke insert(value) on brain.health_observations from brain_ext_garmin', restore: 'grant insert(value) on brain.health_observations to brain_ext_garmin', key: 'required_inserts', publicKey: 'role_ready' },
      { alter: 'grant select on brain.health_observations to brain_ext_garmin', restore: 'revoke select on brain.health_observations from brain_ext_garmin', key: 'no_excess_tables', publicKey: 'role_ready' },
      { alter: 'grant brain_app to brain_ext_garmin', restore: 'revoke brain_app from brain_ext_garmin', key: 'membership_absent', publicKey: 'role_ready' },
      { alter: 'revoke select on brain.health_catalog_v1 from brain_ext_garmin', restore: 'grant select on brain.health_catalog_v1 to brain_ext_garmin', key: 'catalog_select', publicKey: 'role_ready' },
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
