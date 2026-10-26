import { memoryFileStore } from '../src/testing/fakes/file-store.js';
import { describe, expect, it } from 'vitest';
import { transcriptChanges } from '../src/capture/scan.js';
import type { ParserCursor } from '../src/domain/session.js';
import { formatSessionToken } from '../src/domain/session-token.js';
import type { ParseResult, Parser } from '../src/ports/parser.js';
import type { Checkout } from '../src/ports/repository.js';
import { ingestSession, type IngestSessionDependencies } from '../src/sessions/ingest.js';
import { fixedClock } from '../src/testing/fakes/clock.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import { memoryParser, memoryTranscript } from '../src/testing/fakes/parser.js';
import {
  memoryRepositories,
  type MemoryRepositories,
} from '../src/testing/fakes/repository.js';
import { memorySpool, type MemorySpool } from '../src/testing/fakes/spool.js';
import { memoryStore, type MemoryStore } from '../src/testing/fakes/store.js';
import {
  memoryTranscriptReader,
  type MemoryTranscriptReader,
} from '../src/testing/fakes/transcript.js';
import { memoryTranscriptFolder } from '../src/testing/fakes/transcript-folder.js';
import { isUuidV7 } from '../src/testing/uuid-v7.js';

/**
 * The ingest use case against the in-memory ports: the Core rows of the
 * story's I/O matrix. There is no filesystem, no SQLite and no CLI in here —
 * what is checked is the order the use case does things in and what it decides
 * when one of them has nothing to give.
 */

const PATH = '/memory/transcripts/session-0001.jsonl';
const TOKEN = formatSessionToken({ harness: 'demo', harnessSessionId: 'session-0001' });
const INGESTED_AT = new Date('2026-01-02T03:06:00.000Z');

