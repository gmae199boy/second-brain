import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('설치된 Python의 파일 identity를 보존한다', async () => {
  const fixture=await extHome();
  try {
    const install=await fixture.run(['ext','install','garmin','--json']); expect(install.code,install.stdout+install.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python');
    const source=join(fixture.home,'extensions/garmin/src');
    const script="import sys; sys.path.insert(0,sys.argv[1]); from artifacts import locator_for; h='a'*64; x=[locator_for('d','artifact','a/report.md',h),locator_for('d','artifact','b/report.md',h),locator_for('a:b','artifact','c',h),locator_for('a','artifact','b:c',h)]; assert len(set(x))==4; print('ok')";
    expect(execFileSync(python,['-c',script,source],{encoding:'utf8'}).trim()).toBe('ok');
  } finally {await fixture.cleanup();}
});
