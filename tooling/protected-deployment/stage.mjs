#!/usr/bin/env node
// 운영 권한이나 엔진에 접속하지 않는 배치 검토용 산출물이다.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { render } from './policy.mjs';

export function assessEngine() {
  return {
    format: 1,
    engine: 'orbstack',
    status: 'unverified',
    authInput: false,
    externalHttp: false,
    checks: Object.fromEntries([
      'management_api', 'vm', 'contexts', 'volumes', 'backups',
      'inspect_exec_create', 'restart', 'update',
    ].map(name => [name, 'unverified'])),
  };
}

export function createStage(parent = tmpdir()) {
  const root = mkdtempSync(join(parent, 'brain-protected-stage-'));
  mkdirSync(join(root, 'evidence'), { mode: 0o700 });
  render(root);
  const assessment = assessEngine();
  writeFileSync(join(root, 'engine-assessment.json'), JSON.stringify(assessment, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(join(root, 'README.md'), '# 보호 배치 staging\n\n이 산출물은 설치나 격리 증명이 아니다. 인증 입력과 외부 HTTP는 닫힌 상태다.\n', { mode: 0o600, flag: 'wx' });
  return { root, assessment };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('인자를 받지 않습니다.');
    process.exitCode = 1;
  } else {
    const { root, assessment } = createStage();
    console.log(JSON.stringify({ root, assessment }));
  }
}