/** The owner the fakes record, as the installer would have. */
const OWNER = {
  id: '01940000-0000-7000-8000-0000000000ff',
  name: 'brain-owner',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

/**
 * The folder the sample transcript's every line carries, and what git says it
 * is. The paths are made up: there is no filesystem in here (AD-1).
 */
const CWD = '/demo/repo';
const CHECKOUT: Checkout = {
  remoteUrl: 'git@demo.example:brain-owner/notes.git',
  commonDir: '/demo/repo/.git',
  worktreePath: CWD,
};

interface Kit {
  deps: IngestSessionDependencies;
  store: MemoryStore;
  spool: MemorySpool;
  transcripts: MemoryTranscriptReader;
  repositories: MemoryRepositories;
}

interface KitOptions {
  /** What is at `PATH`. Left out, the sample transcript is. */
  content?: string;
  /** Put nothing at the path at all, which is the "no such file" row. */
  missing?: boolean;
  /** Skip the install step, so there is no owner to attribute a session to. */
  withoutOwner?: boolean;
  /**
   * What git answers, by folder. Left out, `CWD` is the checkout above; `{}`
   * is the "outside a repository" row.
   */
  checkouts?: Readonly<Record<string, Checkout>>;
  /** The spool a turn goes to when the store will not take it. */
  spool?: MemorySpool;
  /**
   * The harness's transcript folder, for a call that gives no path. Left out,
   * there is none — which is what this build's capture switch being off means
   * (Boundaries, Decision 1 2026-10-19).
   */
  folderFiles?: readonly { harnessSessionId: string; path: string }[];
  /** Answer every listing with this instead of the files. */
  folderFailure?: string;
}

async function kit(options: KitOptions = {}): Promise<Kit> {
  const store = memoryStore();
  if (options.withoutOwner !== true) {
    await store.ensureSelfUser(OWNER);
  }
  const transcripts = memoryTranscriptReader(
    options.missing === true
      ? {}
      : { files: { [PATH]: options.content ?? memoryTranscript } },
  );
  const repositories = memoryRepositories(options.checkouts ?? { [CWD]: CHECKOUT });
  const spool = options.spool ?? memorySpool();
  return {
    store,
    spool,
    transcripts,
    repositories,
    deps: {
      files: memoryFileStore(),
      store,
      spool,
      clock: fixedClock(INGESTED_AT),
      idGen: sequenceIdGen({ timestampMs: INGESTED_AT.getTime() }),
      parsers: [memoryParser()],
      transcripts,
      ...(options.folderFiles === undefined && options.folderFailure === undefined
        ? {}
        : {
            transcriptFolders: [
              memoryTranscriptFolder({
                harness: 'demo',
                files: (options.folderFiles ?? []).map((file) => ({
                  ...file,
                  sizeBytes: 1,
                  modifiedAt: INGESTED_AT,
                })),
                ...(options.folderFailure === undefined
                  ? {}
                  : { listFailure: options.folderFailure }),
              }),
            ],
          }),
      repositories,
      machine: 'demo-machine',
    },
  };
}

describe('sessions.ingest and what the parser walked past', () => {
  /** A parser that answers like the memory one, with the counts it is given. */
  function counting(droppedLines: Record<string, number>): Parser {
    const inner = memoryParser();
    return {
      ...inner,
      parse: (content, cursor): ParseResult => {
        const result = inner.parse(content, cursor);
        return result.ok ? { ...result, droppedLines } : result;
      },
    };
  }

  it('reports the counts and raises no warning for the lines a filter dropped', async () => {
    const { deps } = await kit();

    const result = await ingestSession(
      { ...deps, parsers: [counting({ unreadable: 0, not_conversation: 7 })] },
      { session: TOKEN, transcriptPath: PATH },
    );

    expect(result).toMatchObject({
      ok: true,
      // A transcript is mostly not conversation, so this is the normal shape of
      // a successful ingest and not a complaint (story 23).
      droppedLines: { unreadable: 0, not_conversation: 7 },
      warnings: [],
    });
  });

  it('warns once when part of the transcript could not be read at all', async () => {
    const { deps } = await kit();

    const result = await ingestSession(
      { ...deps, parsers: [counting({ unreadable: 2, not_conversation: 1 })] },
      { session: TOKEN, transcriptPath: PATH },
    );

    expect(result).toMatchObject({
      ok: true,
      droppedLines: { unreadable: 2, not_conversation: 1 },
      // The rest of the file was collected, and never in silence (NFR-2).
      warnings: ['TRANSCRIPT_LINES_SKIPPED'],
    });
  });

  it('warns behind the store, and about a read that stored nothing', async () => {
    const { deps, store } = await kit();
    const parsers = [counting({ unreadable: 1 })];
    expect(
      (await ingestSession({ ...deps, parsers }, { session: TOKEN, transcriptPath: PATH })).ok,
    ).toBe(true);
    // A read of the same content again: nothing new to store, and the broken
    // line is still there to be told about.
    const again = await ingestSession(
      { ...deps, parsers },
      { session: TOKEN, transcriptPath: PATH },
    );
    expect(again).toMatchObject({
      ok: true,
      inserted: { messages: 0, toolNotes: 0 },
      warnings: ['TRANSCRIPT_LINES_SKIPPED'],
    });

    // And behind the store's own warning, which is about the write rather than
    // about the file it came out of.
    const reset = {
      ...memoryParser(),
      parse: (content: string, cursor?: ParserCursor | null): ParseResult => {
        const result = memoryParser().parse(content, cursor);
        return result.ok
          ? { ...result, cursorReset: true, droppedLines: { unreadable: 1 } }
          : result;
      },
    };
    const third = await ingestSession(
      { ...deps, parsers: [reset] },
      { session: TOKEN, transcriptPath: PATH },
    );
    expect(third).toMatchObject({
      ok: true,
      warnings: ['CURSOR_RESET', 'TRANSCRIPT_LINES_SKIPPED'],
    });
    expect(store.snapshot().sessions).toHaveLength(1);
  });

  it('says nothing about skipped lines for a read that never happened', async () => {
    // `findSession` is the one store step in front of the parse, so this spool
    // mark is written before any file was read: `null` is the honest answer,
    // where an empty record would read as "the whole file was conversation".
    const { deps, store } = await kit();

    const result = await ingestSession(
      {
        ...deps,
        store: {
          ...store,
          async findSession() {
            return { ok: false, code: 'DB_UNAVAILABLE', message: 'the database is away' };
          },
        },
      },
      { session: TOKEN, transcriptPath: PATH },
    );

    expect(result).toMatchObject({
      ok: true,
      spooled: true,
      droppedLines: null,
      warnings: ['SPOOLED', 'DB_UNAVAILABLE'],
    });
  });

  it('still reports the counts and the warning when the write is spooled', async () => {
    // The lock is found in the middle of the use case, by which time the file
    // has been read: what the parse walked past is a fact about the transcript
    // and not about where the write went, and a line it could not read at all
    // still has to be reported (NFR-2).
    const { deps, store } = await kit();

    const result = await ingestSession(
      {
        ...deps,
        parsers: [counting({ unreadable: 3, not_conversation: 2 })],
        store: {
          ...store,
          async ingest() {
            return { ok: false, code: 'DB_UNAVAILABLE', message: 'the database is away' };
          },
        },
      },
      { session: TOKEN, transcriptPath: PATH },
    );

    expect(result).toMatchObject({
      ok: true,
      spooled: true,
      droppedLines: { unreadable: 3, not_conversation: 2 },
      // Where the write went first, then what the file looked like.
      warnings: ['SPOOLED', 'DB_UNAVAILABLE', 'TRANSCRIPT_LINES_SKIPPED'],
    });
  });
});

describe('sessions.ingest on a transcript nothing has read yet', () => {
  it('creates the session, attributes it to the owner, and stores every message', async () => {
    const { deps, store } = await kit();

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(result).toMatchObject({
      ok: true,
      session: TOKEN,
      created: true,
      inserted: { messages: 4, toolNotes: 2 },
      warnings: [],
    });

    const snapshot = store.snapshot();
    expect(snapshot.sessions).toHaveLength(1);
    const [session] = snapshot.sessions;
    expect(session).toMatchObject({
      harness: 'demo',
      harnessSessionId: 'session-0001',
      userId: OWNER.id,
      machine: 'demo-machine',
      ingestSource: 'live',
      // Slice 1 never groups projects, and the sample transcript says the
      // harness started the session fresh.
      workspaceId: null,
      startSource: 'startup',
    });
    // Tagged from the first message's folder, with the rows the tags point at
    // (AD-12). The identity is the normalized remote, not the URL git printed.
    expect(snapshot.projects).toEqual([
      {
        id: session?.projectId,
        remoteIdentity: 'demo.example/brain-owner/notes',
        workspaceId: null,
      },
    ]);
    expect(snapshot.worktrees).toEqual([
      { id: session?.worktreeId, projectId: session?.projectId, path: CWD, removedAt: null },
    ]);
    // The first utterance of the transcript, not the moment it was read (AD-13).
    expect(session?.startedAt).toEqual(new Date('2026-01-02T03:04:05.000Z'));
    expect(session?.ingestedAt).toEqual(INGESTED_AT);
    // Every id is the use case's, minted through the port (AD-8).
    expect(isUuidV7(session?.id ?? '')).toBe(true);
    for (const message of snapshot.messages) expect(isUuidV7(message.id)).toBe(true);
  });

  it('reads the messages back in the order they were uttered', async () => {
    const { deps, store } = await kit();

    await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    const read = await store.readSession(TOKEN);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // No number anywhere: the order is `occurredAt`, which for this transcript
    // is also the order of the file (migration 0006).
    expect(
      read.messages.map((message) => [message.harnessMessageId, message.occurredAt]),
    ).toEqual([
      ['msg-1', new Date('2026-01-02T03:04:05.000Z')],
      ['msg-2', new Date('2026-01-02T03:04:07.000Z')],
      ['msg-3', new Date('2026-01-02T03:05:01.000Z')],
      ['msg-4', new Date('2026-01-02T03:05:20.000Z')],
    ]);
  });

  it('starts the session at the first message, not at the earliest timestamp', async () => {
    // A transcript whose first line carries a later instant than a line behind
    // it. Order is the position in the file and never a clock (research §4),
    // so the session started when the first message was uttered -- taking the
    // minimum would start it at a message that is not its first.
    const outOfOrder = JSON.stringify({
      messages: [
        {
          harnessMessageId: 'msg-1',
          role: 'user',
          occurredAt: '2026-01-02T03:04:05.000Z',
          body: 'the first thing said',
        },
        {
          harnessMessageId: 'msg-2',
          role: 'assistant',
          occurredAt: '2026-01-02T03:04:01.000Z',
          body: 'an answer the harness stamped earlier',
        },
      ],
    });
    const { deps, store } = await kit({ content: outOfOrder });

    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    expect(store.snapshot().sessions[0]?.startedAt).toEqual(
      new Date('2026-01-02T03:04:05.000Z'),
    );
  });

  it('reads the transcript through the port and never a path of its own', async () => {
    const { deps, transcripts } = await kit();

    await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(transcripts.reads()).toEqual([PATH]);
  });
});

describe('sessions.ingest and the folder it tags a session from', () => {
  it('asks git about the first message that carries a folder, and about nothing else', async () => {
    // The cwd of the first message that carries one is the whole of the
    // evidence (AD-12). The sample transcript carries it on every line, so the
    // point of the case is the count: one question, about the first folder.
    const { deps, repositories } = await kit({
      content: memoryTranscript.replace('"cwd":"/demo/repo"', '"cwd":"/demo/elsewhere"'),
      checkouts: { '/demo/elsewhere': { ...CHECKOUT, worktreePath: '/demo/elsewhere' } },
    });

    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    expect(repositories.inspects()).toEqual(['/demo/elsewhere']);
  });

  it('asks git nothing at all once the session is there', async () => {
    const { deps, repositories, store } = await kit();
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    const tagged = store.snapshot().sessions[0];

    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    // Once, on the ingest that created the row. Every hook after that pays
    // nothing for a git call whose answer would be thrown away (AD-12).
    expect(repositories.inspects()).toEqual([CWD]);
    const after = store.snapshot();
    expect(after.projects).toHaveLength(1);
    expect(after.worktrees).toHaveLength(1);
    expect(after.sessions[0]?.projectId).toBe(tagged?.projectId);
    expect(after.sessions[0]?.worktreeId).toBe(tagged?.worktreeId);
  });

  it('skips past a first message with no folder to the one that has it', async () => {
    // What a session that opens with a subagent's hand-back looks like: the
    // parser reports no cwd for that line, because the folder on it is the
    // subagent's and not this conversation's. Taking the first message's cwd
    // literally would leave the session untagged for ever (AD-12).
    const { deps, store, repositories } = await kit({
      content: JSON.stringify({
        messages: [
          {
            harnessMessageId: 'msg-1',
            role: 'assistant',
            occurredAt: '2026-01-02T03:04:05.000Z',
            body: 'The report a delegated run handed back.',
            isSubagentReport: true,
          },
          {
            harnessMessageId: 'msg-2',
            role: 'user',
            occurredAt: '2026-01-02T03:04:06.000Z',
            body: 'Thanks — now summarise it.',
            gitBranch: 'main',
            cwd: CWD,
          },
        ],
      }),
    });

    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    // One question, about the folder of the second message.
    expect(repositories.inspects()).toEqual([CWD]);
    const snapshot = store.snapshot();
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.worktrees[0]?.path).toBe(CWD);
    expect(snapshot.sessions[0]?.projectId).toBe(snapshot.projects[0]?.id);
    // And the session still began when its first message was uttered, folder
    // or no folder.
    expect(snapshot.sessions[0]?.startedAt).toEqual(new Date('2026-01-02T03:04:05.000Z'));
  });

  it('tags nothing and asks nothing when no message carried a folder', async () => {
    const { deps, store, repositories } = await kit({
      content: JSON.stringify({
        messages: [
          {
            harnessMessageId: 'msg-1',
            role: 'user',
            occurredAt: '2026-01-02T03:04:05.000Z',
            body: 'a line the harness wrote without a folder',
          },
        ],
      }),
    });

    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    // Nothing to inspect, and a guess would be a tag nothing can correct.
    expect(repositories.inspects()).toEqual([]);
    const snapshot = store.snapshot();
    expect(snapshot.sessions[0]).toMatchObject({ projectId: null, worktreeId: null });
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.worktrees).toEqual([]);
  });

  it('stores the session with no tags when the folder is not a repository', async () => {
    // The "outside a repository" row: git answers `null`, and the session is
    // ingested anyway. Capture comes before the tags (Decision 2026-10-18).
    const { deps, store, repositories } = await kit({ checkouts: {} });

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(result).toMatchObject({ ok: true, created: true, inserted: { messages: 4 } });
    expect(repositories.inspects()).toEqual([CWD]);
    const snapshot = store.snapshot();
    expect(snapshot.sessions[0]).toMatchObject({ projectId: null, worktreeId: null });
    expect(snapshot.projects).toEqual([]);
  });

  it('falls back to the git common directory for a repository with no remote', async () => {
    const { deps, store } = await kit({
      checkouts: { [CWD]: { ...CHECKOUT, remoteUrl: null } },
    });

    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    // The absolute path as it came, with no prefix and no machine name (AD-12).
    expect(store.snapshot().projects[0]?.remoteIdentity).toBe('/demo/repo/.git');
  });

  it('falls back to the common directory for a remote that names no repository', async () => {
    const { deps, store } = await kit({
      checkouts: { [CWD]: { ...CHECKOUT, remoteUrl: 'file:///srv/notes.git' } },
    });

    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    // A remote nothing can be named from is a remote this clone may as well
    // not have.
    expect(store.snapshot().projects[0]?.remoteIdentity).toBe('/demo/repo/.git');
  });

  it('joins two folders of a repository with no remote into a single project', async () => {
    // The `git init`-only row of the matrix: there is no remote to name the
    // project by, and the common directory is what the two folders share.
    const { deps, store, transcripts } = await kit({
      checkouts: {
        [CWD]: { remoteUrl: null, commonDir: '/demo/repo/.git', worktreePath: CWD },
        '/demo/repo-review': {
          remoteUrl: null,
          commonDir: '/demo/repo/.git',
          worktreePath: '/demo/repo-review',
        },
      },
    });
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    const other = '/memory/transcripts/session-0002.jsonl';
    transcripts.write(
      other,
      memoryTranscript.replaceAll('"cwd":"/demo/repo"', '"cwd":"/demo/repo-review"'),
    );
    expect(
      (await ingestSession(deps, { session: 'demo:session-0002', transcriptPath: other })).ok,
    ).toBe(true);

    const snapshot = store.snapshot();
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.remoteIdentity).toBe('/demo/repo/.git');
    expect(snapshot.worktrees.map((worktree) => worktree.path).sort()).toEqual([
      '/demo/repo',
      '/demo/repo-review',
    ]);
    expect(new Set(snapshot.sessions.map((session) => session.projectId)).size).toBe(1);
    expect(new Set(snapshot.sessions.map((session) => session.worktreeId)).size).toBe(2);
  });

  it('joins two folders of one repository into a single project', async () => {
    // The two-worktree row of the matrix: one remote, two tops, two sessions.
    const { deps, store, transcripts } = await kit({
      checkouts: {
        [CWD]: CHECKOUT,
        // The same repository through its https remote, which normalizes to
        // the same identity as the ssh one above.
        '/demo/repo-review': {
          remoteUrl: 'https://demo.example/brain-owner/notes',
          commonDir: '/demo/repo/.git',
          worktreePath: '/demo/repo-review',
        },
      },
    });
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    const other = '/memory/transcripts/session-0002.jsonl';
    transcripts.write(
      other,
      memoryTranscript.replaceAll('"cwd":"/demo/repo"', '"cwd":"/demo/repo-review"'),
    );
    const review = await ingestSession(deps, {
      session: 'demo:session-0002',
      transcriptPath: other,
    });

    expect(review.ok).toBe(true);
    const snapshot = store.snapshot();
    // One project, two worktrees, and the two sessions tagged accordingly: an
    // ssh clone and an https clone of one repository are one project.
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.worktrees.map((worktree) => worktree.path).sort()).toEqual([
      '/demo/repo',
      '/demo/repo-review',
    ]);
    const projectIds = new Set(snapshot.sessions.map((session) => session.projectId));
    expect(projectIds.size).toBe(1);
    expect(new Set(snapshot.sessions.map((session) => session.worktreeId)).size).toBe(2);
  });
});

