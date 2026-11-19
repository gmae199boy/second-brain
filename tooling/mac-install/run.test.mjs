import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { prepare } from './run.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./run.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
test('심볼릭 링크 CLI 진입으로 준비와 정리를 수행한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-cli-link-'));
  const link = join(dir, 'run.mjs');
  const tempLink = join(dir, 'tmp-link');
  let root;
  try {
    symlinkSync(script, link);
    symlinkSync(realpathSync(tmpdir()), tempLink);
    const made = spawnSync(process.execPath, [link, 'prepare'], { encoding: 'utf8', env: { ...process.env, TMPDIR: tempLink } });
    assert.equal(made.status, 0, made.stderr);
    root = JSON.parse(made.stdout).root;
    assert.equal(root, realpathSync(root));
    assert.equal(realpathSync(join(root, '..')), realpathSync(tmpdir()));
    const cleaned = spawnSync(process.execPath, [link, 'cleanup', root], { encoding: 'utf8' });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(existsSync(root), false);
  } finally { if (root && existsSync(root)) rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
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


test('prepare 실패는 자기 디렉터리만 정리하고 원인을 보존한다', () => {
  let root;
  assert.throws(() => prepare({ afterCreate(path) { root = path; throw new Error('injected failure'); } }), /injected failure/);
  assert.equal(existsSync(root), false);
});

test('prepare 실패에서 대체 경로와 완성 영수증을 보존하고 정리 실패를 알린다', () => {
  const outside = mkdtempSync(join(tmpdir(), 'brain-outside-'));
  let root, moved;
  try {
    assert.throws(() => prepare({ afterCreate(path) {
      root = path; moved = path + '-moved'; renameSync(path, moved); symlinkSync(outside, path);
      throw new Error('replacement failure');
    } }), /replacement failure.*정리 실패/);
    assert.ok(existsSync(outside)); assert.ok(existsSync(moved));
  } finally { if (root) rmSync(root, { force: true }); if (moved) rmSync(moved, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  root = undefined;
  try {
    assert.throws(() => prepare({ afterReceipt(path) { root = path; throw new Error('after receipt'); } }), /after receipt.*정리 실패/);
    assert.ok(existsSync(join(root, 'ownership.json')));
  } finally { if (root) rmSync(root, { recursive: true, force: true }); }
});

test('구 형식 영수증은 정리 가능하고 verify는 카탈로그 사용 전에 거절한다', () => {
  const made = run('prepare'); assert.equal(made.status, 0, made.stderr);
  const root = JSON.parse(made.stdout).root, receiptPath = join(root, 'ownership.json');
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); receipt.phase = 'installed';
    writeFileSync(receiptPath, JSON.stringify(receipt));
    rmSync(join(root, 'fixtures/catalog/testext'), { recursive: true });
    mkdirSync(join(root, 'brain-home/extensions'));
    const doctor = run('doctor', root);
    assert.match(doctor.stderr, /확장이 없는 설치 홈/);
    rmSync(join(root, 'brain-home/extensions'), { recursive: true });
    const result = run('verify', root);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /다시 준비/);
    assert.equal(existsSync(join(root, 'daemon.pid')), false);
    assert.ok(existsSync(receiptPath));
    assert.equal(run('cleanup', root).status, 0);
  } finally { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); }
});

test('생성 패키지는 제품 검증기를 통과하고 변경된 파일은 거절된다', async t => {
  const dist = fileURLToPath(new URL('../../apps/cli/dist/runtime/extension-package.js', import.meta.url));
  if (!existsSync(dist)) { t.skip('제품 CLI dist 빌드 필요'); return; }
  const { prepareExtensionPackage } = await import(new URL('../../apps/cli/dist/runtime/extension-package.js', import.meta.url));
  const made = run('prepare'); assert.equal(made.status, 0, made.stderr);
  const root = JSON.parse(made.stdout).root, fixture = join(root, 'fixtures/catalog/testext');
  try {
    const prepared = await prepareExtensionPackage(fixture);
    try { assert.equal(prepared.digest, readFileSync(join(fixture, 'digest'), 'utf8').trim()); } finally { await prepared.cleanup(); }
    writeFileSync(join(fixture, 'bin/login.mjs'), 'tampered');
    await assert.rejects(prepareExtensionPackage(fixture), /digest mismatch/);
  } finally { assert.equal(run('cleanup', root).status, 0); }
});

test('생성 로그인 엔트리는 ready 전 LOGIN_REQUIRED를 반환하고 이후 성공한다', () => {
  const made = run('prepare'); assert.equal(made.status, 0, made.stderr);
  const root = JSON.parse(made.stdout).root, fixture = join(root, 'fixtures/catalog/testext');
  try {
    const manifest = JSON.parse(readFileSync(join(fixture, 'manifest.json'), 'utf8'));
    const token = join(root, 'synthetic-tokenstore');
    const env = { ...process.env, BRAIN_SETTINGS_SNAPSHOT: JSON.stringify({ values: { 'testext.tokenstore': token } }) };
    const login = () => { const result = spawnSync(process.execPath, [join(fixture, manifest.auth.entry)], { env, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
    assert.equal(login().code, 'LOGIN_REQUIRED');
    mkdirSync(token, { recursive: true }); writeFileSync(join(token, 'ready'), 'ready');
    assert.deepEqual(login(), { abi: 1, type: 'result' });
  } finally { assert.equal(run('cleanup', root).status, 0); }
});


test('verify 사전 검사는 외부 심볼릭 링크와 FIFO를 읽지 않는다', () => {
  const made = run('prepare'); assert.equal(made.status, 0, made.stderr);
  const root = JSON.parse(made.stdout).root, receiptPath = join(root, 'ownership.json');
  const external = mkdtempSync(join(tmpdir(), 'brain-external-'));
  const fixture = join(root, 'fixtures/catalog/testext');
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); receipt.phase = 'installed';
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const reject = () => {
      const result = spawnSync(process.execPath, [script, 'verify', root], { encoding: 'utf8', timeout: 3000 });
      assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
      assert.match(result.stderr, /다시 준비/); assert.equal(existsSync(join(root, 'daemon.pid')), false);
    };
    renameSync(fixture, fixture + '.saved'); symlinkSync(external, fixture);
    try { reject(); } finally { rmSync(fixture); renameSync(fixture + '.saved', fixture); }
    const manifest = join(fixture, 'manifest.json');
    renameSync(manifest, manifest + '.saved'); symlinkSync(join(external, 'manifest.json'), manifest);
    try { reject(); } finally { rmSync(manifest); renameSync(manifest + '.saved', manifest); }
    const digest = join(fixture, 'digest');
    renameSync(digest, digest + '.saved');
    try {
      const fifo = spawnSync('mkfifo', [digest], { encoding: 'utf8' }); assert.equal(fifo.status, 0, fifo.stderr);
      reject();
    } finally { rmSync(digest, { force: true }); renameSync(digest + '.saved', digest); }
    assert.ok(existsSync(receiptPath));
  } finally { assert.equal(run('cleanup', root).status, 0); rmSync(external, { recursive: true, force: true }); }
});
