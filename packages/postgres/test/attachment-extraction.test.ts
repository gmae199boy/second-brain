import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeChunkLocator, type BeginExtractionInput, type BeginExtractionResult, type ChunkLocator, type ExtractionChunkInput } from '@second-brain/core';
import { attachmentStoreContract, extractionStoreContract, sampleEnsureSessionInput, sampleIngestBatch, sampleSelfUserInput } from '@second-brain/core/testing';
import { postgresStore } from '../src/index.js';
import { database, subject, clock } from './fixture.js';

for (const [name, cases] of [['attachment-store contract', attachmentStoreContract()], ['extraction-store contract', extractionStoreContract()]] as const) {
  describe(name, () => { for (const test of cases) it(test.name, () => test.run(subject)); });
}
const id = (n: number) => `01980000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const now = clock.now();
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options = {}) {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl, ...options }); cleanup.push(() => store.close());
  await db.query(`insert into brain.files (id, content_hash, size_bytes, first_seen_at) values ('${id(1)}', 'sha256:${'1'.repeat(64)}', 1024, '${now.toISOString()}')`);
  expect(await store.addWork({ id: id(2), kind: 'document_extract', targetKind: 'file', targetId: id(1), createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
  expect(await store.claimWork({ now, kinds: ['document_extract'], claimedBy: 'worker' })).toMatchObject({ ok: true, item: { id: id(2) } });
  const begin = (n = 3): BeginExtractionInput => ({ id: id(n), fileId: id(1), extractorVersion: 'text-1', startedAt: now, claim: { workItemId: id(2), claimedBy: 'worker' } });
  return { db, store, begin };
}
async function blocker(databaseUrl: string) {
  const client = new pg.Client({ connectionString: databaseUrl }); await client.connect();
  cleanup.push(async () => { await client.query('rollback'); await client.end(); });
  await client.query('begin');
  await client.query('select id from brain.files where id=$1 for update', [id(1)]);
  return client;
}
const chunk = (ordinal = 0, body = 'piece'): ExtractionChunkInput => ({ id: id(1000 + ordinal), ordinal, body, page: null, chunkLocator: { type: 'text', start: ordinal * 2000, end: ordinal * 2000 + body.length } });
const finish = (n = 3) => ({ extractionId: id(n), finishedAt: now, outcome: { status: 'ok' as const, mediaType: 'text/plain', indexConfigId: null } });

it("stores the codec's chunk_locator text byte for byte and reads it back", async () => {
  const { db, store, begin } = await fixture(); expect(await store.beginExtraction(begin())).toMatchObject({ ok: true });
  const locators = [
    { bbox: [-0, 0.2, 0.8, 0.9], page: 4, type: 'pdf' },
    { type: 'pdf', page: 1, bbox: null },
    { end: 20, type: 'text', start: 0 },
    { block: 2, type: 'docx' },
  ] as unknown as ChunkLocator[];
  const encoded = locators.map(locator => { const value = encodeChunkLocator(locator); if (!value.ok) throw new Error(value.message); return value; });
  const chunks = encoded.map((value, ordinal) => ({ id: id(1000 + ordinal), ordinal, body: 'body', page: value.page, chunkLocator: locators[ordinal]! }));
  expect(await store.appendExtractionChunks({ extractionId: id(3), chunks })).toEqual({ ok: true, appended: chunks.length });
  expect(await db.rows('select chunk_locator, page from brain.document_chunks order by ordinal')).toEqual(encoded.map(value => ({ chunk_locator: value.text, page: value.page })));
  const expected = { ok: true, chunks: chunks.map((value, ordinal) => ({ ...value, extractionId: id(3), chunkLocator: encoded[ordinal]!.locator })) };
  expect(await store.listExtractionChunks(id(3))).toEqual(expected);
  const reopened = postgresStore({ databaseUrl: db.appUrl }); cleanup.push(() => reopened.close());
  expect(await reopened.listExtractionChunks(id(3))).toEqual(expected);
});
it('refuses a stored chunk_locator spelling the codec did not write', async () => {
  const { db, store, begin } = await fixture(); await store.beginExtraction(begin());
  await db.query(`insert into brain.document_chunks (id, extraction_id, ordinal, page, body, chunk_locator) values ('${id(100)}', '${id(3)}', 0, null, 'body', '{ "type": "text", "start": 0, "end": 4 }')`);
  expect(await store.listExtractionChunks(id(3))).toMatchObject({ ok: false });
});

const WORKER = fileURLToPath(new URL('./fixtures/extraction-worker.mjs', import.meta.url));
function worker(databaseUrl: string, input: BeginExtractionInput, applicationName: string) {
  const child = spawn(process.execPath, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  let stderr = ''; child.stderr.setEncoding('utf8').on('data', data => { stderr += String(data); });
  let readyResolve!: () => void; let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let result: BeginExtractionResult | undefined;
  lines.on('line', line => { if (line === 'ready') readyResolve(); else { try { result = JSON.parse(line) as BeginExtractionResult; } catch { child.kill('SIGKILL'); } } });
  const done = new Promise<BeginExtractionResult>((resolve, reject) => {
    const fail = (error: Error) => { readyReject(error); reject(error); };
    child.on('error', error => { clearTimeout(timeout); fail(error); });
    child.on('close', code => { clearTimeout(timeout); lines.close(); if (code !== 0 || result === undefined) fail(new Error(`extraction worker exited ${String(code)}: ${stderr}`)); else resolve(result); });
  });
  void ready.catch(() => {}); void done.catch(() => {});
  child.stdin.on('error', () => {}); child.stdin.write(`${JSON.stringify({ databaseUrl, input, applicationName })}\n`);
  return { ready, done, go: () => child.stdin.end('go\n'), stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done.catch(() => {}); } };
}
async function waitForLocks(db: Awaited<ReturnType<typeof database>>, names: string[]) {
  await expect.poll(async () => (await db.rows<{ count: number }>(`select count(*)::int as count from pg_stat_activity where application_name in (${names.map(name => "'" + name.replaceAll("'", "''") + "'").join(",")}) and wait_event_type = 'Lock'`))[0]?.count, { timeout: 2000, interval: 10 }).toBe(names.length);
}
it('keeps one open generation when two processes begin on the same file', async () => {
  const { db, store, begin } = await fixture();
  const held = await blocker(db.url);
  const children = [worker(db.appUrl, begin(3), 'extraction-process-a'), worker(db.appUrl, begin(4), 'extraction-process-b')];
  try {
    await Promise.all(children.map(child => child.ready)); children.forEach(child => child.go());
    try { await waitForLocks(db, ['extraction-process-a', 'extraction-process-b']); } finally { await held.query('rollback'); }
    const results = await Promise.all(children.map(child => child.done));
    results.forEach(result => expect(result).toMatchObject({ ok: true }));
    const successes = results.filter(result => result.ok).sort((a, b) => a.extraction.attempt - b.extraction.attempt);
    expect(successes.map(value => value.extraction.attempt)).toEqual([1, 2]);
    expect(successes[1]).toMatchObject({ closedStale: { id: successes[0]!.extraction.id, status: 'failed', failedStage: 'read' } });
    expect(await db.rows('select count(*)::int as count from brain.document_extractions where finished_at is null')).toEqual([{ count: 1 }]);
    expect(await store.listExtractions(id(1))).toMatchObject({ ok: true, extractions: [{ attempt: 1, status: 'failed', failedStage: 'read' }, { attempt: 2, status: null }] });
  } finally { await Promise.all(children.map(child => child.stop())); }
}, 20_000);
it('leaves no pieces on a generation a racing begin closed', async () => {
  const { db, store, begin } = await fixture({ applicationName: 'append-race' });
  expect(await store.beginExtraction(begin())).toMatchObject({ ok: true });
  const other = postgresStore({ databaseUrl: db.appUrl, applicationName: 'begin-race' }); cleanup.push(() => other.close());
  const held = await blocker(db.url);
  const appending = store.appendExtractionChunks({ extractionId: id(3), chunks: [chunk()] });
  const beginning = other.beginExtraction(begin(4));
  try { await waitForLocks(db, ['append-race', 'begin-race']); } finally { await held.query('rollback'); }
  const [appended, begun] = await Promise.all([appending, beginning]);
  expect(appended.ok || appended.code === 'EXTRACTION_CLOSED').toBe(true); expect(begun).toMatchObject({ ok: true });
  expect(await store.listExtractionChunks(id(3))).toEqual({ ok: true, chunks: [] });
  expect(await store.listExtractions(id(1))).toMatchObject({ ok: true, extractions: [{ id: id(3), status: 'failed' }, { id: id(4), status: null }] });
});
it('round-trips a file name holding U+0000 apart from a literal U+FFFD', async () => {
  const { store } = await fixture();
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
  const batch = sampleIngestBatch();
  const base = { harnessMessageId: batch.messages[0]!.harnessMessageId, sourceKind: 'file', sourceRef: null,
    file: { id: id(1), contentHash: 'sha256:' + '1'.repeat(64), sizeBytes: 1024, location: { id: id(10), storeKind: 'local' as const, ownership: 'brain' as const, locator: 'brain://sha256/' + '1'.repeat(64) }, external: null } };
  expect(await store.ingest({ ...batch, attachments: ['a\u0000b', 'a\ufffdb'].map((displayName, ordinal) => ({ ...base, id: id(20 + ordinal), ordinal, displayName })) })).toMatchObject({ ok: true });
  const missing = await store.listMissingFileNames({ limit: 100 }); if (!missing.ok) throw new Error(missing.message);
  expect(missing.names.map(name => name.text)).toEqual(['a\u0000b', 'a\ufffdb']);
  const names = missing.names.map((name, index) => ({ ...name, id: id(30 + index) }));
  expect(await store.writeFileNames({ names })).toEqual({ ok: true, inserted: 2 });
  expect(await store.writeFileNames({ names })).toEqual({ ok: true, inserted: 0 });
  expect(await store.listFileNames(id(1))).toEqual({ ok: true, names });
  expect(await store.listMissingFileNames({ limit: 100 })).toEqual({ ok: true, names: [] });
});
it('returns DB_LOCKED when an extraction write outlasts lock_timeout, then applies once', async () => {
  const { db, store, begin } = await fixture({ lockTimeoutMs: 40 });
  let held = await blocker(db.url);
  expect(await store.beginExtraction(begin())).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(await db.rows('select * from brain.document_extractions')).toEqual([]);
  await held.query('rollback');
  expect(await store.beginExtraction(begin())).toMatchObject({ ok: true, extraction: { attempt: 1 } });
  held = await blocker(db.url);
  const before = await db.rows('select * from brain.document_extractions');
  expect(await store.finishExtraction(finish())).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(await db.rows('select * from brain.document_extractions')).toEqual(before);
  expect(await db.rows('select current_extraction_id from brain.files')).toEqual([{ current_extraction_id: null }]);
  await held.query('rollback');
  expect(await store.finishExtraction(finish())).toMatchObject({ ok: true, current: true });
  expect(await store.finishExtraction(finish())).toMatchObject({ ok: false, code: 'EXTRACTION_CLOSED' });
});
it.each(['readFileSharing', 'readFileExtractionState'] as const)('returns DB_LOCKED from %s on a table lock and reads normally after release', async verb => {
  const { db, store } = await fixture({ lockTimeoutMs: 40, queryTimeoutMs: 1000 });
  const read = () => verb === 'readFileSharing'
    ? store.readFileSharing({ fileId: id(1) })
    : store.readFileExtractionState(id(1));
  const before = await read();
  expect(before).toMatchObject({ ok: true });
  const held = new pg.Client({ connectionString: db.url }); await held.connect();
  cleanup.push(() => held.end());
  await held.query('begin');
  try {
    await held.query('lock table brain.files in access exclusive mode');
    expect(await read()).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  } finally { await held.query('rollback'); }
  expect(await read()).toEqual(before);
});
it('answers DB_UNAVAILABLE from attachment and extraction verbs when the brain schema is missing', async () => {
  const { db, store, begin } = await fixture(); await db.query('drop schema brain cascade');
  const results = await Promise.all([
    store.listMissingFileNames({ limit: 1 }), store.writeFileNames({ names: [{ id: id(30), fileId: id(1), nameSource: 'attachment_name', text: 'name' }] }), store.listFileNames(id(1)),
    store.linkAttachments({ key: sampleEnsureSessionInput().key, linkedAt: now, attachments: [] }), store.readFileLocation(id(10)), store.listFileLocations(id(1)), store.markFileLocationDeleted({ id: id(10), deletedAt: now }), store.readFileSharing({ fileId: id(1) }),
    store.beginExtraction(begin()), store.appendExtractionChunks({ extractionId: id(3), chunks: [chunk()] }), store.finishExtraction(finish()), store.setFileSourceUnreachable({ fileId: id(1), unreachableAt: now }), store.readFileExtractionState(id(1)), store.listFilesAwaitingExtraction({ limit: 1 }), store.listFilesWithStaleExtraction({ extractorVersion: 'v2', limit: 1 }), store.listExtractions(id(1)), store.listExtractionChunks(id(3)),
  ]);
  expect(results).toHaveLength(17); for (const result of results) expect(result).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
});
it('writes one batch of 200 pieces of 2,000 characters within 2 seconds', async () => {
  const { store, begin } = await fixture(); expect(await store.beginExtraction(begin())).toMatchObject({ ok: true });
  const chunks = Array.from({ length: 200 }, (_, index) => chunk(index, `${index} `.padEnd(2000, '본문입니다 ')));
  expect(chunks.every(value => value.body.length === 2000)).toBe(true);
  const started = performance.now(); expect(await store.appendExtractionChunks({ extractionId: id(3), chunks })).toEqual({ ok: true, appended: 200 });
  expect(performance.now() - started).toBeLessThan(2000);
});
it('refuses out-of-range input instants before writing attachment or extraction state', async () => {
  const { db, store, begin } = await fixture();
  const invalid = new Date('+010000-01-01T00:00:00.000Z');
  const before = await db.rows('select * from brain.files');
  expect(await store.beginExtraction({ ...begin(), startedAt: invalid })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(await db.rows('select * from brain.document_extractions')).toEqual([]);
  expect(await store.beginExtraction(begin())).toMatchObject({ ok: true });
  const open = await db.rows('select * from brain.document_extractions');
  const results = await Promise.all([
    store.finishExtraction({ ...finish(), finishedAt: invalid }),
    store.setFileSourceUnreachable({ fileId: id(1), unreachableAt: invalid }),
    store.markFileLocationDeleted({ id: id(10), deletedAt: invalid }),
    store.linkAttachments({ key: sampleEnsureSessionInput().key, attachments: [], linkedAt: invalid }),
  ]);
  for (const result of results) expect(result).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(await db.rows('select * from brain.document_extractions')).toEqual(open);
  expect(await db.rows('select * from brain.files')).toEqual(before);
});
it('links distinct NUL and literal U+FFFD message identities to their own messages', async () => {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl }); cleanup.push(() => store.close());
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
  const sample = sampleIngestBatch();
  const messages = ['message\u0000id', 'message\ufffdid'].map((harnessMessageId, index) => ({ ...sample.messages[0]!, id: id(40 + index), harnessMessageId }));
  expect(await store.ingest({ ...sample, messages, toolNotes: [] })).toMatchObject({ ok: true });
  const attachments = messages.map((message, index) => ({ id: id(50 + index), harnessMessageId: message.harnessMessageId, ordinal: 0, sourceKind: 'file', sourceRef: null, displayName: `name-${index}`, file: null }));
  expect(await store.linkAttachments({ key: sampleEnsureSessionInput().key, attachments, linkedAt: now })).toEqual({ ok: true, linked: 2 });
  for (const [index, message] of messages.entries()) {
    expect(await store.listMessageAttachments(message.id)).toMatchObject({ ok: true, attachments: [{ id: attachments[index]!.id, displayName: `name-${index}` }] });
  }
  expect(await db.rows('select id, message_id from brain.message_attachments order by id')).toEqual(attachments.map((attachment, index) => ({ id: attachment.id, message_id: messages[index]!.id })));
});
it('handles single new and existing slots without writing a losing payload', async () => {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl }); cleanup.push(() => store.close());
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
  const batch = sampleIngestBatch(); expect(await store.ingest(batch)).toMatchObject({ ok: true });
  const key = sampleEnsureSessionInput().key;
  const attachment = { id: id(50), harnessMessageId: batch.messages[0]!.harnessMessageId, ordinal: 0,
    sourceKind: 'file', sourceRef: 'winner', displayName: 'winner',
    file: { id: id(60), contentHash: `sha256:${'1'.repeat(64)}`, sizeBytes: 10,
      location: { id: id(70), storeKind: 'local' as const, ownership: 'brain' as const, locator: '~/winner' }, external: null } };
  expect(await store.linkAttachments({ key, linkedAt: now, attachments: [attachment] })).toEqual({ ok: true, linked: 1 });
  const loser = { ...attachment, id: id(51), sourceRef: 'loser', file: { ...attachment.file, id: id(61),
    contentHash: `sha256:${'2'.repeat(64)}`, location: { ...attachment.file.location, id: id(71), locator: '~/loser' } } };
  expect(await store.linkAttachments({ key, linkedAt: now, attachments: [loser] })).toEqual({ ok: true, linked: 0 });
  const missing = { ...attachment, id: id(52), ordinal: 1, file: null };
  expect(await store.linkAttachments({ key, linkedAt: now, attachments: [missing] })).toEqual({ ok: true, linked: 1 });
  expect(await db.rows('select id, file_id, status from brain.message_attachments order by ordinal')).toEqual([
    { id: attachment.id, file_id: attachment.file.id, status: 'stored' },
    { id: missing.id, file_id: null, status: 'missing_at_ingest' },
  ]);
  expect(await db.rows('select id, home_location_id from brain.files')).toEqual([{ id: attachment.file.id, home_location_id: attachment.file.location.id }]);
  expect(await db.rows('select id, file_id from brain.file_locations')).toEqual([{ id: attachment.file.location.id, file_id: attachment.file.id }]);
});
it('serializes concurrent links into an empty slot without keeping the losing file or locations', async () => {
  const db = await database(); cleanup.push(() => db.drop());
  const stores = ['link-race-a', 'link-race-b'].map(applicationName => postgresStore({ databaseUrl: db.appUrl, applicationName }));
  for (const store of stores) cleanup.push(() => store.close());
  const store = stores[0]!;
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
  const batch = sampleIngestBatch(); expect(await store.ingest(batch)).toMatchObject({ ok: true });
  const key = sampleEnsureSessionInput().key;
  const held = new pg.Client({ connectionString: db.url }); await held.connect();
  cleanup.push(async () => { await held.query('rollback'); await held.end(); });
  await held.query('begin');
  await held.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${key.harness}:${key.harnessSessionId}`]);
  const attachments = stores.map((_store, index) => {
    const hash = String(index + 1).repeat(64);
    return { id: id(50 + index), harnessMessageId: batch.messages[0]!.harnessMessageId, ordinal: 0, sourceKind: 'file', sourceRef: null, displayName: `file-${index}`,
      file: { id: id(60 + index), contentHash: `sha256:${hash}`, sizeBytes: 10,
        location: { id: id(70 + index), storeKind: 'local' as const, ownership: 'brain' as const, locator: `brain://sha256/${hash}` },
        external: { id: id(80 + index), storeKind: 'local' as const, ownership: 'external' as const, locator: `~/file-${index}` } } };
  });
  const linking = stores.map((writer, index) => writer.linkAttachments({ key, linkedAt: now, attachments: [attachments[index]!] }));
  try { await waitForLocks(db, ['link-race-a', 'link-race-b']); } finally { await held.query('rollback'); }
  const results = await Promise.all(linking);
  expect(results).toContainEqual({ ok: true, linked: 1 }); expect(results).toContainEqual({ ok: true, linked: 0 });
  const winner = attachments[results.findIndex(result => result.ok && result.linked === 1)]!;
  expect(await db.rows('select id, file_id from brain.message_attachments')).toEqual([{ id: winner.id, file_id: winner.file.id }]);
  expect(await db.rows('select id, home_location_id from brain.files')).toEqual([{ id: winner.file.id, home_location_id: winner.file.location.id }]);
  expect(await db.rows('select id, file_id from brain.file_locations order by id')).toEqual([winner.file.location, winner.file.external].map(location => ({ id: location.id, file_id: winner.file.id })));
});
it('closes a failed generation whose error holds U+0000', async () => {
  const { db, store, begin } = await fixture();
  expect(await store.beginExtraction(begin())).toMatchObject({ ok: true });
  expect(await store.finishExtraction({
    ...finish(),
    outcome: { status: 'failed', failedStage: 'read', mediaType: null, error: 'read\u0000failed' },
  })).toMatchObject({ ok: true, current: false, extraction: { status: 'failed', finishedAt: now, error: 'read\ufffdfailed' } });
  expect(await db.rows('select status, finished_at is not null as closed, error from brain.document_extractions')).toEqual([
    { status: 'failed', closed: true, error: 'read\ufffdfailed' },
  ]);
});
it('counts distinct messages sharing a file by id and content hash', async () => {
  const { store } = await fixture();
  expect(await store.ensureSelfUser(sampleSelfUserInput())).toMatchObject({ ok: true });
  expect(await store.ensureSession(sampleEnsureSessionInput())).toMatchObject({ ok: true });
  const batch = sampleIngestBatch();
  const contentHash = 'sha256:' + '1'.repeat(64);
  const attachments = [0, 1, 2].map(index => ({
    id: id(50 + index), harnessMessageId: batch.messages[index === 2 ? 1 : 0]!.harnessMessageId,
    ordinal: index === 2 ? 0 : index, sourceKind: 'file', sourceRef: null, displayName: null,
    file: { id: id(1), contentHash, sizeBytes: 1024,
      location: { id: id(10), storeKind: 'local' as const, ownership: 'brain' as const, locator: 'brain://sha256/' + '1'.repeat(64) }, external: null },
  }));
  expect(await store.ingest({ ...batch, attachments })).toMatchObject({ ok: true });
  const expected = { ok: true, file: { id: id(1), contentHash, redactedAt: null }, messages: 2 };
  expect(await store.readFileSharing({ fileId: id(1) })).toEqual(expected);
  expect(await store.readFileSharing({ contentHash })).toEqual(expected);
});
it('refuses the callers own expired claim without writing a generation', async () => {
  const { db, store, begin } = await fixture();
  const [claim] = await db.rows<{ claimed_by: string; claim_expires_at: string }>('select claimed_by, claim_expires_at from brain.work_items');
  expect(claim!.claimed_by).toBe('worker');
  for (const offset of [0, 1]) {
    expect(await store.beginExtraction({ ...begin(), startedAt: new Date(new Date(claim!.claim_expires_at).getTime() + offset) }))
      .toMatchObject({ ok: false, code: 'CLAIM_LOST' });
  }
  expect(await db.rows('select * from brain.document_extractions')).toEqual([]);
});

