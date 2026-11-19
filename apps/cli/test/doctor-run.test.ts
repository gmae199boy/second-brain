import { postgresStore } from 'second_brain/postgres';
import { sequenceIdGen } from '../../../packages/core/src/testing/fakes/id-gen.js';
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePgHome, pgRunner, runPgCommand, pgDatabaseUrl } from './pg-home.js';
import { PgTestClient } from './pg-client.js';
import { tempHomes } from './temp-home.js';
import { withoutHarnessFolders } from './environment.js';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';
import { assertKoreanLines } from './language.js';
import { writeShim } from '../src/install/shim.js';
import { writeConfig } from '../src/config/codec.js';
const temporary = tempHomes();
afterEach(() => temporary.cleanup());
async function world() {
  const home = await temporary.create('brain-doctor-'); await preparePgHome(home);
  const env = withoutHarnessFolders({ ...process.env, SECOND_BRAIN_HOME: home }); delete env.BRAIN_DATABASE_URL; delete env.DOCKER_HOST;
  return { home, env, run: (args = ['doctor', 'run', '--json']) => runPgCommand(args, env) };
}
describe('PG doctor', () => {
  it('reports PG checks and no SQLite file checks when the store table is absent', async () => {
    const kit = await world();
    await writeFile(join(kit.home, 'config.toml'), 'schema_version=1\n');
    // world() removes the inherited process URL; the isolated home's .env supplies the test DB.
    expect(kit.env).not.toHaveProperty('BRAIN_DATABASE_URL');
    const result = await kit.run();
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    for (const id of ['orbstack', 'container', 'db', 'writable', 'pg_trgm', 'schema-version']) {
      expect(envelope.data.checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
    }
    const ids = envelope.data.checks.map((check: { id: string }) => check.id);
    for (const id of ['db-path', 'db-file', 'store-path', 'wal', 'fts5-trigram', 'foreign-keys']) {
      expect(ids).not.toContain(id);
    }
  });

  it('reports PG prerequisites and adapter checks, with no SQLite file checks', async () => {
    const kit = await world(); const result = await kit.run(); expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    for (const id of ['orbstack', 'container', 'db', 'writable', 'pg_trgm', 'schema-version']) expect(envelope.data.checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
    for (const id of ['wal', 'foreign-keys', 'fts5-trigram']) expect(envelope.data.checks.map((c: { id: string }) => c.id)).not.toContain(id);
    expect(envelope.data.checks).toContainEqual(expect.objectContaining({ id: 'daemon', status: 'warn' }));
    expect(envelope.data.summary.failed).toBe(0);
  });
  it('prints Korean checks and a summary in text mode', async () => {
    const result = await (await world()).run(['doctor', 'run']); expect(result.code).toBe(0); assertKoreanLines(result.stdout, { allow: ['Debian', 'pgdg13'] });
  });
  it('warns on unknown configuration keys without dropping healthy checks', async () => {
    const kit = await world(); await appendFile(join(kit.home, 'config.toml'), '\n[custom]\ncolour="blue"\n');
    const result = await kit.run(); expect(result.code).toBe(0); expect(JSON.parse(result.stdout).warnings).toContain('CONFIG_UNKNOWN_KEY');
  });
  it('warns on ignored file timezone in every PG home', async () => {
    const kit = await world(); await writeFile(join(kit.home, 'config.toml'), 'schema_version=1\ntimezone="Europe/Berlin"\n');
    const result = await kit.run(); expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.checks).toContainEqual(expect.objectContaining({ id: 'config-timezone', status: 'warn' }));
  });
  it('reports an unavailable database without creating a local file', async () => {
    const home = await temporary.create('brain-doctor-');
    expect((await writeConfig(home, {})).ok).toBe(true);
    await writeShim(home, { bin: fileURLToPath(new URL('../dist/bin.js', import.meta.url)) });
    const env = withoutHarnessFolders({ ...process.env, SECOND_BRAIN_HOME: home, BRAIN_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unavailable' });
    delete env.DOCKER_HOST;
    const result = await runPgCommand(['doctor', 'run', '--json'], env); expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).data.checks).toContainEqual(expect.objectContaining({ id: 'db', status: 'fail', code: 'DB_UNAVAILABLE' }));
    for (const name of ['brain.db', 'brain.db-wal', 'brain.db-shm']) {
      expect(await readdir(home)).not.toContain(name);
    }
  });
  it('reports owner-specific schema mismatch', async () => {
    const kit = await world(); const db = new PgTestClient(pgDatabaseUrl(kit.home));
    try { await db.exec("update schema_migrations set version = version + 1 where owner=$$core$$ and version=(select max(version) from brain.schema_migrations where owner=$$core$$)"); const result = await kit.run(); expect(result.code).toBe(1); expect(JSON.parse(result.stdout).data.checks).toContainEqual(expect.objectContaining({ id: 'schema-version', status: 'fail' })); }
    finally { await db.close(); }
  });
  it('skips DB checks when the fake OrbStack prerequisite fails and never calls compose', async () => {
    const kit = await world(); let stdout = ''; const calls: string[] = [];
    const code = await dispatch(commands, ['doctor', 'run', '--json'], { env: kit.env, clock: { now: () => new Date() }, stdout: s => { stdout += s; }, runner: async request => { calls.push(request.command); return { ok: true, stdout: 'Stopped', stderr: '' }; } });
    expect(code).toBe(1); expect(calls).toEqual(['orb']);
    expect(JSON.parse(stdout).data.checks).toContainEqual({ id: 'db', status: 'skip', detail: '앞선 점검 실패: orbstack' });
    expect(JSON.parse(stdout).data.checks).toContainEqual({ id: 'codex-transcripts', status: 'skip', detail: '앞선 점검 실패: orbstack' });
  });
  it('reports a spool entry and keeps healthy DB checks', async () => {
    const kit = await world(); await mkdir(join(kit.home, 'spool')); await writeFile(join(kit.home, 'spool', 'invalid.jsonl'), 'invalid\n');
    const result = await kit.run();
    expect(result.code).toBe(0);
    const checks = JSON.parse(result.stdout).data.checks;
    expect(checks).toContainEqual({ id: 'spool', status: 'warn', code: 'SPOOLED', detail: '1건' });
    for (const id of ['db', 'writable', 'pg_trgm', 'schema-version']) {
      expect(checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
    }
  });
});

describe('brain doctor run without a configuration it can read', () => {
  async function emptyHome() {
    const home = await temporary.create('brain-doctor-no-config-');
    const env = withoutHarnessFolders({ ...process.env, SECOND_BRAIN_HOME: home });
    delete env.DOCKER_HOST;
    return { home, run: (args = ['doctor', 'run', '--json']) => runPgCommand(args, env) };
  }

  it('exits 1, not 2, and reports config and db as failures when there is no file', async () => {
    const kit = await emptyHome();
    await writeShim(kit.home, { bin: fileURLToPath(new URL('../dist/bin.js', import.meta.url)) });

    const run = await kit.run();

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeUndefined();
    const checks = envelope.data.checks;
    expect(checks).toContainEqual(expect.objectContaining({ id: 'config', status: 'fail', code: 'CONFIG_MISSING' }));
    expect(checks).toContainEqual(expect.objectContaining({ id: 'db', status: 'fail', code: 'DB_UNAVAILABLE', detail: expect.stringContaining('설정을 읽을 수 없어서') }));
    for (const id of ['orbstack', 'container', 'shim', 'node-path', 'node-version']) {
      expect(checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
    }
    expect(checks.map((check: { id: string }) => check.id)).toEqual([
      'orbstack', 'container', 'db', 'schema-version', 'failures', 'untagged', 'transcripts', 'codex-transcripts', 'work-stalled', 'work-died', 'work-unknown', 'work-last-error', 'work-model-usage', 'extensions',
      'codex-folders', 'config', 'config-timezone', 'shim', 'node-path', 'node-version', 'plugin', 'last-hook', 'spool', 'drive-refresh-lock', 'garmin-backlog', 'daemon', 'agent-codex-path', 'agent-claude-path',
    ]);
    expect(checks).toContainEqual({ id: 'schema-version', status: 'skip', detail: '앞선 점검 실패: db' });
    expect(envelope.warnings).toEqual(['DB_UNAVAILABLE']);
  });

  it('reports CONFIG_INVALID the same way for a file it cannot understand', async () => {
    const kit = await emptyHome();
    await writeShim(kit.home, { bin: fileURLToPath(new URL('../dist/bin.js', import.meta.url)) });
    // store.path is retired; a relative files.path still makes the configuration invalid.
    await writeFile(join(kit.home, 'config.toml'), 'schema_version=1\n[files]\npath="relative/files"\n');

    const run = await kit.run();

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeUndefined();
    const checks = envelope.data.checks;
    expect(checks).toContainEqual(expect.objectContaining({ id: 'config', status: 'fail', code: 'CONFIG_INVALID' }));
    expect(checks).toContainEqual(expect.objectContaining({ id: 'db', status: 'fail', code: 'DB_UNAVAILABLE' }));
    for (const id of ['orbstack', 'container', 'shim']) {
      expect(checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
    }
  });

  it('prints the failing checks, and no error line, in text mode', async () => {
    const kit = await emptyHome();

    const run = await kit.run(['doctor', 'run']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('orbstack: ok');
    expect(run.stdout).toContain('container: ok');
    expect(run.stdout).toContain('config: fail [CONFIG_MISSING]');
    expect(run.stdout).toContain('db: fail [DB_UNAVAILABLE]');
    expect(run.stdout).toContain('shim: fail');
    expect(run.stdout).toContain('schema-version: skip 앞선 점검 실패: db');
    expect(run.stdout).toContain('node-path: skip 앞선 점검 실패: shim');
    expect(run.stdout).toContain('spool: ok 0건');
    expect(run.stdout.trimEnd().split('\n').at(-1)).toBe('요약: 통과 9, 경고 3, 실패 3, 건너뜀 13');
    expect(run.stderr).not.toContain('CONFIG_MISSING');
    assertKoreanLines(run.stdout);
  });
});

it('shows stalled, died, unknown and last error from PostgreSQL in doctor JSON', async () => {
  const kit = await world(), store = postgresStore({ databaseUrl: pgDatabaseUrl(kit.home) });
  const now = new Date(), idGen = sequenceIdGen({ timestampMs: now.getTime() });
  const ids: Record<string, string> = {};
  try {
    for (const outcome of ['stalled', 'died', 'unknown', 'failed'] as const) {
      const id = idGen.next(), token = idGen.next(); ids[outcome] = id;
      await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: outcome, createdAt: now, nextAttemptAt: now });
      expect(await store.claimSupervisedWork({ now, claimedBy: idGen.next(), kinds: ['process_probe'], attemptToken: token })).toMatchObject({ ok: true, item: { id } });
      if (outcome === 'unknown') await store.settleSupervisedAttempt({ id, attemptToken: token, now, outcome });
      else await store.finishSupervisedWork({ id, attemptToken: token, now, outcome, nextAttemptAt: new Date(now.getTime() + 900_000), lastError: '마지막 오류', ...(outcome === 'failed' ? { errorCode: 'TEMPORARY', errorRetryable: true } : {}) });
    }
    const result = await kit.run(); expect(result.code).toBe(0);
    const checks = JSON.parse(result.stdout).data.checks;
    for (const outcome of ['stalled', 'died', 'unknown', 'failed']) expect(checks).toContainEqual(expect.objectContaining({
      id: outcome === 'failed' ? 'work-last-error' : `work-${outcome}`, status: 'warn', detail: expect.stringContaining(ids[outcome]!),
    }));
    kit.env.BRAIN_DATABASE_URL = 'postgresql://unused@127.0.0.1:1/unavailable';
    const unavailable = JSON.parse((await kit.run()).stdout).data.checks;
    for (const id of ['work-stalled', 'work-died', 'work-unknown', 'work-last-error']) expect(unavailable).toContainEqual({ id, status: 'skip', detail: '앞선 점검 실패: db' });
  } finally { await store.close(); }
});

it.each(['json', 'text'])('reports isolated Codex discovery and uncollected count in %s', async mode => {
  const kit = await world();
  const codex = join(kit.home, 'synthetic-codex');
  await mkdir(join(codex, 'sessions'), { recursive: true });
  await writeFile(join(codex, 'sessions', 'sample.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic' } }) + '\n');
  kit.env.CODEX_HOME = codex;
  const result = await kit.run(mode === 'json' ? ['doctor', 'run', '--json'] : ['doctor', 'run']);
  expect(result.code).toBe(0);
  if (mode === 'json') {
    const checks = JSON.parse(result.stdout).data.checks;
    expect(checks).toContainEqual(expect.objectContaining({ id: 'codex-folders', detail: expect.stringContaining('Codex 폴더 발견') }));
    expect(checks).toContainEqual(expect.objectContaining({ id: 'codex-transcripts', detail: expect.stringContaining('미수집 1건') }));
  } else {
    expect(result.stdout).toContain('Codex 폴더 발견');
    expect(result.stdout).toContain('미수집 1건');
    expect(result.stdout).toContain('자동 hook/notify 연결은 없습니다');
  }
});

it.each(['json', 'text'])('reports excluded Codex metadata safely in %s', async mode => {
  const kit = await world();
  const codex = join(kit.home, 'synthetic-codex');
  await mkdir(join(codex, 'sessions'), { recursive: true });
  const meta = (id: string) => JSON.stringify({type: 'session_meta', payload: {id}}) + '\n';
  await writeFile(join(codex, 'sessions', 'valid.jsonl'), meta('valid-synthetic'));
  await writeFile(join(codex, 'sessions', 'private-path.jsonl'), meta('private-id-one') + meta('private-id-two') + JSON.stringify({body: 'private-synthetic-body'}) + '\n');
  kit.env.CODEX_HOME = codex;
  const result = await kit.run(mode === 'json' ? ['doctor', 'run', '--json'] : ['doctor', 'run']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('미수집 1건'); expect(result.stdout).toContain('제외 1건');
  for (const secret of ['private-id-one', 'private-id-two', 'private-path.jsonl', codex, 'private-synthetic-body']) expect(result.stdout).not.toContain(secret);
  if (mode === 'json') {
    const check = JSON.parse(result.stdout).data.checks.find((item: {id: string}) => item.id === 'codex-transcripts');
    expect(check.status).toBe('warn'); expect(check.detail).toContain('brain queue drain');
  }
});

it('reports a Codex ID collision without a partial zero count or exposing the ID', async () => {
  const kit = await world();
  const codex = join(kit.home, 'synthetic-codex');
  await mkdir(join(codex, 'sessions'), { recursive: true });
  await mkdir(join(codex, 'archived_sessions'));
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'private-synthetic-id' } });
  await writeFile(join(codex, 'sessions', 'a.jsonl'), meta + '\n' + '{"a":1}\n');
  await writeFile(join(codex, 'archived_sessions', 'b.jsonl'), meta + '\n' + '{"a":2}\n');
  kit.env.CODEX_HOME = codex;
  const result = await kit.run();
  expect(result.code).toBe(0);
  const checks = JSON.parse(result.stdout).data.checks;
  expect(checks).toContainEqual(expect.objectContaining({ id: 'codex-transcripts', status: 'warn', detail: expect.stringContaining('Codex 목록 확인 불가') }));
  const detail = checks.find((item: {id: string}) => item.id === 'codex-transcripts').detail;
  expect(detail).toContain('미수집 확인 불가'); expect(detail).toContain('제외 확인 불가');
  expect(JSON.stringify(checks)).not.toContain('private-synthetic-id');
  const text = await kit.run(['doctor', 'run']);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain('Codex 목록 확인 불가');
  expect(text.stdout).toContain('미수집 확인 불가'); expect(text.stdout).toContain('제외 확인 불가');
  expect(text.stdout).not.toContain('private-synthetic-id');
});

