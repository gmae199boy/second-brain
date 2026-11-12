import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionDatabaseUrl } from '../src/config/codec.js';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('공개 CLI는 Garmin 프로필 조회·전체 저장·항목 수정·해제와 검증을 지원한다', async () => {
  const fixture = await extHome();
  const key = 'garmin.analysis_profile';
  try {
    const installed = await fixture.run(['ext', 'install', 'garmin', '--json']);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    const empty = await fixture.run(['config', 'get', key, '--json']);
    expect(empty.code, empty.stdout + empty.stderr).toBe(0);
    expect(empty.body.data).toMatchObject({ key, value: '', scope: 'user', source: 'db' });
    const stored = await fixture.run(['config', 'set', key, '{"schema_version":1,"goals":{"primary":"감량"},"constraints":[]}', '--json']);
    expect(stored.code, stored.stdout + stored.stderr).toBe(0);
    const patched = await fixture.run(['config', 'patch', key, JSON.stringify({ expected_value: stored.body.data.value, set: { 'goals.target_weight_kg': 75, alcohol_units: [{ kind: '소주', unit: '병' }] } }), '--json']);
    expect(patched.code, patched.stdout + patched.stderr).toBe(0);
    expect(JSON.parse(String(patched.body.data.value))).toEqual({ schema_version: 1, goals: { primary: '감량', target_weight_kg: 75 }, constraints: [], alcohol_units: [{ kind: '소주', unit: '병' }] });
    const stale = stored.body.data.value;
    const conflict = await fixture.run(['config', 'patch', key, JSON.stringify({ expected_value: stale, set: { alcohol_units: [] } }), '--json']);
    expect(conflict.code).toBe(1);
    expect(conflict.body.error).toMatchObject({ code: 'DB_LOCKED' });
    const read = await fixture.run(['config', 'get', key, '--json']);
    expect(read.body.data.value).toBe(patched.body.data.value);
    for (const patch of ['{"set":{"goals.target_weight_kg":-75}}', '{"unset":["schema_version"]}', '{}', '{']) {
      const bad = await fixture.run(['config', 'patch', key, patch, '--json']);
      expect(bad.code).toBe(2);
      expect(bad.body.error).toMatchObject({ code: 'CONFIG_INVALID' });
      expect((await fixture.run(['config', 'get', key, '--json'])).body.data.value).toBe(read.body.data.value);
    }
    const removed = await fixture.run(['config', 'patch', key, '{"unset":["goals.target_weight_kg"]}', '--json']);
    expect(removed.code, removed.stdout + removed.stderr).toBe(0);
    expect(JSON.parse(String(removed.body.data.value)).goals).toEqual({ primary: '감량' });
    const unsupported = await fixture.run(['config', 'patch', 'timezone', '{"set":{"timezone":"UTC"}}', '--json']);
    expect(unsupported.code).toBe(2);
  } finally { await fixture.cleanup(); }
}, 120000);


it('프로필 snapshot과 관련 Python 계약만 격리 DB에서 검증한다', async () => {
  const fixture = await extHome();
  try {
    const installed = await fixture.run(['ext', 'install', 'garmin', '--json']);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    const python = join(fixture.home, 'extensions/garmin/.venv/bin/python');
    const root = fileURLToPath(new URL('../../../extensions/garmin', import.meta.url));
    const env = { ...fixture.env, PYTHONPATH: [join(root, 'src'), join(root, 'tests'), process.env.PYTHONPATH ?? ''].join(delimiter),
      GARMIN_TEST_OWNER_DSN: fixture.db.url, GARMIN_TEST_EXTENSION_DSN: await extensionDatabaseUrl(fixture.home, 'garmin', fixture.db.appUrl), GARMIN_TEST_OTHER_DSN: fixture.db.appUrl };
    const files = ['test_analysis_profile', 'test_report_input_pg', 'test_report_runtime', 'test_period_analysis', 'test_collect_runtime'];
    const result = spawnSync(python, ['-m', 'unittest', '-v', ...files], { env, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toMatch(/skipped?=/i);
  } finally { await fixture.cleanup(); }
}, 180000);
