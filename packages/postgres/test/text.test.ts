import { afterEach, expect, it } from 'vitest';
import pg from 'pg';
import type { TestDatabase } from '@second-brain/test-db';
import { sampleEnsureSessionInput, sampleSelfUserInput, sampleIngestBatch, sampleSessionToken, sampleTranscriptFileInput } from '@second-brain/core/testing';
import { postgresStore } from '../src/index.js';
import { database } from './fixture.js';

const databases: TestDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.drop())); });
const id = (n: number) => `01940000-0000-7000-8000-${String(n).padStart(12, '0')}`;
async function world() {
  const db = await database(); databases.push(db);
  const store = postgresStore({ databaseUrl: db.appUrl });
  expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
  return { db, store };
}

it('round-trips all transcript text with NUL and distinguishes replacement-character identities on replay', async () => {
  const { db, store } = await world();
  const original = 'before\u0000한글😀after';
  const searchable = original.replaceAll('\u0000', '\ufffd');
  const firstCwd = `cwd:${original}`;
  try {
    expect(await store.ensureSession(sampleEnsureSessionInput({ firstCwd }))).toMatchObject({ ok: true, session: { firstCwd } });
    const base = sampleIngestBatch();
    const messages = [original, searchable].map((text, index) => ({ ...base.messages[0]!, id: id(600 + index),
      harnessMessageId: text, body: `body:${text}`, model: `model:${text}`, gitBranch: `branch:${text}`,
      occurredAt: new Date(index === 0 ? '2026-01-02T03:05:02.000Z' : '2026-01-02T03:05:01.000Z') }));
    const toolNotes = [original, searchable].map((text, index) => ({ ...base.toolNotes[0]!, id: id(610 + index),
      harnessMessageId: text, callId: text, tool: `tool:${text}`, target: `target:${text}`, earlierPositions: [] }));
    const attachments = messages.map((m, index) => ({ id: id(620 + index), harnessMessageId: m.harnessMessageId,
      ordinal: 0, sourceKind: 'file', sourceRef: `ref:${m.harnessMessageId}`, displayName: `name:${m.harnessMessageId}`, file: null }));
    const batch = { ...base, messages, toolNotes, attachments,
      tracking: { ...base.tracking, cursor: { lastHarnessMessageId: original, fingerprint: 'fingerprint' } } };
    expect(await store.ingest(batch)).toMatchObject({ ok: true, inserted: { messages: 2, toolNotes: 2 } });
    expect(await store.ingest(batch)).toMatchObject({ ok: true, inserted: { messages: 0, toolNotes: 0 } });
    const read = await store.readSession(sampleSessionToken);
    expect(read).toMatchObject({ ok: true, session: { firstCwd, cursor: batch.tracking.cursor } });
    if (!read.ok) return;
    expect(read.messages).toEqual(expect.arrayContaining(messages.map(m => expect.objectContaining({
      id: m.id, body: m.body, model: m.model, gitBranch: m.gitBranch, harnessMessageId: m.harnessMessageId }))));
    expect(read.toolNotes.map(n => n.id)).toEqual([toolNotes[1]!.id, toolNotes[0]!.id]);
    expect(read.toolNotes).toEqual(expect.arrayContaining(toolNotes.map(n => expect.objectContaining({
      id: n.id, target: n.target, tool: n.tool, harnessMessageId: n.harnessMessageId }))));
    for (const [index, m] of messages.entries()) {
      expect(await store.listMessageAttachments(m.id)).toMatchObject({ ok: true,
        attachments: [{ sourceRef: attachments[index]!.sourceRef, displayName: attachments[index]!.displayName, status: 'missing_at_ingest' }] });
    }
    for (const [table, column, prefix] of [
      ['messages', 'body', 'body'], ['messages', 'model', 'model'], ['messages', 'git_branch', 'branch'],
      ['tool_notes', 'tool', 'tool'], ['tool_notes', 'target', 'target'],
      ['message_attachments', 'source_ref', 'ref'], ['message_attachments', 'display_name', 'name'],
    ] as const) {
      expect(await db.rows(`select ${column} as text, ${column}_raw as raw from brain.${table} order by id`))
        .toEqual([{ text: `${prefix}:${searchable}`, raw: Buffer.from(`${prefix}:${original}`) },
          { text: `${prefix}:${searchable}`, raw: null }]);
    }
    // A non-reset read of the older message cannot rewind the latest NUL cursor.
    const olderCursor = { lastHarnessMessageId: searchable, fingerprint: 'older' };
    expect(await store.ingest({ ...batch, tracking: { ...batch.tracking, cursorReset: false, cursor: olderCursor } }))
      .toMatchObject({ ok: true });
    expect(await store.findSession(batch.key)).toMatchObject({ ok: true, session: { cursor: batch.tracking.cursor } });
    // A reset replaces both halves, including clearing raw bytes.
    expect(await store.ingest({ ...batch, tracking: { ...batch.tracking,
      cursorReset: true, cursorBase: batch.tracking.cursor, cursor: null } })).toMatchObject({ ok: true });
    expect(await store.findSession(batch.key)).toMatchObject({ ok: true, session: { cursor: null } });
    expect(await db.rows('select last_harness_message_id_raw from brain.sessions'))
      .toEqual([{ last_harness_message_id_raw: null }]);
    const history = sampleTranscriptFileInput({ cursor: batch.tracking.cursor });
    expect(await store.recordTranscriptFile(history)).toMatchObject({ ok: true, file: { cursor: history.cursor } });
    const updatedCursor = { lastHarnessMessageId: 'updated\u0000cursor', fingerprint: 'updated-fingerprint' };
    expect(await store.recordTranscriptFile({ ...history, sizeBytes: history.sizeBytes + 1, cursor: updatedCursor }))
      .toMatchObject({ ok: true, file: { cursor: updatedCursor } });
    expect(await db.rows('select last_harness_message_id, last_harness_message_id_raw from brain.transcript_files'))
      .toEqual([{ last_harness_message_id: 'updated\ufffdcursor', last_harness_message_id_raw: Buffer.from(updatedCursor.lastHarnessMessageId) }]);
    expect(await store.recordTranscriptFile({ ...history, sizeBytes: history.sizeBytes + 2, cursor: null }))
      .toMatchObject({ ok: true, file: { cursor: null } });
    expect(await db.rows('select last_harness_message_id_raw from brain.transcript_files'))
      .toEqual([{ last_harness_message_id_raw: null }]);
    // Raw immutable metadata must be protected just like its text counterpart.
    await expect(db.query(`update brain.message_attachments set display_name_raw=null where id='${attachments[0]!.id}'`))
      .rejects.toThrow('invariant refused');
    // Exercise the column invariants even when redaction updates are enabled.
    for (const [table, column, rowId, trigger] of [
      ['messages', 'harness_message_id_raw', messages[0]!.id, 'messages_immutable_update'],
      ['tool_notes', 'harness_message_id_raw', toolNotes[0]!.id, 'tool_notes_immutable_update'],
      ['tool_notes', 'call_id_raw', toolNotes[0]!.id, 'tool_notes_immutable_update'],
      ['sessions', 'first_cwd_raw', sampleEnsureSessionInput().id, 'sessions_tag_evidence_update'],
    ]) {
      await expect(db.query(`set brain.redacting = 'on'; update brain.${table} set ${column}=null where id='${rowId}'`))
        .rejects.toThrow(`${trigger}: invariant refused`);
    }
  } finally { await store.close(); }
});

