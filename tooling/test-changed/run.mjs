#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { classifyChanges } from './rules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const ref = args[0] === '--base' ? args[1] : args[0] || process.env.BRAIN_TEST_CHANGED_REF || 'origin/main';
if (!ref || ref.startsWith('-') || (args[0] === '--base' ? args.length !== 2 : args.length > 1)) {
  console.error('Usage: pnpm test:changed [--base] [ref]');
  process.exit(2);
}
function command(executable, argv, capture = false) {
  const result = spawnSync(executable, argv, {cwd: root, env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}, encoding: 'utf8', stdio: capture ? ['ignore','pipe','pipe'] : 'inherit', maxBuffer: 32 * 1024 * 1024});
  if (result.error || result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${executable} ${argv.join(' ')} failed: ${result.error?.message ?? `exit ${result.status ?? result.signal}`}`);
  }
  return result.stdout ?? '';
}
function filesFromGit(argv) {
  return command('git',argv,true).split('\0').filter(Boolean);
}
function list(config, changed) {
  const argv = ['exec','vitest','list',...config,...(changed ? ['--changed',ref] : []),'--filesOnly','--json'];
  const tests = JSON.parse(command('pnpm',argv,true));
  return new Set(tests.map(test => relative(root,test.file))).size;
}
function run(config, changed, label) {
  const count = list(config,changed);
  if (!count) { console.log(`${label}: 선택된 시험 파일 없음`); return; }
  console.log(`${label}: 시험 파일 ${count}개 실행`);
  command('pnpm',['exec','vitest','run',...config,...(changed ? ['--changed',ref] : []),'--passWithNoTests']);
}
try {
  console.log(`빌드: pnpm build`);
  command('pnpm',['build']);
  command('git',['rev-parse','--verify','--end-of-options',`${ref}^{commit}`],true);
  // Match Vitest's merge-base comparison and include staged, unstaged and untracked paths.
  const paths = [...new Set([
    ...filesFromGit(['diff','--name-only','--no-renames','-z',`${ref}...HEAD`]),
    ...filesFromGit(['diff','--cached','--name-only','--no-renames','-z']),
    ...filesFromGit(['diff','--name-only','--no-renames','-z']),
    ...filesFromGit(['ls-files','--others','--exclude-standard','-z']),
  ])];
  const selected = classifyChanges(paths);
  console.log(`기준 ${ref}: 변경 파일 ${paths.length}개 (커밋·작업 트리·미추적 포함)`);
  for (const reason of selected.reasons) console.log(`경로 규칙 ${reason.prefix}: ${reason.reason}`);
  run([],true,'기본 --changed');
  if (selected.postgresAll) run(['--project','postgres'],false,'Postgres migration 전체');
  else console.log('Postgres 전체: migration 변경 없음');
  const python = ['--config','apps/cli/python-test/vitest.config.ts'];
  if (selected.pythonAll) run(python,false,'Python 전체 (경로 규칙)');
  else if (selected.pythonFiles.length) {
    const existing = selected.pythonFiles.filter(path => existsSync(resolve(root,path)));
    if (!existing.length) console.log('Python 선택: 존재하는 시험 파일 없음');
    else {
      console.log(`Python 선택: 변경된 시험 파일 ${existing.length}개 실행`);
      command('pnpm',['exec','vitest','run',...python,...existing,'--passWithNoTests']);
    }
  } else console.log('Python 생략: 경로 규칙에 해당 없음(마무리 전 전체 test:python 필요)');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
