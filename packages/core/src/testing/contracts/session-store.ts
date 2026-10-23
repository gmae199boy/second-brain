import { planRedaction } from '../../domain/redact-plan.js';
import type {
  IngestBatch,
  IngestToolNote,
  ToolNotePosition,
} from '../../domain/ingest-batch.js';
import type { Message } from '../../domain/message.js';
import type { Session } from '../../domain/session.js';
import type { SessionStore, UserStore, WorkStore } from '../../ports/store.js';
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
export type SessionStoreSubject = SessionStore & UserStore & Pick<WorkStore, "listOpenWorkTargets">;

/**
 * The session capability: find-or-create, an idempotent batch write, and a read
 * by session token. Every case gets a fresh, empty subject.
 *
 * A message carries no number of its own (migration 0006), so the cases hold
 * every store to the two rules that replaced one: a message is identified by
 * `(session, harness message id)`, and it is read back in the order it was
 * uttered. The fixture's four messages are 2026-01-02T03:04:05, 03:04:07,
 * 03:05:01 and 03:05:20, so a case can carry them in any order it likes and
 * still know which order they come back in.
 */
export function sessionStoreContract(): ContractCase<SessionStoreSubject>[] {
  return [
    contractCase<SessionStoreSubject>('다시 읽을 세션은 null과 다른 버전을 포함하고 다른 하네스를 제외한다',
      async (make) => withSubject(make, async (store) => {
        await owner(store);
        assertOk(await store.ensureSession(sampleEnsureSessionInput()), '세션 생성');
        let read = await store.listStaleSessions({ harness: sampleSessionKey.harness, parserVersion: 'current' });
        assertOk(read, '목록 읽기');
        assertEqual(read.sessions.length, 1, 'null 버전 포함');
        assertEqual(read.sessions[0]?.harnessSessionId, sampleSessionKey.harnessSessionId, '세션 식별자');
        assertOk(await store.ingest({ ...sampleIngestBatch(), tracking: { ...sampleIngestBatch().tracking, parserVersion: 'current' } }), '버전 기록');
        read = await store.listStaleSessions({ harness: sampleSessionKey.harness, parserVersion: 'current' });
        assertOk(read, '같은 버전 조회');
        assertEqual(read.sessions.length, 0, '현재 버전 제외');
        read = await store.listStaleSessions({ harness: sampleSessionKey.harness, parserVersion: 'next' });
        assertOk(read, '다른 버전 조회');
        assertEqual(read.sessions.length, 1, '다른 버전 포함');
        read = await store.listStaleSessions({ harness: 'another-harness', parserVersion: 'next' });
        assertOk(read, '다른 하네스 조회');
        assertEqual(read.sessions.length, 0, '다른 하네스 제외');
      })),
    contractCase<SessionStoreSubject>(
      'tag evidence is preserved and identity candidates exclude known evidence and prior work',
      async (make) => withSubject(make, async (store) => {
        await owner(store);
        const first = await store.ensureSession(sampleEnsureSessionInput({
          checkout: sampleCheckoutInput(), firstCwd: '/demo/first', tagSource: 'ancestor',
        }));
        assertOk(first, '세션 생성 실패');
        assertEqual(first.session.firstCwd, '/demo/first', '첫 cwd 누락');
        assertEqual(first.session.tagSource, 'ancestor', '출처 누락');
        const repeated = await store.fillSessionTags({ key: sampleSessionKey, checkout: null,
          firstCwd: '/demo/changed', tagSource: null });
        assertOk(repeated, '근거 보존 실패');
        assertEqual(repeated.session.firstCwd, '/demo/first', '첫 cwd 변경');
        assertEqual(repeated.session.tagSource, 'ancestor', '출처 변경');
        const key = { ...sampleSessionKey, harnessSessionId: 'empty-evidence' };
        assertOk(await store.ensureSession(sampleEnsureSessionInput({ id: otherSessionId, key })), '빈 세션 생성');
        let candidates = await store.listIdentityCandidates();
        assertOk(candidates, '목록 읽기');
        assertEqual(candidates.sessions.length, 1, '재판단 대상 수');
        const filled = await store.fillSessionTags({ key, checkout: null, tagSource: null, firstCwd: '/demo/outside' });
        assertOk(filled, '근거 채우기');
        assertTrue(!filled.filled, '꼬리표 없는 근거가 꼬리표로 집계됨');
        assertEqual(filled.session.firstCwd, '/demo/outside', '근거 누락');
        candidates = await store.listIdentityCandidates();
        assertOk(candidates, '목록 재읽기');
        assertEqual(candidates.sessions.length, 0, '근거 있는 세션 재판단');
        const count = await store.countUntaggedSessions();
        assertOk(count, '꼬리표 없는 수');
        assertEqual(count.count, 1, '꼬리표 없는 수 오류');
        const workKey = { ...sampleSessionKey, harnessSessionId: 'prior-work' };
        assertOk(await store.ensureSession(sampleEnsureSessionInput({
          id: '01940000-0000-7000-8000-000000000991', key: workKey,
          identityWork: { id: '01940000-0000-7000-8000-000000000992',
            kind: 'session_identity', targetKind: 'session', targetId: 'demo:prior-work',
            createdAt: new Date('2026-01-01T00:00:00.000Z'), nextAttemptAt: new Date('2026-01-01T00:00:00.000Z') },
        })), '일감 있는 세션');
        candidates = await store.listIdentityCandidates();
        assertOk(candidates, '일감 제외 읽기');
        assertEqual(candidates.sessions.length, 0, '이미 일감 있는 세션 재판단');
      }),
    ),
    contractCase<SessionStoreSubject>(
      'redaction changes body and notes atomically, refuses missing text, and survives ingest replay',
      async (make) => withSubject(make, async (store) => {
        await owner(store);
        assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensure');
        const original = sampleIngestBatch();
        const message = original.messages[0]!;
        const note = original.toolNotes[0]!;
        const batch = { ...original, messages: [{ ...message, body: 'hunter2-x hunter2-x keep-this' }],
          toolNotes: [{ ...note, harnessMessageId: message.harnessMessageId, target: 'hunter2-x hunter2-x keep-this' }] };
        assertOk(await store.ingest(batch), 'ingest');
        let sequence = 100;
        const redact = (text: string, messageId = message.id) => store.redactMessage({ messageId,
          plan: (current) => {
            const plan = planRedaction(current, { mode: 'text', text, kind: 'manual' }, {
              now: () => new Date('2026-10-21T00:00:00.000Z'), newId: () => `01940000-0000-7000-8000-${String(sequence++).padStart(12, '0')}` });
            if (!('refused' in plan)) {
              for (const record of plan.redactions) {
                assertTrue(record.messageId === current.message.id && record.toolNoteId === null
                  || record.messageId === null && current.toolNotes.some((row) => row.id === record.toolNoteId), 'record points to a missing target');
              }
            }
            return plan;
          } });
        const missing = await redact('absent');
        assertNotOk(missing, 'missing text succeeded');
        assertEqual(missing.code, 'REDACT_TEXT_NOT_FOUND', 'missing text code');
        const unknown = await redact('hunter2-x', '01940000-0000-7000-8000-999999999999');
        assertNotOk(unknown, 'unknown message succeeded');
        assertEqual(unknown.code, 'MESSAGE_NOT_FOUND', 'unknown message code');
        const before = await store.readSession(sampleSessionToken);
        assertOk(before, 'read original');
        assertEqual(before.messages[0]?.body, batch.messages[0]?.body, 'refusal changed body');
        const result = await redact('hunter2-x');
        assertOk(result, 'redact');
        assertEqual(result.bodySpans, 2, 'body count');
        assertEqual(result.toolNoteSpans, 2, 'note count');
        assertEqual(result.toolNotesChanged, 1, 'changed note count');
        const first = await store.readSession(sampleSessionToken);
        assertOk(first, 'first read');
        assertEqual(first.messages[0]?.body, '[REDACTED:manual] [REDACTED:manual] keep-this', 'body replacement');
        assertEqual(first.toolNotes[0]?.target, first.messages[0]?.body, 'note replacement');
        assertOk(await redact('keep-this'), 'second redaction');
        const second = await store.readSession(sampleSessionToken);
        assertOk(second, 'second read');
        const replay = await store.ingest(batch);
        assertOk(replay, 'replay');
        assertEqual(replay.inserted.messages + replay.inserted.toolNotes, 0, 'replay inserts');
        const after = await store.readSession(sampleSessionToken);
        assertOk(after, 'read replay');
        assertEqual(after.messages[0]?.body, second.messages[0]?.body, 'replay revived body');
        assertEqual(after.toolNotes[0]?.target, second.toolNotes[0]?.target, 'replay revived target');
      }),
    ),
    contractCase<SessionStoreSubject>(
      'project lookup uses the supplied identity key across display identities',
      async (make) => withSubject(make, async (store) => {
        await owner(store);
        const first = await store.ensureSession(sampleEnsureSessionInput({
          checkout: sampleCheckoutInput({ remoteIdentity: 'github.com/Brain-Owner/Notes' }),
        }));
        const second = await store.ensureSession(sampleEnsureSessionInput({
          id: otherSessionId, key: { ...sampleSessionKey, harnessSessionId: 'other' },
          checkout: sampleCheckoutInput({ projectId: otherProjectId, worktreeId: otherWorktreeId,
            remoteIdentity: 'github.com/brain-owner/notes', worktreePath: '/demo/other' }),
        }));
        assertOk(first, 'first session failed');
        assertOk(second, 'second session failed');
        assertEqual(second.session.projectId, first.session.projectId, 'comparison key split the project');
      }),
    ),
    contractCase<SessionStoreSubject>(
      'identity work opens only when ensureSession creates a session',
      async (make) => withSubject(make, async (store) => {
        await owner(store);
        const now = new Date('2026-01-02T03:06:00.000Z');
        const work = { id: '01940000-0000-7000-8000-000000000810', kind: 'session_identity',
          targetKind: 'session', targetId: sampleSessionToken, createdAt: now, nextAttemptAt: now };
        assertOk(await store.ensureSession(sampleEnsureSessionInput({ identityWork: work })), 'ensure failed');
        assertOk(await store.ensureSession(sampleEnsureSessionInput({ identityWork: { ...work, targetId: 'demo:late' } })), 'repeat failed');
        const open = await store.listOpenWorkTargets({ kind: 'session_identity' });
        assertOk(open, 'work lookup failed');
        assertEqual(open.targets, [{ targetKind: 'session', targetId: sampleSessionToken }], 'work must be atomic and creation-only');
      }),
    ),
    contractCase<SessionStoreSubject>(
      'fillSessionTags fills empty tags once and creates nothing for tagged sessions',
      async (make) => withSubject(make, async (store) => {
        await owner(store);
        assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensure failed');
        const first = await store.fillSessionTags({ firstCwd: '/demo/repo', tagSource: 'cwd', key: sampleSessionKey, checkout: sampleCheckoutInput() });
        assertOk(first, 'fill failed');
        assertTrue(first.filled, 'empty tags were not filled');
        const unused = sampleCheckoutInput({ projectId: otherProjectId, worktreeId: otherWorktreeId,
          remoteIdentity: 'demo.example/brain-owner/other', worktreePath: '/demo/other' });
        const repeat = await store.fillSessionTags({ firstCwd: '/demo/repo', tagSource: 'cwd', key: sampleSessionKey, checkout: unused });
        assertOk(repeat, 'repeat failed');
        assertTrue(!repeat.filled, 'existing tags were overwritten');
        assertEqual(repeat.session.projectId, first.session.projectId, 'project changed');
        const next = await store.ensureSession(sampleEnsureSessionInput({
          id: otherSessionId, key: { ...sampleSessionKey, harnessSessionId: 'other' },
          checkout: sampleCheckoutInput({ projectId: '01940000-0000-7000-8000-000000000899', worktreeId: '01940000-0000-7000-8000-000000000898', remoteIdentity: unused.remoteIdentity }),
        }));
        assertOk(next, 'next ensure failed');
        assertEqual(next.session.projectId, '01940000-0000-7000-8000-000000000899', 'fill created an unreferenced project');
        const absent = await store.fillSessionTags({ firstCwd: '/demo/repo', tagSource: 'cwd',
          key: { ...sampleSessionKey, harnessSessionId: 'absent' }, checkout: sampleCheckoutInput(),
        });
        assertNotOk(absent, 'missing session succeeded');
        assertEqual(absent.code, 'SESSION_NOT_FOUND', 'missing session code changed');
      }),
    ),
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
          // Row for row, in the same order: a replay may not move, rewrite or
          // re-identify anything it already holds (AD-8).
          assertEqual(
            afterSecond.messages.map((message) => [
              message.harnessMessageId,
              message.id,
              message.body,
            ]),
            afterFirst.messages.map((message) => [
              message.harnessMessageId,
              message.id,
              message.body,
            ]),
            'replaying a batch changed the stored messages or the order they are read in',
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
      'ingest stores the whole batch and reads it back in conversation order',
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
          // The fixture's messages are in conversation order and their
          // instants rise with it, so this is both assertions in one: every
          // body is there, and the read is ordered by `occurredAt` (AD-8).
          assertEqual(
            read.messages.map(bodyOf),
            batch.messages.map((message) => message.body),
            'the stored message bodies are not the ones the batch carried, in conversation order',
          );
          assertEqual(
            read.messages.map((message) => message.occurredAt),
            [...batch.messages]
              .map((message) => message.occurredAt)
              .sort((left, right) => left.getTime() - right.getTime()),
            'a read must hand the messages back by the instant they were uttered',
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
      'a batch that carries on from the last one inserts only what is new',
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
      'a batch whose front changed leaves the stored rows alone and is read first',
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
            assertEqual(now.id, was.id, `the id of ${was.harnessMessageId} changed`);
            assertEqual(now.body, was.body, `the body of ${was.harnessMessageId} changed`);
          }
          // And it is read where it was uttered, which here is the front: the
          // message that arrived last is the earliest one of the conversation,
          // and nothing about the order it was inserted in may show (AD-8,
          // migration 0006).
          assertEqual(
            after.messages.map((message) => message.harnessMessageId),
            ['msg-1', 'msg-2', 'msg-3', 'msg-4'],
            'a message that arrived in front must be read in front',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'a message uttered in the middle of a stored conversation is read in its place',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');

          // What a parser version that starts keeping a kind of line does: the
          // conversation was stored without msg-2, and the next read of the
          // same transcript carries it — from the middle, where it was uttered
          // (migration 0006). msg-3 is seeded with a tool note of its own, so
          // the note order has something to be wrong about: msg-2's notes were
          // inserted last and were uttered first.
          const seeded = sampleIngestBatch({ only: ['msg-1', 'msg-3', 'msg-4'] });
          assertOk(
            await store.ingest({
              ...seeded,
              toolNotes: [...seeded.toolNotes, middleToolNote],
            }),
            'the first ingest failed',
          );

          const whole = sampleIngestBatch({ idStart: 600 });
          const result = await store.ingest({
            ...whole,
            toolNotes: [...whole.toolNotes, middleToolNote],
          });
          assertOk(result, 'the second ingest failed');
          assertEqual(
            result.inserted,
            { messages: 1, toolNotes: 2 },
            'only the message the session did not hold, and its own notes, may be inserted',
          );

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the session could not be read after the second ingest');
          assertEqual(
            read.messages.map((message) => message.harnessMessageId),
            ['msg-1', 'msg-2', 'msg-3', 'msg-4'],
            'a message uttered in the middle must be read in the middle, whichever batch carried it',
          );
          assertEqual(
            read.toolNotes.map((note) => [note.harnessMessageId, note.ordinal]),
            [
              ['msg-2', 0],
              ['msg-2', 1],
              ['msg-3', 0],
            ],
            'a tool note must follow its message in the conversation, not the batch it arrived in',
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
      'ingest records the start source the batch carried and never overwrites it',
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

          // And neither may a batch that carries another one. A transcript
          // collects an attachment per start, and the parser answers with the
          // first of them — so a value that disagrees with what is stored is a
          // read of a file whose front this session has already been told about
          // (follow-up review #18).
          assertOk(
            await store.ingest(
              sampleIngestBatch({ idStart: 400, tracking: { startSource: 'startup' } }),
            ),
            'the third ingest failed',
          );
          const first = await store.readSession(sampleSessionToken);
          assertOk(first, 'the session could not be read after the third ingest');
          assertEqual(
            first.session.startSource,
            'resume',
            'the stored start source is the first one learned and must never be overwritten',
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

          // Unless the parse was reset and the session still stands where that
          // read found it: then the front of the transcript is not what it was,
          // and the batch's cursor is the only one that still describes the
          // file (AD-4).
          const reset = sampleIngestBatch({
            idStart: 500,
            only: ['msg-1', 'msg-2'],
            tracking: { cursorReset: true, cursorBase: whole.tracking.cursor },
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
      'the cursor is compared by when the messages were uttered, not by when they arrived',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');

          // Two reads of one transcript, overlapping. The first stopped at
          // msg-4 (03:05:20); the second read less of the file and stopped at
          // msg-3 (03:05:01), which it also inserts — so msg-3 is the newest
          // row in the table and still the earlier moment. A store that
          // compared the two by insertion order would wind the cursor back to
          // it (migration 0006).
          const ahead = sampleIngestBatch({ only: ['msg-1', 'msg-2', 'msg-4'] });
          assertOk(await store.ingest(ahead), 'the first ingest failed');

          const behind = sampleIngestBatch({
            idStart: 700,
            only: ['msg-1', 'msg-2', 'msg-3'],
          });
          const result = await store.ingest(behind);
          assertOk(result, 'the overlapping ingest failed');
          assertEqual(
            result.inserted.messages,
            1,
            'the overlapping batch carried exactly one message the session did not hold',
          );

          const after = await store.readSession(sampleSessionToken);
          assertOk(after, 'the session could not be read after the overlapping ingest');
          assertEqual(
            after.session.cursor,
            ahead.tracking.cursor,
            'a cursor on an earlier message must not move the session, however late it arrived',
          );

          // And a reset says the front of the file is not what it was, so the
          // batch's cursor is the only one that still describes it (AD-4) — as
          // long as the session is still where that read began (story 21).
          const reset = sampleIngestBatch({
            idStart: 800,
            only: ['msg-1', 'msg-2', 'msg-3'],
            tracking: { cursorReset: true, cursorBase: ahead.tracking.cursor },
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
      'two reset batches from one base leave the cursor where the longer read put it',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');

          // One read first, so both of the overlapping reads below start from
          // the cursor it left behind.
          const first = sampleIngestBatch({ only: ['msg-1'] });
          assertOk(await store.ingest(first), 'the first ingest failed');
          const base = first.tracking.cursor;

          // Two hooks that both found the front of the transcript rewritten,
          // both from that base. The one that read further commits first.
          const longer = sampleIngestBatch({
            idStart: 600,
            tracking: { cursorReset: true, cursorBase: base },
          });
          assertOk(await store.ingest(longer), 'the longer reset ingest failed');
          const shorter = sampleIngestBatch({
            idStart: 700,
            only: ['msg-1', 'msg-2'],
            tracking: { cursorReset: true, cursorBase: base },
          });
          assertOk(await store.ingest(shorter), 'the shorter reset ingest failed');

          const after = await store.readSession(sampleSessionToken);
          assertOk(after, 'the session could not be read after the overlapping resets');
          // The shorter read's reset is already stale: the session is no longer
          // where it began, so its answer is the one that must give way, or the
          // next read would parse a stretch that is already stored.
          assertEqual(
            after.session.cursor,
            longer.tracking.cursor,
            'an overlapping reset must not wind the cursor back over what the other read stored',
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
      'a reset batch with no message warns and clears the cursor',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');
          const stored = sampleIngestBatch();
          assertOk(await store.ingest(stored), 'the first ingest failed');

          // The transcript was rewritten down to something with no
          // conversation in it: the parse found the front changed and then
          // found no message, so it has no cursor to offer either.
          const empty = sampleIngestBatch({
            only: [],
            tracking: {
              cursorReset: true,
              cursorBase: stored.tracking.cursor,
              cursor: null,
            },
          });
          const result = await store.ingest(empty);
          assertOk(result, 'the empty reset ingest failed');
          assertEqual(
            [...result.warnings],
            ['CURSOR_RESET'],
            'a reset must warn even when the batch carries no message at all',
          );
          assertEqual(
            result.inserted,
            { messages: 0, toolNotes: 0 },
            'a batch with nothing in it must insert nothing',
          );

          const after = await store.readSession(sampleSessionToken);
          assertOk(after, 'the session could not be read after the empty reset ingest');
          // Cleared, and not left pointing at a message of the transcript that
          // was: a cursor nothing can match again makes every later read start
          // at the front and warn, for ever (follow-up review #16).
          assertEqual(
            after.session.cursor,
            null,
            'a reset batch with no cursor must clear the stored one',
          );
          assertEqual(
            after.messages.map((message) => message.harnessMessageId),
            stored.messages.map((message) => message.harnessMessageId),
            'an empty batch must leave the stored conversation alone',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'a call the session already holds is not stored at a second position',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');
          assertOk(
            await store.ingest(
              oneNote(sampleIngestBatch(), {
                id: firstNoteId,
                harnessMessageId: 'msg-2',
                ordinal: 0,
                callId: 'call-x',
              }),
            ),
            'the first ingest failed',
          );

          // The same call, at the position a *newer* parser version puts it.
          // Two rows for one call would be two notes nobody can tell apart,
          // and a note cannot be taken back (AD-11, #9).
          const again = await store.ingest(
            oneNote(sampleIngestBatch({ idStart: 50 }), {
              id: secondNoteId,
              harnessMessageId: 'msg-3',
              ordinal: 0,
              callId: 'call-x',
            }),
          );
          assertOk(again, 'the second ingest failed');
          assertEqual(
            again.inserted.toolNotes,
            0,
            'a call the session already holds must not be stored again',
          );

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the session could not be read');
          assertEqual(
            read.toolNotes.map((note) => [note.id, note.harnessMessageId, note.ordinal]),
            [[firstNoteId, 'msg-2', 0]],
            'the row the first ingest wrote must be the only one, where it was',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'a note at a position an older version used is recognised by that position',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');
          // A row with no call id, which is what a parser version that named
          // its calls nothing left behind.
          assertOk(
            await store.ingest(
              oneNote(sampleIngestBatch(), {
                id: firstNoteId,
                harnessMessageId: 'msg-2',
                ordinal: 0,
                callId: null,
              }),
            ),
            'the first ingest failed',
          );

          const again = await store.ingest(
            oneNote(sampleIngestBatch({ idStart: 50 }), {
              id: secondNoteId,
              harnessMessageId: 'msg-3',
              ordinal: 0,
              callId: 'call-x',
              earlierPositions: [{ harnessMessageId: 'msg-2', ordinal: 0 }],
            }),
          );
          assertOk(again, 'the second ingest failed');
          assertEqual(
            again.inserted.toolNotes,
            0,
            'a row with no call id at a named earlier position is the same call',
          );

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the session could not be read');
          assertEqual(
            read.toolNotes.map((note) => note.id),
            [firstNoteId],
            'the row with no call id must be left exactly as it was',
          );
        });
      },
    ),

    contractCase<SessionStoreSubject>(
      'a note whose earlier positions name no stored row is a new call',
      async (make) => {
        await withSubject(make, async (store) => {
          await owner(store);
          assertOk(await store.ensureSession(sampleEnsureSessionInput()), 'ensureSession failed');
          assertOk(
            await store.ingest(
              oneNote(sampleIngestBatch(), {
                id: firstNoteId,
                harnessMessageId: 'msg-2',
                ordinal: 0,
                callId: null,
              }),
            ),
            'the first ingest failed',
          );

          // A different position, and nothing claims the stored row is this
          // call: the list is a superset on purpose, and a position nobody
          // named is simply not matched (`domain/ingest-batch.ts`).
          const again = await store.ingest(
            oneNote(sampleIngestBatch({ idStart: 50 }), {
              id: secondNoteId,
              harnessMessageId: 'msg-3',
              ordinal: 0,
              callId: 'call-y',
            }),
          );
          assertOk(again, 'the second ingest failed');
          assertEqual(again.inserted.toolNotes, 1, 'a new call must be stored');

          const read = await store.readSession(sampleSessionToken);
          assertOk(read, 'the session could not be read');
          assertEqual(
            read.toolNotes.map((note) => note.id).slice().sort(),
            [firstNoteId, secondNoteId].slice().sort(),
            'both calls must be stored, each at its own position',
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
 * Two note ids outside the range `sampleIngestBatch` mints from, so a case can
 * name the row a particular ingest wrote.
 */
const firstNoteId = '01940000-0000-7000-8000-0000000009f2';
const secondNoteId = '01940000-0000-7000-8000-0000000009f3';

/**
 * The batch with one tool note and nothing else, for the three cases about how
 * a store recognises the same call across parser versions (#9).
 */
function oneNote(
  batch: IngestBatch,
  note: {
    id: string;
    harnessMessageId: string;
    ordinal: number;
    callId: string | null;
    earlierPositions?: readonly ToolNotePosition[];
  },
): IngestBatch {
  const only: IngestToolNote = {
    id: note.id,
    harnessMessageId: note.harnessMessageId,
    ordinal: note.ordinal,
    tool: 'read',
    target: 'notes/import.md',
    ok: true,
    callId: note.callId,
    earlierPositions: note.earlierPositions ?? [],
  };
  return { ...batch, toolNotes: [only] };
}

/**
 * A tool note on msg-3, which the "uttered in the middle" case seeds before the
 * message that was uttered *before* it arrives. The fixture transcript puts its
 * only tool calls on msg-2, so without this the note order would have nothing
 * to get wrong. The id is outside the range `sampleIngestBatch` mints from.
 */
const middleToolNote = {
  id: '01940000-0000-7000-8000-0000000009f1',
  harnessMessageId: 'msg-3',
  ordinal: 0,
  tool: 'read',
  target: 'notes/import.md',
  ok: true,
  // A harness that names its calls nothing, which is the `null` case every
  // store has to handle: the note is then recognised by its position alone.
  callId: null,
  earlierPositions: [],
};

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