it('matches legacy note positions by original NUL and replacement-character identities', async () => {
  const { db, store } = await world();
  try {
    await store.ensureSession(sampleEnsureSessionInput());
    const base = sampleIngestBatch();
    const identities = ['legacy\u0000message', 'legacy\ufffdmessage'];
    const messages = identities.map((harnessMessageId, index) => ({ ...base.messages[0]!,
      id: id(730 + index), harnessMessageId }));
    const legacy = identities.map((harnessMessageId, index) => ({ ...base.toolNotes[0]!,
      id: id(740 + index), harnessMessageId, ordinal: index, callId: null, earlierPositions: [] }));
    const batch = { ...base, messages, toolNotes: legacy, tracking: { ...base.tracking, cursor: null } };
    expect(await store.ingest(batch)).toMatchObject({ ok: true, inserted: { messages: 2, toolNotes: 2 } });
    const moved = legacy.map((note, index) => ({ ...note, id: id(750 + index), ordinal: 2,
      callId: `moved-${index}`, earlierPositions: [{ harnessMessageId: note.harnessMessageId, ordinal: note.ordinal }] }));
    expect(await store.ingest({ ...batch, toolNotes: moved }))
      .toMatchObject({ ok: true, inserted: { messages: 0, toolNotes: 0 } });
    expect(await db.rows('select id from brain.tool_notes order by id')).toEqual(legacy.map(note => ({ id: note.id })));
    // These earlier positions exist only under the OTHER original identity.
    // They must not suppress new calls whose searchable IDs happen to match.
    const fresh = legacy.map((note, index) => ({ ...note, id: id(760 + index), ordinal: 3,
      callId: `fresh-${index}`, earlierPositions: [{ harnessMessageId: note.harnessMessageId, ordinal: 1 - index }] }));
    expect(await store.ingest({ ...batch, toolNotes: fresh }))
      .toMatchObject({ ok: true, inserted: { messages: 0, toolNotes: 2 } });
    expect(await store.ingest({ ...batch, toolNotes: moved }))
      .toMatchObject({ ok: true, inserted: { messages: 0, toolNotes: 0 } });
    expect(await db.rows('select id from brain.tool_notes order by id'))
      .toEqual([...legacy, ...fresh].map(note => ({ id: note.id })));
  } finally { await store.close(); }
});

