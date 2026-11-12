import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';
import { extensionDatabaseUrl } from '../src/config/codec.js';

it('백필·수집·보호 경로의 지정 Python 파일만 전용 DB에서 검증한다', async () => {
  const fixture = await extHome();
  try {
    const install = await fixture.run(['ext','install','garmin','--json']);
    expect(install.code, install.stdout + install.stderr).toBe(0);
    const root = fileURLToPath(new URL('../../../extensions/garmin',import.meta.url));
    const python = join(fixture.home,'extensions/garmin/.venv/bin/python');
    const extDsn = await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl);
    const modules = ['test_backfill','test_collect_runtime','test_collect_supervised',
      'test_collect_auth_ports_pg','test_collect_credentials','test_collect_oracle_pg'];
    const result = spawnSync(python,['-m','unittest','-v',...modules], {
      env: {...fixture.env, PYTHONPATH:[join(root,'src'),join(root,'tests')].join(delimiter),
        GARMIN_TEST_OWNER_DSN:fixture.db.url, GARMIN_TEST_EXTENSION_DSN:extDsn,
        GARMIN_TEST_OTHER_DSN:fixture.db.appUrl},
      encoding:'utf8',timeout:120000,maxBuffer:32 * 1024 * 1024,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    expect(result.error,result.error?.message).toBeUndefined();
    expect(result.status,result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Ran [1-9]\d* tests? in /);
    expect(result.stdout + result.stderr).not.toMatch(/skipped?=/i);
    const receipts = await fixture.db.rows("select connection_id,key from garmin.meta where key like 'backfill_result:%' order by key limit 1");
    expect(receipts).toHaveLength(1);
    const input={connection_id:String(receipts[0]!.connection_id),work_id:String(receipts[0]!.key).slice('backfill_result:'.length)};
    const query=await fixture.run(['ext','garmin','backfill-status','--input',JSON.stringify(input),'--json']);
    expect(query.code,query.stdout+query.stderr).toBe(0);
    expect(query.body.data.result.status).toBe('dry_run');
    expect(query.body.data.result.plan.items).toEqual([{date:'2026-10-15',endpoint:'sleep_data',count:1}]);
    const missing=await fixture.run(['ext','garmin','backfill-status','--input',JSON.stringify({...input,work_id:'00000000-0000-4000-8000-000000000099'}),'--json']);
    expect(missing.code,missing.stdout+missing.stderr).toBe(0);
    expect(missing.body.data).toEqual({result:null});

  } finally { await fixture.cleanup(); }
},180000);
