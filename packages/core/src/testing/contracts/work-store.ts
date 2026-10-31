import { dependencyFailedText, workKindPolicy } from '../../domain/work-item.js';
import type { WorkItem } from '../../domain/work-item.js';
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
export function workStoreContract(readItem: (store: WorkStore, id: string) => Promise<Pick<WorkItem, 'serializationKey' | 'outcome' | 'completedAt' | 'currentAttemptToken' | 'nextAttemptAt' | 'lastError'> | null>, readAttempt?: (store: WorkStore, token: string) => Promise<{ lastProgressAt: Date | null; renewedAt: Date | null } | null>): ContractCase<WorkStore>[] {
  const NOW = new Date('2026-02-03T04:05:06.000Z');
  const LATER = new Date('2026-02-03T05:05:06.000Z');
  const KINDS = ['demo_work'];

  return [
    contractCase('일감 ID로 정확한 항목과 마지막 시도를 조회한다', async make => {
      await withSubject(make, async store => {
        assertEqual(await store.getWork(sampleWorkItemId), { ok: true, entry: null }, '없는 일감');
        const added = await store.addWork(sampleWorkInput()); assertOk(added, '일감 생성');
        const read = await store.getWork(sampleWorkItemId); assertOk(read, 'ID 조회');
        assertEqual(read.entry?.item, added.item, '일감 조회');
        assertEqual(read.entry?.latestAttempt, null, '시도 없음');
      });
    }),
    contractCase('rejects invalid hold group names without persisting them', async make => {
      await withSubject(make, async store => {
        for (const group of ['', 'x'.repeat(201), '😀'.repeat(201)]) {
          const result = await store.holdWorkGroup({ group, now: NOW });
          assertEqual(result.ok, false, 'invalid group rejected');
          if (!result.ok) assertEqual(result.code, 'DB_UNAVAILABLE', 'constraint failure');
          assertEqual(await store.releaseWorkGroup({ group }), { ok: true, released: false }, 'no hold persisted');
        }
        const group = '😀'.repeat(200);
        assertEqual(await store.holdWorkGroup({ group, now: NOW }), { ok: true, held: true }, '200 code points accepted');
        assertEqual(await store.releaseWorkGroup({ group }), { ok: true, released: true }, 'boundary hold persisted');
      });
    }),
    contractCase('validates resolved work groups before creating or merging rows and graphs', async make => {
      await withSubject(make, async store => {
        const invalid = [{ holdGroup: '' }, { holdGroup: 'x'.repeat(201) }, { holdGroup: '😀'.repeat(201) }, { kind: 'x'.repeat(191) + '.job' }];
        for (const over of invalid) {
          const result = await store.addWork(sampleWorkInput(over));
          assertEqual(result.ok, false, 'invalid resolved group rejected');
          if (!result.ok) assertEqual(result.code, 'DB_UNAVAILABLE', 'constraint failure');
        }
        const empty = await store.listWork({ includeClosed: true, limit: 10 }); assertOk(empty, 'empty');
        assertEqual(empty.entries, [], 'rejected creation writes nothing');
        const added = await store.addWork(sampleWorkInput({ holdGroup: '😀'.repeat(200) })); assertOk(added, 'boundary');
        assertEqual(added.item.holdGroup, '😀'.repeat(200), 'counts code points');
        const before = await store.listWork({ includeClosed: true, limit: 10 });
        for (const holdGroup of ['', '😀'.repeat(201)]) {
          const merged = await store.addWork(sampleWorkInput({ id: otherWorkItemId, holdGroup,
            scheduledDates: { scheduleId: null, from: '2026-02-01', to: '2026-02-02', timeZone: 'UTC' } }));
          assertEqual(merged.ok, false, 'invalid merge rejected');
          if (!merged.ok) assertEqual(merged.code, 'DB_UNAVAILABLE', 'merge constraint failure');
        }
        const graph = await store.addWorkGraph({ nodes: [
          { ...sampleWorkInput({ id: otherWorkItemId, targetId: 'valid' }), after: [] },
          { ...sampleWorkInput({ id: lastWorkItemId, targetId: 'invalid', holdGroup: '' }), after: [] },
        ] });
        assertEqual(graph.ok, false, 'invalid graph rejected');
        if (!graph.ok) assertEqual(graph.code, 'DB_UNAVAILABLE', 'graph constraint failure');
        assertEqual(await store.listWork({ includeClosed: true, limit: 10 }), before, 'no merge or partial graph persisted');
        const automatic = await store.addWork(sampleWorkInput({ id: otherWorkItemId, kind: 'testext.job', holdGroup: '' })); assertOk(automatic, 'automatic overrides empty');
        const merged = await store.addWork(sampleWorkInput({ id: lastWorkItemId, kind: 'testext.job', holdGroup: '😀'.repeat(201) })); assertOk(merged, 'automatic overrides long explicit');
        assertEqual(merged.item.holdGroup, 'extension:testext', 'resolved group validated');
      });
    }),
    contractCase('stores the automatic extension group and an explicit core group', async make => {
      await withSubject(make, async store => {
        const automatic = await store.addWork(sampleWorkInput({ kind: 'testext.job', holdGroup: 'other' })); assertOk(automatic, 'automatic');
        assertEqual(automatic.item.holdGroup, 'extension:testext', 'extension wins');
        const core = await store.addWork(sampleWorkInput({ id: otherWorkItemId, holdGroup: 'extension:testext' })); assertOk(core, 'core');
        assertEqual(core.item.holdGroup, 'extension:testext', 'explicit core group');
        const merged = await store.addWork(sampleWorkInput({ id: lastWorkItemId, holdGroup: 'different' })); assertOk(merged, 'merged');
        assertEqual(merged.item.holdGroup, 'extension:testext', 'merge retains group');
        const graph = await store.addWorkGraph({ nodes: [ { ...sampleWorkInput({ id: lastWorkItemId, kind: 'otherext.graph' }), after: [] } ] }); assertOk(graph, 'graph');
        assertEqual(graph.items[0]?.item.holdGroup, 'extension:otherext', 'graph group');
      });
    }),
    contractCase('skips held groups on every claim path and resumes on release', async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput({ holdGroup: 'extension:testext' }));
        await store.addWork(sampleWorkInput({ id: otherWorkItemId, kind: 'process_probe', holdGroup: 'extension:testext' }));
        await store.holdWorkGroup({ group: 'extension:testext', now: NOW });
        assertEqual(await store.hasDueWork({ now: NOW, kinds: KINDS }), { ok: true, due: false }, 'held not due');
        assertEqual(await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'core' }), { ok: true, item: null }, 'core blocked');
        assertEqual(await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'supervisor', attemptToken: sampleFailureId }), { ok: true, item: null, attemptToken: null }, 'supervisor blocked');
        const list = await store.listWork({ includeClosed: false, limit: 10 }); assertOk(list, 'list');
        assertEqual(list.entries.map(e => e.held), [true, true], 'both held');
        await store.releaseWorkGroup({ group: 'extension:testext' });
        const core = await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'core' }); assertOk(core, 'core'); assertEqual(core.item?.id, sampleWorkItemId, 'core resumed');
        const supervised = await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'supervisor', attemptToken: sampleFailureId }); assertOk(supervised, 'supervisor'); assertEqual(supervised.item?.id, otherWorkItemId, 'supervisor resumed');
      });
    }),
    contractCase('marks open supervised attempts of a held group', async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput({ kind: 'process_probe', holdGroup: 'extension:testext' }));
        await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'supervisor', attemptToken: sampleFailureId });
        await store.holdWorkGroup({ group: 'extension:testext', now: NOW });
        const open = await store.listOpenSupervisedAttempts(); assertOk(open, 'open');
        assertEqual(open.attempts[0]?.held, true, 'held'); assertEqual(open.attempts[0]?.cancelRequested, false, 'not user cancellation');
        await store.settleSupervisedAttempt({ id: sampleWorkItemId, attemptToken: sampleFailureId, now: NOW, outcome: 'cancelled' });
        const list = await store.listWork({ includeClosed: false, limit: 10 }); assertOk(list, 'list');
        assertEqual(list.entries[0]?.item.attempts, 0, 'attempt returned'); assertEqual(list.entries[0]?.item.claimedAt, null, 'claim released');
        assertEqual(list.entries[0]?.latestAttempt?.outcome, 'cancelled', 'attempt cancelled');
      });
    }),
    contractCase('reports hold and release idempotently', async make => {
      await withSubject(make, async store => {
        assertEqual(await store.holdWorkGroup({ group: 'group', now: NOW }), { ok: true, held: true }, 'first hold');
        assertEqual(await store.holdWorkGroup({ group: 'group', now: LATER }), { ok: true, held: false }, 'second hold');
        assertEqual(await store.releaseWorkGroup({ group: 'group' }), { ok: true, released: true }, 'first release');
        assertEqual(await store.releaseWorkGroup({ group: 'group' }), { ok: true, released: false }, 'second release');
      });
    }),
    contractCase('lists open work newest first with the latest attempt', async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput({ kind: 'process_probe', createdAt: NOW }));
        await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'worker', attemptToken: sampleFailureId });
        await store.settleSupervisedAttempt({ id: sampleWorkItemId, attemptToken: sampleFailureId, now: NOW, outcome: 'died' });
        await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'worker', attemptToken: otherFailureId });
        await store.addWork(sampleWorkInput({ id: otherWorkItemId, targetId: 'other', createdAt: LATER }));
        const page = await store.listWork({ includeClosed: false, limit: 1 }); assertOk(page, 'page');
        assertEqual(page.entries[0]?.item.id, otherWorkItemId, 'newest'); assertEqual(page.hasMore, true, 'more');
        const all = await store.listWork({ includeClosed: false, limit: 10 }); assertOk(all, 'all');
        assertEqual(all.entries[1]?.latestAttempt?.token, otherFailureId, 'attempt');
      });
    }),
    contractCase('reads the current attempt separately when tied starts sort an older attempt first', async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput({ kind: 'process_probe', createdAt: NOW }));
        await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'worker', attemptToken: otherFailureId });
        await store.settleSupervisedAttempt({ id: sampleWorkItemId, attemptToken: otherFailureId, now: NOW, outcome: 'died', elapsedMs: 1000 });
        await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'worker', attemptToken: sampleFailureId });
        await store.settleSupervisedAttempt({ id: sampleWorkItemId, attemptToken: sampleFailureId, now: NOW, outcome: 'unknown', elapsedMs: 2000 });
        const read = await store.listWork({ includeClosed: false, limit: 10 }); assertOk(read, 'list');
        assertEqual(read.entries[0]?.latestAttempt?.token, otherFailureId, 'latest uses descending token for tied starts');
        assertEqual(read.entries[0]?.latestAttempt?.outcome, 'died', 'latest display outcome');
        assertEqual(read.entries[0]?.currentAttempt?.token, sampleFailureId, 'current uses retained token');
        assertEqual(read.entries[0]?.currentAttempt?.outcome, 'unknown', 'current unknown outcome');
      });
    }),
    contractCase('lists closed work only when asked and filters by kind', async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput());
        await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'worker' });
        await store.completeWork({ id: sampleWorkItemId, claimedBy: 'worker', now: NOW });
        const open = await store.listWork({ includeClosed: false, limit: 10 }); assertOk(open, 'open'); assertEqual(open.entries, [], 'closed hidden');
        const all = await store.listWork({ includeClosed: true, kind: KINDS[0]!, limit: 10 }); assertOk(all, 'all'); assertEqual(all.entries.length, 1, 'closed included');
        const other = await store.listWork({ includeClosed: true, kind: 'other', limit: 10 }); assertOk(other, 'other'); assertEqual(other.entries, [], 'kind');
      });
    }),
    contractCase('sums model usage over the given kinds only', async make => {
      await withSubject(make, async store => {
        for (const [id, token, usage, elapsedMs] of [[sampleWorkItemId, sampleFailureId, { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 }, 1000],
          [otherWorkItemId, otherFailureId, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, 500]] as const) {
          await store.addWork(sampleWorkInput({ id, kind: 'process_probe', targetId: id }));
          await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'worker', attemptToken: token });
          await store.finishSupervisedWork({ id, attemptToken: token, now: LATER, outcome: 'succeeded', usage, elapsedMs });
        }
        const read = await store.readModelWorkUsage({ kinds: ['process_probe'] }); assertOk(read, 'usage');
        assertEqual([read.usage.inputTokens, read.usage.cachedInputTokens, read.usage.outputTokens, read.usage.elapsedMs], [11,2,6,1500], 'sums');
        const excluded = await store.readModelWorkUsage({ kinds: [] }); assertOk(excluded, 'excluded');
        assertEqual(excluded.usage, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, elapsedMs: 0, latest: null }, 'empty kinds');
      });
    }),
    contractCase('one serialization key is claimed once across kinds and claim paths', async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput({ serializationKey: 'account' }));
        await store.addWork(sampleWorkInput({ id: otherWorkItemId, kind: 'demo_other', serializationKey: 'account' }));
        await store.addWork(sampleWorkInput({ id: lastWorkItemId, kind: 'process_probe', serializationKey: 'account' }));
        const first = await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'core' }); assertOk(first, 'claim first');
        assertEqual(first.item?.serializationKey, 'account', 'key round trip');
        assertEqual(await store.claimWork({ now: NOW, kinds: ['demo_other'], claimedBy: 'other' }), { ok: true, item: null }, 'same key across kinds');
        assertEqual(await store.hasDueWork({ now: NOW, kinds: ['demo_other'] }), { ok: true, due: false }, 'blocked is not due');
        assertEqual(await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'supervisor', attemptToken: sampleFailureId }), { ok: true, item: null, attemptToken: null }, 'same key across paths');
        await store.addWork(sampleWorkInput({ id: sampleFailureId, kind: 'demo_other', targetId: 'independent', serializationKey: 'other' }));
        const independent = await store.claimWork({ now: NOW, kinds: ['demo_other'], claimedBy: 'other' }); assertOk(independent, 'claim independent');
        assertEqual(independent.item?.id, sampleFailureId, 'different key runs');
      });
    }),
    contractCase('a supervised claim holds its key against core claims', async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput({ kind: 'process_probe', serializationKey: 'account' }));
        await store.addWork(sampleWorkInput({ id: otherWorkItemId, serializationKey: 'account' }));
        const claimed = await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'supervisor', attemptToken: sampleFailureId }); assertOk(claimed, 'claim supervised');
        assertEqual(claimed.item?.id, sampleWorkItemId, 'supervised starts');
        assertEqual(await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'core' }), { ok: true, item: null }, 'core waits');
        assertEqual(await store.hasDueWork({ now: NOW, kinds: KINDS }), { ok: true, due: false }, 'core not due');
      });
    }),
    contractCase('an expired core lease frees its serialization key', async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput({ serializationKey: 'account' }));
        await store.addWork(sampleWorkInput({ id: otherWorkItemId, kind: 'demo_other', serializationKey: 'account' }));
        await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'core' });
        const claimed = await store.claimWork({ now: new Date(NOW.getTime() + workKindPolicy('demo_work').claimForMs), kinds: ['demo_other'], claimedBy: 'other' }); assertOk(claimed, 'claim after expiry');
        assertEqual(claimed.item?.id, otherWorkItemId, 'expired key available');
      });
    }),
    ...(['complete', 'retry', 'release', 'failure'] as const).map(mode => contractCase<WorkStore>(`core ${mode} frees its serialization key`, async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput({ serializationKey: 'account' }));
        await store.addWork(sampleWorkInput({ id: otherWorkItemId, kind: 'demo_other', serializationKey: 'account' }));
        await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'core' });
        const finish = { id: sampleWorkItemId, claimedBy: 'core' };
        const result = mode === 'complete' ? await store.completeWork({ ...finish, now: NOW })
          : mode === 'retry' ? await store.retryWork({ ...finish, nextAttemptAt: LATER, lastError: 'retry' })
          : mode === 'release' ? await store.releaseWork(finish)
          : await store.recordFailure(sampleFailureInput({ closeWork: { ...finish, now: NOW } }));
        assertOk(result, 'finish holder');
        const claimed = await store.claimWork({ now: NOW, kinds: ['demo_other'], claimedBy: 'other' }); assertOk(claimed, 'claim next');
        assertEqual(claimed.item?.id, otherWorkItemId, 'key released');
      });
    })),
    ...(['succeeded', 'retry', 'died', 'cancelled'] as const).map(mode => contractCase<WorkStore>(`supervised ${mode} frees its serialization key`, async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput({ kind: 'process_probe', serializationKey: 'account' }));
        await store.addWork(sampleWorkInput({ id: otherWorkItemId, serializationKey: 'account' }));
        await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'supervisor', attemptToken: sampleFailureId });
        const finish = { id: sampleWorkItemId, attemptToken: sampleFailureId, now: NOW };
        const result = mode === 'died' || mode === 'cancelled' ? await store.settleSupervisedAttempt({ ...finish, outcome: mode })
          : await store.finishSupervisedWork({ ...finish, outcome: mode === 'retry' ? 'failed' : 'succeeded',
            ...(mode === 'retry' ? { nextAttemptAt: LATER, lastError: 'retry', errorCode: 'TEMP', errorRetryable: true } : {}) });
        assertOk(result, 'finish holder');
        const claimed = await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'core' }); assertOk(claimed, 'claim next');
        assertEqual(claimed.item?.id, otherWorkItemId, 'key released');
      });
    })),
    contractCase('an unknown attempt keeps its serialization key', async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput({ kind: 'process_probe', serializationKey: 'account' }));
        await store.addWork(sampleWorkInput({ id: otherWorkItemId, serializationKey: 'account' }));
        await store.addWork(sampleWorkInput({ id: lastWorkItemId, kind: 'process_probe', targetId: 'second', serializationKey: 'account' }));
        await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'supervisor', attemptToken: sampleFailureId });
        await store.settleSupervisedAttempt({ id: sampleWorkItemId, attemptToken: sampleFailureId, now: NOW, outcome: 'unknown' });
        assertEqual(await store.claimWork({ now: LATER, kinds: KINDS, claimedBy: 'core' }), { ok: true, item: null }, 'unknown holds against core');
        assertEqual(await store.hasDueWork({ now: LATER, kinds: KINDS }), { ok: true, due: false }, 'unknown not due');
        assertEqual(await store.claimSupervisedWork({ now: LATER, kinds: ['process_probe'], claimedBy: 'supervisor', attemptToken: otherFailureId }), { ok: true, item: null, attemptToken: null }, 'unknown holds against supervised');
      });
    }),
    contractCase('find-or-create preserves the original serialization key', async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput({ serializationKey: 'original' }));
        const merged = await store.addWork(sampleWorkInput({ id: otherWorkItemId, serializationKey: 'replacement' })); assertOk(merged, 'merge');
        assertEqual(merged.created, false, 'merged existing');
        assertEqual(merged.item.serializationKey, 'original', 'key preserved');
        assertEqual((await readItem(store, sampleWorkItemId))?.serializationKey, 'original', 'stored key preserved');
      });
    }),
    contractCase('null serialization keys allow independent live claims', async make => {
      await withSubject(make, async store => {
        await store.addWork(sampleWorkInput());
        await store.addWork(sampleWorkInput({ id: otherWorkItemId, targetId: 'second', serializationKey: null }));
        for (const id of [sampleWorkItemId, otherWorkItemId]) {
          const claimed = await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'core' }); assertOk(claimed, 'claim independent');
          assertEqual(claimed.item?.id, id, 'both claimable');
          assertEqual(claimed.item?.serializationKey, null, 'null default');
        }
      });
    }),
    contractCase('dependent waits for its prerequisite to succeed', async make => {
      await withSubject(make, async store => {
        await store.addWorkGraph({ nodes: [{ ...sampleWorkInput(), after: [] }, { ...sampleWorkInput({ id: otherWorkItemId, targetId: 'dependent' }), after: [0] }] });
        assertEqual(await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'worker' }).then(r => r.ok ? r.item?.id : null), sampleWorkItemId, 'prerequisite claimed');
        assertEqual(await store.hasDueWork({ now: NOW, kinds: KINDS }), { ok: true, due: false }, 'dependent is not due');
        assertEqual(await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'other' }), { ok: true, item: null }, 'dependent waits');
        await store.completeWork({ id: sampleWorkItemId, claimedBy: 'worker', now: NOW });
        assertEqual(await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'worker' }).then(r => r.ok ? r.item?.id : null), otherWorkItemId, 'success unlocks dependent');
      });
    }),
    ...([false, true] as const).map(reverse => contractCase<WorkStore>(`one of two prerequisites is not enough (${reverse ? 'reverse' : 'forward'} completion)`, async make => {
      await withSubject(make, async store => {
        await store.addWorkGraph({ nodes: [
          { ...sampleWorkInput(), after: [] },
          { ...sampleWorkInput({ id: otherWorkItemId, targetId: 'second' }), after: [] },
          { ...sampleWorkInput({ id: lastWorkItemId, targetId: 'dependent' }), after: [0, 1] },
        ] });
        for (const id of [sampleWorkItemId, otherWorkItemId]) {
          const claim = await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'worker' }); assertOk(claim, 'store succeeded');
          assertEqual(claim.item?.id, id, 'prerequisite order');
        }
        const order = reverse ? [otherWorkItemId, sampleWorkItemId] : [sampleWorkItemId, otherWorkItemId];
        assertEqual(await store.completeWork({ id: order[0]!, now: NOW, claimedBy: 'worker' }), { ok: true, outcome: 'done' }, 'first success');
        assertEqual(await store.hasDueWork({ now: NOW, kinds: KINDS }), { ok: true, due: false }, 'one success is not enough');
        assertEqual(await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'other' }), { ok: true, item: null }, 'dependent remains blocked');
        assertEqual(await store.completeWork({ id: order[1]!, now: NOW, claimedBy: 'worker' }), { ok: true, outcome: 'done' }, 'second success');
        assertEqual(await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'worker' }).then(r => r.ok ? r.item?.id : null), lastWorkItemId, 'both unlock');
      });
    })),
    contractCase('prerequisite retry keeps the dependent waiting', async make => {
      await withSubject(make, async store => {
        await store.addWorkGraph({ nodes: [{ ...sampleWorkInput(), after: [] }, { ...sampleWorkInput({ id: otherWorkItemId, targetId: 'dependent' }), after: [0] }] });
        await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'worker' });
        await store.retryWork({ id: sampleWorkItemId, claimedBy: 'worker', nextAttemptAt: LATER, lastError: 'retry' });
        assertEqual(await store.hasDueWork({ now: NOW, kinds: KINDS }), { ok: true, due: false }, 'retry keeps dependent blocked');
        assertEqual((await readItem(store, otherWorkItemId))?.completedAt, null, 'dependent remains open');
      });
    }),
    ...(['failed', 'cancelled', 'lost'] as const).map(mode => contractCase<WorkStore>(mode === 'failed' ? 'failed prerequisite closes dependents transitively' : mode === 'cancelled' ? 'cancelled prerequisite closes its dependent' : 'lost close does not propagate', async make => {
      await withSubject(make, async store => {
        await store.addWorkGraph({ nodes: [{ ...sampleWorkInput(), after: [] }, { ...sampleWorkInput({ id: otherWorkItemId, targetId: 'dependent' }), after: [0] }, { ...sampleWorkInput({ id: lastWorkItemId, targetId: 'last' }), after: [1] }] });
        if (mode === 'cancelled') await store.requestWorkCancel({ id: sampleWorkItemId, now: LATER });
        else {
          await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'worker' });
          const closed = await store.recordFailure(sampleFailureInput({ closeWork: { id: sampleWorkItemId, claimedBy: mode === 'lost' ? 'other' : 'worker', now: LATER } }));
          if (mode === 'lost') assertEqual(closed, { ok: true, outcome: 'lost' }, 'lost close');
        }
        const failures = await store.listFailures({ includeResolved: true }); assertOk(failures, 'read failures');
        assertEqual(failures.failures.map(failure => failure.id), mode === 'failed' ? [sampleFailureId] : [], 'propagation records only the root failure');
        for (const id of [otherWorkItemId, lastWorkItemId]) {
          const row = await readItem(store, id);
          assertEqual(row?.outcome, mode === 'lost' ? null : 'dependency_failed', 'dependent outcome');
          assertEqual(row?.completedAt, mode === 'lost' ? null : LATER, 'same close instant');
          assertEqual(row?.lastError, mode === 'lost' ? null : dependencyFailedText(sampleWorkItemId, mode === 'cancelled' ? 'cancelled' : 'failed'), 'root failure sentence');
        }
      });
    })),
    ...(['failure', 'finish', 'settle'] as const).map(mode => contractCase<WorkStore>(`supervised ${mode} closes dependents`, async make => {
      await withSubject(make, async store => {
        await store.addWorkGraph({ nodes: [{ ...sampleWorkInput({ kind: 'process_probe' }), after: [] }, { ...sampleWorkInput({ id: otherWorkItemId, targetId: 'dependent' }), after: [0] }] });
        await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: 'worker', attemptToken: lastWorkItemId });
        if (mode !== 'failure') await store.requestWorkCancel({ id: sampleWorkItemId, now: NOW });
        if (mode === 'settle') await store.settleSupervisedAttempt({ id: sampleWorkItemId, attemptToken: lastWorkItemId, now: LATER, outcome: 'died' });
        else await store.finishSupervisedWork({ id: sampleWorkItemId, attemptToken: lastWorkItemId, now: LATER, outcome: 'failed', ...(mode === 'failure' ? { failure: sampleFailureInput() } : {}) });
        const row = await readItem(store, otherWorkItemId);
        assertEqual(row?.outcome, 'dependency_failed', 'supervised propagation');
        assertEqual(row?.lastError, dependencyFailedText(sampleWorkItemId, mode === 'failure' ? 'failed' : 'cancelled'), 'root reason');
      });
    })),
    ...(['succeeded', 'failed', 'died'] as const).map(mode => contractCase<WorkStore>(`supervised prerequisite ${mode} preserves dependent until success`, async make => {
      await withSubject(make, async store => {
        assertOk(await store.addWorkGraph({ nodes: [
          { ...sampleWorkInput({ kind: 'process_probe' }), after: [] },
          { ...sampleWorkInput({ id: otherWorkItemId, targetId: 'dependent' }), after: [0] },
        ] }), 'graph added');
        const query = { now: NOW, kinds: ['process_probe'], claimedBy: 'worker' };
        const claim = await store.claimSupervisedWork({ ...query, attemptToken: lastWorkItemId }); assertOk(claim, 'claim A');
        assertEqual(claim.item?.id, sampleWorkItemId, 'A claimed');
        const input = { id: sampleWorkItemId, attemptToken: lastWorkItemId, now: LATER };
        const finished = mode === 'died'
          ? await store.settleSupervisedAttempt({ ...input, outcome: 'died' })
          : await store.finishSupervisedWork({ ...input, outcome: mode, nextAttemptAt: LATER });
        assertEqual(finished, { ok: true, outcome: 'done' }, 'finish first attempt');
        if (mode !== 'succeeded') {
          const dependent = await readItem(store, otherWorkItemId);
          assertEqual(dependent?.completedAt, null, 'B remains open');
          assertEqual(dependent?.outcome, null, 'B has no terminal outcome');
          assertEqual(await store.claimWork({ now: LATER, kinds: KINDS, claimedBy: 'worker' }), { ok: true, item: null }, 'B remains blocked');
          const retry = await store.claimSupervisedWork({ ...query, now: LATER, attemptToken: sampleFailureId }); assertOk(retry, 'retry A');
          assertEqual(retry.item?.id, sampleWorkItemId, 'A next attempt claimed');
          assertEqual(await store.finishSupervisedWork({ id: sampleWorkItemId, attemptToken: sampleFailureId, now: LATER, outcome: 'succeeded' }), { ok: true, outcome: 'done' }, 'retry succeeds');
        }
        const dependent = await store.claimWork({ now: LATER, kinds: KINDS, claimedBy: 'worker' }); assertOk(dependent, 'claim B');
        assertEqual(dependent.item?.id, otherWorkItemId, 'supervised success unlocks B');
      });
    })),
    contractCase('supervised dependent waits for its core prerequisite', async make => {
      await withSubject(make, async store => {
        await store.addWorkGraph({ nodes: [{ ...sampleWorkInput(), after: [] }, { ...sampleWorkInput({ id: otherWorkItemId, targetId: 'dependent', kind: 'process_probe' }), after: [0] }] });
        const input = { now: NOW, kinds: ['process_probe'], claimedBy: 'worker', attemptToken: lastWorkItemId };
        assertEqual(await store.claimSupervisedWork(input), { ok: true, item: null, attemptToken: null }, 'supervised waits');
        await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'worker' });
        await store.completeWork({ id: sampleWorkItemId, now: NOW, claimedBy: 'worker' });
        const claim = await store.claimSupervisedWork(input); assertOk(claim, 'store succeeded'); assertEqual(claim.item?.id, otherWorkItemId, 'supervised unlocked');
      });
    }),
    contractCase('merged node keeps its own prerequisites', async make => {
      await withSubject(make, async store => {
        const existing = sampleWorkInput({ id: otherWorkItemId, targetId: 'existing' });
        assertOk(await store.addWorkGraph({ nodes: [{ ...sampleWorkInput(), after: [] }, { ...existing, after: [0] }] }), 'existing P→X');
        const result = await store.addWorkGraph({ nodes: [
          { ...sampleWorkInput({ id: lastWorkItemId, targetId: 'new-prerequisite' }), after: [] },
          { ...existing, id: sampleFailureId, after: [0] },
        ] });
        assertOk(result, 'store succeeded'); assertEqual(result.items[1]?.item.id, otherWorkItemId, 'merged X id');
        assertEqual(result.items[1]?.created, false, 'merged');
        for (const id of [sampleWorkItemId, lastWorkItemId]) {
          const claim = await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'worker' }); assertOk(claim, 'store succeeded');
          assertEqual(claim.item?.id, id, 'claim P then Q');
        }
        assertEqual(await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'other' }), { ok: true, item: null }, 'X retains P prerequisite');
        assertEqual(await store.completeWork({ id: sampleWorkItemId, now: NOW, claimedBy: 'worker' }), { ok: true, outcome: 'done' }, 'P succeeds');
        assertEqual((await readItem(store, lastWorkItemId))?.completedAt, null, 'Q still pending');
        const claim = await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'other' }); assertOk(claim, 'store succeeded');
        assertEqual(claim.item?.id, otherWorkItemId, 'P success alone unlocks X without Q edge');
      });
    }),
    contractCase('merged prerequisite gates the new dependent', async make => {
      await withSubject(make, async store => {
        const existing = sampleWorkInput({ id: otherWorkItemId, targetId: 'existing' });
        await store.addWork(existing);
        const result = await store.addWorkGraph({ nodes: [
          { ...existing, id: lastWorkItemId, after: [] }, { ...sampleWorkInput(), after: [0] },
        ] });
        assertOk(result, 'store succeeded'); assertEqual(result.items[0]?.created, false, 'merged');
        const claim = await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'worker' }); assertOk(claim, 'store succeeded');
        assertEqual(claim.item?.id, otherWorkItemId, 'claim available root');
        assertEqual(await store.claimWork({ now: NOW, kinds: KINDS, claimedBy: 'other' }), { ok: true, item: null }, 'new dependent waits');
      });
    }),

    ...(readAttempt === undefined ? [] : [contractCase<WorkStore>('heartbeat renews the lease without moving last progress', async make => {
      await withSubject(make, async store => {
        const work = sampleWorkInput({ kind: 'process_probe' }); await store.addWork(work);
        await store.claimSupervisedWork({ now: NOW, claimedBy: sampleWorkItemId, kinds: ['process_probe'], attemptToken: otherWorkItemId });
        await store.renewSupervisedLease({ id: work.id, attemptToken: otherWorkItemId, now: NOW, progressAt: NOW });
        await store.renewSupervisedLease({ id: work.id, attemptToken: otherWorkItemId, now: LATER, progressAt: null });
        assertEqual(await readAttempt(store, otherWorkItemId), { lastProgressAt: NOW, renewedAt: LATER }, 'heartbeat keeps progress');
      });
    })]),
    contractCase<WorkStore>('cancel closes unclaimed and core-claimed work and distinguishes missing and closed', async make => {
      await withSubject(make, async store => {
        const work = sampleWorkInput(); await store.addWork(work);
        const claimed = await store.claimWork({ now: NOW, claimedBy: sampleWorkItemId, kinds: [work.kind] }); assertOk(claimed, 'claim');
        const cancelled = await store.requestWorkCancel({ id: work.id, now: NOW }); assertOk(cancelled, 'cancel'); assertEqual(cancelled.state, 'cancelled', 'cancelled');
        const late = await store.completeWork({ id: work.id, claimedBy: sampleWorkItemId, now: LATER }); assertOk(late, 'complete'); assertEqual(late.outcome, 'lost', 'core claim lost');
        const closed = await store.requestWorkCancel({ id: work.id, now: LATER }); assertOk(closed, 'closed'); assertEqual(closed.state, 'already_closed', 'already closed');
        const missing = await store.requestWorkCancel({ id: lastWorkItemId, now: NOW }); assertOk(missing, 'missing'); assertEqual(missing.state, 'not_found', 'not found');
        const waiting = sampleWorkInput({ id: otherWorkItemId, targetId: 'waiting' }); await store.addWork(waiting);
        const direct = await store.requestWorkCancel({ id: waiting.id, now: NOW }); assertOk(direct, 'waiting'); assertEqual(direct.state, 'cancelled', 'waiting cancelled');
      });
    }),
    ...(['died', 'cancelled', 'unknown', 'requested'] as const).map(mode => contractCase<WorkStore>(`settles supervised ${mode} with token CAS and process identity`, async make => {
      await withSubject(make, async store => {
        const work = sampleWorkInput({ kind: 'process_probe' }); await store.addWork(work);
        await store.claimSupervisedWork({ now: NOW, claimedBy: sampleWorkItemId, kinds: ['process_probe'], attemptToken: otherWorkItemId });
        const process = { id: work.id, attemptToken: otherWorkItemId, pid: 123, pgid: 123, osBootAt: NOW, osStartedAt: NOW };
        const stale = await store.recordSupervisedProcess({ ...process, attemptToken: lastWorkItemId }); assertOk(stale, 'stale'); assertEqual(stale.outcome, 'lost', 'stale process');
        const recorded = await store.recordSupervisedProcess(process); assertOk(recorded, 'process'); assertEqual(recorded.outcome, 'done', 'recorded');
        if (mode === 'requested') {
          const request = await store.requestWorkCancel({ id: work.id, now: NOW }); assertOk(request, 'request'); assertEqual(request.state, 'requested', 'requested');
          await store.requestWorkCancel({ id: work.id, now: LATER });
        }
        const open = await store.listOpenSupervisedAttempts(); assertOk(open, 'open'); assertEqual(open.attempts.length, 1, 'one attempt');
        assertEqual(open.attempts[0]!.targetKind, work.targetKind, 'target kind');
        assertEqual(open.attempts[0]!.targetId, work.targetId, 'target id');
        assertEqual(open.attempts[0]!.pid, 123, 'pid'); assertEqual(open.attempts[0]!.incarnation, sampleWorkItemId, 'incarnation');
        assertEqual(open.attempts[0]!.cancelRequested, mode === 'requested', 'request flag');
        const settled = await store.settleSupervisedAttempt({ id: work.id, attemptToken: otherWorkItemId, now: LATER, outcome: mode === 'requested' ? 'died' : mode }); assertOk(settled, 'settle'); assertEqual(settled.outcome, 'done', 'settled');
        const none = await store.listOpenSupervisedAttempts(); assertOk(none, 'none'); assertEqual(none.attempts.length, 0, 'closed or unknown omitted');
        if (mode !== 'requested') {
          const read = await store.addWork(work); assertOk(read, 'read');
          assertEqual(read.item.attempts, mode === 'cancelled' ? 0 : 1, 'attempt count');
          assertEqual(read.item.currentAttemptToken, mode === 'unknown' ? otherWorkItemId : null, 'token');
          assertEqual(read.item.nextAttemptAt.getTime(), mode === 'died' ? LATER.getTime() : NOW.getTime(), 'next attempt');
          if (mode === 'unknown') {
            const before = await readItem(store, work.id);
            for (const late of [
              await store.renewSupervisedLease({ id: work.id, attemptToken: otherWorkItemId, now: LATER, progressAt: LATER }),
              await store.finishSupervisedWork({ id: work.id, attemptToken: otherWorkItemId, now: LATER, outcome: 'succeeded' }),
              await store.settleSupervisedAttempt({ id: work.id, attemptToken: otherWorkItemId, now: LATER, outcome: 'died' }),
              await store.recordSupervisedProcess({ ...process, pid: 999, pgid: 999 }),
            ]) {
              assertOk(late, 'finished attempt write'); assertEqual(late.outcome, 'lost', 'unknown token cannot write');
            }
            assertEqual(JSON.stringify(await readItem(store, work.id)), JSON.stringify(before), 'unknown item unchanged');
            const blocked = await store.claimSupervisedWork({ now: new Date(LATER.getTime() + 600000), claimedBy: sampleWorkItemId, kinds: ['process_probe'], attemptToken: lastWorkItemId }); assertOk(blocked, 'blocked'); assertEqual(blocked.item, null, 'unknown blocks claim');
            const request = await store.requestWorkCancel({ id: work.id, now: LATER }); assertOk(request, 'unknown cancel'); assertEqual(request.state, 'requested', 'unknown request only');
          }
        } else {
          const closed = await store.requestWorkCancel({ id: work.id, now: LATER }); assertOk(closed, 'closed'); assertEqual(closed.state, 'already_closed', 'request closed');
        }
        const old = await store.settleSupervisedAttempt({ id: work.id, attemptToken: lastWorkItemId, now: LATER, outcome: 'died' }); assertOk(old, 'old'); assertEqual(old.outcome, 'lost', 'stale settle');
      });
    })),
    ...(['succeeded', 'failed', 'stalled', 'died'] as const).map(outcome => contractCase<WorkStore>(`cancellation race with ${outcome} closes supervised work`, async make => {
      await withSubject(make, async store => {
        const work = sampleWorkInput({ kind: 'process_probe' }); await store.addWork(work);
        await store.claimSupervisedWork({ now: NOW, claimedBy: sampleWorkItemId, kinds: ['process_probe'], attemptToken: otherWorkItemId });
        await store.requestWorkCancel({ id: work.id, now: NOW });
        const done = await store.finishSupervisedWork({ id: work.id, attemptToken: otherWorkItemId, now: LATER, outcome, nextAttemptAt: LATER, lastError: '실행 실패',
          ...(outcome === 'succeeded' ? {} : { failure: { id: sampleFailureId, stage: work.kind, fingerprint: 'cause', code: 'PERMANENT', message: '실행 실패', occurredAt: LATER } }) }); assertOk(done, 'done');
        assertEqual(done.outcome, 'done', 'finish');
        const failures = await store.listFailures({}); assertOk(failures, 'failures'); assertEqual(failures.failures.length, 0, 'cancel records no failure');
        const item = await readItem(store, work.id);
        assertTrue(item !== null, 'finished item exists');
        assertEqual(item!.outcome, outcome === 'succeeded' ? 'succeeded' : 'cancelled', 'work outcome');
        assertEqual(item!.completedAt?.getTime(), LATER.getTime(), 'completion time');
        assertEqual(item!.currentAttemptToken, null, 'finished token cleared');
        if (outcome !== 'succeeded') {
          assertEqual(item!.nextAttemptAt.getTime(), LATER.getTime(), 'failed race retry time');
          assertEqual(item!.lastError, '실행 실패', 'failed race error');
        }
        const closed = await store.requestWorkCancel({ id: work.id, now: LATER }); assertOk(closed, 'closed'); assertEqual(closed.state, 'already_closed', 'closed race');
      });
    })),
    contractCase<WorkStore>('supervised lease renewal and token CAS isolate core claims and old attempts', async (make) => {
      await withSubject(make, async (store) => {
        const work = sampleWorkInput({ kind: 'process_probe' });
        const added = await store.addWork(work); assertOk(added, 'add');
        assertEqual(added.item.executionClass, 'supervised', 'registry');
        const query = { now: NOW, kinds: ['process_probe'], claimedBy: sampleWorkItemId };
        const due = await store.hasDueWork(query); assertOk(due, 'due'); assertEqual(due.due, false, 'core due excludes supervised');
        const core = await store.claimWork(query); assertOk(core, 'core'); assertEqual(core.item, null, 'core claim');
        const a = await store.claimSupervisedWork({ ...query, attemptToken: otherWorkItemId });
        assertOk(a, 'claim A'); assertTrue(a.item !== null, 'item A');
        assertEqual(a.attemptToken, otherWorkItemId, 'token A');
        const renewedAt = new Date(NOW.getTime() + 590_000);
        const renewed = await store.renewSupervisedLease({ id: work.id, attemptToken: otherWorkItemId, now: renewedAt, progressAt: renewedAt });
        assertOk(renewed, 'renew'); assertEqual(renewed.outcome, 'done', 'renew done');
        const early = await store.claimSupervisedWork({ ...query, now: new Date(NOW.getTime() + 650_000), attemptToken: lastWorkItemId });
        assertOk(early, 'early'); assertEqual(early.item, null, 'renewed lease held');
        const later = new Date(NOW.getTime() + 1_200_000);
        const blocked = await store.claimSupervisedWork({ ...query, now: later, attemptToken: lastWorkItemId });
        assertOk(blocked, 'blocked'); assertEqual(blocked.item, null, 'current token prevents expired reclaim');
        await store.settleSupervisedAttempt({ id: work.id, attemptToken: otherWorkItemId, now: later, outcome: 'died' });
        const b = await store.claimSupervisedWork({ ...query, now: later, attemptToken: lastWorkItemId });
        assertOk(b, 'claim B'); assertTrue(b.item !== null, 'item B');
        const before = await store.addWork(work); assertOk(before, 'before');
        for (const stale of [await store.renewSupervisedLease({ id: work.id, attemptToken: otherWorkItemId, now: later, progressAt: later }), await store.finishSupervisedWork({ id: work.id, attemptToken: otherWorkItemId, now: later, outcome: 'succeeded' })]) {
          assertOk(stale, 'stale'); assertEqual(stale.outcome, 'lost', 'stale token');
        }
        const after = await store.addWork(work); assertOk(after, 'after');
        assertEqual(JSON.stringify(after.item), JSON.stringify(before.item), 'stale writes changed item');
        const finished = await store.finishSupervisedWork({ id: work.id, attemptToken: lastWorkItemId, now: later, outcome: 'succeeded' });
        assertOk(finished, 'finish'); assertEqual(finished.outcome, 'done', 'current token');
      });
    }),
    ...(['failed', 'stalled', 'died'] as const).map(outcome => contractCase<WorkStore>(`${outcome} supervised work releases its claim and schedules the retry`, async (make) => {
      await withSubject(make, async (store) => {
        const work = sampleWorkInput({ kind: 'process_probe' }); await store.addWork(work);
        const claimed = await store.claimSupervisedWork({ now: NOW, kinds: ['process_probe'], claimedBy: sampleWorkItemId, attemptToken: otherWorkItemId }); assertOk(claimed, 'claim');
        const finish = await store.finishSupervisedWork({ id: work.id, attemptToken: otherWorkItemId, now: NOW, outcome, nextAttemptAt: LATER, lastError: '다시 시도합니다' }); assertOk(finish, 'finish');
        assertEqual(finish.outcome, 'done', 'done');
        const read = await store.addWork(work); assertOk(read, 'read');
        assertEqual(read.item.claimedBy, null, 'claim cleared'); assertEqual(read.item.currentAttemptToken, null, 'token cleared');
        assertEqual(read.item.nextAttemptAt.getTime(), LATER.getTime(), 'retry time'); assertEqual(read.item.lastError, '다시 시도합니다', 'error');
        const health = await store.readWorkAttemptHealth(); assertOk(health, 'health');
        assertEqual(health.health[outcome].count, 1, 'health count');
        assertEqual(health.health[outcome].latest?.workItemId, work.id, 'latest id');
      });
    })),
    contractCase<WorkStore>('core completion has a succeeded outcome', async make => {
      await withSubject(make, async store => {
        const work = sampleWorkInput(); await store.addWork(work);
        await store.claimWork({ now: NOW, claimedBy: 'worker', kinds: KINDS });
        await store.completeWork({ id: work.id, claimedBy: 'worker', now: LATER });
        assertEqual((await readItem(store, work.id))?.outcome, 'succeeded', 'completed outcome');
      });
    }),
    ...(['failed', 'stalled', 'died'] as const).map(outcome => contractCase<WorkStore>(`supervised ${outcome} failure recording closes with failed outcome`, async make => {
      await withSubject(make, async store => {
        const work = sampleWorkInput({ kind: 'process_probe' }); await store.addWork(work);
        await store.claimSupervisedWork({ now: NOW, claimedBy: sampleWorkItemId, kinds: ['process_probe'], attemptToken: otherWorkItemId });
        await store.finishSupervisedWork({ id: work.id, attemptToken: otherWorkItemId, now: LATER, outcome, lastError: '실패',
          failure: { id: sampleFailureId, stage: work.kind, fingerprint: 'cause', code: 'PROCESS_STALLED', message: '실패', occurredAt: LATER } });
        const item = await readItem(store, work.id);
        assertEqual(item?.outcome, 'failed', 'work outcome'); assertEqual(item?.completedAt, LATER, 'closed at');
        const failures = await store.listFailures({}); assertOk(failures, 'failures'); assertEqual(failures.failures.length, 1, 'one failure');
        const health = await store.readWorkAttemptHealth(); assertOk(health, 'health'); assertEqual(health.health[outcome].count, 0, 'closed work omitted');
      });
    })),
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
        assertEqual((await readItem(store, added.item.id))?.outcome, 'failed', 'recorded outcome');
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