it('distinguishes NUL and replacement-character call IDs across batches and deduplicates a moved NUL call', async () => {
  const { db, store } = await world();
  try {
    await store.ensureSession(sampleEnsureSessionInput());
    const base = sampleIngestBatch();
    const nulCallId = 'call\u0000id';
    const replacementCallId = 'call\ufffdid';
    const first = { ...base.toolNotes[0]!, id: id(770), harnessMessageId: base.messages[0]!.harnessMessageId,
      ordinal: 0, callId: nulCallId, earlierPositions: [] };
    const second = { ...first, id: id(771), harnessMessageId: base.messages[1]!.harnessMessageId,
      ordinal: 1, callId: replacementCallId };
    expect(await store.ingest({ ...base, toolNotes: [first] })).toMatchObject({ ok: true, inserted: { toolNotes: 1 } });
    expect(await store.ingest({ ...base, toolNotes: [second] })).toMatchObject({ ok: true, inserted: { toolNotes: 1 } });
    expect(await store.ingest({ ...base, toolNotes: [{ ...first, id: id(772), harnessMessageId: second.harnessMessageId, ordinal: 2 }] }))
      .toMatchObject({ ok: true, inserted: { toolNotes: 0 } });
    const rows = await db.rows<{ id: string; harness_message_id: string; ordinal: number; call_id: string; call_id_raw: Buffer | null }>(
      'select id, harness_message_id, ordinal, call_id, call_id_raw from brain.tool_notes order by id');
    expect(rows.map(row => ({ id: row.id, harnessMessageId: row.harness_message_id, ordinal: row.ordinal,
      callId: row.call_id_raw?.toString('utf8') ?? row.call_id })))
      .toEqual([first, second].map(note => ({ id: note.id, harnessMessageId: note.harnessMessageId, ordinal: note.ordinal, callId: note.callId })));
  } finally { await store.close(); }
});

