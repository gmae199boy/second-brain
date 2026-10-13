import type { Message } from '../../domain/message.js';
import type { Session } from '../../domain/session.js';
import type { SessionStore } from '../../ports/store.js';
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
  sampleSessionId,
  sampleSessionToken,
  unknownSessionToken,
} from '../fixtures.js';

/**
 * The session capability: find-or-create, an idempotent batch write, and a
 * read by session token. Every case gets a fresh, empty subject.
 */
export function sessionStoreContract(): ContractCase<SessionStore>[] {
  return [
    contractCase<SessionStore>(
      'ensureSession creates the row once and keeps the first id',
      async (make) => {
        await withSubject(make, async (store) => {
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

    contractCase<SessionStore>(
      'ensureSession keeps the key, the tags and the immutable columns',
      async (make) => {
        await withSubject(make, async (store) => {
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
          // whoever created the session (AD-12).
          const again = await store.ensureSession(
            sampleEnsureSessionInput({
              id: otherSessionId,
              userId: 'someone-else',
              machine: 'other-machine',
              startedAt: new Date('2027-06-07T08:09:10.000Z'),
              ingestSource: 'import',
              workspaceId: '01940000-0000-7000-8000-00000000000a',
              projectId: '01940000-0000-7000-8000-00000000000b',
              worktreeId: '01940000-0000-7000-8000-00000000000c',
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

    contractCase<SessionStore>(
      'ingest adds nothing the second time the same batch arrives',
      async (make) => {
        await withSubject(make, async (store) => {
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
        });
      },
    ),

    contractCase<SessionStore>(
      'ingest stores the messages and the tool notes of the batch',
      async (make) => {
        await withSubject(make, async (store) => {
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
            'the stored message bodies are not the ones the batch carried',
          );
          assertEqual(
            read.messages.map((message) => message.seq),
            batch.messages.map((message) => message.seq),
            'readSession must return the messages in seq order',
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

    contractCase<SessionStore>(
      'ingest advances the cursor and records the parser version',
      async (make) => {
        await withSubject(make, async (store) => {
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
        });
      },
    ),

    contractCase<SessionStore>(
      'ingest warns with CURSOR_RESET when the parser read from the start',
      async (make) => {
        await withSubject(make, async (store) => {
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

    contractCase<SessionStore>(
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

    contractCase<SessionStore>(
      'readSession reports an unknown token as a value',
      async (make) => {
        await withSubject(make, async (store) => {
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

function bodyOf(message: Message): string {
  return message.body;
}
