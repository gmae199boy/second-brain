import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./run.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
test('격리 카탈로그 testext의 시험 로그인과 패키지 digest가 일치한다', () => {
  const made = run('prepare');
  assert.equal(made.status, 0, made.stderr);
  const { root } = JSON.parse(made.stdout);
  try {
    const fixture = join(root, 'fixtures/catalog/testext');
    const manifest = JSON.parse(readFileSync(join(fixture, 'manifest.json'), 'utf8'));
    assert.equal(manifest.name, 'testext');
    assert.equal(manifest.login_required, true);
    assert.equal(manifest.auth.entry, 'bin/login.mjs');
    assert.ok(manifest.files.includes(manifest.auth.entry));
    const digest = createHash('sha256');
    for (const file of manifest.files) {
      const name = Buffer.from(file);
      const bytes = readFileSync(join(fixture, file));
      digest.update(`f${name.length}:`).update(name).update(`:${bytes.length}:`).update(bytes);
    }
    assert.equal(readFileSync(join(fixture, 'digest'), 'utf8').trim(), digest.digest('hex'));
  } finally {
    const cleaned = run('cleanup', root);
    assert.equal(cleaned.status, 0, cleaned.stderr);
  }
});

test('소유권 불일치 또는 미확인 데몬은 정리를 막고 영수증을 보존한다', () => {
  const made = run('prepare'); assert.equal(made.status, 0, made.stderr);
  const root = JSON.parse(made.stdout).root, path = join(root, 'ownership.json');
  const original = readFileSync(path, 'utf8'), receipt = JSON.parse(original);
  try {
    receipt.volume = 'second-brain-pg'; writeFileSync(path, JSON.stringify(receipt));
    assert.notEqual(run('cleanup', root).status, 0); assert.ok(existsSync(path));
    writeFileSync(path, original); writeFileSync(join(root, 'daemon.pid'), '1');
    assert.notEqual(run('cleanup', root).status, 0); assert.ok(existsSync(path));
    rmSync(join(root, 'daemon.pid'));
    receipt.volume = JSON.parse(original).volume; receipt.phase = 'starting';
    writeFileSync(path, JSON.stringify(receipt));
    assert.equal(run('cleanup', root).status, 0); assert.equal(existsSync(root), false);
  } finally { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); }
});
