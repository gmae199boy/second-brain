import { workKindPolicy } from '../../domain/work-item.js';
import type { WorkStore } from '../../ports/store.js';
import { assertEqual, assertOk, assertTrue } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
import {
  lastWorkItemId,
  otherFailureId,
  otherWorkItemId,
  sampleFailureId,
  sampleFailureInput,
  sampleWorkInput,
  sampleWorkItemId,
} from '../fixtures.js';

/**
 * The queue capability: one backlog, claimed by one worker at a time, finished
 * only by the worker that still holds the claim (AD-21).
 *
 * The whole of it is "exactly once, even when a worker disappears". A claim
 * lasts a while and then expires, so two workers can believe they hold the same
 * row — and every verb that finishes an item is therefore a compare-and-set on
 * `claimed_by`, not an update by id. A store that got that wrong would let a
 * killed worker's late answer overwrite the live worker's state, and both
 * "processed once" and "a lost claim does not raise the count" would break
 * (Design Notes).
 *
 * `now` is given, never read: a store that reached for a clock would make the
 * expiry of a claim depend on the machine rather than on the instant the drain
 * decided (AD-13).
 */
export function workStoreContract(): ContractCase<WorkStore>[] {
  const NOW = new Date('2026-02-03T04:05:06.000Z');
  const LATER = new Date('2026-02-03T05:05:06.000Z');
  const KINDS = ['demo_work'];

  return [
    contractCase<WorkStore>('addWork is find-or-create on the open key', async (make) => {
      await withSubject(make, async (store) => {
        const first = await store.addWork(sampleWorkInput());
        assertOk(first, 'the first addWork failed');
        assertTrue(first.created, 'the first addWork must create the row');
        assertEqual(first.item.id, sampleWorkItemId, 'the created row kept another id');
        assertEqual(first.item.attempts, 0, 'a fresh item must have no attempts');
        assertEqual(first.item.claimedBy, null, 'a fresh item must not be claimed');
        assertEqual(first.item.completedAt, null, 'a fresh item must not be completed');

        const again = await store.addWork(
          sampleWorkInput({ id: otherWorkItemId, nextAttemptAt: LATER }),
        );
        assertOk(again, 'the second addWork failed');
        assertTrue(!again.created, 'a second addWork for the same work must create nothing');
        assertEqual(
          again.item.id,
          sampleWorkItemId,
          'addWork must hand back the open row, not the proposed id',
        );
        assertEqual(
          again.item.nextAttemptAt.getTime(),
          NOW.getTime(),
          'a second addWork must change nothing about the open row (AD-21)',
        );
      });
    }),

    contractCase<WorkStore>('a second call with the same proposed id creates nothing', async (make) => {
      await withSubject(make, async (store) => {
        // A caller replaying a record proposes the id it minted the first time
        // — a spooled `failure` record carries its own id and is put back as it
        // was (AD-9). So `created` must be "this call made the row", which the
        // id cannot answer: a store that compared them would call the replay a
        // creation and every count built on it would be one too high.
        const first = await store.addWork(sampleWorkInput());
        assertOk(first, 'the first addWork failed');
        assertTrue(first.created, 'the first addWork must create the row');

        const again = await store.addWork(sampleWorkInput());
        assertOk(again, 'the second addWork failed');
        assertTrue(!again.created, 'the same id proposed twice must not read as two creations');

        const recorded = await store.recordFailure(sampleFailureInput());
        assertOk(recorded, 'the first recordFailure failed');
        if (recorded.outcome !== 'recorded') {
          assertTrue(false, 'the first recordFailure did not record');
          return;
        }
        assertTrue(recorded.created, 'the first recordFailure must create the row');

        const twice = await store.recordFailure(sampleFailureInput());
        assertOk(twice, 'the second recordFailure failed');
        if (twice.outcome !== 'recorded') {
          assertTrue(false, 'the second recordFailure did not record');
          return;
        }
        assertTrue(!twice.created, 'the same failure id proposed twice must not read as two rows');
      });
    }),

    contractCase<WorkStore>(
      'claimWork takes the least attempted, then the oldest id',
      async (make) => {
        await withSubject(make, async (store) => {
          // The first item alone, and tried twice, so that the two added after
          // it are behind it by id and ahead of it by attempts. The order is
          // `(attempts, id)`, so one poisonous row cannot starve the rest.
          const tried = await store.addWork(sampleWorkInput({ targetId: 'target-a' }));
          assertOk(tried, 'addWork failed');
          for (let round = 0; round < 2; round += 1) {
            const primed = await store.claimWork({
              now: NOW,
              claimedBy: `w${String(round)}`,
              kinds: KINDS,
            });
            assertOk(primed, 'a priming claim failed');
            assertEqual(primed.item?.id, tried.item.id, 'the priming claim took the wrong item');
            const retry = await store.retryWork({
              id: tried.item.id,
              claimedBy: `w${String(round)}`,
              // Back into the past, so the item is due again at `NOW`: this is
              // priming the attempt count, not the schedule.
              nextAttemptAt: NOW,
              lastError: 'primed',
            });
            assertOk(retry, 'the priming retry failed');
            assertEqual(retry.outcome, 'done', 'the priming retry lost its own claim');
          }

          // Two untried items, in reverse id order, so a store that happened to
          // return them in insertion order would fail the tie-break.
          const later = await store.addWork(
            sampleWorkInput({ id: lastWorkItemId, targetId: 'target-c' }),
          );
          assertOk(later, 'the third addWork failed');
          const second = await store.addWork(
            sampleWorkInput({ id: otherWorkItemId, targetId: 'target-b' }),
          );
          assertOk(second, 'the second addWork failed');

          const first = await store.claimWork({ now: NOW, claimedBy: 'd1', kinds: KINDS });
          assertOk(first, 'claimWork failed');
          assertEqual(
            first.item?.id,
            second.item.id,
            'claimWork must take the least attempted item, oldest id first (AD-21)',
          );

          const next = await store.claimWork({ now: NOW, claimedBy: 'd2', kinds: KINDS });
          assertOk(next, 'the second claimWork failed');
          assertEqual(next.item?.id, later.item.id, 'the id tie-break was not applied');

          // And only now the one that has already been tried twice.
          const last = await store.claimWork({ now: NOW, claimedBy: 'd3', kinds: KINDS });
          assertOk(last, 'the third claimWork failed');
          assertEqual(
            last.item?.id,
            tried.item.id,
            'a much-attempted item must come after the untried ones',
          );
        });
      },
    ),

    contractCase<WorkStore>('claimWork raises attempts inside the claim', async (make) => {
      await withSubject(make, async (store) => {
        assertOk(await store.addWork(sampleWorkInput()), 'addWork failed');

        const claim = await store.claimWork({ now: NOW, claimedBy: 'drain', kinds: KINDS });
        assertOk(claim, 'claimWork failed');
        const item = claim.item;
        if (item === null) {
          assertTrue(false, 'claimWork found nothing to claim');
          return;
        }
        assertEqual(item.attempts, 1, 'the claim must raise attempts (Decision 1, 2026-10-19)');
        assertEqual(item.claimedBy, 'drain', 'the claim must record who holds it');
        assertEqual(
          item.claimedAt?.getTime(),
          NOW.getTime(),
          'the claim must be stamped with the instant it was given, not one the store read',
        );
        assertEqual(
          item.claimExpiresAt?.getTime(),
          NOW.getTime() + workKindPolicy(item.kind).claimForMs,
          "the claim must expire at the instant this kind's policy says (AD-21)",
        );
      });
    }),

    contractCase<WorkStore>('a live claim hides the item, an expired one does not', async (make) => {
      await withSubject(make, async (store) => {
        assertOk(await store.addWork(sampleWorkInput()), 'addWork failed');
        const first = await store.claimWork({ now: NOW, claimedBy: 'a', kinds: KINDS });
        assertOk(first, 'the first claim failed');
        assertTrue(first.item !== null, 'the first claim found nothing');

        const live = await store.hasDueWork({ now: NOW, kinds: KINDS });
        assertOk(live, 'hasDueWork failed while a claim was live');
        assertTrue(!live.due, 'an item somebody is holding must not be due (AD-21)');
        const blocked = await store.claimWork({ now: NOW, claimedBy: 'b', kinds: KINDS });
        assertOk(blocked, 'the second claim failed');
        assertEqual(blocked.item, null, 'a live claim must not be handed to a second worker');

        // Past the claim window the row is fair game again, which is how a
        // drain takes over from a worker that was killed.
        const expired = await store.hasDueWork({ now: LATER, kinds: KINDS });
        assertOk(expired, 'hasDueWork failed after the claim expired');
        assertTrue(expired.due, 'an expired claim must leave the item due again');
        const taken = await store.claimWork({ now: LATER, claimedBy: 'b', kinds: KINDS });
        assertOk(taken, 'the take-over claim failed');
        assertEqual(taken.item?.attempts, 2, 'the take-over claim must raise attempts again');
      });
    }),

    contractCase<WorkStore>('an item due in the future is not claimed', async (make) => {
      await withSubject(make, async (store) => {
        assertOk(
          await store.addWork(sampleWorkInput({ nextAttemptAt: LATER })),
          'addWork failed',
        );

        const due = await store.hasDueWork({ now: NOW, kinds: KINDS });
        assertOk(due, 'hasDueWork failed');
        assertTrue(!due.due, 'an item whose next attempt is in the future must not be due');
        const claim = await store.claimWork({ now: NOW, claimedBy: 'drain', kinds: KINDS });
        assertOk(claim, 'claimWork failed');
        assertEqual(claim.item, null, 'an item due later must not be claimed');

        const soon = await store.claimWork({ now: LATER, claimedBy: 'drain', kinds: KINDS });
        assertOk(soon, 'the later claim failed');
        assertTrue(soon.item !== null, 'the item must be claimable once it is due');
      });
    }),

    contractCase<WorkStore>('a kind nobody handles is left alone', async (make) => {
      await withSubject(make, async (store) => {
        assertOk(await store.addWork(sampleWorkInput({ kind: 'unknown_work' })), 'addWork failed');

        const due = await store.hasDueWork({ now: NOW, kinds: KINDS });
        assertOk(due, 'hasDueWork failed');
        assertTrue(!due.due, 'a kind this build cannot do must not be due (Decision 4)');
        const claim = await store.claimWork({ now: NOW, claimedBy: 'drain', kinds: KINDS });
        assertOk(claim, 'claimWork failed');
        assertEqual(claim.item, null, 'a kind with no handler must not be claimed');

        // And it is still there: an old build must not close a new build's work.
        const named = await store.hasDueWork({ now: NOW, kinds: ['unknown_work'] });
        assertOk(named, 'hasDueWork failed for the kind itself');
        assertTrue(named.due, 'the item must still be waiting for a build that knows its kind');
      });
    }),

    contractCase<WorkStore>('finishing with somebody else\'s claim is lost', async (make) => {
      await withSubject(make, async (store) => {
        const added = await store.addWork(sampleWorkInput());
        assertOk(added, 'addWork failed');
        const claim = await store.claimWork({ now: NOW, claimedBy: 'a', kinds: KINDS });
        assertOk(claim, 'claimWork failed');
        const id = added.item.id;

        for (const finish of [
          async () => store.completeWork({ id, claimedBy: 'b', now: NOW }),
          async () =>
            store.retryWork({ id, claimedBy: 'b', nextAttemptAt: LATER, lastError: 'nope' }),
          async () => store.releaseWork({ id, claimedBy: 'b' }),
        ]) {
          const result = await finish();
          assertOk(result, 'a finishing verb failed instead of answering lost');
          assertEqual(
            result.outcome,
            'lost',
            "a finishing verb must change nothing when the claim is somebody else's",
          );
        }

        const recorded = await store.recordFailure(
          sampleFailureInput({ closeWork: { id, claimedBy: 'b', now: NOW } }),
        );
        assertOk(recorded, 'recordFailure failed instead of answering lost');
        assertEqual(
          recorded.outcome,
          'lost',
          'recordFailure with a claim that is not ours must write nothing (port contract)',
        );

        // The row is untouched: still claimed by `a`, still on one attempt.
        const still = await store.claimWork({ now: NOW, claimedBy: 'c', kinds: KINDS });
        assertOk(still, 'the check claim failed');
        assertEqual(still.item, null, 'the live claim of the first worker was lost');
        const after = await store.claimWork({ now: LATER, claimedBy: 'c', kinds: KINDS });
        assertOk(after, 'the check claim after expiry failed');
        assertEqual(
          after.item?.attempts,
          2,
          'attempts must have risen only for the claims that were actually taken',
        );
      });
    }),

    contractCase<WorkStore>('releaseWork hands the attempt back as well', async (make) => {
      await withSubject(make, async (store) => {
        const added = await store.addWork(sampleWorkInput());
        assertOk(added, 'addWork failed');
        const claim = await store.claimWork({ now: NOW, claimedBy: 'a', kinds: KINDS });
        assertOk(claim, 'claimWork failed');
        assertEqual(claim.item?.attempts, 1, 'the claim did not raise attempts');

        const back = await store.releaseWork({ id: added.item.id, claimedBy: 'a' });
        assertOk(back, 'releaseWork failed');
        assertEqual(back.outcome, 'done', 'releaseWork lost its own claim');

        // Due again at once — `next_attempt_at` is untouched — and back to zero
        // attempts, because nothing was tried (AD-21).
        const again = await store.claimWork({ now: NOW, claimedBy: 'b', kinds: KINDS });
        assertOk(again, 'the claim after the release failed');
        assertEqual(again.item?.attempts, 1, 'releaseWork must undo the attempt it gave back');
      });
    }),

    contractCase<WorkStore>('completeWork closes the row and clears the claim', async (make) => {
      await withSubject(make, async (store) => {
        const added = await store.addWork(sampleWorkInput());
        assertOk(added, 'addWork failed');
        assertOk(
          await store.claimWork({ now: NOW, claimedBy: 'a', kinds: KINDS }),
          'claimWork failed',
        );

        const done = await store.completeWork({ id: added.item.id, claimedBy: 'a', now: NOW });
        assertOk(done, 'completeWork failed');
        assertEqual(done.outcome, 'done', 'completeWork lost its own claim');

        const due = await store.hasDueWork({ now: LATER, kinds: KINDS });
        assertOk(due, 'hasDueWork failed after the item was completed');
        assertTrue(!due.due, 'a completed item must never be due again');

        // The completed row is out of the open key, so the same work asked for
        // again is a new row — which is what `failures retry` depends on.
        const next = await store.addWork(sampleWorkInput({ id: otherWorkItemId }));
        assertOk(next, 'addWork after completion failed');
        assertTrue(next.created, 'the same work after completion must be a new row (AD-21)');
        assertEqual(next.item.id, otherWorkItemId, 'the new row did not keep the proposed id');
      });
    }),

    contractCase<WorkStore>('the same failure key is one row, reopened', async (make) => {
      await withSubject(make, async (store) => {
        const first = await store.recordFailure(sampleFailureInput());
        assertOk(first, 'the first recordFailure failed');
        assertEqual(first.outcome, 'recorded', 'the first recordFailure recorded nothing');
        if (first.outcome !== 'recorded') return;
        assertTrue(first.created, 'the first recordFailure must create the row');

        const again = await store.recordFailure(
          sampleFailureInput({
            id: otherFailureId,
            message: '다른 문장',
            occurredAt: LATER,
          }),
        );
        assertOk(again, 'the second recordFailure failed');
        if (again.outcome !== 'recorded') {
          assertTrue(false, 'the second recordFailure did not record');
          return;
        }
        assertTrue(!again.created, 'the same failure key must not make a second row');
        assertEqual(
          again.failureId,
          sampleFailureId,
          'the reopened row must keep the id it was first given (Decision 2)',
        );

        // A different classification code is a different cause, so a different
        // row: the fingerprint is built from the code (I/O matrix).
        const other = await store.recordFailure(
          sampleFailureInput({ id: otherFailureId, code: 'OTHER', fingerprint: 'sha256:other' }),
        );
        assertOk(other, 'the third recordFailure failed');
        if (other.outcome !== 'recorded') {
          assertTrue(false, 'the third recordFailure did not record');
          return;
        }
        assertTrue(other.created, 'a different fingerprint must be a different row');
      });
    }),

    contractCase<WorkStore>(
      'the same cause three times is one row that counts them, keeping the first instant',
      async (make) => {
        await withSubject(make, async (store) => {
          const THIRD = new Date('2026-02-03T06:05:06.000Z');
          // Three occurrences of one cause, each with its own sentence: what
          // the row has to end up saying is when it started, when it last
          // happened, and how many times (0005, I/O matrix).
          for (const [index, occurredAt] of [NOW, LATER, THIRD].entries()) {
            const recorded = await store.recordFailure(
              sampleFailureInput({
                id: index === 0 ? sampleFailureId : otherFailureId,
                message: `${String(index + 1)}번째 문장`,
                occurredAt,
              }),
            );
            assertOk(recorded, `recordFailure ${String(index + 1)} failed`);
            if (recorded.outcome !== 'recorded') {
              assertTrue(false, `recordFailure ${String(index + 1)} did not record`);
              return;
            }
            assertTrue(
              recorded.created === (index === 0),
              'only the first record of a cause may create the row',
            );
          }

          const listed = await store.listFailures({});
          assertOk(listed, 'listFailures failed after the cause was met three times');
          assertEqual(listed.failures.length, 1, 'three records of one cause must be one row');
          const row = listed.failures[0];
          assertEqual(row?.occurrences, 3, 'the row must count every occurrence of the cause');
          assertEqual(
            row?.firstOccurredAt.getTime(),
            NOW.getTime(),
            'the first instant must stay the first occurrence\'s (0005)',
          );
          assertEqual(
            row?.occurredAt.getTime(),
            THIRD.getTime(),
            'the instant must be the latest occurrence\'s (Decision 2)',
          );
          assertEqual(row?.message, '3번째 문장', 'the sentence must be the latest occurrence\'s');
        });
      },
    ),

    contractCase<WorkStore>('recordFailure closes the item it was about', async (make) => {
      await withSubject(make, async (store) => {
        const added = await store.addWork(sampleWorkInput());
        assertOk(added, 'addWork failed');
        assertOk(
          await store.claimWork({ now: NOW, claimedBy: 'a', kinds: KINDS }),
          'claimWork failed',
        );

        const recorded = await store.recordFailure(
          sampleFailureInput({ closeWork: { id: added.item.id, claimedBy: 'a', now: NOW } }),
        );
        assertOk(recorded, 'recordFailure failed');
        assertEqual(recorded.outcome, 'recorded', 'recordFailure lost its own claim');

        const due = await store.hasDueWork({ now: LATER, kinds: KINDS });
        assertOk(due, 'hasDueWork failed after the item was recorded');
        assertTrue(!due.due, 'recordFailure with closeWork must close the item (AD-21)');
      });
    }),

    contractCase<WorkStore>(
      'listOpenWorkTargets answers the open items of one kind, and nothing else',
      async (make) => {
        await withSubject(make, async (store) => {
          const empty = await store.listOpenWorkTargets({ kind: 'demo_work' });
          assertOk(empty, 'listOpenWorkTargets must answer with a value on an empty queue');
          assertEqual(empty.targets.length, 0, 'an empty queue has no open targets');

          assertOk(await store.addWork(sampleWorkInput()), 'addWork failed');
          assertOk(
            await store.addWork(
              sampleWorkInput({
                id: otherWorkItemId,
                kind: 'other_work',
                targetId: 'demo:session-0002',
              }),
            ),
            'the second addWork failed',
          );

          const open = await store.listOpenWorkTargets({ kind: 'demo_work' });
          assertOk(open, 'listOpenWorkTargets failed');
          assertEqual(open.targets.length, 1, 'only the asked-for kind may come back');
          assertEqual(
            open.targets[0],
            { targetKind: 'session', targetId: sampleWorkInput().targetId },
            'listOpenWorkTargets must answer with the target of the open item',
          );

          // Completed is not open: the scan uses this to decide what it need
          // not enqueue, and work that finished has to be enqueued again.
          const claimed = await store.claimWork({ now: NOW, claimedBy: 'a', kinds: KINDS });
          assertOk(claimed, 'claimWork failed');
          assertOk(
            await store.completeWork({ id: sampleWorkItemId, claimedBy: 'a', now: NOW }),
            'completeWork failed',
          );
          const after = await store.listOpenWorkTargets({ kind: 'demo_work' });
          assertOk(after, 'listOpenWorkTargets failed after the item was completed');
          assertEqual(after.targets.length, 0, 'a completed item is not an open target (AD-21)');
        });
      },
    ),

    contractCase<WorkStore>('listFailures answers newest first and narrows', async (make) => {
      await withSubject(make, async (store) => {
        const first = await store.recordFailure(
          sampleFailureInput({ occurredAt: NOW, code: 'DEMO_FAILED' }),
        );
        assertOk(first, 'the first recordFailure failed');
        const second = await store.recordFailure(
          sampleFailureInput({
            id: otherFailureId,
            targetKind: 'file',
            targetId: 'sha256:demo',
            stage: 'other_work',
            fingerprint: 'sha256:other',
            occurredAt: LATER,
          }),
        );
        assertOk(second, 'the second recordFailure failed');

        const all = await store.listFailures({});
        assertOk(all, 'listFailures failed');
        assertEqual(all.failures.length, 2, 'both failures must come back');
        assertEqual(
          all.failures.map((failure) => failure.id),
          [otherFailureId, sampleFailureId],
          'listFailures must answer newest first (occurred_at desc, id desc)',
        );

        const narrowed = await store.listFailures({ targetKind: 'file' });
        assertOk(narrowed, 'listFailures with a target kind failed');
        assertEqual(narrowed.failures.length, 1, 'targetKind must narrow the answer');
        assertEqual(narrowed.failures[0]?.targetKind, 'file', 'the wrong row came back');

        const byStage = await store.listFailures({ stage: 'demo_work' });
        assertOk(byStage, 'listFailures with a stage failed');
        assertEqual(byStage.failures.length, 1, 'stage must narrow the answer');

        const paged = await store.listFailures({ limit: 1 });
        assertOk(paged, 'listFailures with a limit failed');
        assertEqual(paged.failures.length, 1, 'limit must cut the answer');
        assertEqual(
          paged.failures[0]?.id,
          otherFailureId,
          'a limited page must still be the newest rows',
        );
      });
    }),

    contractCase<WorkStore>(
      'resolveFailures closes the open rows of one target and stage only',
      async (make) => {
        await withSubject(make, async (store) => {
          assertOk(await store.recordFailure(sampleFailureInput()), 'recordFailure failed');
          assertOk(
            await store.recordFailure(
              sampleFailureInput({
                id: otherFailureId,
                stage: 'other_work',
                fingerprint: 'sha256:other',
              }),
            ),
            'the second recordFailure failed',
          );

          const resolved = await store.resolveFailures({
            targetKind: 'session',
            targetId: sampleFailureInput().targetId,
            stage: 'demo_work',
            now: LATER,
          });
          assertOk(resolved, 'resolveFailures failed');
          assertEqual(resolved.resolved, 1, 'only the asked-for stage may be resolved');

          const open = await store.listFailures({});
          assertOk(open, 'listFailures failed after a resolve');
          assertEqual(
            open.failures.map((failure) => failure.id),
            [otherFailureId],
            'a resolved row must be out of the unresolved list',
          );

          const everything = await store.listFailures({ includeResolved: true });
          assertOk(everything, 'listFailures with includeResolved failed');
          assertEqual(everything.failures.length, 2, 'includeResolved must bring history back');
          const was = everything.failures.find((failure) => failure.id === sampleFailureId);
          assertEqual(
            was?.resolvedAt?.getTime(),
            LATER.getTime(),
            'a resolved row must carry the instant it was resolved at',
          );

          // A second resolve changes nothing: the row keeps the instant it was
          // first resolved at, so a success does not rewrite history.
          const again = await store.resolveFailures({
            targetKind: 'session',
            targetId: sampleFailureInput().targetId,
            stage: 'demo_work',
            now: new Date('2026-02-03T06:05:06.000Z'),
          });
          assertOk(again, 'the second resolveFailures failed');
          assertEqual(again.resolved, 0, 'only unresolved rows may be resolved (port contract)');
          const unchanged = await store.listFailures({ includeResolved: true });
          assertOk(unchanged, 'listFailures failed after the second resolve');
          assertEqual(
            unchanged.failures.find((failure) => failure.id === sampleFailureId)?.resolvedAt?.getTime(),
            LATER.getTime(),
            'a resolved row must keep the instant it was first resolved at',
          );
        });
      },
    ),

    contractCase<WorkStore>(
      'the same cause met again is open once more, and resolvable again',
      async (make) => {
        await withSubject(make, async (store) => {
          assertOk(await store.recordFailure(sampleFailureInput()), 'recordFailure failed');
          assertOk(
            await store.resolveFailures({
              targetKind: 'session',
              targetId: sampleFailureInput().targetId,
              stage: 'demo_work',
              now: NOW,
            }),
            'resolveFailures failed',
          );

          const again = await store.recordFailure(
            sampleFailureInput({ id: otherFailureId, occurredAt: LATER }),
          );
          assertOk(again, 'the second recordFailure failed');

          const open = await store.listFailures({});
          assertOk(open, 'listFailures failed after the cause was met again');
          assertEqual(
            open.failures.map((failure) => failure.id),
            [sampleFailureId],
            'a cause met again must reopen the row it already has (Table Contract)',
          );
        });
      },
    ),
  ];
}
