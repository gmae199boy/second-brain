import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChanges } from '../../test-changed/rules.mjs';

describe('changed test path rules', () => {
  it('exempts only proven independent test files from the broad Python rules', () => {
    const independent = [
      'tooling/test-db/test/test-changed.test.ts',
      'tooling/test-db/test/test-changed-record.test.ts',
      'packages/postgres/test/schedule-occurrences.test.ts',
      'packages/postgres/test/user-keys.test.ts',
    ];
    for (const path of independent) {
      expect(classifyChanges([path]), path).toEqual({pythonAll:false,pythonFiles:[],postgresAll:false,reasons:[]});
    }
    expect(classifyChanges([...independent, independent[0]!])).toEqual({pythonAll:false,pythonFiles:[],postgresAll:false,reasons:[]});
    expect(classifyChanges([])).toEqual({pythonAll:false,pythonFiles:[],postgresAll:false,reasons:[]});

    const adjacent = [
      'tooling/test-db/src/index.ts', 'tooling/test-db/test/global-setup.test.ts',
      'tooling/test-db/test/fixtures/test-changed/run-baseline.mjs',
      'tooling/test-db/test/fixtures/test-changed/preload.cjs',
      'tooling/test-db/test/unknown.test.ts',
      'packages/postgres/test/fixture.ts', 'packages/postgres/test/global-setup.ts',
      'packages/postgres/test/fixtures/drive-delete-barrier-child.mjs',
      'packages/postgres/src/store.ts', 'packages/postgres/tsconfig.json',
      'packages/postgres/test/unknown.test.ts',
      ...independent.map(path => path + '.bak'),
    ];
    for (const path of adjacent) {
      const expectedPrefix = path.startsWith('tooling/test-db/') ? 'tooling/test-db/' : 'packages/postgres/';
      const result = classifyChanges([path]);
      expect(result.pythonAll, path).toBe(true);
      expect(result.reasons.map(reason => reason.prefix), path).toContain(expectedPrefix);
      expect(classifyChanges([independent[0]!, path]).pythonAll, path).toBe(true);
    }
    // The API compares literal strings: deletion and untracked status do not
    // alter classification; a rename supplies old and new paths independently.
    expect(classifyChanges([independent[2]!, 'packages/postgres/test/renamed.test.ts']).pythonAll).toBe(true);
    expect(classifyChanges([independent[2]!, independent[3]!]).pythonAll).toBe(false);
    expect(classifyChanges([independent[2]!.replace('schedule', 'Schedule')]).pythonAll).toBe(true);
    expect(classifyChanges([independent[2]!.replaceAll('/', '\\')]).pythonAll).toBe(false);
    expect(classifyChanges([independent[2]!, 'packages/postgres/migrations/0044_drive_resume.sql']))
      .toMatchObject({pythonAll:true,postgresAll:true});
    const direct = 'apps/cli/python-test/missing.test.ts';
    expect(classifyChanges([independent[0]!, direct, direct]))
      .toMatchObject({pythonAll:false,pythonFiles:[direct],postgresAll:false});
    expect(classifyChanges([independent[0]!, direct, 'tooling/test-db/src/index.ts']))
      .toMatchObject({pythonAll:true,pythonFiles:[direct],postgresAll:false});
  });
  it('keeps the complete hook file exclusively in the Python config', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const hook = 'tooling/bootstrap/test/hook.test.ts';
    expect(readFileSync(join(root, 'apps/cli/python-test/vitest.config.ts'), 'utf8'))
      .toMatch(/env:\s*\{\s*BRAIN_PYTHON_UPDATE_TEST:\s*['"]1['"]/);
    const list = (options: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), 'brain-hook-list-'));
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir, BRAIN_TEST_DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/postgres', BRAIN_PYTHON_UPDATE_TEST: '0' };
        delete env.BRAIN_TEST_SLOT_LEASE;
        delete env.BRAIN_TEST_RUN_ID;
        delete env.BRAIN_TEST_SLOT_ID;
        delete env.BRAIN_TEST_FILE_ID;
        const result = spawnSync('pnpm', ['exec', 'vitest', 'list', hook, ...options, '--json'], {
          cwd: root, env, encoding: 'utf8', timeout: 120000,
        });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout) as { file: string; name: string }[];
      } finally { rmSync(dir, { recursive: true, force: true }); }
    };
    expect(list(['--filesOnly'])).toEqual([]);
    const cases = list(['--config', 'apps/cli/python-test/vitest.config.ts', '--no-static-parse']);
    expect(cases.every(item => item.file.endsWith('/' + hook))).toBe(true);
    const names = cases.map(item => item.name);
    const expected = [
      'clones, builds, installs, and records the commit the plugin asked for',
      'does nothing at all on a second session with the same ref',
      '갱신 전에 기존 데몬을 멈추고 새 빌드를 노출한다',
      '실제 app 승격 뒤 완료 기록 실패를 같은 대상으로 재시도하며 원래 backup을 보존한다',
      'collects a Stop payload, records its arrival, and ignores a transcript with no conversation',
      '실제 package 설치와 같은 core bootstrap이 겹쳐도 둘 다 성공하고 일관된다',
      '설치된 확장의 다른 commit을 SessionStart가 무질문 갱신하고 기억과 이력을 보존한다',
      '무인 bootstrap 갱신이 Python 확장 환경과 데이터를 보존한다',
    ];
    expect(names).toHaveLength(expected.length);
    for (const name of expected) expect(names.filter(actual => actual.endsWith(name)), name).toHaveLength(1);
  }, 300000);

  it('routes bootstrap and config changes through the Python slots runner', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'brain-changed-route-'));
    const log = join(dir, 'commands');
    try {
      writeFileSync(join(dir, 'git'), `#!/bin/sh
case "$1" in
  diff) case "$*" in *...HEAD*) printf '%s\\0' "$CHANGED_PATH";; esac;;
  *) :;;
esac
`, { mode: 0o755 });
      writeFileSync(join(dir, 'pnpm'), `#!/bin/sh
printf 'pnpm %s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  *'vitest list'*'--config apps/cli/python-test/vitest.config.ts'*) printf '[{"file":"/tooling/bootstrap/test/hook.test.ts"}]';;
  *'vitest list'*) printf '[]';;
esac
`, { mode: 0o755 });
      writeFileSync(join(dir, 'node'), `#!/bin/sh
printf 'node %s\\n' "$*" >> "$COMMAND_LOG"
`, { mode: 0o755 });
      for (const changed of ['tooling/bootstrap/test/hook.test.ts', 'tooling/bootstrap/test/hook-resources.ts', 'tooling/bootstrap/src/bootstrap.ts', 'vitest.config.ts', 'apps/cli/python-test/vitest.config.ts']) {
        writeFileSync(log, '');
        const result = spawnSync(process.execPath, ['tooling/test-changed/run.mjs', 'HEAD'], {
          cwd: root, encoding: 'utf8', env: { ...process.env, PATH: dir + delimiter + process.env.PATH, CHANGED_PATH: changed, COMMAND_LOG: log }, timeout: 30000,
        });
        expect(result.status, `${changed}: ${result.stderr}`).toBe(0);
        const commands = readFileSync(log, 'utf8');
        expect(commands).toContain('vitest list --changed HEAD --filesOnly --json');
        expect(commands).toContain('vitest list --config apps/cli/python-test/vitest.config.ts --filesOnly --json');
        expect(commands).toContain('node tooling/test-db/dist/python-slots.js\n');
        expect(commands).not.toContain('vitest run');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('runs Python for extension and runtime paths', () => {
    for (const file of [
      'extensions/garmin/src/body_ipc.py', 'extensions/garmin/tests/test_body_runtime.py', 'extensions/garmin/tests/test_store_contract_integration.py', 'extensions/garmin/tests/test_report_process.py', 'extensions/garmin/tests/test_report_supervised.py', 'extensions/garmin/tests/report-fixture/codex',
      'apps/cli/python-test/garmin-report-observer.ts', 'extensions/garmin/tests/report_input_oracle_child.py', 'extensions/garmin/tests/test_report_input_pg.py', 'extensions/garmin/fixtures/legacy/analysis-input-fixture.json', 'extensions/garmin/fixtures/legacy/report_v8/measurement.json', 'extensions/garmin/src/report.py', 'extensions/garmin/src/report_runtime.py', 'extensions/garmin/src/body_runtime.py', 'extensions/garmin/skills/garmin-body-intake/SKILL.md',
      'extensions/garmin/src/supervised_input.py', 'extensions/garmin/tests/test_supervised_input_contract.py',
      'extensions/garmin/src/collect_runtime.py', 'extensions/garmin/src/collect_refresh.py', 'extensions/garmin/migrations/0015_raw_observations.sql', 'extensions/garmin/tests/collect_oracle_child.py', 'extensions/garmin/tests/supervised_fake_network.py', 'extensions/garmin/tests/test_collect_oracle_pg.py',
      'extensions/garmin/src/native_import.py', 'extensions/garmin/src/native_artifacts.py', 'extensions/garmin/migrations/0014_native_store.sql', 'extensions/garmin/fixtures/native/synthetic.py', 'extensions/garmin/tests/oracle/src/garmin_pipeline/report_input.py', 'extensions/garmin/tests/test_native_store.py', 'extensions/garmin/tests/test_normalize_oracle_pg.py', 'extensions/garmin/tests/normalize_oracle_child.py', 'extensions/garmin/fixtures/legacy/normalize_v8/input.json', 'extensions/garmin/tests/oracle/src/garmin_pipeline/normalize/__init__.py',
      'extensions/garmin/src/x.py', 'extensions/other/manifest.json', 'plugins/testext/bin/install.sh', 'plugins/testext/package/digest', 'plugins/garmin/bin/install.sh', 'plugins/garmin/package/digest', 'tooling/package-garmin/build.mjs', 'tooling/garmin-import/capture.py', 'tooling/garmin-import/test_capture.py', '.claude-plugin/marketplace.json',
      'apps/cli/test/fixtures/fake-drive.ts','packages/postgres/test/fixtures/drive-crash-child.mjs','packages/postgres/migrations/0040_drive_uploads.sql','packages/postgres/src/store.ts','packages/postgres/src/extension-install-lock.ts','packages/postgres/test/extension-command-lock.test.ts','packages/postgres/migrations/001.sql',
      'packages/core/src/sources/sync.ts','packages/core/src/ports/source-remote.ts','apps/cli/test/source-runtime.test.ts','apps/cli/test/drive-source-tracer.test.ts','packages/postgres/migrations/0041_sources.sql',
      'packages/core/src/queue/supervisor.ts','packages/core/src/process-abi/codec.ts',
      'packages/core/src/extensions/install.ts','packages/core/src/imports/x.ts',
      'packages/core/src/channels/handoff.ts','packages/core/src/files/import-work.ts',
      'packages/core/src/domain/work-item.ts','packages/core/src/brain.ts','packages/core/src/schema.ts',
      'packages/core/src/instant.ts','packages/core/src/envelope.ts',
      'packages/core/src/testing/fixtures.ts','packages/second_brain/src/testing.ts',
      'packages/core/schemas/example.json','apps/cli/src/daemon/run.ts','apps/cli/src/runtime/extensions.ts',
      'apps/cli/src/runtime/extension-package-worker.ts','apps/cli/src/install/flow.ts','apps/cli/src/install/promotion-protocol.ts','apps/cli/src/config/codec.ts','apps/cli/src/commands/ext-install.ts',
      'apps/cli/src/assembly.ts','apps/cli/scripts/write-build-info.mjs','apps/cli/src/envelope.ts','apps/cli/src/commands/index.ts',
      'apps/cli/src/commands/daemon-status.ts','apps/cli/test/ext-fixture.ts','apps/cli/test/global-setup.ts',
      'apps/cli/test/pg-home.ts','apps/cli/test/extension-commands.test.ts','packages/core/src/testing/contracts/extension-quiesce.ts','apps/cli/test/install-lock.test.ts','apps/cli/test/ext-package.test.ts','apps/cli/test/ext-install-resume.test.ts','tooling/test-db/src/index.ts','tooling/bootstrap/src/bootstrap.ts',
      'tooling/recall-eval/health-cases.json', 'apps/cli/python-test/vitest.config.ts','apps/cli/python-test/global-setup.ts','vitest.config.ts','tooling/test-changed/rules.mjs','package.json','pnpm-lock.yaml',
      'apps/cli/src/mcp/serve.ts', 'apps/cli/src/commands/mcp-serve.ts', 'packages/core/src/ports/process.ts', 'packages/core/fixtures/extensions/v1/check-manifests.py',
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
    expect(classifyChanges(['apps/cli/python-test/garmin-core.test.ts'])).toMatchObject({pythonAll:false,pythonFiles:['apps/cli/python-test/garmin-core.test.ts']});
    expect(classifyChanges(['apps/cli/python-test/garmin-report.test.ts'])).toMatchObject({pythonAll:false,pythonFiles:['apps/cli/python-test/garmin-report.test.ts']});
    expect(classifyChanges(['apps/cli/python-test/garmin-collect.test.ts'])).toMatchObject({pythonAll:false,pythonFiles:['apps/cli/python-test/garmin-collect.test.ts']});
    expect(classifyChanges(['apps/cli/python-test/garmin-capture.test.ts'])).toMatchObject({pythonAll:false,pythonFiles:['apps/cli/python-test/garmin-capture.test.ts']});
    expect(classifyChanges(['apps/cli/python-test/garmin-native.test.ts','apps/cli/python-test/garmin-unit.test.ts'])).toMatchObject({pythonAll:false,pythonFiles:['apps/cli/python-test/garmin-native.test.ts','apps/cli/python-test/garmin-unit.test.ts']});
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