describe('sessions.ingest and the secrets it stores exactly as it read them', () => {
  /**
   * A transcript whose conversation carries invented secrets, and one Bash call
   * whose command carries another. Everything in here has the shape of the real
   * thing and none of it is valid anywhere.
   */
  const SECRETS = JSON.stringify({
    startSource: 'startup',
    messages: [
      {
        harnessMessageId: 'msg-1',
        role: 'user',
        occurredAt: '2026-01-02T03:04:05.000Z',
        cwd: CWD,
        body: '키는 sk-AAAAAAAAAAAAAAAAAAAA 이고 비밀번호는 Tiger2024',
      },
      {
        harnessMessageId: 'msg-2',
        role: 'assistant',
        occurredAt: '2026-01-02T03:04:06.000Z',
        cwd: CWD,
        body: 'notes/import.md 를 보세요. 커밋은 9f1c0e2a7b3d4e5f60718293a4b5c6d7e8f90123 입니다.',
        toolCalls: [{ tool: 'bash', target: 'OPENAI_API_KEY=xyz123 node run.js' }],
      },
    ],
  });

  it('stores the body and the target character for character, and masks nothing', async () => {
    // 마스킹 B: a stored message is never rewritten, so over-masking on the way
    // in would be a deletion nobody could undo. The secrets go in whole and the
    // output codecs take them out on the way back (AD-11).
    const { deps, store } = await kit({ content: SECRETS });

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(result).toMatchObject({
      ok: true,
      inserted: { messages: 2, toolNotes: 1 },
    });

    const snapshot = store.snapshot();
    expect(snapshot.messages.map((message) => message.body)).toEqual([
      '키는 sk-AAAAAAAAAAAAAAAAAAAA 이고 비밀번호는 Tiger2024',
      'notes/import.md 를 보세요. 커밋은 9f1c0e2a7b3d4e5f60718293a4b5c6d7e8f90123 입니다.',
    ]);
    expect(snapshot.toolNotes.map((note) => note.target)).toEqual([
      'OPENAI_API_KEY=xyz123 node run.js',
    ]);
    // No marker anywhere, and no record of one either.
    expect(JSON.stringify(snapshot)).not.toContain('[REDACTED:');
    expect(snapshot.redactions).toEqual([]);
  });

  it('counts the messages and the tool notes, and nothing else', async () => {
    const { deps } = await kit({ content: SECRETS });

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.inserted).sort()).toEqual(['messages', 'toolNotes']);
  });

  it('writes no record the second time the same transcript is read either', async () => {
    const { deps, store } = await kit({ content: SECRETS });
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    const again = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(again).toMatchObject({ ok: true, inserted: { messages: 0, toolNotes: 0 } });
    expect(store.snapshot().redactions).toEqual([]);
  });

  it('tags the session from the folder of a message that carried a secret', async () => {
    // The body is not touched and neither is `cwd`: the tags are read from it
    // (AD-12), and this case is what says the two never interfered.
    const { deps, store, repositories } = await kit({ content: SECRETS });

    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    expect(repositories.inspects()).toEqual([CWD]);
    expect(store.snapshot().worktrees[0]?.path).toBe(CWD);
  });
});

