#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { classifyChanges } from './rules.mjs';
import { createRecord, safePath } from './record.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const ref = args[0] === '--base' ? args[1] : args[0] || process.env.BRAIN_TEST_CHANGED_REF || 'origin/main';
if (!ref || ref.startsWith('-') || (args[0] === '--base' ? args.length !== 2 : args.length > 1)) {
  console.error('Usage: pnpm test:changed [--base] [ref]');
  process.exit(2);
}
const record = createRecord(root, ref);
const stageNames = ['build', 'verify-ref', 'git-committed', 'git-staged', 'git-unstaged', 'git-untracked', 'default-list', 'default-run', 'postgres-list', 'postgres-run', 'python-list', 'python-run'];
let activeStage = null;
function command(stage, executable, argv, capture = false) {
  activeStage = stage;
  const end = record.begin(stage);
  const result = spawnSync(executable, argv, {cwd: root, env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}, encoding: 'utf8', stdio: capture ? ['ignore','pipe','pipe'] : 'inherit', maxBuffer: 32 * 1024 * 1024});
  end(result.error || result.status !== 0 ? 'failed' : 'completed', result);
  if (result.error || result.status !== 0) {
    if (result.signal && !result.error) record.data.interruption = { source: 'child', signal: result.signal, stage };
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${executable} ${argv.join(' ')} failed: ${result.error?.message ?? `exit ${result.status ?? result.signal}`}`);
  }
  return result.stdout ?? '';
}
function filesFromGit(stage, argv) {
  return command(stage, 'git',argv,true).split('\0').filter(Boolean);
}
function list(stage, config, changed) {
  const argv = ['exec','vitest','list',...config,...(changed ? ['--changed',ref] : []),'--filesOnly','--json'];
  const tests = JSON.parse(command(stage, 'pnpm',argv,true));
  const files = [...new Set(tests.map(test => relative(root,test.file)))];
  return files;
}
function run(config, changed, label, prefix) {
  const files = list(`${prefix}-list`, config,changed);
  record.data.selection[prefix] = files.map(path => safePath(root, path));
  if (prefix === 'default') record.data.tracer.files = files.filter(path => /tracer/i.test(path)).map(path => safePath(root, path));
  record.snapshot();
  if (!files.length) { record.skip(`${prefix}-run`, 'no-selected-files'); console.log(`${label}: 선택된 시험 파일 없음`); return; }
  console.log(`${label}: 시험 파일 ${files.length}개 실행`);
  command(`${prefix}-run`, 'pnpm',['exec','vitest','run',...config,...(changed ? ['--changed',ref] : []),'--passWithNoTests']);
}
try {
  console.log(`빌드: pnpm build`);
  command('build', 'pnpm',['build']);
  const baseSha = command('verify-ref', 'git',['rev-parse','--verify','--end-of-options',`${ref}^{commit}`],true).trim();
  record.data.comparison.baseSha = /^[a-f0-9]{40,64}$/i.test(baseSha) ? baseSha : null;
  // Match Vitest's merge-base comparison and include staged, unstaged and untracked paths.
  const paths = [...new Set([
    ...filesFromGit('git-committed', ['diff','--name-only','--no-renames','-z',`${ref}...HEAD`]),
    ...filesFromGit('git-staged', ['diff','--cached','--name-only','--no-renames','-z']),
    ...filesFromGit('git-unstaged', ['diff','--name-only','--no-renames','-z']),
    ...filesFromGit('git-untracked', ['ls-files','--others','--exclude-standard','-z']),
  ])];
  const selected = classifyChanges(paths);
  record.data.inputs = paths.map(path => safePath(root, path));
  record.data.selection = {
    default: null, postgres: null, python: null,
    pythonMode: selected.pythonAll ? 'all' : selected.pythonFiles.length ? 'files' : 'none',
    postgresAll: selected.postgresAll,
    reasons: selected.reasons.map(({prefix, reason}) => ({ prefix: safePath(root, prefix.replace(/\/$/, '')), reason })),
    inputReasons: paths.map(path => ({ path: safePath(root, path), reasons: classifyChanges([path]).reasons.map(({prefix, reason}) => ({prefix: safePath(root, prefix.replace(/\/$/, '')), reason})), postgresMigration: path.startsWith('packages/postgres/migrations/'), pythonDirect: selected.pythonFiles.includes(path) })),
    pythonMissing: [],
  };
  record.snapshot();
  console.log(`기준 ${ref}: 변경 파일 ${paths.length}개 (커밋·작업 트리·미추적 포함)`);
  for (const reason of selected.reasons) console.log(`경로 규칙 ${reason.prefix}: ${reason.reason}`);
  run([],true,'기본 --changed','default');
  if (selected.postgresAll) run(['--project','postgres'],false,'Postgres migration 전체','postgres');
  else { record.skip('postgres-list', 'no-migration-change'); record.skip('postgres-run', 'no-migration-change'); console.log('Postgres 전체: migration 변경 없음'); }
  const python = ['--config','apps/cli/python-test/vitest.config.ts'];
  if (selected.pythonAll) {
    const files = list('python-list', python, false);
    record.data.selection.python = files.map(path => safePath(root, path)); record.snapshot();
    if (!files.length) { record.skip('python-run', 'no-selected-files'); console.log('Python 전체: 선택된 시험 파일 없음'); }
    else { console.log(`Python 전체 (경로 규칙): 시험 파일 ${files.length}개 실행`); command('python-run', 'node', ['tooling/test-db/dist/python-slots.js']); }
  }
  else if (selected.pythonFiles.length) {
    record.skip('python-list', 'direct-files');
    const existing = selected.pythonFiles.filter(path => existsSync(resolve(root,path)));
    record.data.selection.python = existing.map(path => safePath(root, path));
    record.data.selection.pythonMissing = selected.pythonFiles.filter(path => !existing.includes(path)).map(path => safePath(root, path)); record.snapshot();
    if (!existing.length) { record.skip('python-run', 'no-existing-files'); console.log('Python 선택: 존재하는 시험 파일 없음'); }
    else {
      console.log(`Python 선택: 변경된 시험 파일 ${existing.length}개 실행`);
      command('python-run', 'node',['tooling/test-db/dist/python-slots.js','--files',...existing]);
    }
  } else { record.data.selection.python = []; record.skip('python-list', 'no-matching-rule'); record.skip('python-run', 'no-matching-rule'); console.log('Python 생략: 경로 규칙에 해당 없음(마무리 전 전체 test:python 필요)'); }
  record.finish('completed', 0);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  for (const name of stageNames) if (!record.data.stages.some(stage => stage.name === name)) record.skip(name, 'prior-failure');
  record.finish(record.data.interruption ? 'interrupted' : 'failed', 1, record.data.interruption ?? (activeStage ? { source: 'runner', stage: activeStage, reason: 'command-or-processing-failure' } : null));
}
