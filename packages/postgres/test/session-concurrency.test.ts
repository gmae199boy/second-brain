import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { IngestBatch, IngestResult } from '@second-brain/core';
import { sampleEnsureSessionInput, sampleIngestBatch, sampleSelfUserInput, sampleSessionToken } from '@second-brain/core/testing';
import { postgresStore } from '../src/index.js';
import { database } from './fixture.js';

const WORKER = fileURLToPath(new URL('./fixtures/ingest-worker.mjs', import.meta.url));

function worker(databaseUrl: string, batch: IngestBatch) {
  const child = spawn(process.execPath, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill(), 15_000);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', data => { stderr += String(data); });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let result: IngestResult | undefined;
  lines.on('line', line => {
    if (line === 'ready') readyResolve();
    else {
      try { result = JSON.parse(line) as IngestResult; }
      catch { child.kill(); }
    }
  });
  const done = new Promise<IngestResult>((resolve, reject) => {
    const fail = (error: Error) => { readyReject(error); reject(error); };
    child.on('error', error => { clearTimeout(timeout); fail(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      lines.close();
      if (code !== 0 || result === undefined) fail(new Error(`ingest worker exited ${String(code)}: ${stderr}`));
      else resolve(result);
    });
  });
  // Both promises can fail while the caller is still waiting for the other one.
  void ready.catch(() => {}); void done.catch(() => {});
  child.stdin.on('error', () => {});
  child.stdin.write(`${JSON.stringify({ databaseUrl, batch })}\n`);
  return { ready, done, go: () => child.stdin.end('go\n'), stop: async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await done.catch(() => {});
  } };
}

it('serializes identical batches from two Node processes like one collection', async () => {
  const concurrent = await database();
  const single = await database();
  const actual = postgresStore({ databaseUrl: concurrent.appUrl });
  const expected = postgresStore({ databaseUrl: single.appUrl });
  const workers: ReturnType<typeof worker>[] = [];
  try {
    for (const store of [actual, expected]) {
      expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
      expect((await store.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
    }
    const sample = sampleIngestBatch();
    const messages = Array.from({ length: 128 }, (_, i) => ({ ...sample.messages[0]!,
      id: `01940000-0000-7000-8000-${String(10000 + i).padStart(12, '0')}`,
      harnessMessageId: `message-${i}`, body: `body-${i}`,
      occurredAt: new Date(Date.UTC(2026, 0, 2, 3, 0, i)),
    }));
    const toolNotes = messages.map((message, i) => ({ ...sample.toolNotes[0]!,
      id: `01940000-0000-7000-8000-${String(20000 + i).padStart(12, '0')}`,
      harnessMessageId: message.harnessMessageId, callId: `call-${i}`, ordinal: 0,
    }));
    const batch: IngestBatch = { ...sample, messages, toolNotes,
      tracking: { ...sample.tracking, parserVersion: 'concurrent-v1',
        cursor: { lastHarnessMessageId: messages.at(-1)!.harnessMessageId, fingerprint: 'sha256:' + 'a'.repeat(64) } },
    };
    expect(await expected.ingest(batch)).toMatchObject({ ok: true, inserted: { messages: 128, toolNotes: 128 } });
    workers.push(worker(concurrent.appUrl, batch), worker(concurrent.appUrl, batch));
    await Promise.all(workers.map(child => child.ready));
    for (const child of workers) child.go();
    const results = await Promise.all(workers.map(child => child.done));
    for (const result of results) expect(result).toMatchObject({ ok: true });
    expect(results.reduce((sum, result) => sum + (result.ok ? result.inserted.messages : 0), 0)).toBe(messages.length);
    expect(results.reduce((sum, result) => sum + (result.ok ? result.inserted.toolNotes : 0), 0)).toBe(toolNotes.length);
    const actualRead = await actual.readSession(sampleSessionToken);
    expect(actualRead).toEqual(await expected.readSession(sampleSessionToken));
    expect(actualRead).toMatchObject({ ok: true, messages: expect.any(Array), toolNotes: expect.any(Array),
      session: { cursor: batch.tracking.cursor, parserVersion: batch.tracking.parserVersion } });
    const snapshot = `select last_harness_message_id, cursor_fingerprint, parser_version,
      (select count(*)::int from brain.messages) as messages,
      (select count(*)::int from brain.tool_notes) as tool_notes from brain.sessions`;
    expect(await concurrent.rows(snapshot)).toEqual(await single.rows(snapshot));
    expect(await concurrent.rows(snapshot)).toMatchObject([{ messages: 128, tool_notes: 128,
      last_harness_message_id: batch.tracking.cursor!.lastHarnessMessageId,
      cursor_fingerprint: batch.tracking.cursor!.fingerprint, parser_version: 'concurrent-v1' }]);
  } finally {
    await Promise.all(workers.map(child => child.stop()));
    await actual.close(); await expected.close();
    await concurrent.drop(); await single.drop();
  }
}, 30_000);