describe('sessions.ingest on a transcript it has already read', () => {
  it('adds nothing the second time and reports the same session', async () => {
    const { deps, store } = await kit();
    const first = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });
    expect(first.ok).toBe(true);

    const second = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(second).toMatchObject({
      ok: true,
      created: false,
      inserted: { messages: 0, toolNotes: 0 },
    });
    const snapshot = store.snapshot();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(4);
    expect(snapshot.toolNotes).toHaveLength(2);
  });

  it('appends only what grew, and reads the whole conversation in order', async () => {
    const shorter = JSON.stringify({
      messages: [
        {
          harnessMessageId: 'msg-1',
          role: 'user',
          occurredAt: '2026-01-02T03:04:05.000Z',
          body: 'Where did we leave the import notes?',
        },
      ],
    });
    const { deps, store, transcripts } = await kit({ content: shorter });
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    transcripts.write(PATH, memoryTranscript);
    const again = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(again).toMatchObject({ ok: true, created: false, inserted: { messages: 3 } });
    const read = await store.readSession(TOKEN);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.messages.map((message) => message.harnessMessageId)).toEqual([
      'msg-1',
      'msg-2',
      'msg-3',
      'msg-4',
    ]);
  });
});

describe('sessions.ingest and the cursor it starts from', () => {
  it('reads the stored cursor before the transcript and hands it to the parser', async () => {
    const { deps, store } = await kit();
    const seen: (ParserCursor | null | undefined)[] = [];
    const inner = memoryParser();
    const watched = {
      ...inner,
      parse(content: string, cursor?: ParserCursor | null) {
        seen.push(cursor);
        return inner.parse(content, cursor);
      },
    };
    const deps2 = { ...deps, parsers: [watched] };

    await ingestSession(deps2, { session: TOKEN, transcriptPath: PATH });
    await ingestSession(deps2, { session: TOKEN, transcriptPath: PATH });

    // The first read has nothing to start from; the second starts at the
    // message the first one stopped at, which is the whole point of the order
    // `findSession → read → parse` (AD-4).
    const read = await store.readSession(TOKEN);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(seen[0]).toBeNull();
    expect(seen[1]).toEqual(read.session.cursor);
  });

  it('빈 다시 읽기도 현재 parser 버전을 기록한다', async () => {
    const { deps, store } = await kit();
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    const next: Parser = { ...memoryParser({ version: '2' }), parse: () => ({
      ok: true, parserVersion: '2', messages: [], attachments: [], toolNotes: [], cursor: null,
      cursorReset: false, startSource: null, startCwd: null, droppedLines: { unreadable: 0 },
    }) };
    expect(await ingestSession({ ...deps, parsers: [next] }, { session: TOKEN, transcriptPath: PATH }))
      .toMatchObject({ ok: true, inserted: { messages: 0, toolNotes: 0 } });
    expect(store.snapshot().sessions[0]?.parserVersion).toBe('2');
    expect(await store.listStaleSessions({ harness: 'demo', parserVersion: '2' }))
      .toEqual({ ok: true, sessions: [] });
  });

  it('읽기가 시작한 시각을 내역에 남긴다', async () => {
    const { deps, store, transcripts } = await kit();
    let now = INGESTED_AT;
    const result = await ingestSession({ ...deps, clock: { now: () => now }, transcripts: {
      async read(path) { now = new Date(INGESTED_AT.getTime() + 5000); return transcripts.read(path); },
    } }, { session: TOKEN, transcriptPath: PATH });
    expect(result.ok).toBe(true);
    expect(store.snapshot().transcriptFiles[0]?.scannedAt).toEqual(INGESTED_AT);
  });

  it('hands over no cursor for a session another parser version read', async () => {
    const { deps, store } = await kit();
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    const stored = await store.readSession(TOKEN);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.session.cursor).not.toBeNull();

    // The same session, read again by a parser whose rules have moved. The
    // cursor it left means something else now — lines it dropped are messages
    // under the new rules — so the transcript is read from the front again.
    const seen: (ParserCursor | null | undefined)[] = [];
    const inner = memoryParser({ version: '2' });
    const next = {
      ...inner,
      parse(content: string, cursor?: ParserCursor | null) {
        seen.push(cursor);
        return inner.parse(content, cursor);
      },
    };

    const again = await ingestSession(
      { ...deps, parsers: [next] },
      { session: TOKEN, transcriptPath: PATH },
    );

    expect(again.ok).toBe(true);
    expect(seen).toEqual([null]);
    // Reading it all again is idempotent, so nothing is inserted twice, and
    // the session now records the version that read it (AD-4, AD-8).
    expect(again).toMatchObject({ inserted: { messages: 0, toolNotes: 0 } });
    expect(store.snapshot().sessions[0]?.parserVersion).toBe('2');
  });

  it('warns with CURSOR_RESET when the transcript no longer fits the cursor', async () => {
    const { deps, store, transcripts } = await kit();
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    const before = await store.readSession(TOKEN);
    expect(before.ok).toBe(true);

    // What a compact or a fork does: the part the cursor fingerprinted is not
    // what it was any more, so the parse starts at the front again.
    transcripts.write(
      PATH,
      memoryTranscript.replace(
        'Where did we leave the import notes?',
        'Where did we put the import notes?',
      ),
    );
    const again = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(again).toMatchObject({ ok: true, warnings: ['CURSOR_RESET'] });
    // Degraded but successful: nothing already stored changed, because ingest
    // is idempotent on the harness message id (AD-8).
    const after = await store.readSession(TOKEN);
    expect(after.ok).toBe(true);
    if (!after.ok || !before.ok) return;
    expect(after.messages).toEqual(before.messages);
  });

  it('warns and clears the cursor when a reset read finds no message at all', async () => {
    const { deps, store, transcripts } = await kit();
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    const before = await store.readSession(TOKEN);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.session.cursor).not.toBeNull();

    // The transcript was rewritten down to something with no conversation in
    // it. The cursor cannot be found, so the parse resets — and then it finds
    // nothing, which used to end the call before the warning or the stale
    // cursor could be dealt with (follow-up review #16).
    transcripts.write(PATH, JSON.stringify({ messages: [] }));
    const reset = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(reset).toMatchObject({
      ok: true,
      created: false,
      inserted: { messages: 0, toolNotes: 0 },
      warnings: ['CURSOR_RESET'],
    });
    const after = await store.readSession(TOKEN);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.session.cursor).toBeNull();
    // Nothing stored was touched, because ingest is idempotent (AD-8).
    expect(after.messages).toEqual(before.messages);

    // And the next read of the same file is no longer a reset: there is no
    // cursor left for it to fail to match.
    const again = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });
    expect(again).toMatchObject({ ok: true, warnings: [] });
  });

  it('reports the collection when the transcript history throws', async () => {
    const { deps, store } = await kit();
    const throwing: MemoryStore = {
      ...store,
      recordTranscriptFile() {
        // An adapter that throws where the port says it answers. The history is
        // a shortcut nothing depends on, so the turn it was collecting must not
        // break over it (follow-up review #19).
        throw new Error('the history table is gone');
      },
    };

    const result = await ingestSession(
      { ...deps, store: throwing },
      { session: TOKEN, transcriptPath: PATH },
    );

    expect(result).toMatchObject({
      ok: true,
      created: true,
      inserted: { messages: 4, toolNotes: 2 },
      warnings: [],
    });
    expect(store.snapshot().messages).toHaveLength(4);
  });

  it('reports the empty read when the transcript history throws', async () => {
    // The other call site of the same shortcut: the early return that a
    // transcript with no conversation in it takes.
    const { deps, store } = await kit({ content: JSON.stringify({ messages: [] }) });
    const throwing: MemoryStore = {
      ...store,
      recordTranscriptFile() {
        throw new Error('the history table is gone');
      },
    };

    const result = await ingestSession(
      { ...deps, store: throwing },
      { session: TOKEN, transcriptPath: PATH },
    );

    expect(result).toMatchObject({ ok: true, inserted: { messages: 0, toolNotes: 0 } });
    expect(store.snapshot().sessions).toEqual([]);
  });

  it('ingests a batch of tool notes alone into a session that is already there', async () => {
    // A read that found no new message but did find the answer to a call the
    // last read left waiting. There is no row to create and nothing to
    // attribute, and the notes belong to messages the session already holds.
    const { deps, store } = await kit();
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    const notesOnly = {
      ...memoryParser(),
      parse: (): ParseResult => ({
        ok: true,
        parserVersion: '1',
        messages: [], attachments: [],
        toolNotes: [
          {
            harnessMessageId: 'msg-2',
            ordinal: 2,
            tool: 'read',
            target: 'notes/open.md',
            ok: false,
            callId: null,
            earlierPositions: [],
          },
        ],
        cursor: null,
        cursorReset: false,
        startSource: null,
        startCwd: null,
        droppedLines: { unreadable: 0 },
      }),
    };

    const result = await ingestSession(
      { ...deps, parsers: [notesOnly] },
      { session: TOKEN, transcriptPath: PATH },
    );

    expect(result).toMatchObject({
      ok: true,
      created: false,
      inserted: { messages: 0, toolNotes: 1 },
    });
    expect(store.snapshot().toolNotes).toHaveLength(3);
  });

  it('creates no session for a batch of tool notes with no session to put them in', async () => {
    const { deps, store } = await kit();
    const notesOnly = {
      ...memoryParser(),
      parse: (): ParseResult => ({
        ok: true,
        parserVersion: '1',
        messages: [], attachments: [],
        toolNotes: [
          {
            harnessMessageId: 'msg-2',
            ordinal: 0,
            tool: 'read',
            target: 'notes/open.md',
            ok: true,
            callId: null,
            earlierPositions: [],
          },
        ],
        cursor: null,
        cursorReset: false,
        startSource: null,
        startCwd: null,
        droppedLines: { unreadable: 0 },
      }),
    };

    const result = await ingestSession(
      { ...deps, parsers: [notesOnly] },
      { session: TOKEN, transcriptPath: PATH },
    );

    // A session row created for notes alone would be a session with no
    // conversation in it, and no `started_at` that is true.
    expect(result).toMatchObject({ ok: true, inserted: { messages: 0, toolNotes: 0 } });
    expect(store.snapshot().sessions).toEqual([]);
  });

  it('passes the start source the transcript carried to the session row', async () => {
    const { deps, store } = await kit({
      content: memoryTranscript.replace('"startSource":"startup"', '"startSource":"compact"'),
    });

    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);

    expect(store.snapshot().sessions[0]?.startSource).toBe('compact');
  });
});

