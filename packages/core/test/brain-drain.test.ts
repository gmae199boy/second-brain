import { memoryFileStore } from '../src/testing/fakes/file-store.js';
import { describe, expect, it } from 'vitest';
import { createBrain, type BrainDependencies } from '../src/brain.js';
import { SESSION_INGEST_KIND } from '../src/capture/session-ingest-work.js';
import { DRAIN_BUDGET_MS } from '../src/domain/work-item.js';
import { fixedClock } from '../src/testing/fakes/clock.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import { memoryParser, memoryTranscript } from '../src/testing/fakes/parser.js';
import { memoryRepositories } from '../src/testing/fakes/repository.js';
import { memorySpool, type MemorySpool } from '../src/testing/fakes/spool.js';
import { memoryStore, type MemoryStore } from '../src/testing/fakes/store.js';
import { memoryTranscriptReader } from '../src/testing/fakes/transcript.js';
import {
  memoryTranscriptFolder,
  type MemoryTranscriptFolder,
} from '../src/testing/fakes/transcript-folder.js';
import { sampleSelfUserInput, sampleSpoolRecord } from '../src/testing/fixtures.js';

/**
 * One drain run, whole: the spool goes back in, the folders are scanned, and
 * the queue is worked — in that order, under one deadline (Design Notes).
 *
 * This is where the three steps of story 12 meet, so the cases here are about
 * the seams between them rather than about any one of them: that a scan's item
 * is collected in the same run, that an unwritable database ends the run before
 * the scan, and that the counts of all three are in one answer.
 */

const NOW = new Date('2026-03-04T05:06:07.000Z');
const PATH = '/transcripts/session-0001.jsonl';
const TOKEN = 'demo:session-0001';

interface Kit {
  brain: ReturnType<typeof createBrain>;
  store: MemoryStore;
  spool: MemorySpool;
  folder: MemoryTranscriptFolder;
}

/**
 * A brain over the memory fakes, with one transcript on the disk and an owner
 * recorded — which is the least a collection needs (AD-12).
 */
async function kit(
  options: { withFolder?: boolean; store?: MemoryStore; spool?: MemorySpool; parser?: ReturnType<typeof memoryParser> } = {},
): Promise<Kit> {
  const store = options.store ?? memoryStore();
  expect(await store.ensureSelfUser(sampleSelfUserInput())).toMatchObject({ ok: true });
  const spool = options.spool ?? memorySpool();
  const folder = memoryTranscriptFolder({
    harness: 'demo',
    files: [
      {
        harnessSessionId: 'session-0001',
        path: PATH,
        sizeBytes: memoryTranscript.length,
        modifiedAt: NOW,
      },
    ],
  });
  const dependencies: BrainDependencies = {
    // The schema version is doctor's question and nothing a drain asks, so the
    // fake answers it beside the memory store rather than having one of its own.
    store: {
      ...store,
      async readSchemaVersion() {
        return { ok: true, version: { version: 6, appliedAt: NOW } };
      },
    },
    spool,
    files: memoryFileStore(),
    schemaVersion: 6,
    clock: fixedClock(NOW),
    idGen: sequenceIdGen({ timestampMs: NOW.getTime() }),
    parsers: [options.parser ?? memoryParser()],
    transcripts: memoryTranscriptReader({ files: { [PATH]: memoryTranscript } }),
    ...(options.withFolder === false ? {} : { transcriptFolders: [folder] }),
    repositories: memoryRepositories(),
    machine: 'demo-machine',
  };
  return { brain: createBrain(dependencies), store, spool, folder };
}

