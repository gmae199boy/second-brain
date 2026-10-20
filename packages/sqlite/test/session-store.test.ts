import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  otherProjectId,
  otherSessionId,
  otherWorktreeId,
  sampleCheckoutInput,
  sampleEnsureSessionInput,
  sampleIngestBatch,
  sampleSelfUserInput,
  sampleSessionKey,
  sampleSessionToken,
  sessionStoreContract,
  type SessionStoreSubject,
} from '@second-brain/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite } from '../src/connect.js';
import { runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';

/**
 * The session capability against the file this package writes: the shared
 * contract, and the things only a real database can be held to — that a
 * `seq` collision is an error rather than a row quietly dropped, and that a
 * session with no user is refused.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-sessions-'));
  directories.push(directory);
  return directory;
}

/** A fresh file brought up to the version this package ships. */
async function migratedPath(): Promise<string> {
  const path = join(await scratch(), 'brain.db');
  const migrated = await runSqliteMigrations({ path });
  expect(migrated.ok).toBe(true);
  return path;
}

async function freshStore(): Promise<SessionStoreSubject> {
  return sqliteStore({ path: await migratedPath() });
}

describe('the session contract against the SQLite store', () => {
  for (const testCase of sessionStoreContract()) {
    it(testCase.name, async () => {
      await testCase.run(freshStore);
    });
  }
});

describe('the SQLite session store and the columns behind it', () => {
  it('writes the instants as canonical text and the cursor as its two halves', async () => {
    const path = await migratedPath();
    const store = sqliteStore({ path });
    const batch = sampleIngestBatch();
    try {
      expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
      expect((await store.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
      expect((await store.ingest(batch)).ok).toBe(true);
    } finally {
      await store.close();
    }

    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const row = opened.connection.database
        .prepare(
          `select started_at, ingested_at, last_harness_message_id, cursor_fingerprint,
                  parser_version, ended_at, start_source
             from sessions`,
        )
        .get();
      expect(row).toEqual({
        started_at: '2026-01-02T03:04:00.000Z',
        ingested_at: '2026-01-02T03:06:00.000Z',
        last_harness_message_id: batch.tracking.cursor?.lastHarnessMessageId,
        cursor_fingerprint: batch.tracking.cursor?.fingerprint,
        parser_version: batch.tracking.parserVersion,
        start_source: batch.tracking.startSource,
        // Nothing tells us when a session ended yet (AD-6).
        ended_at: null,
      });
      expect(
        opened.connection.database
          .prepare(
            'select seq, role, git_branch, is_subagent_report from messages order by seq',
          )
          .all(),
      ).toEqual([
        // The branch exactly as the line carried it, and the report mark as the
        // integer SQLite stores a boolean in (migration 0004).
        { seq: 0, role: 'user', git_branch: 'main', is_subagent_report: 0 },
        { seq: 1, role: 'assistant', git_branch: 'main', is_subagent_report: 0 },
        { seq: 2, role: 'user', git_branch: 'topic/notes', is_subagent_report: 0 },
        { seq: 3, role: 'assistant', git_branch: 'topic/notes', is_subagent_report: 1 },
      ]);
    } finally {
      await opened.connection.close();
    }
  });

  it('writes no masking record at all, and stores the body as it was given', async () => {
    // 마스킹 B: capture masks nothing, so the one table that could hold a
    // secret's hash stays empty until somebody runs `messages redact` (AD-11).
    const path = await migratedPath();
    const store = sqliteStore({ path });
    const batch = sampleIngestBatch();
    try {
      expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
      expect((await store.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
      const ingested = await store.ingest(batch);
      expect(ingested.ok).toBe(true);
      if (!ingested.ok) return;
      expect(Object.keys(ingested.inserted).sort()).toEqual(['messages', 'toolNotes']);
    } finally {
      await store.close();
    }

    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      expect(
        opened.connection.database.prepare('select count(*) as rows from redactions').get(),
      ).toEqual({ rows: 0 });
      expect(
        opened.connection.database.prepare('select body from messages order by seq').all(),
      ).toEqual(batch.messages.map((message) => ({ body: message.body })));
    } finally {
      await opened.connection.close();
    }
  });

  it('refuses a masking record whose message is not there', async () => {
    // The foreign key is what keeps a record from outliving the body it is
    // about. Capture writes no record of its own any more (마스킹 B), but
    // `messages.redact` (story 2.13) will, and this is the rule it inherits.
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
      expect((await store.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
      expect((await store.ingest(sampleIngestBatch())).ok).toBe(true);
    } finally {
      await store.close();
    }

    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      expect(() =>
        opened.connection.database
          .prepare(
            `insert into redactions (id, message_id, file_id, start, "end", kind,
                                     content_hash, occurred_at, pattern_version)
                  values (?, '01940000-0000-7000-8000-00000000dead', null, 0, 5, 'api_key',
                          ?, '2026-01-02T03:06:00.000Z', '1')`,
          )
          .run('01940000-0000-7000-8000-0000000009fd', `sha256:${'0'.repeat(64)}`),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      await opened.connection.close();
    }
  });

  it('writes the project and the worktree of a checkout, and tags the session with them', async () => {
    const path = await migratedPath();
    const store = sqliteStore({ path });
    const checkout = sampleCheckoutInput();
    try {
      expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
      const created = await store.ensureSession(sampleEnsureSessionInput({ checkout }));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.session.projectId).toBe(checkout.projectId);
      expect(created.session.worktreeId).toBe(checkout.worktreeId);

      // The same repository from another folder, with ids nobody has seen:
      // the identity keeps the id it has, and the path becomes its own row.
      const elsewhere = await store.ensureSession(
        sampleEnsureSessionInput({
          id: otherSessionId,
          key: { harness: sampleSessionKey.harness, harnessSessionId: 'session-0002' },
          checkout: sampleCheckoutInput({
            projectId: otherProjectId,
            worktreeId: otherWorktreeId,
            worktreePath: '/demo/repo-review',
          }),
        }),
      );
      expect(elsewhere.ok).toBe(true);
      if (!elsewhere.ok) return;
      expect(elsewhere.session.projectId).toBe(checkout.projectId);
      expect(elsewhere.session.worktreeId).toBe(otherWorktreeId);
    } finally {
      await store.close();
    }

    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      // One project for the identity, two worktrees under it, and `removed_at`
      // untouched: marking a folder that is gone is drain's (AD-12).
      expect(
        opened.connection.database
          .prepare('select id, remote_identity, workspace_id from projects')
          .all(),
      ).toEqual([
        {
          id: checkout.projectId,
          remote_identity: checkout.remoteIdentity,
          workspace_id: null,
        },
      ]);
      expect(
        opened.connection.database
          .prepare('select project_id, path, removed_at from worktrees order by path')
          .all(),
      ).toEqual([
        { project_id: checkout.projectId, path: '/demo/repo', removed_at: null },
        { project_id: checkout.projectId, path: '/demo/repo-review', removed_at: null },
      ]);
      expect(
        opened.connection.database
          .prepare(
            `select harness_session_id, project_id, worktree_id, workspace_id
               from sessions order by harness_session_id`,
          )
          .all(),
      ).toEqual([
        {
          harness_session_id: sampleSessionKey.harnessSessionId,
          project_id: checkout.projectId,
          worktree_id: checkout.worktreeId,
          workspace_id: null,
        },
        {
          harness_session_id: 'session-0002',
          project_id: checkout.projectId,
          worktree_id: otherWorktreeId,
          workspace_id: null,
        },
      ]);
    } finally {
      await opened.connection.close();
    }
  });

  it('puts two GitHub remotes that differ only in case into one project', async () => {
    // GitHub compares an owner and a repository name without case, so these are
    // one repository under two spellings — and one project, under the id the
    // first checkout minted (0005, AD-12). Only this store can be held to it:
    // the comparison key is SQL until story 20 moves it into Core, and the
    // memory fake still keys a project on `remoteIdentity`.
    const path = await migratedPath();
    const store = sqliteStore({ path });
    const first = sampleCheckoutInput({ remoteIdentity: 'github.com/Brain-Owner/Notes' });
    try {
      expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
      const created = await store.ensureSession(sampleEnsureSessionInput({ checkout: first }));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.session.projectId).toBe(first.projectId);

      const lowered = await store.ensureSession(
        sampleEnsureSessionInput({
          id: otherSessionId,
          key: { harness: sampleSessionKey.harness, harnessSessionId: 'session-0002' },
          checkout: sampleCheckoutInput({
            projectId: otherProjectId,
            remoteIdentity: 'github.com/brain-owner/notes',
            worktreeId: otherWorktreeId,
            worktreePath: '/demo/repo-review',
          }),
        }),
      );
      // No `UnsettledEnsure`: the lookup is on the comparison key, so the
      // project that is already there is found rather than inserted again.
      expect(lowered.ok).toBe(true);
      if (!lowered.ok) return;
      expect(lowered.session.projectId).toBe(first.projectId);
      expect(lowered.session.worktreeId).toBe(otherWorktreeId);
    } finally {
      await store.close();
    }

    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      // One row, keeping the remote the first checkout wrote: the key answers
      // "same repository", and `remote_identity` stays the value a person
      // recognises.
      expect(
        opened.connection.database
          .prepare('select id, remote_identity, identity_key from projects')
          .all(),
      ).toEqual([
        {
          id: first.projectId,
          remote_identity: 'github.com/Brain-Owner/Notes',
          identity_key: 'github.com/brain-owner/notes',
        },
      ]);
      expect(
        opened.connection.database
          .prepare('select count(*) as rows from worktrees where project_id = ?')
          .get(first.projectId),
      ).toEqual({ rows: 2 });
    } finally {
      await opened.connection.close();
    }
  });

  it('writes no project row for a checkout handed to a session that is already there', async () => {
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
      // Created from a cwd that said nothing, then ingested again by a run
      // whose git did answer: the tags are decided once (AD-12).
      expect((await store.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
      const again = await store.ensureSession(
        sampleEnsureSessionInput({ checkout: sampleCheckoutInput() }),
      );
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.session.projectId).toBeNull();
      expect(again.session.worktreeId).toBeNull();
    } finally {
      await store.close();
    }

    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      // A project nothing points at is a project nobody will ever find again,
      // so the session check comes before the insert (port contract).
      expect(
        opened.connection.database.prepare('select count(*) as rows from projects').get(),
      ).toEqual({ rows: 0 });
      expect(
        opened.connection.database.prepare('select count(*) as rows from worktrees').get(),
      ).toEqual({ rows: 0 });
    } finally {
      await opened.connection.close();
    }
  });

  it('leaves no project or worktree behind when a proposed id is already taken', async () => {
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
      const taken = sampleCheckoutInput();
      expect((await store.ensureSession(sampleEnsureSessionInput({ checkout: taken }))).ok).toBe(
        true,
      );

      // A second repository whose worktree proposal reuses the id the first
      // worktree already has: nothing about this call can be settled.
      const clash = await store.ensureSession(
        sampleEnsureSessionInput({
          id: otherSessionId,
          key: { harness: sampleSessionKey.harness, harnessSessionId: 'session-0002' },
          checkout: sampleCheckoutInput({
            projectId: otherProjectId,
            remoteIdentity: 'demo.example/brain-owner/other',
            worktreeId: taken.worktreeId,
            worktreePath: '/demo/other',
          }),
        }),
      );
      expect(clash).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    } finally {
      await store.close();
    }

    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      // The whole transaction rolled back: the project the failed call had
      // already inserted is gone with it, because a project no session points
      // at is a project nobody will ever find again (port contract).
      expect(
        opened.connection.database.prepare('select remote_identity from projects').all(),
      ).toEqual([{ remote_identity: sampleCheckoutInput().remoteIdentity }]);
      expect(opened.connection.database.prepare('select path from worktrees').all()).toEqual([
        { path: '/demo/repo' },
      ]);
      expect(
        opened.connection.database.prepare('select count(*) as rows from sessions').get(),
      ).toEqual({ rows: 1 });
    } finally {
      await opened.connection.close();
    }
  });

  it('raises on a seq collision rather than dropping the row in silence', async () => {
    // The point of conflicting on `(session_id, harness_message_id)` alone: a
    // `seq` that is already taken means this code numbered two messages the
    // same, which is a bug, and `on conflict (session_id, seq) do nothing`
    // would swallow it (NFR-2).
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
      const created = await store.ensureSession(sampleEnsureSessionInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect((await store.ingest(sampleIngestBatch())).ok).toBe(true);
    } finally {
      await store.close();
    }

    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const sessionId = String(
        opened.connection.database.prepare('select id from sessions').get()?.id,
      );
      expect(() =>
        opened.connection.database
          .prepare(
            `insert into messages (id, session_id, harness_message_id, seq, role, model,
                                   body, occurred_at)
                  values (?, ?, 'msg-9', 0, 'user', null, 'a different message',
                          '2026-01-02T03:04:05.000Z')`,
          )
          .run('01940000-0000-7000-8000-0000000009ff', sessionId),
      ).toThrow(/UNIQUE/i);
    } finally {
      await opened.connection.close();
    }
  });

  it('refuses a session whose user has no row', async () => {
    const store = sqliteStore({ path: await migratedPath() });
    try {
      // No `ensureSelfUser` first, so `sessions.user_id` points at nothing.
      // The foreign key of migration 0003 is what refuses it, which is why
      // this is an exception and not a coded value: Core only ever passes the
      // owner it has just read, so a dangling id is a bug (Conventions).
      await expect(store.ensureSession(sampleEnsureSessionInput())).rejects.toThrow(
        /FOREIGN KEY/i,
      );
    } finally {
      await store.close();
    }
  });

  it('reads nothing back for a token that is not one', async () => {
    const store = sqliteStore({ path: await migratedPath() });
    try {
      expect(await store.readSession('not-a-token')).toMatchObject({
        ok: false,
        code: 'SESSION_NOT_FOUND',
      });
    } finally {
      await store.close();
    }
  });

  it('reports a database that is not there as unreachable, for every verb', async () => {
    const store = sqliteStore({ path: join(await scratch(), 'brain.db') });
    try {
      expect(await store.ensureSession(sampleEnsureSessionInput())).toMatchObject({
        ok: false,
        code: 'DB_UNAVAILABLE',
      });
      expect(await store.ingest(sampleIngestBatch())).toMatchObject({
        ok: false,
        code: 'DB_UNAVAILABLE',
      });
      expect(await store.readSession(sampleSessionToken)).toMatchObject({
        ok: false,
        code: 'DB_UNAVAILABLE',
      });
      expect(await store.findSession(sampleSessionKey)).toMatchObject({
        ok: false,
        code: 'DB_UNAVAILABLE',
      });
    } finally {
      await store.close();
    }
  });

  it('refuses a report mark that is neither 0 nor 1', async () => {
    // The `check` of migration 0004 is what keeps the column to a boolean, so
    // nothing but this code can put a third value in it.
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
      expect((await store.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
      expect((await store.ingest(sampleIngestBatch())).ok).toBe(true);
    } finally {
      await store.close();
    }

    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const sessionId = String(
        opened.connection.database.prepare('select id from sessions').get()?.id,
      );
      expect(() =>
        opened.connection.database
          .prepare(
            `insert into messages (id, session_id, harness_message_id, seq, role, model,
                                   body, occurred_at, git_branch, is_subagent_report)
                  values (?, ?, 'msg-9', 9, 'user', null, 'a message with a third value',
                          '2026-01-02T03:04:05.000Z', 'main', 2)`,
          )
          .run('01940000-0000-7000-8000-0000000009fe', sessionId),
      ).toThrow(/CHECK/i);
    } finally {
      await opened.connection.close();
    }
  });
});
