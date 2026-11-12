import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';
import { extensionDatabaseUrl } from '../src/config/codec.js';

// 변경 범위만 검증할 때 Python 파일명을 명시하며 기본 전체 회귀는 기존 discover를 유지한다.
const modules = process.env['GARMIN_UNIT_TEST_MODULES']?.split(',') ?? process.env['GARMIN_UNIT_TEST_FILES']?.split(',').map(name => name.replace(/\.py$/, ''));
if (modules && (!modules.length || modules.some(name => !/^test_[a-z0-9_]+$/.test(name)))) throw Error('잘못된 Garmin 시험 모듈');
it(modules ? `runs selected Garmin Python files: ${modules.join(', ')}` : 'runs every Garmin Python unittest with isolated owned roles', async () => {
  const fixture = await extHome();
  try {
    const install = await fixture.run(['ext','install','garmin','--json']);
    expect(install.code, install.stdout + install.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python');
    const root=fileURLToPath(new URL('../../../extensions/garmin',import.meta.url));
    const extDsn=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl);
    const env={...fixture.env,PYTHONPATH:[join(root,'src'),join(root,'tests'),process.env.PYTHONPATH ?? ''].join(delimiter),
      GARMIN_TEST_OWNER_DSN:fixture.db.url,GARMIN_TEST_EXTENSION_DSN:extDsn,GARMIN_TEST_OTHER_DSN:fixture.db.appUrl};
    const argv = modules ? ['-m','unittest','-v',...modules] : ['-m','unittest','discover','-s',join(root,'tests'),'-p','test_*.py','-v'];
    const result=spawnSync(python,argv,{env,encoding:'utf8',timeout:60000,maxBuffer:32 * 1024 * 1024});
    // unittest writes verbose per-method results to stderr, including on success.
    // Forward both streams before checking status so failures retain the same evidence.
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status,result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Ran [1-9]\d* tests? in /);
    expect(result.stdout + result.stderr).not.toMatch(/skipped?=/i);
  } finally { await fixture.cleanup(); }
},120000);