describe('brain.queue.drain', () => {
  it('scans the folders and collects what it found in the same run', async () => {
    // Which is what makes one `brain queue drain` on a fresh install collect
    // everything on the disk (SM-5): the scan comes before the queue loop, so
    // the item it adds is claimed by that same loop.
    const { brain, store } = await kit();

    const report = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });

    expect(report).toMatchObject({
      replayed: 0,
      spoolFailed: 0,
      enqueued: 1,
      claimed: 1,
      completed: 1,
      failed: 0,
      stopped: 'empty',
    });
    const sessions = store.snapshot().sessions;
    expect(sessions).toHaveLength(1);
    // A session a folder scan found is an import, however many live turns
    // follow it (Table Contract).
    expect(sessions[0]).toMatchObject({ harnessSessionId: 'session-0001', ingestSource: 'import' });
    expect(store.snapshot().messages.length).toBeGreaterThan(0);
  });

  it('writes the history, so a second run finds nothing to do', async () => {
    const { brain, store } = await kit();

    const first = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });
    const messagesAfterFirst = store.snapshot().messages.length;
    const second = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });

    expect(first.enqueued).toBe(1);
    expect(messagesAfterFirst).toBeGreaterThan(0);
    // The history is what stops the second run: the listing and the row agree
    // about the size, so nothing changed (Decision 2, 2026-10-19).
    expect(store.snapshot().transcriptFiles).toHaveLength(1);
    expect(second).toMatchObject({ enqueued: 0, claimed: 0, stopped: 'empty' });
    // And every table holds what it held after the first run (SM-5, AD-8).
    expect(store.snapshot().sessions).toHaveLength(1);
    expect(store.snapshot().messages).toHaveLength(messagesAfterFirst);
  });

  it.each([false, true])('구버전 세션은 같은 크기라도 한 번만 다시 읽는다 (빈 결과 %s)', async (empty) => {
    const { brain: old, store } = await kit();
    await old.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });
    const messages = store.snapshot().messages.length;
    const parser = memoryParser({ version: '2' });
    if (empty) parser.parse = () => ({ ok: true, parserVersion: '2', messages: [], attachments: [], toolNotes: [],
      cursor: null, cursorReset: false, startSource: null, startCwd: null, droppedLines: { unreadable: 0 } });
    const { brain } = await kit({ store, parser });
    expect(await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command }))
      .toMatchObject({ enqueued: 1, rereadMissing: 0, completed: 1 });
    expect(store.snapshot().sessions[0]?.parserVersion).toBe('2');
    expect(store.snapshot().messages).toHaveLength(messages);
    expect(await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command })).toMatchObject({ enqueued: 0 });
  });

  it('구버전 세션의 파일이 사라졌으면 일감 없이 센다', async () => {
    const { brain: old, store } = await kit();
    await old.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });
    const { brain, folder } = await kit({ store, parser: memoryParser({ version: '2' }) });
    folder.remove(PATH);
    expect(await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command }))
      .toMatchObject({ enqueued: 0, rereadMissing: 1 });
  });

  it('쓰기 불가로 멈춘 보고의 다시 못 읽음은 0이다', async () => {
    const { brain: old, store } = await kit();
    await old.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });
    const { brain, folder } = await kit({ store, parser: memoryParser({ version: '2' }) });
    folder.remove(PATH);
    await store.addWork({ id: '01940000-0000-7000-8000-0000000000c1', kind: 'probe',
      targetKind: 'session', targetId: TOKEN, createdAt: NOW, nextAttemptAt: NOW });
    expect(await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command, handlers: {
      probe: async () => ({ ok: false, code: 'DB_UNAVAILABLE', message: '쓸 수 없습니다' }),
    } })).toMatchObject({ stopped: 'unwritable', rereadMissing: 0 });
  });

  it('구버전 세션의 미해결 실패는 다시 넣지 않는다', async () => {
    const { brain: old, store } = await kit();
    await old.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });
    await recordFailure(store);
    const { brain } = await kit({ store, parser: memoryParser({ version: '2' }) });
    expect(await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command })).toMatchObject({ enqueued: 0 });
    expect(store.snapshot().sessions[0]?.parserVersion).toBe('1');
  });

  it('does nothing at all with no transcript folder', async () => {
    const { brain, store } = await kit({ withFolder: false });

    const report = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });

    expect(report).toMatchObject({ enqueued: 0, claimed: 0, stopped: 'empty' });
    expect(store.snapshot().sessions).toEqual([]);
  });

  it('replays a spooled mark as a live session, and resolves what it recorded', async () => {
    const { brain, store, spool } = await kit({ withFolder: false });
    expect(
      await spool.append([sampleSpoolRecord({ transcriptPath: PATH })]),
    ).toMatchObject({ ok: true });

    const report = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });

    expect(report).toMatchObject({ replayed: 1, spoolFailed: 0, enqueued: 0 });
    expect(await spool.stats()).toMatchObject({ records: 0, failed: 0 });
    // A mark written by a hook is about a session happening now, so the row it
    // creates is `live` and not an import (Table Contract).
    expect(store.snapshot().sessions[0]).toMatchObject({ ingestSource: 'live' });
  });

  it('stops before the scan when the database will not take a write', async () => {
    // The replay finds that out first, and a scan that enqueued work against
    // the same database would fail and cost an attempt for nothing (AD-9).
    const store = memoryStore();
    const locked: MemoryStore = {
      ...store,
      async findSession() {
        return { ok: false, code: 'DB_UNAVAILABLE', message: '파일을 열 수 없습니다' };
      },
    };
    const { brain, folder } = await kit({ store: locked });
    expect(await brain.sessions.ingest({ session: TOKEN, transcriptPath: PATH })).toMatchObject({
      ok: true,
      spooled: true,
    });

    const report = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });

    expect(report).toMatchObject({
      stopped: 'unwritable',
      code: 'DB_UNAVAILABLE',
      enqueued: 0,
      rereadMissing: 0,
      claimed: 0,
    });
    // The folder was never listed: the run ended at the replay.
    expect(folder.lists()).toBe(0);
  });

  it('puts every count of one run in one answer', async () => {
    const { brain } = await kit({ withFolder: false });

    const report = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.opportunistic });

    // A person reading `brain queue drain` wants the spool, the folders and the
    // queue in one line, so the three numbers are on one report.
    expect(Object.keys(report).sort()).toEqual(
      [
        'claimed',
        'completed',
        'enqueued',
        'failed',
        'lost',
        'released',
        'replayed',
        'rereadMissing',
        'retried',
        'spoolFailed',
        'spooled',
        'stopped',
      ].sort(),
    );
  });
});