it('reports absent Codex roots and DB skip in both public output modes', async () => {
  const kit = await world();
  kit.env.CODEX_HOME = join(kit.home, 'absent-codex');
  const json = await kit.run();
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout).data.checks).toContainEqual(expect.objectContaining({ id: 'codex-folders', detail: expect.stringContaining('미발견') }));
  const text = await kit.run(['doctor', 'run']);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain('Codex 폴더 미발견');
  expect(text.stdout).toContain('scan-only');
  kit.env.BRAIN_DATABASE_URL = 'postgresql://unused@127.0.0.1:1/unavailable';
  const unavailable = await kit.run();
  expect(unavailable.code).toBe(1);
  expect(JSON.parse(unavailable.stdout).data.checks).toContainEqual({ id: 'codex-transcripts', status: 'skip', detail: '앞선 점검 실패: db' });
  const unavailableText = await kit.run(['doctor', 'run']);
  expect(unavailableText.code).toBe(1);
  expect(unavailableText.stdout).toContain('codex-transcripts: skip');
});

it.each(['json', 'text'])('reports synthetic Codex success and open failure alongside Claude in %s', async mode => {
  const kit = await world();
  kit.env.CODEX_HOME = join(kit.home, 'synthetic-codex');
  await mkdir(join(kit.env.CODEX_HOME, 'sessions'), { recursive: true });
  const store = postgresStore({ databaseUrl: pgDatabaseUrl(kit.home) });
  const idGen = sequenceIdGen({ timestampMs: Date.now() });
  const now = new Date('2026-03-04T05:06:07.000Z');
  try {
    expect(await store.recordTranscriptFile({ id: idGen.next(), harness: 'codex', path: '/synthetic/completed.jsonl', sizeBytes: 1, fingerprint: 'sha256:synthetic', cursor: null, scannedAt: now, reset: false })).toMatchObject({ ok: true });
    for (const harness of ['codex', 'claude-code']) {
      expect(await store.recordFailure({ id: idGen.next(), targetKind: 'session', targetId: `${harness}:synthetic`, stage: 'session_ingest', fingerprint: 'sha256:synthetic', harness, sessionId: null, code: 'TRANSCRIPT_UNREADABLE', message: '합성 실패', occurredAt: now })).toMatchObject({ ok: true });
    }
    const result = await kit.run(mode === 'json' ? ['doctor', 'run', '--json'] : ['doctor', 'run']);
    expect(result.code).toBe(0);
    if (mode === 'json') {
      const checks = JSON.parse(result.stdout).data.checks;
      expect(checks).toContainEqual(expect.objectContaining({ id: 'failures', detail: expect.stringContaining('session 2건') }));
      const detail = checks.find((c: { id: string }) => c.id === 'codex-transcripts').detail;
      expect(detail).toContain('미해결 수집 실패 1건');
      expect(detail).toContain('2026-03-04T05:06:07.000Z');
      expect(detail).toContain('--target-kind session');
    } else {
      expect(result.stdout).toContain('미해결 수집 실패 1건');
      expect(result.stdout).toContain('2026-03-04T05:06:07.000Z');
      expect(result.stdout).toContain('Claude를 포함한 모든 세션 실패');
    }
  } finally { await store.close(); }
});

it('reports a file root as unknown in public doctor output', async () => {
  const kit = await world();
  const codex = join(kit.home, 'synthetic-codex');
  await mkdir(codex);
  await writeFile(join(codex, 'sessions'), 'not a directory');
  kit.env.CODEX_HOME = codex;
  const json = await kit.run();
  expect(json.code).toBe(0);
  const checks = JSON.parse(json.stdout).data.checks;
  expect(checks).toContainEqual(expect.objectContaining({ id: 'codex-folders', status: 'warn', detail: expect.stringContaining('확인 불가') }));
  expect(checks).toContainEqual(expect.objectContaining({ id: 'codex-transcripts', status: 'warn', detail: expect.stringContaining('미수집 확인 불가') }));
  const text = await kit.run(['doctor', 'run']);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain('Codex 폴더 확인 불가');
});
