import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./run.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
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
