import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planRedaction, SECRET_PATTERN_VERSION, type RedactionRequest } from '@second-brain/core';
import { sampleEnsureSessionInput, sampleIngestBatch, sampleSelfUserInput, sampleSessionToken } from '@second-brain/core/testing';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import { runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';
import { sqliteSessionStore } from '../src/sessions.js';

const dirs: string[] = [];
const connections: SqliteConnection[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
let sequence = 200;
const secret = 'hunter2-x-unmistakable';
async function fixture(body = `${secret} ${secret}`, target = `${secret} ${secret}`) {
  const dir = await mkdtemp(join(tmpdir(), 'brain-redact-'));
  dirs.push(dir);
  const path = join(dir, 'brain.db');
  expect((await runSqliteMigrations({ path })).ok).toBe(true);
  const store = sqliteStore({ path });
  await store.ensureSelfUser(sampleSelfUserInput());
  const ensured = await store.ensureSession(sampleEnsureSessionInput());
  if (!ensured.ok) throw new Error('ensure failed');
  const original = sampleIngestBatch();
  const message = original.messages[0]!;
  const batch = { ...original, messages: [{ ...message, body }],
    toolNotes: [{ ...original.toolNotes[0]!, harnessMessageId: message.harnessMessageId, target }] };
  expect((await store.ingest(batch)).ok).toBe(true);
  await store.close();
  const opened = openSqlite({ path, busyTimeoutMs: 30 });
  if (!opened.ok) throw new Error(opened.message);
  const connection = opened.connection;
  connections.push(connection);
  const sessions = sqliteSessionStore(() => ({ ok: true, connection }));
  const db = connection.database;
  db.prepare(`insert into chunks (id, session_id, index_config_id, from_at, to_at, body)
    select ?, ?, id, ?, ?, ? from index_configs where kind = 'chunk' limit 1`)
    .run('chunk-hit', ensured.session.id, message.occurredAt.toISOString(), message.occurredAt.toISOString(), secret);
  db.prepare(`insert into chunks (id, session_id, index_config_id, from_at, to_at, body)
    select ?, ?, id, ?, ?, ? from index_configs where kind = 'chunk' limit 1`)
    .run('chunk-kept', ensured.session.id, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'ordinary');
  const redact = (request: RedactionRequest = { mode: 'text', text: secret, kind: 'manual' }) => sessions.redactMessage({ messageId: message.id,
    plan: (current) => planRedaction(current, request, { now: () => new Date('2026-10-21T00:00:00.000Z'),
      newId: () => `01940000-0000-7000-8000-${String(sequence++).padStart(12, '0')}` }) });
  return { path, connection, db, sessions, message, batch, redact };
}
function snapshot(db: SqliteConnection['database']) {
  return ['messages', 'tool_notes', 'redactions', 'chunks'].map((table) => db.prepare(`select * from ${table}`).all());
}

describe('SQLite message redaction', () => {
  it('erases body, notes, FTS and disk bytes, preserving unrelated chunks and replayed records', async () => {
    const f = await fixture();
    expect(f.db.prepare(`select count(*) as n from chunks_fts where chunks_fts match '"hunter2-x-unmistakable"'`).get()).toEqual({ n: 1 });
    expect(await f.redact()).toMatchObject({ ok: true, bodySpans: 2, toolNoteSpans: 2, toolNotesChanged: 1, chunksRemoved: 1 });
    const rows = f.db.prepare('select * from redactions').all();
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.message_id === null && row.tool_note_id !== null)).toHaveLength(2);
    expect(rows.every((row) => row.pattern_version === null)).toBe(true);
    expect(JSON.stringify(snapshot(f.db))).not.toContain(secret);
    for (const table of ['chunks_fts', 'tool_notes_fts']) {
      expect(f.db.prepare(`select count(*) as n from ${table} where ${table} match '"hunter2-x-unmistakable"'`).get()).toEqual({ n: 0 });
    }
    expect(f.db.prepare('select id from chunks').all()).toEqual([{ id: 'chunk-kept' }]);
    expect(f.connection.isRedactAllowed()).toBe(false);
    expect(f.db.prepare('pragma secure_delete').get()).toEqual({ secure_delete: 0 });
    expect(() => f.db.exec("update messages set body = 'x'")).toThrow();
    const before = snapshot(f.db);
    expect((await f.sessions.ingest(f.batch)).ok).toBe(true);
    expect(snapshot(f.db)).toEqual(before);
    await f.connection.close();
    connections.splice(connections.indexOf(f.connection), 1);
    for (const suffix of ['', '-wal']) {
      const bytes = await readFile(f.path + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return Buffer.alloc(0);
        throw error;
      });
      expect(bytes.includes(Buffer.from(secret)), suffix).toBe(false);
    }
  });
  it.each(['tool_notes', 'redactions', 'chunks'])('rolls back all changes when applying %s fails', async (table) => {
    const f = await fixture();
    const before = snapshot(f.db);
    const operation = table === 'tool_notes' ? 'update' : table === 'redactions' ? 'insert' : 'delete';
    f.db.exec(`create trigger fail_redact before ${operation} on ${table} begin select raise(abort, 'injected'); end`);
    await expect(f.redact()).rejects.toThrow('injected');
    expect(snapshot(f.db)).toEqual(before);
    expect(f.connection.isRedactAllowed()).toBe(false);
    expect(f.db.prepare('pragma secure_delete').get()).toEqual({ secure_delete: 0 });
    expect(() => f.db.exec("update messages set body = 'x'")).toThrow();
    expect(f.db.prepare(`select count(*) as n from tool_notes_fts where tool_notes_fts match '"hunter2-x-unmistakable"'`).get()).toEqual({ n: 1 });
  });
  it('records detected pattern versions and leaves a no-match call unchanged', async () => {
    const f = await fixture('api_key=sk-abcdefghijklmnopqrstuvwx', 'TOKEN=another-unmistakable-value');
    expect(await f.redact({ mode: 'detected' })).toMatchObject({ ok: true, bodySpans: 1, toolNoteSpans: 1 });
    expect(f.db.prepare('select pattern_version from redactions').all()).toEqual([{ pattern_version: SECRET_PATTERN_VERSION }, { pattern_version: SECRET_PATTERN_VERSION }]);
    const before = snapshot(f.db);
    expect(await f.redact({ mode: 'detected' })).toMatchObject({ ok: true, bodySpans: 0, toolNoteSpans: 0, chunksRemoved: 0 });
    expect(snapshot(f.db)).toEqual(before);
    expect(await f.redact({ mode: 'text', text: 'absent', kind: 'manual' })).toMatchObject({ code: 'REDACT_TEXT_NOT_FOUND' });
    expect(snapshot(f.db)).toEqual(before);
  });
  it('returns DB_LOCKED and DB_UNAVAILABLE without applying a plan', async () => {
    const f = await fixture();
    const other = openSqlite({ path: f.path, busyTimeoutMs: 1 });
    if (!other.ok) throw new Error(other.message);
    connections.push(other.connection);
    other.connection.database.exec('begin immediate');
    try {
      expect(await f.redact()).toMatchObject({ ok: false, code: 'DB_LOCKED' });
      expect(f.connection.isRedactAllowed()).toBe(false);
    } finally { other.connection.database.exec('rollback'); }
    const missing = sqliteStore({ path: join(dirs[0]!, 'missing.db') });
    expect(await missing.redactMessage({ messageId: f.message.id, plan: () => { throw new Error('must not plan'); } })).toMatchObject({ code: 'DB_UNAVAILABLE' });
    await missing.close();
  });
  it('keeps a committed result when an external WAL reader prevents truncation', async () => {
    const f = await fixture();
    const reader = openSqlite({ path: f.path, busyTimeoutMs: 1 });
    if (!reader.ok) throw new Error(reader.message);
    connections.push(reader.connection);
    reader.connection.database.exec('begin');
    reader.connection.database.prepare('select * from messages').all();
    try {
      expect(await f.redact()).toMatchObject({ ok: true });
      expect(JSON.stringify(snapshot(f.db))).not.toContain(secret);
      expect((await readFile(f.path + '-wal')).length).toBeGreaterThan(0);
    } finally { reader.connection.database.exec('rollback'); }
  });
});