describe('brain.failures', () => {
  it('reads what is recorded and asks for it to be done again', async () => {
    const { brain, store } = await kit({ withFolder: false });
    expect(
      await store.recordFailure({
        id: '01940000-0000-7000-8000-0000000000b1',
        targetKind: 'session',
        targetId: TOKEN,
        stage: SESSION_INGEST_KIND,
        fingerprint: 'sha256:one',
        harness: 'demo',
        sessionId: null,
        code: 'TRANSCRIPT_UNREADABLE',
        message: '읽을 수 없습니다',
        occurredAt: NOW,
      }),
    ).toMatchObject({ ok: true });

    expect(await brain.failures.list()).toMatchObject({ ok: true, count: 1 });
    expect(await brain.failures.retry()).toMatchObject({ ok: true, added: 1 });
    expect(store.snapshot().workItems[0]).toMatchObject({
      kind: SESSION_INGEST_KIND,
      targetId: TOKEN,
    });
  });
});

async function recordFailure(store: MemoryStore): Promise<void> {
  expect(await store.recordFailure({
    id: '01940000-0000-7000-8000-0000000000b1', targetKind: 'session', targetId: TOKEN,
    stage: SESSION_INGEST_KIND, fingerprint: 'sha256:one', harness: 'demo', sessionId: null,
    code: 'TRANSCRIPT_UNREADABLE', message: '읽을 수 없습니다', occurredAt: NOW,
  })).toMatchObject({ ok: true });
}

