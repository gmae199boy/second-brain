import { chmod, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { tempHomes } from './temp-home.js';
import { withoutHarnessFolders } from './environment.js';
import { pgHome, runPgCommand } from './pg-home.js';
it('config CLI는 가짜 실행 파일을 검증해 global로 저장하고 깨진 경로를 거부한다', async () => {
  const homes = tempHomes(), home = await homes.create('brain-exec-config-'), db = await pgHome(home, false);
  const env = {...withoutHarnessFolders(process.env),...db.env,SECOND_BRAIN_HOME:home};
  try {
    const path = join(home,'synthetic codex'); await writeFile(path,'#!/bin/sh\nprintf "codex-cli 1.0.0\\n"\n'); await chmod(path,0o700);
    const canonical = await realpath(path);
    const set = await runPgCommand(['config','set','agent.codex_path',path,'--json'],env);
    expect(set.code,set.stdout+set.stderr).toBe(0); expect(JSON.parse(set.stdout).data).toMatchObject({scope:'global',value:canonical});
    const get = await runPgCommand(['config','get','agent.codex_path','--json'],env);
    expect(JSON.parse(get.stdout).data).toMatchObject({source:'db',value:canonical});
    for (const invalid of ['codex',join(home,'missing')]) {
      const refused = await runPgCommand(['config','set','agent.codex_path',invalid,'--json'],env);
      expect(refused.code).toBe(2); expect(JSON.parse(refused.stdout).error.code).toBe('CONFIG_INVALID');
    }
    const kept = await runPgCommand(['config','get','agent.codex_path','--json'],env);
    expect(JSON.parse(kept.stdout).data.value).toBe(canonical);
  } finally { await db.drop(); await homes.cleanup(); }
});
