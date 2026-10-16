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
  otherSessionId,
  sampleEnsureSessionInput,
  sampleIngestBatch,
  sampleSelfUserInput,
  sampleSessionId,
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
            assertEqual(session.projectId, input.projectId, `the project tag changed ${where}`);
            assertEqual(session.worktreeId, input.worktreeId, `the worktree tag changed ${where}`);
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
              projectId: '01940000-0000-7000-8000-00000000001b',
              worktreeId: '01940000-0000-7000-8000-00000000001c',
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
          const stored = sampleIngestBatch({ only: ['msg-2', 'msg-3'] });
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