describe('sessions.ingest when there is nothing to ingest', () => {
  it('creates no session for a transcript with no conversation in it', async () => {
    const { deps, store } = await kit({ content: JSON.stringify({ messages: [] }) });

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    // Not a failure: a session's first seconds look exactly like this, and the
    // next hook picks the conversation up (research §1).
    expect(result).toMatchObject({
      ok: true,
      created: false,
      inserted: { messages: 0, toolNotes: 0 },
    });
    expect(store.snapshot().sessions).toEqual([]);
  });

  it('writes nothing when the transcript is not there', async () => {
    const { deps, store } = await kit({ missing: true });

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(result).toMatchObject({ ok: false, code: 'TRANSCRIPT_UNREADABLE' });
    expect(store.snapshot().sessions).toEqual([]);
  });

  it('writes nothing when the transcript cannot be parsed', async () => {
    const { deps, store } = await kit({ content: 'not json at all {' });

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(result).toMatchObject({ ok: false, code: 'TRANSCRIPT_UNREADABLE' });
    expect(store.snapshot().sessions).toEqual([]);
  });
});

describe('sessions.ingest and the session it was asked for', () => {
  it('refuses a token that is not one', async () => {
    const { deps } = await kit();

    const result = await ingestSession(deps, { session: 'session-0001', transcriptPath: PATH });

    expect(result).toMatchObject({ ok: false, code: 'USAGE' });
  });

  it('refuses a harness this build cannot read, naming the ones it can', async () => {
    const { deps, transcripts } = await kit();

    const result = await ingestSession(deps, {
      session: 'other:session-0001',
      transcriptPath: PATH,
    });

    expect(result).toMatchObject({ ok: false, code: 'USAGE' });
    if (result.ok) return;
    expect(result.message).toContain('demo');
    // Refused before anything was read: choosing the parser comes first.
    expect(transcripts.reads()).toEqual([]);
  });

  it('says it cannot find the transcript when no path was given and no folder is read', async () => {
    // A call with no path looks the file up in that harness's folder, and a
    // build with no folder for it has nowhere to look — which is what the
    // capture switch being off means (Boundaries, Decision 1).
    const { deps } = await kit();

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: '' });

    expect(result).toMatchObject({ ok: false, code: 'TRANSCRIPT_UNREADABLE' });
    if (result.ok) return;
    expect(result.message).toContain('트랜스크립트를 찾을 수 없습니다');
  });
});

describe('sessions.ingest on a database with no owner', () => {
  it('says USER_MISSING and writes nothing', async () => {
    const { deps, store } = await kit({ withoutOwner: true });

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(result).toMatchObject({ ok: false, code: 'USER_MISSING' });
    expect(store.snapshot().sessions).toEqual([]);
    expect(store.snapshot().messages).toEqual([]);
  });

  it('does not ask who the owner is for a transcript with nothing in it', async () => {
    // The owner is read only once there is something to attribute, so an empty
    // transcript on a half-installed brain is still a quiet success.
    const { deps } = await kit({
      withoutOwner: true,
      content: JSON.stringify({ messages: [] }),
    });

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(result.ok).toBe(true);
  });
});