describe('brain.sessions.ingest 실패 해소', () => {
  it('성공하면 이 세션의 미해결 실패를 해소하고 평소에는 쓰지 않는다', async () => {
    const store = memoryStore();
    let writes = 0;
    const { brain } = await kit({ store: { ...store, async resolveFailures(input) {
      writes += 1; return store.resolveFailures(input);
    } } });
    expect((await brain.sessions.ingest({ session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    expect(writes).toBe(0);
    await recordFailure(store);
    expect((await brain.sessions.ingest({ session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    expect(writes).toBe(1);
    expect(await store.listFailures({})).toMatchObject({ ok: true, failures: [] });
  });

  it('spool로 가면 실패를 해소하지 않는다', async () => {
    const store = memoryStore();
    await recordFailure(store);
    let writes = 0;
    const { brain } = await kit({ store: { ...store,
      async findSession() { return { ok: false, code: 'DB_UNAVAILABLE', message: '읽을 수 없습니다' }; },
      async resolveFailures(input) { writes += 1; return store.resolveFailures(input); },
    } });
    expect(await brain.sessions.ingest({ session: TOKEN, transcriptPath: PATH })).toMatchObject({ ok: true, spooled: true });
    expect(writes).toBe(0);
  });

  it.each(['list', 'resolve', 'throw'])('실패 해소의 오류도 수집 성공을 바꾸지 않는다: %s', async (failure) => {
    const store = memoryStore();
    await recordFailure(store);
    const { brain } = await kit({ store: { ...store,
      async listFailures(query) {
        if (failure === 'list') return { ok: false, code: 'DB_UNAVAILABLE', message: '읽을 수 없습니다' };
        return store.listFailures(query);
      },
      async resolveFailures() {
        if (failure === 'throw') throw new Error('쓰기 실패');
        return { ok: false, code: 'DB_LOCKED', message: '잠겨 있습니다' };
      },
    } });
    expect(await brain.sessions.ingest({ session: TOKEN, transcriptPath: PATH })).toMatchObject({ ok: true, spooled: false });
    expect(store.snapshot().failures[0]?.resolvedAt).toBeNull();
  });
});

it('메시지보다 먼저 온 첨부 연결은 시도를 쓰고 나중에 메시지가 생기면 원본 없이 연결한다', async () => {
  const {brain,store,spool}=await kit({withFolder:false});
  await brain.sessions.ingest({session:TOKEN,transcriptPath:PATH});
  const session=store.snapshot().sessions[0]!;
  const target=store.snapshot().messages[0]!;
  const record = { ...sampleSpoolRecord(), kind:'attachment_link' as const, payload:{session:TOKEN,harnessMessageId:'later-image',ordinal:0,sourceKind:'image',sourceRef:null,displayName:null,contentHash:'sha256:'+'a'.repeat(64),sizeBytes:1,storeKind:'local' as const,ownership:'brain' as const,locator:`aa/aa/${'a'.repeat(64)}`} };
  expect(await spool.append([record])).toMatchObject({ok:true});
  expect(await brain.queue.drain({budgetMs:DRAIN_BUDGET_MS.command})).toMatchObject({replayed:0,spoolFailed:0});
  expect(spool.records()[0]?.attempts).toBe(1);
  expect(await store.listMessageAttachments(target.id)).toEqual({ok:true,attachments:[]});
  // The saved metadata remains sufficient even when no transcript carries it.
  const fresh={...target,id:'01940000-0000-7000-8000-00000000ffff',harnessMessageId:'later-image',cwd:null};
  const {sessionId: _sessionId,...message}=fresh;
  await store.ingest({key:{harness:session.harness,harnessSessionId:session.harnessSessionId},messages:[message],toolNotes:[],attachments:[],tracking:{parserVersion:'1',cursor:null,cursorBase:null,cursorReset:false,startSource:null,endedAt:null,ingestedAt:NOW}});
  // Clear the retry delay without changing the immutable metadata.
  await spool.append([{...record,id:'01940000-0000-7000-8000-00000000fffe'}]);
  expect(await brain.queue.drain({budgetMs:DRAIN_BUDGET_MS.command})).toMatchObject({replayed:1});
  expect(await store.listMessageAttachments(message.id)).toMatchObject({ok:true,attachments:[{status:'stored',file:{contentHash:record.payload.contentHash}}]});
});
