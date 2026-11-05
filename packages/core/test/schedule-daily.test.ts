import { fakeCron, sampleSelfUserInput } from '../src/testing/index.js';
import { expect, it } from 'vitest';
import { createBrain } from '../src/brain.js';
import { memoryStore, memorySchemaStore, memorySpool, memoryFileStore, memoryRepositories,
  memoryTranscriptReader, sequenceIdGen, manualTime } from '../src/testing/index.js';

function kit(start = '2026-10-01T00:00:00Z') {
  const time = manualTime(new Date(start)); const store = memoryStore(); void store.ensureSelfUser(sampleSelfUserInput());
  const brain = createBrain({ cron: fakeCron, store: { ...store, ...memorySchemaStore({ version: 9 }) }, schemaVersions: { core: 9 },
    clock: time.clock, idGen: sequenceIdGen({ timestampMs: new Date(start).getTime() }), spool: memorySpool(), files: memoryFileStore(), parsers: [],
    transcripts: memoryTranscriptReader(), repositories: memoryRepositories(), machine: 'test' });
  return { store, brain, time, set: (at: string) => time.advance(new Date(at).getTime() - time.clock.now().getTime()),
    zone: (value: string) => store.setSetting({ userId: null, key: 'timezone', value, updatedAt: time.clock.now() }),
    add: (localTime = '11:00') => brain.schedules.add({ kind: 'schedule_probe', targetKind: 'probe', targetId: 'daily', localTime }),
    drain: () => brain.queue.drain({ budgetMs: 1000 }) };
}
async function added(k: ReturnType<typeof kit>, localTime = '11:00') {
  const result = await k.add(localTime); if (!result.ok) throw new Error(result.message); return result.schedule.id;
}
it('daily firing records one occurrence and manual runs do not account for one', async () => {
  const k=kit(); const id=await added(k);
  expect(await k.brain.schedules.run({scheduleId:id})).toMatchObject({ok:true,created:true}); await k.drain();
  expect(await k.store.listOccurrences({scheduleId:id})).toEqual({ok:true,occurrences:[]});
  k.set('2026-10-01T02:00:00Z'); expect(await k.brain.schedules.tick()).toMatchObject({fired:1,enqueued:1}); await k.drain();
  expect(await k.store.listOccurrences({scheduleId:id})).toMatchObject({ok:true,occurrences:[{occurrenceAt:new Date('2026-10-01T02:00:00Z'),status:'done'}]});
});
it('daily gap resolves to the transition instant',async()=>{
  const k=kit('2026-03-08T00:00:00Z'); await k.zone('America/New_York'); const id=await added(k,'02:30');
  k.set('2026-03-08T07:00:00Z'); await k.brain.schedules.tick(); await k.drain();
  expect(await k.store.listOccurrences({scheduleId:id})).toMatchObject({ok:true,occurrences:[{occurrenceAt:new Date('2026-03-08T07:00:00Z'),status:'done'}]});
});
it('new firing during an attempt remains pending',async()=>{
  const k=kit(); const id=await added(k); k.set('2026-10-01T02:00:00Z'); await k.brain.schedules.tick();
  const claim=await k.store.claimWork({kinds:['schedule_probe'],claimedBy:'worker',now:k.time.clock.now()}); if(!claim.ok || !claim.item)throw Error('missing claim');
  k.set('2026-10-02T02:00:00Z');await k.brain.schedules.tick();await k.store.completeWork({id:claim.item.id,claimedBy:'worker',now:k.time.clock.now()});
  const rows=await k.store.listOccurrences({scheduleId:id}); if(!rows.ok)throw Error(rows.message);expect(rows.occurrences.map(x=>x.status)).toEqual(['done','pending']);
});
it('fold chooses the first instant once',async()=>{
  const k=kit('2026-11-01T00:00:00Z');await k.zone('America/New_York');const id=await added(k,'01:30');
  k.set('2026-11-01T05:30:00Z');await k.brain.schedules.tick();await k.drain();k.set('2026-11-01T06:30:00Z');expect(await k.brain.schedules.tick()).toMatchObject({fired:0});
  const rows=await k.store.listOccurrences({scheduleId:id});if(!rows.ok)throw Error(rows.message);expect(rows.occurrences.map(row=>row.occurrenceAt)).toEqual([new Date('2026-11-01T05:30:00Z')]);
});
it('rezone preserves previously completed occurrence instants',async()=>{
  const k=kit();const id=await added(k);k.set('2026-10-01T02:00:00Z');await k.brain.schedules.tick();await k.drain();
  const before=await k.store.listOccurrences({scheduleId:id});await k.zone('America/New_York');await k.brain.schedules.tick();
  expect(await k.store.listOccurrences({scheduleId:id})).toEqual(before);
  expect(await k.store.readSchedule({id})).toMatchObject({schedule:{timeZone:'America/New_York'}});
});
it('manual work merges with already open scheduled work without adding occurrences',async()=>{
  const k=kit();const id=await added(k);k.set('2026-10-01T02:00:00Z');await k.brain.schedules.tick();
  const before=await k.store.listOccurrences({scheduleId:id});expect(await k.brain.schedules.run({scheduleId:id})).toMatchObject({ok:true,created:false});
  expect(await k.store.listOccurrences({scheduleId:id})).toEqual(before);
});
it('rejects malformed daily time and reports missing reservation',async()=>{
  const k=kit();expect(await k.add('24:00')).toMatchObject({ok:false,code:'SCHEDULE_INVALID'});
  expect(await k.brain.schedules.run({scheduleId:'missing'})).toMatchObject({ok:false,code:'SCHEDULE_NOT_FOUND'});
});