describe('sessions.ingest when the store cannot take the write', () => {
  /**
   * A store whose one step answers like a database out of reach.
   *
   * The code differs by step because the port does: a read can only fail with
   * `DB_UNAVAILABLE` — nothing waits on a lock to read, under WAL — and only
   * the two writes can come back `DB_LOCKED` (`ports/store.ts`).
   */
  function refusing(
    store: MemoryStore,
    step: 'findSession' | 'readSelfUser' | 'ensureSession' | 'ingest',
    code: 'DB_UNAVAILABLE' | 'DB_LOCKED',
  ): MemoryStore {
    const message = 'the database is out of reach';
    const unavailable = { ok: false as const, code: 'DB_UNAVAILABLE' as const, message };
    const refusal = { ok: false as const, code, message };
    switch (step) {
      case 'findSession':
        return { ...store, findSession: async () => unavailable };
      case 'readSelfUser':
        return { ...store, readSelfUser: async () => unavailable };
      case 'ensureSession':
        return { ...store, ensureSession: async () => refusal };
      default:
        return { ...store, ingest: async () => refusal };
    }
  }

  it.each([
    ['the session row', 'ensureSession'],
    ['the batch', 'ingest'],
  ] as const)('spools the turn when %s meets a held lock', async (_what, step) => {
    const { deps, store, spool } = await kit();

    const result = await ingestSession(
      { ...deps, store: refusing(store, step, 'DB_LOCKED') },
      { session: TOKEN, transcriptPath: PATH },
    );

    // A success, because the turn worked: the conversation is safe and a later
    // drain will put it in (AD-9, NFR-3). The counts say what reached the
    // database, which is nothing.
    expect(result).toEqual({
      ok: true,
      session: TOKEN,
      spooled: true,
      created: false,
      inserted: { messages: 0, toolNotes: 0 },
      // The lock was met *after* the parse, so what the read found is still
      // reported: the file was read either way (AD-9).
      droppedLines: { unreadable: 0 },
      // `DB_LOCKED` is not a warning code, so a lock leaves `SPOOLED` alone,
      // and this read had nothing of its own to add.
      warnings: ['SPOOLED'],
    });
    expect(spool.records()).toEqual([
      {
        schemaVersion: 1,
        id: expect.any(String),
        kind: 'session_ingest',
        occurredAt: INGESTED_AT,
        // No replay has failed yet: the count is the replay's own bookkeeping.
        attempts: 0,
        payload: { session: TOKEN, transcriptPath: PATH, cause: 'DB_LOCKED' },
      },
    ]);
    // The transcript is not in the record: the replay reads the file again,
    // and a copy would be stale the moment it was written (story 12).
    expect(JSON.stringify(spool.records())).not.toContain('import notes');
  });

  it.each([
    ['the cursor read', 'findSession'],
    ['the owner read', 'readSelfUser'],
    ['the session row', 'ensureSession'],
    ['the batch', 'ingest'],
  ] as const)(
    'spools the turn, and names the cause beside SPOOLED, when %s cannot reach the database',
    async (_what, step) => {
      const { deps, store, spool } = await kit();

      const result = await ingestSession(
        { ...deps, store: refusing(store, step, 'DB_UNAVAILABLE') },
        { session: TOKEN, transcriptPath: PATH },
      );

      // Two facts, and a reader needs both: the write is in the spool, and the
      // database was unreachable (NFR-2).
      expect(result).toMatchObject({
        ok: true,
        spooled: true,
        created: false,
        inserted: { messages: 0, toolNotes: 0 },
        warnings: ['SPOOLED', 'DB_UNAVAILABLE'],
      });
      expect(spool.records()[0]?.payload).toEqual({
        session: TOKEN,
        transcriptPath: PATH,
        cause: 'DB_UNAVAILABLE',
      });
    },
  );

  it('spools once, at the first step that could not write', async () => {
    // Which is what keeps a hook to one lock budget: a turn that waited three
    // seconds four times would be a turn the person is waiting twelve for
    // (Boundaries).
    const { deps, store, spool } = await kit();
    const refusal = {
      ok: false as const,
      code: 'DB_LOCKED' as const,
      message: 'the database is out of reach',
    };
    const calls: string[] = [];
    const locked: MemoryStore = {
      ...store,
      async findSession(key) {
        calls.push('findSession');
        return store.findSession(key);
      },
      async readSelfUser() {
        calls.push('readSelfUser');
        // A read can only be unavailable; nothing waits on a lock to read.
        return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: refusal.message };
      },
      async ensureSession() {
        calls.push('ensureSession');
        return refusal;
      },
      async ingest() {
        calls.push('ingest');
        return refusal;
      },
    };

    expect(
      await ingestSession({ ...deps, store: locked }, { session: TOKEN, transcriptPath: PATH }),
    ).toMatchObject({ ok: true, spooled: true });

    expect(calls).toEqual(['findSession', 'readSelfUser']);
    expect(spool.records()).toHaveLength(1);
  });

  it('reports the original failure when the spool could not take it either', async () => {
    const spool = memorySpool({ appendFailure: 'spool 폴더 자리에 일반 파일이 있습니다' });
    const { deps, store } = await kit({ spool });

    const result = await ingestSession(
      { ...deps, store: refusing(store, 'ensureSession', 'DB_LOCKED') },
      { session: TOKEN, transcriptPath: PATH },
    );

    // The code stays the cause's — that is what a caller acts on — and the
    // message carries both halves (Boundaries).
    expect(result).toMatchObject({ ok: false, code: 'DB_LOCKED' });
    if (result.ok) return;
    expect(result.message).toContain('spool');
    expect(result.message).toContain('일반 파일');
  });

  it('does not spool a failure no amount of waiting fixes', async () => {
    // A database with no owner, a transcript that is not there, a token that
    // is not one: none of them is a write the database refused (AD-21).
    const missingOwner = await kit({ withoutOwner: true });
    expect(
      await ingestSession(missingOwner.deps, { session: TOKEN, transcriptPath: PATH }),
    ).toMatchObject({ ok: false, code: 'USER_MISSING' });
    expect(missingOwner.spool.records()).toEqual([]);

    const noTranscript = await kit({ missing: true });
    expect(
      await ingestSession(noTranscript.deps, { session: TOKEN, transcriptPath: PATH }),
    ).toMatchObject({ ok: false, code: 'TRANSCRIPT_UNREADABLE' });
    expect(noTranscript.spool.records()).toEqual([]);

    const badToken = await kit();
    expect(
      await ingestSession(badToken.deps, { session: 'session-0001', transcriptPath: PATH }),
    ).toMatchObject({ ok: false, code: 'USAGE' });
    expect(badToken.spool.records()).toEqual([]);
  });

  it('writes nothing to the spool on an ordinary ingest', async () => {
    const { deps, spool } = await kit();

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(result).toMatchObject({ ok: true, spooled: false });
    expect(spool.records()).toEqual([]);
  });
});

describe('sessions.ingest when the caller gave no transcript path', () => {
  it('finds the file in that harness folder by session id', async () => {
    const { deps, store, transcripts } = await kit({
      folderFiles: [{ harnessSessionId: 'session-0001', path: PATH }],
    });

    const result = await ingestSession(deps, { session: TOKEN });

    expect(result).toMatchObject({ ok: true, created: true });
    // The path the folder named, and no other: Core never builds one.
    expect(transcripts.reads()).toEqual([PATH]);
    expect(store.snapshot().sessions).toHaveLength(1);
  });

  it('says it cannot find it when the folder holds no file for that session', async () => {
    const { deps, transcripts } = await kit({
      folderFiles: [{ harnessSessionId: 'session-9999', path: '/elsewhere.jsonl' }],
    });

    const result = await ingestSession(deps, { session: TOKEN });

    expect(result).toMatchObject({ ok: false, code: 'TRANSCRIPT_UNREADABLE' });
    // Nothing was opened: there was nothing to open.
    expect(transcripts.reads()).toEqual([]);
  });

  it('says why when the folder itself could not be listed', async () => {
    const { deps } = await kit({ folderFailure: 'EACCES: permission denied' });

    const result = await ingestSession(deps, { session: TOKEN });

    expect(result).toMatchObject({ ok: false, code: 'TRANSCRIPT_UNREADABLE' });
    if (result.ok) return;
    // The reason is in the sentence, because the three ways to come back with
    // nothing have different fixes (`locateTranscript`).
    expect(result.message).toContain('EACCES');
  });

  it('never looks in a folder when the caller did give a path', async () => {
    // The hook path does not depend on the folders at all: a path the harness
    // named is the path that is read (Boundaries).
    const { deps, transcripts } = await kit();

    expect(await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).toMatchObject({
      ok: true,
    });
    expect(transcripts.reads()).toEqual([PATH]);
  });
});

describe('sessions.ingest and where the session came from', () => {
  it('records a session the caller called an import as one', async () => {
    const { deps, store } = await kit();

    await ingestSession(deps, { session: TOKEN, transcriptPath: PATH, source: 'import' });

    expect(store.snapshot().sessions[0]).toMatchObject({ ingestSource: 'import' });
  });

  it('leaves the source of a session that is already there alone', async () => {
    // Decided once, when the row is created, and never again: a session first
    // seen by a folder scan stays an import however many live turns follow
    // (Table Contract).
    const { deps, store } = await kit();
    await ingestSession(deps, { session: TOKEN, transcriptPath: PATH, source: 'import' });

    await ingestSession(deps, { session: TOKEN, transcriptPath: PATH, source: 'live' });

    expect(store.snapshot().sessions[0]).toMatchObject({ ingestSource: 'import' });
  });

  it('defaults to live, which is what a hook reports', async () => {
    const { deps, store } = await kit();

    await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    expect(store.snapshot().sessions[0]).toMatchObject({ ingestSource: 'live' });
  });
});

