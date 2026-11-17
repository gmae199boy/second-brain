import { spawn } from 'node:child_process';
import { copyFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createIsolatedTestDatabase } from '@second-brain/test-db';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';
import { PgTestClient } from './pg-client.js';
import { pgHome } from './pg-home.js';
import { tempHomes } from './temp-home.js';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const claudeFixture = fileURLToPath(new URL('../../../packages/claude-code/test/fixtures/two-turns.jsonl', import.meta.url));
const homes = tempHomes();
afterEach(() => homes.cleanup());

function invoke(home: string, args: string[], stdin = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = withoutHarnessFolders({ ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, [HOME_ENV]: home, HOME: home, XDG_CONFIG_HOME: join(home, 'xdg') });
  delete env.SECOND_BRAIN_DATABASE_URL;
  delete env.BRAIN_TEST_DATABASE_URL;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

type Envelope = { ok: boolean; warnings: string[]; data: any; error?: { code: string } };
async function ingest(home: string, harness: string, input: object): Promise<Envelope> {
  const result = await invoke(home, ['sessions', 'ingest', harness, '--json'], JSON.stringify(input));
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as Envelope;
}
async function expectIngestFailure(home: string, input: object, code: string): Promise<void> {
  const result = await invoke(home, ['sessions', 'ingest', 'codex', '--json'], JSON.stringify(input));
  expect(result.code).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(code);
  expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
}
async function read(home: string, token: string): Promise<Envelope> {
  const result = await invoke(home, ['sessions', 'read', token, '--json']);
  expect(result.code).toBe(0);
  const envelope = JSON.parse(result.stdout) as Envelope;
  expect(envelope.ok).toBe(true);
  return envelope;
}
async function counts(home: string): Promise<Record<string, number>> {
  const db = new PgTestClient(home);
  try {
    const tables = await db.prepare("select tablename from pg_tables where schemaname='brain' order by tablename").all();
    const result: Record<string, number> = {};
    for (const table of tables) {
      const name = String(table.tablename);
      // Table names come from pg_catalog and are still quoted as identifiers.
      const row = await db.prepare(`select count(*) as n from "${name.replaceAll('"', '""')}"`).get();
      result[name] = row!.n as number;
    }
    return result;
  } finally { await db.close(); }
}
const line = (value: unknown) => JSON.stringify(value) + '\n';
const meta = (id: string, cwd: string) => ({ type: 'session_meta', payload: { id, session_id: 'shared-parent', cwd } });
const message = (role: string, text: string, second: number) => ({ timestamp: `2026-01-01T00:00:0${second}Z`, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const item = (type: string, data: object) => ({ type: 'response_item', payload: { type, ...data } });

async function claudeSnapshot(home: string): Promise<unknown> {
  const db = new PgTestClient(home);
  try {
    const session = await db.prepare("select id, harness_session_id, first_cwd, workspace_id, project_id, worktree_id, tag_source, parser_version from sessions where harness='claude-code'").get();
    if (!session) throw new Error('missing Claude session');
    const messages = await db.prepare('select role, body, harness_message_id from messages where session_id=$1 order by occurred_at, id').all(session.id);
    const notes = await db.prepare('select harness_message_id, ordinal, tool, target, ok from tool_notes where session_id=$1 order by harness_message_id, ordinal').all(session.id);
    return { session, messages, notes };
  } finally { await db.close(); }
}

describe('Codex explicit file to PostgreSQL and sessions read', () => {
  it('keeps parent and child separate and idempotent while preserving Claude rows and tags', async () => {
    const home = await homes.create('brain-codex-tracer-');
    await pgHome(home, true, createIsolatedTestDatabase);
    const claudePath = join(home, 'claude.jsonl');
    await copyFile(claudeFixture, claudePath);
    const claudeId = 'synthetic-claude-id';
    expect(await ingest(home, 'claude-code', { session_id: claudeId, transcript_path: claudePath })).toMatchObject({ ok: true, data: { inserted: { messages: 4, toolNotes: 1 } } });
    const claudeBefore = await claudeSnapshot(home) as { messages: { body: string }[]; notes: unknown[] };
    expect(claudeBefore.messages.map(m => m.body)).toEqual(['Where did we leave the import notes?', 'They are in notes/import.md.\nI added the open question at the end.', 'Good. Write that down as a decision.', "Written down, with today's date."]);
    expect(claudeBefore.notes).toHaveLength(1);

    const parentPath = join(home, 'parent.jsonl'), childPath = join(home, 'child.jsonl');
    const parent = line(meta('parent-file', home)) + line(message('user', '부모 원문', 1)) + line({ type: 'event_msg', payload: { type: 'user_message', message: '부모 원문' } }) + line(item('function_call', { call_id: 'call-one', name: 'shell', arguments: '{"cmd":"one"}' })) + line(item('function_call_output', { call_id: 'call-one', output: 'Chunk ID: synthetic123\nWall time: 0.2 seconds\nProcess exited with code 0\nFinal output:\ndone' })) + line(item('custom_tool_call', { call_id: 'call-two', name: 'edit', input: 'synthetic patch' })) + line(item('custom_tool_call_output', { call_id: 'call-two', output: { is_error: true } })) + line(message('assistant', '부모 응답', 2));
    const child = line(meta('child-file', home)) + line(message('user', '자식 원문', 3)) + line(message('assistant', '자식 응답', 4));
    await writeFile(parentPath, parent); await writeFile(childPath, child);
    const inputs = [{ id: 'parent-file', transcript_path: parentPath }, { id: 'child-file', transcript_path: childPath }];
    for (const input of inputs) expect(await ingest(home, 'codex', input)).toMatchObject({ ok: true, data: { created: true, spooled: false } });
    const before = await counts(home);
    for (const input of inputs) expect(await ingest(home, 'codex', input)).toMatchObject({ ok: true, data: { created: false, inserted: { messages: 0, toolNotes: 0 } } });
    expect(await counts(home)).toEqual(before);

    const db = new PgTestClient(home);
    try {
      const sessions = await db.prepare("select harness_session_id, parser_version, last_harness_message_id, cursor_fingerprint from sessions where harness='codex' order by harness_session_id").all();
      expect(sessions.map(s => s.harness_session_id)).toEqual(['child-file', 'parent-file']);
      for (const s of sessions) { expect(s.parser_version).toBe('codex-v1'); expect(s.last_harness_message_id).toBeTruthy(); expect(s.cursor_fingerprint).toBeTruthy(); }
      expect(await db.prepare("select call_id, tool, target, ok from tool_notes where session_id=(select id from sessions where harness='codex' and harness_session_id='parent-file') order by ordinal").all()).toEqual([{ call_id: 'call-one', tool: 'shell', target: '{"cmd":"one"}', ok: 1 }, { call_id: 'call-two', tool: 'edit', target: 'synthetic patch', ok: 0 }]);
    } finally { await db.close(); }
    const parentRead = await read(home, 'codex:parent-file');
    expect(parentRead.data.map((row: { kind: string; body: string }) => [row.kind, row.body])).toEqual([['message', '부모 원문'], ['tool', '{"cmd":"one"}'], ['tool', 'synthetic patch'], ['message', '부모 응답']]);
    expect((await read(home, 'codex:child-file')).data.map((row: { body: string }) => row.body)).toEqual(['자식 원문', '자식 응답']);
    expect(await claudeSnapshot(home)).toEqual(claudeBefore);
    expect((await read(home, `claude-code:${claudeId}`)).data.filter((row: { kind: string }) => row.kind === 'message').map((row: { body: string }) => row.body)).toEqual(claudeBefore.messages.map(m => m.body));
  });

  it('rejects bad identity without any DB changes, then completes a partial tail and a late tool result', async () => {
    const home = await homes.create('brain-codex-incremental-');
    await pgHome(home, true, createIsolatedTestDatabase);
    const path = join(home, 'explicit.jsonl');
    const start = line(meta('file-id', home)) + line(message('user', '첫 메시지', 1)) + line(item('function_call', { call_id: 'late', name: 'shell', arguments: 'pending' })) + line(message('assistant', '이어진 메시지', 2));
    const output = line(item('function_call_output', { call_id: 'late', output: 'Chunk ID: synthetic123\nWall time: 0.2 seconds\nProcess exited with code 0\nFinal output:\ndone' }));
    const tail = JSON.stringify(message('user', '완성된 메시지', 3));
    await writeFile(path, start + tail);
    const empty = await counts(home);
    await expectIngestFailure(home, { id: 'wrong-id', transcript_path: path }, 'TRANSCRIPT_UNREADABLE');
    expect(await counts(home)).toEqual(empty);
    for (const invalid of [line({ type: 'session_meta', payload: { session_id: 'shared-parent' } }), line(meta('', home)), line(meta('file-id', home)) + line(meta('other-id', home))]) {
      await writeFile(path, invalid + line(message('user', '거부', 1)));
      await expectIngestFailure(home, { id: 'file-id', transcript_path: path }, 'TRANSCRIPT_UNREADABLE');
      expect(await counts(home)).toEqual(empty);
    }
    await writeFile(path, start + tail);
    expect(await ingest(home, 'codex', { id: 'file-id', transcript_path: path })).toMatchObject({ ok: true, data: { inserted: { messages: 2, toolNotes: 0 } } });
    expect((await read(home, 'codex:file-id')).data.map((row: { body: string }) => row.body)).toEqual(['첫 메시지', '이어진 메시지']);
    await writeFile(path, start + output + tail + '\n');
    expect(await ingest(home, 'codex', { id: 'file-id', transcript_path: path })).toMatchObject({ ok: true, data: { inserted: { messages: 1, toolNotes: 1 } } });
    expect((await read(home, 'codex:file-id')).data.map((row: { body: string }) => row.body)).toEqual(['첫 메시지', 'pending', '이어진 메시지', '완성된 메시지']);
    const stable = await counts(home);
    expect(await ingest(home, 'codex', { id: 'file-id', transcript_path: path })).toMatchObject({ ok: true, data: { inserted: { messages: 0, toolNotes: 0 } } });
    expect(await counts(home)).toEqual(stable);
  });
});
