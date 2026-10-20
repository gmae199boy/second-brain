import type { Message } from '../../domain/message.js';
import type { Session } from '../../domain/session.js';
import type { SessionStore, UserStore } from '../../ports/store.js';
import {
  assertEqual,
  assertNotOk,
  assertOk,
  assertTrue,
} from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
import {
  otherProjectId,
  otherSessionId,
  otherWorktreeId,
  sampleCheckoutInput,
  sampleEnsureSessionInput,
  sampleIngestBatch,
  sampleSelfUserInput,
  sampleSessionId,
  sampleSessionKey,
  sampleSessionToken,
  unknownSessionToken,
} from '../fixtures.js';

/**
 * What the session cases run against. It is the session capability plus the
 * identity one, because a session belongs to a user and a real adapter has the
 * foreign key to prove it (AD-12): a case cannot create a session without
 * first making the owner the fixture points at.
 */
export type SessionStoreSubject = SessionStore & UserStore;

/**
 * The session capability: find-or-create, an idempotent batch write that owns
 * `seq`, and a read by session token. Every case gets a fresh, empty subject.
 */
export function sessionStoreContract(): ContractCase<SessionStoreSubject>[] {
  return [
    contractCase<SessionStoreSubject>(
      'ensureSession creates the row once and keeps the first id',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          const first = await store.ensureSession(
            sampleEnsureSessionInput({ id: sampleSessionId }),
          );
          assertOk(first, 'the first ensureSession failed');
          assertTrue(first.created, 'the first ensureSession must create the row');
          assertEqual(first.session.id, sampleSessionId, 'the created row kept another id');

          const second = await store.ensureSession(
            sampleEnsureSessionInput({ id: otherSessionId }),
          );
          assertOk(second, 'the second ensureSession failed');
          assertTrue(
            !second.created,
            'the second ensureSession for the same key must not create a row',
          );
          assertEqual(
            second.session.id,
            sampleSessionId,
            'ensureSession must hand back the existing row, not the proposed id',
          );

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the session that was just created could not be read');
          assertEqual(
            read.session.id,
            sampleSessionId,
            'the store kept more than one row for the same session key',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'ensureSession keeps the key, the tags and the immutable columns',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          const input = sampleEnsureSessionInput();
          const created = await store.ensureSession(input);
          assertOk(created, 'ensureSession failed');

          const check = (session: Session, where: string): void => {
            assertEqual(session.harness, input.key.harness, `the harness changed ${where}`);
            assertEqual(
              session.harnessSessionId,
              input.key.harnessSessionId,
              `the harness session id changed ${where}`,
            );
            assertEqual(session.userId, input.userId, `the user id changed ${where}`);
            assertEqual(session.machine, input.machine, `the machine changed ${where}`);
            assertEqual(session.startedAt, input.startedAt, `the start time changed ${where}`);
            assertEqual(
              session.ingestSource,
              input.ingestSource,
              `the ingest source changed ${where}`,
            );
            assertEqual(
              session.workspaceId,
              input.workspaceId,
              `the workspace tag changed ${where}`,
            );
            // Created from a cwd that said nothing, so both tags are null and
            // stay null: a later call's checkout may not fill them in.
            assertEqual(session.projectId, null, `the project tag changed ${where}`);
            assertEqual(session.worktreeId, null, `the worktree tag changed ${where}`);
            assertEqual(
              session.continuedFromSessionId,
              null,
              `slice 1 never fills continuedFromSessionId ${where}`,
            );
          };

          check(created.session, 'on create');

          // A second ensureSession for the same key must find, not overwrite:
          // the key, the tags and the immutable columns are decided once, by
          // whoever created the session (AD-12). The user id is not proposed
          // differently here: a real adapter would refuse an id with no row.
          const again = await store.ensureSession(
            sampleEnsureSessionInput({
              id: otherSessionId,
              machine: 'other-machine',
              startedAt: new Date('2027-06-07T08:09:10.000Z'),
              ingestSource: 'import',
              workspaceId: '01940000-0000-7000-8000-00000000001a',
              checkout: sampleCheckoutInput(),
            }),
          );
          assertOk(again, 'the second ensureSession failed');
          check(again.session, 'on the second ensureSession');

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the session could not be read');
          check(read.session, 'when read back');
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'ensureSession tags a new session with the project and worktree of its checkout',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          const checkout = sampleCheckoutInput();
          const created = await store.ensureSession(sampleEnsureSessionInput({ checkout }));
          assertOk(created, 'ensureSession failed');
          // Nothing was there, so both proposals became rows and the session
          // carries their ids (AD-8, AD-12).
          assertEqual(
            created.session.projectId,
            checkout.projectId,
            'a new identity must become the project the session is tagged with',
          );
          assertEqual(
            created.session.worktreeId,
            checkout.worktreeId,
            'a new path must become the worktree the session is tagged with',
          );
          // `workspace_id` stays empty: slice 1 never groups projects (AD-12).
          assertEqual(
            created.session.workspaceId,
            null,
            'nothing in slice 1 may fill the workspace tag',
          );

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the tagged session could not be read');
          assertEqual(
            [read.session.projectId, read.session.worktreeId],
            [checkout.projectId, checkout.worktreeId],
            'the tags that were read back are not the ones the session was created with',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'a second session of the same repository joins the project it already has',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          const first = sampleCheckoutInput();
          const created = await store.ensureSession(sampleEnsureSessionInput({ checkout: first }));
          assertOk(created, 'the first ensureSession failed');

          // The same repository, a second working folder, and ids nobody has
          // seen: this is the second worktree of one clone (I/O matrix).
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
          assertOk(elsewhere, 'the second ensureSession failed');
          assertEqual(
            elsewhere.session.projectId,
            first.projectId,
            'an identity that is already stored must keep its id, not take the proposal',
          );
          assertEqual(
            elsewhere.session.worktreeId,
            otherWorktreeId,
            'another path under the same project must become a worktree of its own',
          );

          // And the same path again: one worktree, however many sessions were
          // opened in it and whatever id each of them proposed.
          const sameFolder = await store.ensureSession(
            sampleEnsureSessionInput({
              id: '01940000-0000-7000-8000-000000000003',
              key: { harness: sampleSessionKey.harness, harnessSessionId: 'session-0003' },
              checkout: sampleCheckoutInput({
                projectId: '01940000-0000-7000-8000-000000000013',
                worktreeId: '01940000-0000-7000-8000-000000000014',
              }),
            }),
          );
          assertOk(sameFolder, 'the third ensureSession failed');
          assertEqual(
            [sameFolder.session.projectId, sameFolder.session.worktreeId],
            [first.projectId, first.worktreeId],
            'the same identity and the same path must be the same project and worktree',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'a checkout handed to a session that already exists creates nothing',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          // Created from a cwd that said nothing, which is the state of every
          // session this case is about.
          assertOk(
            await store.ensureSession(sampleEnsureSessionInput({ checkout: null })),
            'ensureSession failed',
          );

          const late = sampleCheckoutInput({ projectId: otherProjectId });
          const again = await store.ensureSession(sampleEnsureSessionInput({ checkout: late }));
          assertOk(again, 'the second ensureSession failed');
          assertEqual(
            [again.session.projectId, again.session.worktreeId],
            [null, null],
            'a session that is already stored must not take the tags of a later checkout',
          );

          // And no project row was created either. Nothing in the port reads
          // the table, so it is asked the only way the port allows: a *new*
          // session with the same identity proposes an id of its own, and it
          // keeps that id only if the call above stored nothing.
          const fresh = await store.ensureSession(
            sampleEnsureSessionInput({
              id: otherSessionId,
              key: { harness: sampleSessionKey.harness, harnessSessionId: 'session-0002' },
              checkout: sampleCheckoutInput(),
            }),
          );
          assertOk(fresh, 'the ensureSession of the second session failed');
          assertEqual(
            fresh.session.projectId,
            sampleCheckoutInput().projectId,
            'the checkout of a session that already existed must not have left a project row',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'a session created without a checkout has no project and no worktree',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          // The "outside a repository" row of the matrix: the session is
          // stored, with both tags empty, and that is a success (Decision
          // 2026-10-18).
          const created = await store.ensureSession(
            sampleEnsureSessionInput({ checkout: null }),
          );
          assertOk(created, 'ensureSession failed');
          assertEqual(
            [created.session.projectId, created.session.worktreeId],
            [null, null],
            'a session with no checkout must carry no tags',
          );

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the untagged session could not be read');
          assertEqual(
            [read.session.projectId, read.session.worktreeId],
            [null, null],
            'the untagged session came back with tags',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'ingest adds nothing the second time the same batch arrives',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');
          const batch = sampleIngestBatch();

          const first = await store.ingest(batch);
          assertOk(first, 'the first ingest failed');
          assertEqual(
            first.inserted,
            { messages: batch.messages.length, toolNotes: batch.toolNotes.length },
            'the first ingest did not insert the whole batch',
          );

          const afterFirst = await store.readSession(sampleSessionToken);
          assertOk(afterFirst, 'the session could not be read after the first ingest');

          const second = await store.ingest(batch);
          assertOk(second, 'the second ingest failed');
          assertEqual(
            second.inserted,
            { messages: 0, toolNotes: 0 },
            'replaying a batch must insert nothing (AD-8)',
          );

          const afterSecond = await store.readSession(sampleSessionToken);
          assertOk(afterSecond, 'the session could not be read after the second ingest');
          assertEqual(
            afterSecond.messages.length,
            afterFirst.messages.length,
            'replaying a batch changed the message count',
          );
          assertEqual(
            afterSecond.toolNotes.length,
            afterFirst.toolNotes.length,
            'replaying a batch changed the tool note count',
          );
          assertEqual(
            afterSecond.messages.map((message) => message.seq),
            afterFirst.messages.map((message) => message.seq),
            'replaying a batch renumbered the messages that were already stored',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'ingest counts messages and tool notes, and nothing else',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');
          const batch = sampleIngestBatch();

          const result = await store.ingest(batch);
          assertOk(result, 'ingest failed');
          // Exactly two keys. Ingest writes no `redactions` row — the body it
          // stored is the body it was given, and secrets are masked on the way
          // out instead (마스킹 B, AD-11) — so a count of them would be a
          // count of something that cannot happen.
          assertEqual(
            Object.keys(result.inserted).sort(),
            ['messages', 'toolNotes'],
            'inserted must report the messages and the tool notes alone',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'ingest stores the batch in its own order, numbering seq from 0',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          const created = await store.ensureSession(sampleEnsureSessionInput());
          assertOk(created, 'ensureSession failed');
          const batch = sampleIngestBatch();
          const ingested = await store.ingest(batch);
          assertOk(ingested, 'ingest failed');
          assertEqual(
            ingested.sessionId,
            created.session.id,
            'ingest reported another session id than ensureSession did',
          );

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the ingested session could not be read');
          assertEqual(
            read.messages.map(bodyOf),
            batch.messages.map((message) => message.body),
            'the stored message bodies are not the ones the batch carried, in its order',
          );
          // `seq` is the store's, and the first batch of an empty session runs
          // 0, 1, 2, … in the order the batch carried (AD-8).
          assertEqual(
            read.messages.map((message) => message.seq),
            batch.messages.map((_message, index) => index),
            'the first batch of a session must be numbered 0, 1, 2, … in batch order',
          );
          assertEqual(
            read.messages.map((message) => message.id),
            batch.messages.map((message) => message.id),
            'the stored rows must keep the ids the batch minted (AD-8)',
          );
          assertEqual(
            read.toolNotes.map((note) => note.id),
            batch.toolNotes.map((note) => note.id),
            'the stored tool notes must keep the ids the batch minted (AD-8)',
          );
          assertEqual(
            read.toolNotes.map((note) => note.target).slice().sort(),
            batch.toolNotes.map((note) => note.target).slice().sort(),
            'the stored tool note targets are not the ones the batch carried',
          );
          for (const message of read.messages) {
            assertEqual(
              message.sessionId,
              created.session.id,
              'a stored message points at another session',
            );
          }
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'a batch that carries on from the last one takes the numbers after it',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');

          // The transcript as it stood after one turn, then the whole of it:
          // exactly what a second hook on a longer file hands over.
          const first = sampleIngestBatch({ only: ['msg-1', 'msg-2'] });
          assertOk(await store.ingest(first), 'the first ingest failed');
          const second = sampleIngestBatch({ idStart: 100 });

          const result = await store.ingest(second);
          assertOk(result, 'the second ingest failed');
          assertEqual(
            result.inserted.messages,
            second.messages.length - first.messages.length,
            'only the messages the session did not have yet may be inserted',
          );

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the session could not be read');
          assertEqual(
            read.messages.map((message) => message.seq),
            read.messages.map((_message, index) => index),
            'an appended batch must carry the numbering on with no gaps',
          );
          assertEqual(
            read.messages.map((message) => message.harnessMessageId),
            second.messages.map((message) => message.harnessMessageId),
            'the stored messages are not the ones the two batches carried, in order',
          );
          assertEqual(
            read.messages.slice(0, first.messages.length).map((message) => message.id),
            first.messages.map((message) => message.id),
            'a second ingest must leave the ids of the stored messages alone',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'a batch whose front changed leaves the stored seq, body and id alone',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');

          // What a compact or a fork does: the messages that are already
          // stored come back with something new in front of them.
          const stored = sampleIngestBatch({ only: ['msg-2', 'msg-3', 'msg-4'] });
          assertOk(await store.ingest(stored), 'the first ingest failed');
          const before = await store.readSession(sampleSessionToken);
          assertOk(before, 'the session could not be read after the first ingest');

          const rewritten = sampleIngestBatch({ idStart: 200 });
          const result = await store.ingest(rewritten);
          assertOk(result, 'the second ingest failed');
          assertEqual(
            result.inserted.messages,
            1,
            'only the message that was not stored yet may be inserted',
          );

          const after = await store.readSession(sampleSessionToken);
          assertOk(after, 'the session could not be read after the second ingest');
          const byId = new Map(
            after.messages.map((message) => [message.harnessMessageId, message]),
          );
          for (const was of before.messages) {
            const now = byId.get(was.harnessMessageId);
            if (now === undefined) {
              assertTrue(false, `message ${was.harnessMessageId} disappeared`);
              continue;
            }
            assertEqual(now.seq, was.seq, `the seq of ${was.harnessMessageId} changed`);
            assertEqual(now.id, was.id, `the id of ${was.harnessMessageId} changed`);
            assertEqual(now.body, was.body, `the body of ${was.harnessMessageId} changed`);
          }
          // The newcomer goes at the end of the numbering, not at the front of
          // it: nothing already stored may be renumbered (AD-4).
          const newcomer = byId.get('msg-1');
          if (newcomer === undefined) {
            assertTrue(false, 'the message that arrived in front was not stored at all');
            return;
          }
          assertEqual(
            newcomer.seq,
            before.messages.length,
            'a message that arrived in front must take the next free number, not 0',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'ingest advances the cursor and records the parser version',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');
          const batch = sampleIngestBatch();
          assertOk(await store.ingest(batch), 'ingest failed');

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the ingested session could not be read');
          assertEqual(
            read.session.parserVersion,
            batch.tracking.parserVersion,
            'the session did not record the parser version of the batch',
          );
          assertEqual(
            read.session.cursor,
            batch.tracking.cursor,
            'the session did not advance to the cursor of the batch',
          );
          assertEqual(
            read.session.ingestedAt,
            batch.tracking.ingestedAt,
            'the session must record the instant the batch carried, not one of its own (AD-13)',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'ingest keeps the branch and the subagent-report mark of every message',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');
          const batch = sampleIngestBatch();
          assertOk(await store.ingest(batch), 'ingest failed');

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the ingested session could not be read');
          // Both columns of migration 0004, as the batch carried them: the
          // branch exactly as the line had it, nulls included, and the mark on
          // the one message that is a delegated run's report.
          assertEqual(
            read.messages.map((message) => [
              message.harnessMessageId,
              message.gitBranch,
              message.isSubagentReport,
            ]),
            batch.messages.map((message) => [
              message.harnessMessageId,
              message.gitBranch,
              message.isSubagentReport,
            ]),
            'the stored branch or report mark is not the one the batch carried',
          );
          assertTrue(
            batch.messages.some((message) => message.isSubagentReport),
            'the session fixture must carry a subagent report, or this proves nothing',
          );
          // `cwd` travels on the parsed message and is tagged onto the session
          // by story 2.8; no message row keeps it (migration 0004).
          for (const message of read.messages) {
            assertTrue(
              !Object.hasOwn(message, 'cwd'),
              'a stored message must not keep the cwd of its line',
            );
          }
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'ingest records the start source the batch carried and keeps it when it carries none',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          // Created knowing nothing about the start, which is the state of a
          // session whose first read saw no `SessionStart` attachment.
          assertOk(
            await store.ensureSession(sampleEnsureSessionInput({ startSource: null })),
            'ensureSession failed',
          );

          assertOk(
            await store.ingest(sampleIngestBatch({ tracking: { startSource: 'resume' } })),
            'the first ingest failed',
          );
          const learned = await store.readSession(sampleSessionToken);
          assertOk(learned, 'the session could not be read after the first ingest');
          assertEqual(
            learned.session.startSource,
            'resume',
            'a batch that carries a start source must record it',
          );

          assertOk(
            await store.ingest(
              sampleIngestBatch({ idStart: 300, tracking: { startSource: null } }),
            ),
            'the second ingest failed',
          );
          const kept = await store.readSession(sampleSessionToken);
          assertOk(kept, 'the session could not be read after the second ingest');
          // A read that saw no attachment knows nothing about the start. Its
          // `null` must not erase what an earlier read did know.
          assertEqual(
            kept.session.startSource,
            'resume',
            'a batch with no start source must leave the stored one alone',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'the cursor does not go backwards unless the parse was reset',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');

          const whole = sampleIngestBatch();
          assertOk(await store.ingest(whole), 'the first ingest failed');
          const ahead = await store.readSession(sampleSessionToken);
          assertOk(ahead, 'the session could not be read after the first ingest');
          assertEqual(
            ahead.session.cursor,
            whole.tracking.cursor,
            'the session did not advance to the cursor of the batch',
          );

          // An older hook, committing last: it read less of the same transcript,
          // so its cursor names a message the stored one has already passed.
          const behind = sampleIngestBatch({ idStart: 400, only: ['msg-1', 'msg-2'] });
          assertOk(await store.ingest(behind), 'the overlapping ingest failed');
          const after = await store.readSession(sampleSessionToken);
          assertOk(after, 'the session could not be read after the overlapping ingest');
          assertEqual(
            after.session.cursor,
            whole.tracking.cursor,
            'an older batch must not wind the cursor back to a message already passed',
          );

          // Unless the parse was reset: then the front of the transcript is not
          // what it was, and the batch's cursor is the only one that still
          // describes the file (AD-4).
          const reset = sampleIngestBatch({
            idStart: 500,
            only: ['msg-1', 'msg-2'],
            tracking: { cursorReset: true },
          });
          assertOk(await store.ingest(reset), 'the reset ingest failed');
          const moved = await store.readSession(sampleSessionToken);
          assertOk(moved, 'the session could not be read after the reset ingest');
          assertEqual(
            moved.session.cursor,
            reset.tracking.cursor,
            'a reset parse must be allowed to move the cursor back',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'findSession answers with the row alone, or null for a key nobody stored',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          const missing = await store.findSession(sampleSessionKey);
          assertOk(missing, 'findSession failed for a key nobody stored');
          // A value, not a failure: that is the state of every session before
          // its first ingest, and the caller's next move is to read the whole
          // transcript rather than to catch anything.
          assertEqual(
            missing.session,
            null,
            'findSession must answer null for a key no session has',
          );

          const created = await store.ensureSession(sampleEnsureSessionInput());
          assertOk(created, 'ensureSession failed');
          const found = await store.findSession(sampleSessionKey);
          assertOk(found, 'findSession failed for a key that is stored');
          assertEqual(
            found.session,
            created.session,
            'findSession must answer with the row ensureSession made',
          );

          // And it carries the cursor, which is the whole reason it exists: the
          // next parse starts where the last one stopped (AD-4).
          const batch = sampleIngestBatch();
          assertOk(await store.ingest(batch), 'ingest failed');
          const tracked = await store.findSession(sampleSessionKey);
          assertOk(tracked, 'findSession failed after an ingest');
          assertEqual(
            tracked.session?.cursor,
            batch.tracking.cursor,
            'findSession must carry the cursor the last batch left',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'ingest warns with CURSOR_RESET when the parser read from the start',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');
          const result = await store.ingest(
            sampleIngestBatch({ tracking: { cursorReset: true } }),
          );
          assertOk(result, 'ingest failed');
          assertEqual(
            [...result.warnings],
            ['CURSOR_RESET'],
            'a cursor reset must surface as a warning code, never silently',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'ingest reports an unknown session as a value',
      async (make) => {
        await withSubject(make, async (store) => {
          const result = await store.ingest(sampleIngestBatch());
          assertNotOk(result, 'ingest into a session that was never created');
          assertEqual(
            result.code,
            'SESSION_NOT_FOUND',
            'an ingest without a session row must answer SESSION_NOT_FOUND',
          );
          assertTrue(result.message !== '', 'a failing ingest must say why');
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'readSession reports an unknown token as a value',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');
          const result = await store.readSession(unknownSessionToken);
          assertNotOk(result, 'readSession of a token nobody stored');
          assertEqual(
            result.code,
            'SESSION_NOT_FOUND',
            'an unknown session token must answer SESSION_NOT_FOUND',
          );
          assertTrue(result.message !== '', 'a failing readSession must say why');
        });
      },
    ),
  ];
}

/**
 * The owner `sampleEnsureSessionInput` points at. Every case that creates a
 * session starts with this: `sessions.user_id` is a foreign key in a real
 * adapter, so a session with no user is a row the database refuses (AD-12).
 */
async function owner(store: UserStore): Promise<void> {
  const created = await store.ensureSelfUser(sampleSelfUserInput());
  assertOk(created, 'the owner row could not be created, so no session can be');
}

function bodyOf(message: Message): string {
  return message.body;
}
