import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sqliteStore } from 'second_brain';
import { sampleEnsureSessionInput, sampleIngestBatch, sampleSelfUserInput } from 'second_brain/testing';
import { SECRET_PATTERN_VERSION } from 'second_brain';
import { DatabaseSync } from 'node:sqlite';
import { withoutHarnessFolders } from './environment.js';
import { assertKoreanLines } from './language.js';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const install = fileURLToPath(new URL('../dist/install.js', import.meta.url));
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });
async function home() {
  const path = await mkdtemp(join(tmpdir(), 'brain-cli-redact-'));
  homes.push(path);
  return path;
}
function run(home: string, args: string[], script = bin): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = withoutHarnessFolders({ ...process.env, SECOND_BRAIN_HOME: home });
  delete env.SECOND_BRAIN_DATABASE_URL;
  delete env.BRAIN_TEST_DATABASE_URL;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function seed(body: string, target: string) {
  const path = await home();
  const installed = await run(path, ['--yes'], install);
  expect(installed.code, installed.stdout + installed.stderr).toBe(0);
  const store = sqliteStore({ path: join(path, 'brain.db') });
  // The installer already made the self user; ensure keeps its id.
  const owner = await store.ensureSelfUser(sampleSelfUserInput());
  if (!owner.ok) throw new Error(owner.message);
  await store.ensureSession(sampleEnsureSessionInput({ userId: owner.user.id }));
  const batch = sampleIngestBatch();
  const message = batch.messages[0]!;
  await store.ingest({ ...batch, messages: [{ ...message, body }], toolNotes: [
    { ...batch.toolNotes[0]!, harnessMessageId: message.harnessMessageId, target },
  ] });
  await store.close();
  return { path, message: message.id };
}

describe('brain messages redact', () => {
  it('validates and gates before configuration or database access, without a prompt', async () => {
    const path = await home();
    const message = sampleIngestBatch().messages[0]!.id;
    const call = ['messages', 'redact', message, '--detected'];
    const gated = await run(path, [...call, '--json']);
    expect(gated.code).toBe(3);
    const envelope = JSON.parse(gated.stdout);
    expect(envelope.error).toMatchObject({ code: 'CONFIRMATION_REQUIRED', retry: {
      ns: 'messages', verb: 'redact', args: { message, detected: true, confirm: true },
    } });
    expect(envelope.error.retry_argv).toContain('--yes');
    expect(envelope.error.retry_argv).toContain('--json');
    expect(await readFile(join(path, 'brain.db')).catch(() => null)).toBe(null);
    const text = await run(path, call);
    expect(text.code).toBe(3);
    expect(text.stderr).toContain('다시 하려면: brain messages redact');
    assertKoreanLines(text.stderr, { allow: ['brain messages redact'] });
    for (const flags of [[], ['--text', 'x', '--detected'], ['--kind', 'manual'], ['--text', 'x', '--kind', 'Db-Pw'], ['--text', '']]) {
      const bad = await run(path, ['messages', 'redact', message, ...flags, '--json']);
      expect(bad.code).toBe(2);
      expect(JSON.parse(bad.stdout).error.code).toBe('USAGE');
    }
    const masked = await run(path, ['messages', 'redact', message, '--text', 'sk-abcdefghijklmnopqrstuvwx', '--json']);
    expect(masked.code).toBe(3);
    expect(masked.stdout).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(JSON.parse(masked.stdout).error.retry).toBeUndefined();
  });
  it('replaces literal matches with custom kind, reports counts, and returns missing codes', async () => {
    const secret = 'hunter2-x';
    const f = await seed(`${secret} ${secret}`, `${secret} ${secret}`);
    const before = await readFile(join(f.path, 'brain.db'));
    expect((await run(f.path, ['messages', 'redact', f.message, '--detected', '--json'])).code).toBe(3);
    expect(await readFile(join(f.path, 'brain.db'))).toEqual(before);
    const result = await run(f.path, ['messages', 'redact', f.message, '--text', secret, '--kind', 'db_password', '--yes', '--json']);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(JSON.parse(result.stdout).data).toEqual({ message_id: f.message, body_spans: 2,
      tool_note_spans: 2, tool_notes_changed: 1, chunks_removed: 0, pattern_version: null });
    const db = new DatabaseSync(join(f.path, 'brain.db'));
    try {
      expect(db.prepare('select body from messages').get()).toEqual({ body: '[REDACTED:db_password] [REDACTED:db_password]' });
      expect(db.prepare('select count(*) as n from redactions').get()).toEqual({ n: 4 });
    } finally { db.close(); }
    const absent = await run(f.path, ['messages', 'redact', f.message, '--text', secret, '--yes', '--json']);
    expect(absent.code).toBe(1);
    expect(JSON.parse(absent.stdout).error.code).toBe('REDACT_TEXT_NOT_FOUND');
    const missing = await run(f.path, ['messages', 'redact', '01940000-0000-7000-8000-999999999999', '--detected', '--yes', '--json']);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).error).toMatchObject({ code: 'MESSAGE_NOT_FOUND', retryable: false });
  });
  it('detects body and tool target secrets and prints Korean counts', async () => {
    const f = await seed('api_key=sk-abcdefghijklmnopqrstuvwx', 'TOKEN=hunter2-x');
    const result = await run(f.path, ['messages', 'redact', f.message, '--detected', '--yes']);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    assertKoreanLines(result.stdout);
    expect(result.stdout).toContain('본문 1곳');
    const db = new DatabaseSync(join(f.path, 'brain.db'));
    try {
      expect(db.prepare('select pattern_version from redactions').all()).toEqual([
        { pattern_version: SECRET_PATTERN_VERSION }, { pattern_version: SECRET_PATTERN_VERSION },
      ]);
    } finally { db.close(); }
    const again = await run(f.path, ['messages', 'redact', f.message, '--detected', '--yes', '--json']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout).data).toMatchObject({ body_spans: 0, tool_note_spans: 0 });
  });
});
