import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessEngine, createStage } from './stage.mjs';

test('격리 staging은 운영 엔진에 접속하지 않고 모든 경로를 미검증으로 둔다', () => {
  const parent = mkdtempSync(join(tmpdir(), 'brain-stage-test-'));
  try {
    const { root, assessment } = createStage(parent);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, 'engine-assessment.json')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'engine-assessment.json'))), assessment);
    assert.equal(assessment.status, 'unverified');
    assert.equal(assessment.authInput, false);
    assert.equal(assessment.externalHttp, false);
    assert.equal(Object.keys(assessment.checks).length, 8);
    assert.ok(Object.values(assessment.checks).every(value => value === 'unverified'));
    assert.deepEqual(assessEngine(), assessment);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('별도 프로세스는 임의 엔진 결과나 경로를 인자로 받지 않는다', () => {
  const result = spawnSync(process.execPath, ['tooling/protected-deployment/stage.mjs', '--verified'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('변조와 소유권 불명은 사전 검사를 통과하지 못한다', async () => {
  const { preflight } = await import('./policy.mjs');
  const { writeFileSync } = await import('node:fs');
  const parent = mkdtempSync(join(tmpdir(), 'brain-stage-preflight-'));
  try {
    const { root } = createStage(parent);
    assert.equal(preflight(root).ready, false);
    writeFileSync(join(root, 'policy.json'), '{}');
    const result = preflight(root);
    assert.ok(result.failures.includes('PACKAGE_MISMATCH'));
    assert.ok(result.failures.includes('ENGINE_ISOLATION_UNVERIFIED'));
    assert.equal(result.externalHttp, false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('복구는 낯선 파일을 보존하고 정상 staging만 제거한다', async () => {
  const { rollback } = await import('./policy.mjs');
  const { existsSync, writeFileSync } = await import('node:fs');
  const parent = mkdtempSync(join(tmpdir(), 'brain-stage-rollback-'));
  try {
    const { root } = createStage(parent);
    writeFileSync(join(root, 'unknown'), '보존');
    assert.throws(() => rollback(root), /STAGE_CHANGED/);
    assert.ok(existsSync(join(root, 'unknown')));
    rmSync(join(root, 'unknown'));
    rollback(root);
    assert.equal(existsSync(root), false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('별도 프로세스 사전 검사는 정상 staging도 실제 격리 미증명으로 거부한다', () => {
  const parent = mkdtempSync(join(tmpdir(), 'brain-stage-child-'));
  try {
    const { root } = createStage(parent);
    const child = spawnSync(process.execPath, ['tooling/protected-deployment/preflight.mjs', root], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    const result = JSON.parse(child.stdout);
    assert.equal(result.ready, false);
    assert.ok(result.failures.includes('ENGINE_ISOLATION_UNVERIFIED'));
    assert.ok(result.failures.includes('SIGNATURE_UNVERIFIED'));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