async function currentAndOpen(store: ReturnType<typeof postgresStore>, begin: (n?: number) => BeginExtractionInput) {
  expect(await store.beginExtraction(begin(3))).toMatchObject({ ok: true });
  expect(await store.appendExtractionChunks({ extractionId: id(3), chunks: [chunk(0)] })).toEqual({ ok: true, appended: 1 });
  expect(await store.finishExtraction(finish(3))).toMatchObject({ ok: true, current: true });
  expect(await store.beginExtraction(begin(4))).toMatchObject({ ok: true });
  expect(await store.appendExtractionChunks({ extractionId: id(4), chunks: [chunk(1)] })).toEqual({ ok: true, appended: 1 });
}
async function extractionSnapshot(db: Awaited<ReturnType<typeof database>>) {
  return {
    files: await db.rows('select * from brain.files order by id'),
    generations: await db.rows('select * from brain.document_extractions order by id'),
    chunks: await db.rows('select * from brain.document_chunks order by id'),
  };
}
it.each(['reclaimed', 'completed'] as const)('refuses begin after a blocked claim is %s without changing extraction state', async change => {
  const { db, store, begin } = await fixture({ applicationName: 'claim-share-race' });
  await currentAndOpen(store, begin);
  const before = await extractionSnapshot(db);
  const owner = new pg.Client({ connectionString: db.url }); await owner.connect();
  cleanup.push(async () => { await owner.query('rollback'); await owner.end(); });
  await owner.query('begin');
  if (change === 'reclaimed') {
    await owner.query('update brain.work_items set claimed_by=$1 where id=$2', ['other-worker', id(2)]);
  } else {
    await owner.query("update brain.work_items set outcome='succeeded', completed_at=$1, claimed_by=null, claimed_at=null, claim_expires_at=null where id=$2", [now, id(2)]);
  }
  const pending = store.beginExtraction(begin(5));
  try { await waitForLocks(db, ['claim-share-race']); } finally { await owner.query('commit'); }
  expect(await pending).toMatchObject({ ok: false, code: 'CLAIM_LOST' });
  expect(await extractionSnapshot(db)).toEqual(before);
});
it('allows file B extraction to finish while file A waits on its file row', async () => {
  const { db, store, begin } = await fixture({ applicationName: 'file-a-waiting' });
  const other = postgresStore({ databaseUrl: db.appUrl, applicationName: 'file-b-independent', lockTimeoutMs: 100 });
  cleanup.push(() => other.close());
  await db.query(`insert into brain.files (id, content_hash, size_bytes, first_seen_at) values ('${id(10)}', 'sha256:${'2'.repeat(64)}', 10, '${now.toISOString()}')`);
  expect(await other.addWork({ id: id(11), kind: 'document_extract', targetKind: 'file', targetId: id(10), createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
  expect(await other.claimWork({ now, kinds: ['document_extract'], claimedBy: 'worker-b' })).toMatchObject({ ok: true, item: { id: id(11) } });
  const held = await blocker(db.url);
  const pending = store.beginExtraction(begin());
  try {
    await waitForLocks(db, ['file-a-waiting']);
    expect(await other.beginExtraction({ ...begin(12), fileId: id(10), claim: { workItemId: id(11), claimedBy: 'worker-b' } })).toMatchObject({ ok: true });
    expect(await other.appendExtractionChunks({ extractionId: id(12), chunks: [chunk()] })).toEqual({ ok: true, appended: 1 });
    expect(await other.finishExtraction(finish(12))).toMatchObject({ ok: true, current: true });
    await waitForLocks(db, ['file-a-waiting']);
  } finally { await held.query('rollback'); }
  expect(await pending).toMatchObject({ ok: true });
});
it('refuses begin and append on a redacted file and closes its running generation redacted', async () => {
  const { db, store, begin } = await fixture();
  expect(await store.beginExtraction(begin())).toMatchObject({ ok: true });
  expect(await store.appendExtractionChunks({ extractionId: id(3), chunks: [chunk()] })).toEqual({ ok: true, appended: 1 });
  const owner = new pg.Client({ connectionString: db.url }); await owner.connect();
  cleanup.push(async () => { await owner.query('rollback'); await owner.end(); });
  await owner.query('begin');
  await owner.query("set local brain.redacting = 'on'");
  await owner.query('update brain.files set redacted_at=$1 where id=$2', [now, id(1)]);
  await owner.query('commit');
  const before = await extractionSnapshot(db);
  expect(await store.beginExtraction(begin(4))).toMatchObject({ ok: false, code: 'FILE_REDACTED' });
  expect(await store.appendExtractionChunks({ extractionId: id(3), chunks: [chunk(1)] })).toMatchObject({ ok: false, code: 'FILE_REDACTED' });
  expect(await extractionSnapshot(db)).toEqual(before);
  expect(await store.finishExtraction(finish())).toMatchObject({ ok: true, current: false, extraction: { status: 'redacted', finishedAt: now, indexConfigId: null } });
  expect(await store.listExtractionChunks(id(3))).toEqual({ ok: true, chunks: [] });
  expect(await db.rows('select current_extraction_id from brain.files')).toEqual([{ current_extraction_id: null }]);
});
it('shares the session lock between ingest and link without keeping the losing file or locations', async () => {
  const db = await database(); cleanup.push(() => db.drop());
  const ingesting = postgresStore({ databaseUrl: db.appUrl, applicationName: 'mixed-ingest' });
  const linking = postgresStore({ databaseUrl: db.appUrl, applicationName: 'mixed-link' });
  cleanup.push(() => ingesting.close(), () => linking.close());
  expect(await ingesting.ensureSelfUser(sampleSelfUserInput())).toMatchObject({ ok: true });
  expect(await ingesting.ensureSession(sampleEnsureSessionInput())).toMatchObject({ ok: true });
  const batch = sampleIngestBatch(); expect(await ingesting.ingest(batch)).toMatchObject({ ok: true });
  const attachments = [0, 1].map(index => {
    const hash = String(index + 1).repeat(64);
    return { id: id(50 + index), harnessMessageId: batch.messages[0]!.harnessMessageId, ordinal: 0, sourceKind: 'file', sourceRef: null, displayName: null,
      file: { id: id(60 + index), contentHash: `sha256:${hash}`, sizeBytes: 10,
        location: { id: id(70 + index), storeKind: 'local' as const, ownership: 'brain' as const, locator: `brain://sha256/${hash}` },
        external: { id: id(80 + index), storeKind: 'local' as const, ownership: 'external' as const, locator: `~/mixed-file-${index}` } } };
  });
  const owner = new pg.Client({ connectionString: db.url }); await owner.connect();
  cleanup.push(async () => { await owner.query('rollback'); await owner.end(); });
  await owner.query('begin');
  await owner.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${batch.key.harness}:${batch.key.harnessSessionId}`]);
  const a = ingesting.ingest({ ...batch, attachments: [attachments[0]!] });
  const b = linking.linkAttachments({ key: batch.key, linkedAt: now, attachments: [attachments[1]!] });
  try { await waitForLocks(db, ['mixed-ingest', 'mixed-link']); } finally { await owner.query('rollback'); }
  expect(await a).toMatchObject({ ok: true });
  const linked = await b; expect(linked).toMatchObject({ ok: true });
  const rows = await db.rows<{ id: string; file_id: string }>('select id, file_id from brain.message_attachments');
  expect(rows).toHaveLength(1);
  const winner = attachments.find(attachment => attachment.id === rows[0]!.id)!;
  expect(rows).toEqual([{ id: winner.id, file_id: winner.file.id }]);
  expect(linked).toEqual({ ok: true, linked: winner === attachments[1] ? 1 : 0 });
  expect(await db.rows('select id, home_location_id from brain.files')).toEqual([{ id: winner.file.id, home_location_id: winner.file.location.id }]);
  expect(await db.rows('select id, file_id from brain.file_locations order by id')).toEqual([winner.file.location, winner.file.external].map(location => ({ id: location.id, file_id: winner.file.id })));
});
it('rolls back closing stale generations and deleting pieces when begin insert violates a constraint', async () => {
  const { db, store, begin } = await fixture();
  await currentAndOpen(store, begin);
  const before = await extractionSnapshot(db);
  // Reusing the current generation id fails the final INSERT's primary key,
  // after begin has closed the open generation and deleted its pieces.
  expect(await store.beginExtraction(begin(3))).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE', message: expect.stringContaining('duplicate key') });
  expect(await extractionSnapshot(db)).toEqual(before);
});

it('batches large attachment sets while preserving first slots, shared files, ownership and raw text on replay', async () => {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl }); cleanup.push(() => store.close());
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
  const batch = sampleIngestBatch(); expect(await store.ingest(batch)).toMatchObject({ ok: true });
  const hash = 'sha256:' + 'a'.repeat(64);
  const make = (n: number) => ({ id: id(10000 + n), harnessMessageId: batch.messages[n % 2]!.harnessMessageId,
    ordinal: Math.floor(n / 2), sourceKind: 'file', sourceRef: n === 0 ? 'ref\u0000x' : 'ref\ufffdx', displayName: n === 0 ? 'name\u0000x' : 'name\ufffdx',
    file: n === 2 ? null : { id: id(20000 + n), contentHash: hash, sizeBytes: 10,
      location: { id: id(30000 + n), storeKind: 'local' as const, ownership: 'external' as const, locator: '~/shared' },
      external: { id: id(40000 + n), storeKind: 'drive' as const, ownership: 'brain' as const, locator: 'drive://shared' } } });
  const attachments = Array.from({ length: 1001 }, (_, n) => make(n));
  const loser = { ...make(1100), harnessMessageId: attachments[0]!.harnessMessageId, ordinal: 0,
    file: { ...make(1100).file!, contentHash: 'sha256:' + 'b'.repeat(64) } };
  const input = { key: batch.key, linkedAt: now, attachments: [attachments[0]!, loser, ...attachments.slice(1)] };
  expect(await store.linkAttachments(input)).toEqual({ ok: true, linked: 1001 });
  const snapshot = async () => ({ attachments: await db.rows('select * from brain.message_attachments order by id'),
    files: await db.rows('select * from brain.files order by id'), locations: await db.rows('select * from brain.file_locations order by id') });
  const before = await snapshot();
  expect(before.attachments).toHaveLength(1001); expect(before.files).toHaveLength(1); expect(before.locations).toHaveLength(2);
  expect(before.files[0]).toMatchObject({ id: id(20000), home_location_id: id(40000) });
  expect(before.locations).toEqual(expect.arrayContaining([expect.objectContaining({ id: id(30000), ownership: 'external' })]));
  expect(await store.linkAttachments(input)).toEqual({ ok: true, linked: 0 });
  expect(await snapshot()).toEqual(before);
  const read = await store.listMessageAttachments(batch.messages[0]!.id);
  expect(read).toMatchObject({ ok: true, attachments: expect.arrayContaining([expect.objectContaining({ id: id(10000), sourceRef: 'ref\u0000x', displayName: 'name\u0000x' })]) });
  if (!read.ok) throw new Error(read.message);
  expect(read.attachments.find(a => a.id === id(10002))).toMatchObject({ status: 'missing_at_ingest', file: null });
});

it('rolls back an entire attachment batch when a later row violates a constraint', async () => {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl }); cleanup.push(() => store.close());
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
  const batch = sampleIngestBatch(); expect(await store.ingest(batch)).toMatchObject({ ok: true });
  const snapshot = async () => ({ attachments: await db.rows('select * from brain.message_attachments order by id'),
    files: await db.rows('select * from brain.files order by id'), locations: await db.rows('select * from brain.file_locations order by id') });
  const before = await snapshot();
  const base = { harnessMessageId: batch.messages[0]!.harnessMessageId, sourceKind: 'file', sourceRef: null, displayName: null };
  const attachments = Array.from({ length: 201 }, (_, ordinal) => ({ ...base, id: id(50000 + (ordinal === 200 ? 0 : ordinal)), ordinal,
    file: { id: id(60000 + ordinal), contentHash: 'sha256:' + ordinal.toString(16).padStart(64, '0'), sizeBytes: 10,
      location: { id: id(61000 + ordinal), storeKind: 'local' as const, ownership: 'brain' as const, locator: `~/rollback-${ordinal}` }, external: null } }));
  expect(await store.linkAttachments({ key: batch.key, linkedAt: now, attachments })).toMatchObject({ ok: false });
  expect(await snapshot()).toEqual(before);
});

it.each([
  'ABCDEF01-2345-7789-ABCD-EF0123456789',
  '{ABCDEF0123457789ABCDEF0123456789}',
  'abcd-ef01-2345-7789-abcd-ef01-2345-6789',
])('keeps the first ingest slot across chunks for PostgreSQL UUID spelling %s', async messageId => {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl }); cleanup.push(() => store.close());
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
  const batch = sampleIngestBatch(), message = { ...batch.messages[0]!, id: messageId };
  const common = { harnessMessageId: message.harnessMessageId, sourceKind: 'file', sourceRef: null, displayName: null };
  const location = (n: number) => ({ id: id(70000 + n), storeKind: 'local' as const, ownership: 'brain' as const, locator: `~/uuid-${n}` });
  const file = (n: number) => ({ id: id(71000 + n), contentHash: 'sha256:' + String(n).repeat(64), sizeBytes: 10, location: location(n), external: null });
  const first = { ...common, id: id(72000), ordinal: 0, displayName: 'winner', file: file(1) };
  const filler = Array.from({ length: 199 }, (_, n) => ({ ...common, id: id(72001 + n), ordinal: n + 1, file: null }));
  const loser = { ...common, id: id(73000), ordinal: 0, displayName: 'loser', file: file(2) };
  const attachments = [first, ...filler, loser];
  expect(await store.ingest({ ...batch, messages: [message, ...batch.messages.slice(1)], attachments })).toMatchObject({ ok: true });
  expect(await db.rows('select id, ordinal, display_name, file_id from brain.message_attachments where ordinal=0')).toEqual([{ id: first.id, ordinal: 0, display_name: 'winner', file_id: first.file.id }]);
  expect(await db.rows('select id, content_hash from brain.files')).toEqual([{ id: first.file.id, content_hash: first.file.contentHash }]);
  expect(await db.rows('select id from brain.file_locations')).toEqual([{ id: first.file.location.id }]);
  expect(await store.linkAttachments({ key: batch.key, linkedAt: now, attachments })).toEqual({ ok: true, linked: 0 });
  expect(await db.rows('select count(*)::int as count from brain.message_attachments')).toEqual([{ count: 200 }]);
});

it('uses stored location ownership, selects the first brain candidate and keeps an existing home', async () => {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl }); cleanup.push(() => store.close());
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
  const batch = sampleIngestBatch(); expect(await store.ingest(batch)).toMatchObject({ ok: true });
  const hash = 'sha256:' + 'c'.repeat(64);
  const loc = (n: number, ownership: 'brain' | 'external', locator: string) => ({ id: id(81000 + n), storeKind: 'local' as const, ownership, locator });
  const external = loc(0, 'external', '~/external'), brain = loc(1, 'brain', '~/brain');
  const attachment = (n: number, location: ReturnType<typeof loc>, other: ReturnType<typeof loc> | null = null) => ({ id: id(82000 + n), harnessMessageId: batch.messages[0]!.harnessMessageId, ordinal: n, sourceKind: 'file', sourceRef: null, displayName: null,
    file: { id: id(83000 + n), contentHash: hash, sizeBytes: 10, location, external: other } });
  // Establish external-only location so the next slot's claimed brain ownership
  // must not promote it, then introduce two genuine brain locations in order.
  expect(await store.linkAttachments({ key: batch.key, linkedAt: now, attachments: [attachment(0, external)] })).toEqual({ ok: true, linked: 1 });
  expect(await db.rows('select home_location_id from brain.files')).toEqual([{ home_location_id: null }]);
  const claimedBrain = loc(2, 'brain', external.locator), secondBrain = loc(3, 'brain', '~/brain-second');
  expect(await store.linkAttachments({ key: batch.key, linkedAt: now, attachments: [attachment(1, claimedBrain, brain), attachment(2, secondBrain)] })).toEqual({ ok: true, linked: 2 });
  expect(await db.rows('select id, home_location_id from brain.files')).toEqual([{ id: id(83000), home_location_id: brain.id }]);
  expect(await db.rows('select id, ownership from brain.file_locations order by id')).toEqual([{ id: external.id, ownership: 'external' }, { id: brain.id, ownership: 'brain' }, { id: secondBrain.id, ownership: 'brain' }]);
  // A stored brain location remains brain when the input claims external; a
  // newly inserted brain candidate also cannot replace the existing home.
  const claimedExternal = loc(4, 'external', brain.locator), laterBrain = loc(5, 'brain', '~/later');
  expect(await store.linkAttachments({ key: batch.key, linkedAt: now, attachments: [attachment(3, claimedExternal, laterBrain)] })).toEqual({ ok: true, linked: 1 });
  expect(await db.rows('select id, home_location_id from brain.files')).toEqual([{ id: id(83000), home_location_id: brain.id }]);
  expect(await db.rows("select id, ownership from brain.file_locations where locator='~/brain'")).toEqual([{ id: brain.id, ownership: 'brain' }]);
  expect(await db.rows("select id, ownership from brain.file_locations where locator='~/later'")).toEqual([{ id: laterBrain.id, ownership: 'brain' }]);
  const savedHash = 'sha256:' + 'd'.repeat(64), savedFile = id(84000), savedLocation = id(84001);
  await db.query(`insert into brain.files (id, content_hash, size_bytes, first_seen_at) values ('${savedFile}', '${savedHash}', 10, '${now.toISOString()}')`);
  await db.query(`insert into brain.file_locations (id, file_id, store_kind, locator, ownership, first_seen_at) values ('${savedLocation}', '${savedFile}', 'local', '~/stored-brain', 'brain', '${now.toISOString()}')`);
  const reusing = attachment(4, loc(6, 'external', '~/stored-brain'));
  reusing.file.contentHash = savedHash;
  expect(await store.linkAttachments({ key: batch.key, linkedAt: now, attachments: [reusing] })).toEqual({ ok: true, linked: 1 });
  expect(await db.rows(`select home_location_id from brain.files where id='${savedFile}'`)).toEqual([{ home_location_id: savedLocation }]);
  expect(await db.rows(`select id, ownership from brain.file_locations where file_id='${savedFile}'`)).toEqual([{ id: savedLocation, ownership: 'brain' }]);
});

it.each([['external','brain'],['brain','external']] as const)('keeps the first same-chunk location ownership: %s then %s', async (firstOwner, secondOwner) => {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl }); cleanup.push(() => store.close());
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
  const batch = sampleIngestBatch(); expect(await store.ingest(batch)).toMatchObject({ ok: true });
  const location = (n: number, ownership: 'brain' | 'external') => ({ id: id(85000+n), storeKind: 'local' as const, locator: '~/same-slot-location', ownership });
  const attachments = [firstOwner,secondOwner].map((owner,n)=>({ id: id(85100+n), harnessMessageId: batch.messages[0]!.harnessMessageId, ordinal:n, sourceKind:'file', sourceRef:null, displayName:null,
    file:{id:id(85200+n),contentHash:'sha256:'+'e'.repeat(64),sizeBytes:10,location:location(n,owner),external:null} }));
  expect(await store.linkAttachments({key:batch.key,linkedAt:now,attachments})).toEqual({ok:true,linked:2});
  expect(await db.rows('select id, ownership from brain.file_locations')).toEqual([{id:id(85000),ownership:firstOwner}]);
  expect(await db.rows('select id, home_location_id from brain.files')).toEqual([{id:id(85200),home_location_id:firstOwner==='brain'?id(85000):null}]);
});

it('stores distinct files and two locations across a chunk boundary and replays unchanged', async () => {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl }); cleanup.push(() => store.close());
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput());
  const batch = sampleIngestBatch(); expect(await store.ingest(batch)).toMatchObject({ ok: true });
  const attachments = Array.from({length:201},(_,n)=>({id:id(86000+n),harnessMessageId:batch.messages[0]!.harnessMessageId,ordinal:n,sourceKind:'file',sourceRef:null,displayName:null,
    file:{id:id(87000+n),contentHash:'sha256:'+n.toString(16).padStart(64,'0'),sizeBytes:n+1,
      location:{id:id(88000+n),storeKind:'local' as const,locator:`~/home-${n}`,ownership:'brain' as const},
      external:{id:id(89000+n),storeKind:'local' as const,locator:`~/external-${n}`,ownership:'external' as const}}}));
  const input={key:batch.key,linkedAt:now,attachments};
  expect(await store.linkAttachments(input)).toEqual({ok:true,linked:201});
  const snapshot=async()=>({attachments:await db.rows('select * from brain.message_attachments order by id'),files:await db.rows('select * from brain.files order by id'),locations:await db.rows('select * from brain.file_locations order by id')});
  const before=await snapshot(); expect(before.attachments).toHaveLength(201); expect(before.files).toHaveLength(201); expect(before.locations).toHaveLength(402);
  for(const a of attachments) {
    expect(before.attachments).toContainEqual(expect.objectContaining({id:a.id,file_id:a.file.id}));
    expect(before.files).toContainEqual(expect.objectContaining({id:a.file.id,home_location_id:a.file.location.id,content_hash:a.file.contentHash}));
    expect(before.locations).toContainEqual(expect.objectContaining({id:a.file.location.id,file_id:a.file.id,ownership:'brain'}));
    expect(before.locations).toContainEqual(expect.objectContaining({id:a.file.external.id,file_id:a.file.id,ownership:'external'}));
  }
  expect(await store.linkAttachments(input)).toEqual({ok:true,linked:0}); expect(await snapshot()).toEqual(before);
});