it('preserves a work INSERT lock SQLSTATE and rolls session creation back', async () => {
  const { db, store: setupStore } = await world();
  await setupStore.close();
  const store = postgresStore({ databaseUrl: db.appUrl, lockTimeoutMs: 40 });
  const blocker = new pg.Client({ connectionString: db.url }); await blocker.connect();
  try {
    await blocker.query('begin');
    await blocker.query('lock table brain.work_items in share mode');
    const at = new Date('2026-10-28T00:00:00.000Z');
    const input = sampleEnsureSessionInput({ identityWork: { id: id(650), kind: 'session_identity', targetKind: 'session',
      targetId: sampleSessionToken, createdAt: at, nextAttemptAt: at } });
    expect(await store.ensureSession(input)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
    expect(await db.rows('select id from brain.sessions')).toEqual([]);
    await blocker.query('rollback');
    expect(await store.ensureSession(input)).toMatchObject({ ok: true, created: true });
  } finally { await blocker.query('rollback'); await blocker.end(); await store.close(); }
});

it('rolls back messages, files, locations, links and tracking when a later attachment fails', async () => {
  const { db, store } = await world();
  try {
    await store.ensureSession(sampleEnsureSessionInput());
    const batch = sampleIngestBatch();
    const attachment = { id: id(670), harnessMessageId: batch.messages[0]!.harnessMessageId, ordinal: 0,
      sourceKind: 'file', sourceRef: 'fixture.txt', displayName: 'fixture.txt',
      file: { id: id(671), contentHash: 'sha256:' + 'e'.repeat(64), sizeBytes: 1,
        location: { id: id(672), storeKind: 'local' as const, ownership: 'brain' as const, locator: 'ee/ee/fixture.txt' }, external: null } };
    const before = await db.rows('select * from brain.sessions');
    expect(await store.ingest({ ...batch, attachments: [attachment, { ...attachment, id: id(673), ordinal: -1 }] }))
      .toMatchObject({ ok: false });
    for (const table of ['messages', 'tool_notes', 'files', 'file_locations', 'message_attachments']) {
      expect(await db.rows(`select id from brain.${table}`)).toEqual([]);
    }
    expect(await db.rows('select * from brain.sessions')).toEqual(before);
    expect(await store.ingest({ ...batch, attachments: [attachment] })).toMatchObject({ ok: true });
  } finally { await store.close(); }
});

it('reuses one file hash across different messages and proposed file/location IDs', async () => {
  const { db, store } = await world();
  try {
    await store.ensureSession(sampleEnsureSessionInput());
    const batch = sampleIngestBatch();
    const attachments = batch.messages.slice(0, 2).map((m, index) => ({ id: id(680 + index), harnessMessageId: m.harnessMessageId,
      ordinal: 0, sourceKind: 'file', sourceRef: 'fixture.txt', displayName: 'fixture.txt',
      file: { id: id(690 + index), contentHash: 'sha256:' + 'f'.repeat(64), sizeBytes: 1,
        location: { id: id(700 + index), storeKind: 'local' as const, ownership: 'brain' as const, locator: 'ff/ff/fixture.txt' }, external: null } }));
    expect(await store.ingest({ ...batch, attachments })).toMatchObject({ ok: true });
    expect(await store.ingest({ ...batch, attachments })).toMatchObject({ ok: true, inserted: { messages: 0, toolNotes: 0 } });
    expect(await db.rows('select id from brain.files')).toEqual([{ id: attachments[0]!.file.id }]);
    expect(await db.rows('select id from brain.file_locations')).toEqual([{ id: attachments[0]!.file.location.id }]);
    expect(await db.rows('select file_id from brain.message_attachments')).toEqual(attachments.map(() => ({ file_id: attachments[0]!.file.id })));
    for (const m of batch.messages.slice(0, 2)) expect(await store.listMessageAttachments(m.id))
      .toMatchObject({ ok: true, attachments: [{ file: { id: attachments[0]!.file.id, home: { locator: 'ff/ff/fixture.txt' } } }] });
  } finally { await store.close(); }
});
