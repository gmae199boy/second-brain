import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChanges } from '../../test-changed/rules.mjs';

describe('changed test path rules', () => {
  it('runs Python for extension and runtime paths', () => {
    for (const file of [
      'extensions/garmin/src/x.py', 'extensions/other/manifest.json',
      'packages/postgres/src/store.ts','packages/postgres/migrations/001.sql',
      'packages/core/src/queue/supervisor.ts','packages/core/src/process-abi/codec.ts',
      'packages/core/src/extensions/install.ts','packages/core/src/imports/x.ts',
      'packages/core/src/channels/handoff.ts','packages/core/src/files/import-work.ts',
      'packages/core/src/domain/work-item.ts','packages/core/src/brain.ts','packages/core/src/schema.ts',
      'packages/core/src/instant.ts','packages/core/src/envelope.ts',
      'packages/core/src/testing/fixtures.ts','packages/second_brain/src/testing.ts',
      'packages/core/schemas/example.json','apps/cli/src/daemon/run.ts','apps/cli/src/runtime/extensions.ts',
      'apps/cli/src/install/flow.ts','apps/cli/src/config/codec.ts','apps/cli/src/commands/ext-install.ts',
      'apps/cli/src/assembly.ts','apps/cli/src/envelope.ts','apps/cli/src/commands/index.ts',
      'apps/cli/src/commands/daemon-status.ts','apps/cli/test/ext-fixture.ts','apps/cli/test/global-setup.ts',
      'apps/cli/test/pg-home.ts','tooling/test-db/src/index.ts','tooling/bootstrap/src/bootstrap.ts',
      'apps/cli/python-test/vitest.config.ts','tooling/test-changed/rules.mjs','package.json','pnpm-lock.yaml',
    ]) expect(classifyChanges([file]).pythonAll, file).toBe(true);
  });
  it('skips Python for unrelated command and core changes', () => {
    for (const file of ['apps/cli/src/commands/guide-show.ts','apps/cli/src/commands/failures-list.ts','packages/core/src/guide.ts']) {
      expect(classifyChanges([file]),file).toMatchObject({pythonAll:false,pythonFiles:[],postgresAll:false,reasons:[]});
    }
  });
  it('runs Postgres and Python for migrations', () => {
    expect(classifyChanges(['packages/postgres/migrations/0028_file_request_metadata.sql'])).toMatchObject({pythonAll:true,postgresAll:true});
  });
  it('selects only explicitly changed Python and hook tests without a full rule', () => {
    const tests: [string, string] = ['apps/cli/python-test/garmin-charts.test.ts','tooling/bootstrap/test/hook.test.ts'];
    expect(classifyChanges([tests[0],tests[0]])).toMatchObject({pythonAll:false,pythonFiles:[tests[0]]});
    expect(classifyChanges([tests[1]])).toMatchObject({pythonAll:true,pythonFiles:[tests[1]]});
    expect(classifyChanges(tests)).toMatchObject({pythonAll:true,pythonFiles:tests});
    expect(classifyChanges([tests[0],'apps/cli/src/daemon/run.ts'])).toMatchObject({pythonAll:true,pythonFiles:[tests[0]]});
    expect(classifyChanges(['apps/cli/python-test/nested/test.test.ts'])).toMatchObject({pythonAll:false,pythonFiles:[]});
  });
  it('follows a changed core source into workspace consumers', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(),'brain-changed-git-'));
    const git = execFileSync('which',['git'],{encoding:'utf8'}).trim();
    try {
      writeFileSync(join(dir,'git'), `#!/bin/sh
case "$*" in
  'diff --name-only origin/main...HEAD') printf '%s\\n' 'packages/core/src/channels/handoff.ts';;
  'diff --cached --name-only'|'ls-files --other --modified --exclude-standard') :;;
  *) exec "$BRAIN_REAL_GIT" "$@";;
esac
`, {mode:0o755});
      const result = spawnSync('pnpm',['exec','vitest','list','--changed','origin/main','--filesOnly','--json'], {
        cwd:root, encoding:'utf8', env:{...process.env,PATH:dir+delimiter+process.env.PATH,BRAIN_REAL_GIT:git}, timeout:20000,
      });
      expect(result.status,result.stderr).toBe(0);
      const files = JSON.parse(result.stdout) as {file:string}[];
      expect(files.some(item=>item.file.endsWith('/packages/postgres/test/source-resolution.test.ts'))).toBe(true);
      expect(files.some(item=>item.file.endsWith('/apps/cli/test/channels-legacy.test.ts'))).toBe(true);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  },30000);
  it('does not match lookalike prefixes and combines independent rules', () => {
    expect(classifyChanges(['extension/garmin/a.py','packages/postgres-extra/migrations/a.sql'])).toMatchObject({pythonAll:false,pythonFiles:[],postgresAll:false,reasons:[]});
    expect(classifyChanges(['extensions/garmin/a.py','packages/postgres/migrations/a.sql']).reasons).toHaveLength(2);
  });
});
