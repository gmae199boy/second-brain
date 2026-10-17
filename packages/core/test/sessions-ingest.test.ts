import { describe, expect, it } from 'vitest';
import type { ParserCursor } from '../src/domain/session.js';
import { formatSessionToken } from '../src/domain/session-token.js';
import type { ParseResult } from '../src/ports/parser.js';
import type { Checkout } from '../src/ports/repository.js';
import { ingestSession, type IngestSessionDependencies } from '../src/sessions/ingest.js';
import { fixedClock } from '../src/testing/fakes/clock.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import { memoryParser, memoryTranscript } from '../src/testing/fakes/parser.js';
import {
  memoryRepositories,
  type MemoryRepositories,
} from '../src/testing/fakes/repository.js';
import { memoryStore, type MemoryStore } from '../src/testing/fakes/store.js';
import {
  memoryTranscriptReader,
  type MemoryTranscriptReader,
} from '../src/testing/fakes/transcript.js';
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
  return {
    store,
    transcripts,
    repositories,
    deps: {
      store,
      clock: fixedClock(INGESTED_AT),
      idGen: sequenceIdGen({ timestampMs: INGESTED_AT.getTime() }),
      parsers: [memoryParser()],
      transcripts,
      repositories,
      machine: 'demo-machine',
    },
  };
}

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

  it('numbers the messages from 0 in the order the transcript holds them', async () => {
    const { deps, store } = await kit();

    await ingestSession(deps, { session: TOKEN, transcriptPath: PATH });

    const read = await store.readSession(TOKEN);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.messages.map((message) => [message.seq, message.harnessMessageId])).toEqual([
      [0, 'msg-1'],
      [1, 'msg-2'],
      [2, 'msg-3'],
      [3, 'msg-4'],
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
  it('asks git about the first message, and about nothing else', async () => {
    // The first message's cwd is the whole of the evidence (AD-12). The sample
    // transcript carries it on every line, so the point of the case is the
    // count: one question, about the first folder.
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

  it('tags nothing and asks nothing when the first message carried no folder', async () => {
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

  it('appends only what grew, with the numbering carried on', async () => {
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
    expect(read.messages.map((message) => message.seq)).toEqual([0, 1, 2, 3]);
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
        messages: [],
        toolNotes: [
          { harnessMessageId: 'msg-2', ordinal: 2, tool: 'read', target: 'notes/open.md', ok: false },
        ],
        cursor: null,
        cursorReset: false,
        startSource: null,
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
        messages: [],
        toolNotes: [
          { harnessMessageId: 'msg-2', ordinal: 0, tool: 'read', target: 'notes/open.md', ok: true },
        ],
        cursor: null,
        cursorReset: false,
        startSource: null,
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

  it('refuses a call that named no transcript', async () => {
    const { deps } = await kit();

    const result = await ingestSession(deps, { session: TOKEN, transcriptPath: '' });

    expect(result).toMatchObject({ ok: false, code: 'USAGE' });
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
  it('passes a held lock back as DB_LOCKED', async () => {
    const { deps, store } = await kit();
    const locked = {
      ...store,
      async ensureSession() {
        return {
          ok: false as const,
          code: 'DB_LOCKED' as const,
          message: 'another process is writing',
        };
      },
    };

    const result = await ingestSession({ ...deps, store: locked }, {
      session: TOKEN,
      transcriptPath: PATH,
    });

    // Epic 2's spool is what turns this into a retry; until then the caller
    // reports it (Boundaries).
    expect(result).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  });
});