describe('sessions.ingest and the history it leaves for the next scan', () => {
  it('records what it read: the bytes, their fingerprint and this cursor', async () => {
    const { deps, store } = await kit();

    await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    const [history] = store.snapshot().transcriptFiles;
    expect(history).toMatchObject({ harness: 'demo', path: PATH });
    expect(history?.sizeBytes).toBe(Buffer.byteLength(memoryTranscript, 'utf8'));
    expect(history?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The cursor the parse produced, so the next read starts where this one
    // stopped (AD-4).
    expect(history?.cursor).not.toBe(null);
    expect(history?.scannedAt.getTime()).toBe(INGESTED_AT.getTime());
  });

  it('커서가 맞는 축소 파일은 나중 읽기의 작은 크기를 기록해 다시 넣지 않는다', async () => {
    const original = memoryTranscript + ' '.repeat(100);
    const { deps, store, transcripts } = await kit({ content: original });
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    const cursor = store.snapshot().sessions[0]?.cursor;
    transcripts.write(PATH, memoryTranscript);
    const later = { ...deps, clock: fixedClock(new Date(INGESTED_AT.getTime() + 1)) };
    const result = await ingestSession(later, { session: TOKEN, transcriptPath: PATH });
    expect(result).toMatchObject({ ok: true, inserted: { messages: 0 } });
    if (result.ok) expect(result.warnings).not.toContain('CURSOR_RESET');
    expect(store.snapshot().sessions[0]?.cursor).toEqual(cursor);
    const history = store.snapshot().transcriptFiles;
    expect(history[0]?.sizeBytes).toBe(memoryTranscript.length);
    expect(transcriptChanges([{ harness: 'demo', harnessSessionId: 'session-0001', path: PATH,
      sizeBytes: memoryTranscript.length, modifiedAt: INGESTED_AT }], history)).toEqual([]);
  });

  it('records it even for a transcript with no conversation in it yet', async () => {
    // Otherwise a scan would read that file again on every drain, for a session
    // that has nothing in it: the one case where nothing ever settles.
    const { deps, store } = await kit({ content: JSON.stringify({ messages: [] }) });

    expect(await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).toMatchObject({
      ok: true,
      created: false,
      inserted: { messages: 0 },
    });
    expect(store.snapshot().transcriptFiles).toHaveLength(1);
  });

  it('answers success even when the history could not be written', async () => {
    // The history is a shortcut and not a fact anything depends on: a scan that
    // does not find it reads the file again and inserts nothing (AD-8).
    const { deps, store } = await kit();
    const refusing = {
      ...deps,
      store: {
        ...store,
        async recordTranscriptFile() {
          return {
            ok: false as const,
            code: 'DB_LOCKED' as const,
            message: '다른 연결이 쓰고 있습니다',
          };
        },
      },
    };

    expect(await ingestSession(refusing, { session: TOKEN, transcriptPath: PATH })).toMatchObject({
      ok: true,
      created: true,
      spooled: false,
    });
    expect(store.snapshot().messages.length).toBeGreaterThan(0);
  });
});

describe('sessions.ingest for a caller that is itself the deferred path', () => {
  it('hands the code back instead of spooling, and writes no mark', async () => {
    // The drain and the spool replay both come here with `spoolOnUnwritable`
    // false: a mark written from there would be a second copy of work the queue
    // is already holding, and the honest answer is the code so the item is
    // released with its attempt intact (AD-21).
    const { deps, store, spool } = await kit();
    const locked = {
      ...deps,
      store: {
        ...store,
        async ingest() {
          return {
            ok: false as const,
            code: 'DB_LOCKED' as const,
            message: '다른 연결이 쓰고 있습니다',
          };
        },
      },
    };

    const result = await ingestSession(
      locked,
      { session: TOKEN, transcriptPath: PATH },
      { spoolOnUnwritable: false },
    );

    expect(result).toMatchObject({ ok: false, code: 'DB_LOCKED' });
    expect(spool.records()).toEqual([]);
  });
});

describe('첨부 수집', () => {
  const bytes = [137,80,78,71,13,10,26,10,0];
  const content = JSON.stringify({messages:[1,2].map(i=>({harnessMessageId:`image-${i}`,role:'user',body:'',occurredAt:'2026-01-02T03:04:05.000Z',attachments:[{bytes}]}))});
  it('같은 바이트는 한 번 넣고 기존 메시지의 첨부도 멱등으로 연결한다', async () => {
    const {deps,store} = await kit({content});
    let puts = 0; const files = deps.files;
    deps.files = {...files, async put(b) { puts++; return files.put(b); }};
    expect((await ingestSession(deps,{session:TOKEN,transcriptPath:PATH})).ok).toBe(true);
    expect(puts).toBe(1);
    const messages = store.snapshot().messages; expect(messages.map(m=>m.body)).toEqual(['','']);
    const rows = await Promise.all(messages.map(m=>store.listMessageAttachments(m.id)));
    expect(rows.every(r=>r.ok && r.attachments.length===1)).toBe(true);
    expect((await ingestSession(deps,{session:TOKEN,transcriptPath:PATH})).ok).toBe(true);
    expect(store.snapshot().messages).toHaveLength(2);
    // A prior version stored the messages but carried no attachment data.
    const legacy = await kit({content:JSON.stringify({messages:[{harnessMessageId:'image-1',role:'user',body:'',occurredAt:'2026-01-02T03:04:05.000Z'}]})});
    await ingestSession(legacy.deps,{session:TOKEN,transcriptPath:PATH});
    legacy.deps.transcripts = deps.transcripts;
    legacy.deps.parsers = [memoryParser({version:'5'})];
    expect((await ingestSession(legacy.deps,{session:TOKEN,transcriptPath:PATH})).ok).toBe(true);
    const first = legacy.store.snapshot().messages[0]!;
    expect(await legacy.store.listMessageAttachments(first.id)).toMatchObject({ok:true,attachments:[{ordinal:0,status:'stored'}]});
  });
  it('파일 저장 실패는 메시지와 이력과 spool을 쓰지 않는다', async () => {
    const {deps,store,spool}=await kit({content});
    deps.files={...deps.files,async put(){return {ok:false,code:'FILES_UNAVAILABLE',message:'저장 실패'};}};
    expect(await ingestSession(deps,{session:TOKEN,transcriptPath:PATH})).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'});
    expect(store.snapshot().messages).toEqual([]); expect(store.snapshot().transcriptFiles).toEqual([]);
    const claim = await spool.claim(); expect(claim).toMatchObject({ok:true,claim:null});
  });
  it('DB 거부는 한 append에 다시 수집할 줄 다음 첨부 연결을 쓰고 너무 큰 연결은 뺀다', async () => {
    const {deps,spool}=await kit({content});
    deps.store={...deps.store,async ingest(){return {ok:false,code:'DB_LOCKED',message:'잠김'};}};
    expect(await ingestSession(deps,{session:TOKEN,transcriptPath:PATH})).toMatchObject({ok:true,spooled:true});
    const claim=await spool.claim(); expect(claim.ok).toBe(true); if(!claim.ok || claim.claim===null) return;
    const records=claim.claim.lines.map(line=>JSON.parse(line) as {kind:string;payload:Record<string,unknown>});
    expect(records.map(r=>r.kind)).toEqual(['session_ingest','attachment_link','attachment_link']);
    expect(records[1]?.payload).not.toHaveProperty('bytes');
    expect(await spool.claim()).toMatchObject({ok:true,claim:null});
    const huge=await kit({content:JSON.stringify({messages:[{harnessMessageId:'m',role:'user',body:'',occurredAt:'2026-01-02T03:04:05.000Z',attachments:[{bytes,sourceRef:'x'.repeat(65536)}]}]})});
    huge.deps.store={...huge.deps.store,async ingest(){return {ok:false,code:'DB_LOCKED',message:'잠김'};}};
    expect(await ingestSession(huge.deps,{session:TOKEN,transcriptPath:PATH})).toMatchObject({ok:true,spooled:true});
    const h=await huge.spool.claim(); if(!h.ok || h.claim===null) throw new Error('spool 없음');
    expect(h.claim.lines).toHaveLength(1);
  });
});

for (const phase of ['readSelfUser','ensureSession','ingest'] as const) {
  it(`${phase}의 DB 거부도 저장한 첨부를 같은 spool 파일에 보존한다`, async () => {
    const content=JSON.stringify({messages:[{harnessMessageId:'image',role:'user',body:'',occurredAt:'2026-01-02T03:04:05.000Z',attachments:[{bytes:[1,2,3]}]}]});
    const {deps,spool}=await kit({content});
    deps.store={...deps.store,[phase]:async()=>({ok:false as const,code:'DB_UNAVAILABLE' as const,message:'접근 불가'})};
    expect(await ingestSession(deps,{session:TOKEN,transcriptPath:PATH})).toMatchObject({ok:true,spooled:true});
    expect(spool.files()).toHaveLength(1); expect(spool.records().map(r=>r.kind)).toEqual(['session_ingest','attachment_link']);
  });
}

describe('@파일 원본 선택', () => {
  const sourcePath = '/tmp/brain-ingest-source/note.md';
  const contentFor = (attachments: unknown[]) => JSON.stringify({ messages: [{ harnessMessageId: 'source', role: 'user', body: '읽기', occurredAt: '2026-10-26T00:00:00.000Z', attachments }] });
  it('transcript 바이트를 우선하고 줄 수·크기가 맞는 fallback만 저장한다', async () => {
    const attachments = [
      { bytes: [65], sourcePath },
      { bytes: null, sourcePath, sourceCheck: { lineCount: 2 } },
      { bytes: null, sourcePath, sourceCheck: { sizeBytes: 3 } },
      { bytes: null, sourcePath, sourceCheck: { lineCount: 3 } },
      { bytes: null, sourcePath, sourceCheck: null },
      { bytes: [66], sourcePath: '/tmp/outside/note.md' },
    ];
    const { deps, store } = await kit({ content: contentFor(attachments) });
    const reads: number[] = [];
    deps.userHome = '/tmp/brain-ingest-source';
    deps.sources = { async read(_path, maxBytes) { reads.push(maxBytes); return { ok: true, bytes: Uint8Array.of(97, 10, 98) }; } };
    expect(await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).toMatchObject({ ok: true });
    expect(reads).toEqual([32 * 1024 * 1024, 32 * 1024 * 1024, 32 * 1024 * 1024]);
    const result = await store.listMessageAttachments(store.snapshot().messages[0]!.id);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.attachments.map(a => a.status)).toEqual(['stored', 'stored', 'stored', 'missing_at_ingest', 'missing_at_ingest', 'stored']);
    expect(result.attachments[1]?.file?.id).toBe(result.attachments[2]?.file?.id);
    expect(result.attachments[0]?.file?.locations).toContainEqual({ storeKind: 'local', ownership: 'external', locator: '~/note.md' });
    expect(result.attachments[5]?.file?.locations).toHaveLength(1);
    const file = result.attachments[0]!.file!;
    expect(await deps.files.get(file.home!)).toEqual({ ok: true, bytes: Uint8Array.of(65) });
  });
  it('옛 parser 버전으로 저장된 메시지에도 다시 읽기가 @파일 첨부를 잇는다', async () => {
    // The earlier version stored the message and knew nothing of the @file.
    const legacy = await kit({ content: contentFor([]) });
    expect((await ingestSession(legacy.deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    const message = legacy.store.snapshot().messages[0]!;
    expect(await legacy.store.listMessageAttachments(message.id)).toEqual({ ok: true, attachments: [] });
    legacy.deps.transcripts = memoryTranscriptReader({ files: { [PATH]: contentFor([
      { bytes: null, sourcePath, sourceCheck: { sizeBytes: 1 }, sourceKind: 'file', sourceRef: 'row', displayName: 'note.md' },
    ]) } });
    legacy.deps.parsers = [memoryParser({ version: '2' })];
    legacy.deps.userHome = '/tmp/brain-ingest-source';
    legacy.deps.sources = { async read() { return { ok: true, bytes: Uint8Array.of(65) }; } };
    expect((await ingestSession(legacy.deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    expect(legacy.store.snapshot().messages).toHaveLength(1);
    expect(await legacy.store.listMessageAttachments(message.id)).toMatchObject({ ok: true, attachments: [{
      ordinal: 0, sourceKind: 'file', status: 'stored',
      file: { locations: [{ ownership: 'brain' }, { ownership: 'external', locator: '~/note.md' }] },
    }] });
  });
  it.each([
    ['사라졌다 같은 크기로 다시 생긴 원본', null, Uint8Array.of(65)],
    ['같은 크기의 다른 내용으로 바뀐 원본', Uint8Array.of(65), Uint8Array.of(66)],
  ] as const)('다시 읽어도 이미 채운 자리는 원본을 다시 읽거나 넣지 않는다: %s', async (_name, first, second) => {
    const { deps, store } = await kit({ content: contentFor([{ bytes: null, sourcePath, sourceCheck: { sizeBytes: 1 }, displayName: 'note.md' }]) });
    let source: Uint8Array | null = first;
    let reads = 0; let puts = 0;
    deps.userHome = '/tmp/brain-ingest-source';
    deps.sources = { async read() { reads++; return source === null ? { ok: false, message: '없음' } : { ok: true, bytes: source }; } };
    const files = deps.files;
    deps.files = { ...files, async put(bytes) { puts++; return files.put(bytes); } };
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    const message = store.snapshot().messages[0]!;
    const before = await store.listMessageAttachments(message.id);
    const putsBefore = puts; const readsBefore = reads;
    source = second;
    // A new parser version reads the whole transcript again, message and all.
    deps.parsers = [memoryParser({ version: '2' })];
    expect((await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).ok).toBe(true);
    expect(puts).toBe(putsBefore);
    expect(reads).toBe(readsBefore);
    expect(await store.listMessageAttachments(message.id)).toEqual(before);
  });
  it.each(['absent', 'failed', 'oversize'])('원본 읽기 %s면 missing이며 spool도 상태를 보존한다', async failure => {
    const { deps, spool } = await kit({ content: contentFor([{ bytes: null, sourcePath, sourceCheck: { sizeBytes: 1 }, displayName: 'note.md' }]) });
    if (failure !== 'absent') deps.sources = { async read() { return failure === 'failed' ? { ok: false, message: '읽기 실패' } : { ok: true, bytes: new Uint8Array(32 * 1024 * 1024 + 1) }; } };
    deps.store = { ...deps.store, async ingest() { return { ok: false, code: 'DB_LOCKED', message: '잠김' }; } };
    expect(await ingestSession(deps, { session: TOKEN, transcriptPath: PATH })).toMatchObject({ ok: true, spooled: true });
    const record = spool.records().find(r => r.kind === 'attachment_link');
    expect(record?.payload).toMatchObject({ status: 'missing_at_ingest', contentHash: null, sizeBytes: null, storeKind: null, locator: null, ownership: null, externalLocator: null });
    expect(JSON.stringify(record)).not.toContain(sourcePath);
  });
});
