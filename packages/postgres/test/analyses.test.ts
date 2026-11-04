import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { enqueueDayAnalysis } from '@second-brain/core';
import { postgresStore } from '../src/index.js';
import { database, clock } from './fixture.js';

it('replays snapshots after queue failure, checks hashes and rejects different content', async () => {
  const db = await database(), store = postgresStore({ databaseUrl: db.appUrl });
  try {
    const content = Buffer.from('{"synthetic":true}');
    const snapshot = { id: randomUUID(), bundleId: randomUUID(), localDate: '2026-01-02', timeZone: 'UTC', content, contentSha256: createHash('sha256').update(content).digest('hex'), createdAt: clock.now() };
    const deps = { store: { ...store, addWork: async () => ({ ok: false as const, code: 'DB_UNAVAILABLE' as const, message: 'synthetic' }) }, idGen: { next: randomUUID }, now: () => clock.now() };
    expect(await enqueueDayAnalysis(deps, snapshot)).toMatchObject({ ok: false });
    expect(await enqueueDayAnalysis({ ...deps, store }, snapshot)).toMatchObject({ ok: true, created: true });
    const read = await store.readAnalysisSnapshot(snapshot.id); expect(read).toMatchObject({ ok: true, snapshot });
    if (!read.ok || !read.snapshot) throw Error('snapshot missing'); expect(read.snapshot.createdAt).toBeInstanceOf(Date);
    expect(await store.createAnalysisSnapshot({ ...snapshot, timeZone: 'Asia/Seoul' })).toMatchObject({ ok: false });
    expect(await store.createAnalysisSnapshot({ ...snapshot, id: randomUUID(), contentSha256: 'a'.repeat(64) })).toMatchObject({ ok: false });
    expect(await db.rows('select id from brain.analysis_snapshots')).toHaveLength(1);
  } finally { await store.close(); await db.drop(); }
});

it('fences snapshot targets and rolls back every row on late relation failure', async () => {
  const db = await database(), store = postgresStore({ databaseUrl: db.appUrl });
  try {
    const content = Buffer.from('{}'), now = clock.now();
    const snapshot = { id: randomUUID(), bundleId: randomUUID(), localDate: '2026-01-02', timeZone: 'UTC', content, contentSha256: createHash('sha256').update(content).digest('hex'), createdAt: now };
    const other = { ...snapshot, id: randomUUID() };
    expect(await store.createAnalysisSnapshot(snapshot)).toMatchObject({ ok: true }); expect(await store.createAnalysisSnapshot(other)).toMatchObject({ ok: true });
    const workId = randomUUID(), token = randomUUID(), staleToken = randomUUID();
    expect(await store.addWork({ id: workId, kind: 'health_analysis', targetKind: 'analysis_snapshot', targetId: snapshot.id, createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
    expect(await store.claimSupervisedWork({ now, claimedBy: 'test', kinds: ['health_analysis'], attemptToken: staleToken })).toMatchObject({ ok: true, item: { id: workId } });
    expect(await store.finishSupervisedWork({ id: workId, attemptToken: staleToken, now, outcome: 'failed', nextAttemptAt: now })).toMatchObject({ ok: true });
    expect(await store.claimSupervisedWork({ now, claimedBy: 'test', kinds: ['health_analysis'], attemptToken: token })).toMatchObject({ ok: true, item: { id: workId } });
    const input = { id: randomUUID(), fileId: randomUUID(), locationId: randomUUID(), snapshot, output: { status: 'ok' as const, summary: '', report_md: 'synthetic', judgments: [], evidence: [], next_checks: [] }, agent: 'codex', workId, attemptToken: token, now, contentHash: 'sha256:' + 'b'.repeat(64), sizeBytes: 9, location: { storeKind: 'local' as const, ownership: 'brain' as const, locator: 'synthetic' } };
    const state = async () => Promise.all(['analyses','files','file_locations','analysis_files'].map(table => db.rows(`select * from brain.${table} order by 1`)));
    const before = await state();
    expect(await store.commitCoreAnalysis({ ...input, attemptToken: staleToken })).toMatchObject({ ok: false }); expect(await state()).toEqual(before);
    expect(await store.commitCoreAnalysis({ ...input, snapshot: other })).toMatchObject({ ok: false }); expect(await state()).toEqual(before);
    await expect(db.query(`insert into brain.analyses(id,source,dataset,revision,model_missing,created_at_missing,source_work_item_id,source_attempt_token,report_date,scope,bundle_id,snapshot_id,agent,output_json) values ('${input.id}','core','health',1,true,true,'${workId}','${token}','2026-01-02','day','${other.bundleId}','${other.id}','codex','{}')`)).rejects.toMatchObject({ code: 'BRS01' });
    expect(await state()).toEqual(before);
    await db.query("create function brain.test_reject_analysis_file() returns trigger language plpgsql as $$ begin raise exception 'synthetic rejection'; end $$; create trigger test_reject before insert on brain.analysis_files for each row execute function brain.test_reject_analysis_file()");
    expect(await store.commitCoreAnalysis(input)).toMatchObject({ ok: false }); expect(await state()).toEqual(before);
    await db.query('drop trigger test_reject on brain.analysis_files; drop function brain.test_reject_analysis_file()');
    expect(await store.commitCoreAnalysis(input)).toEqual({ ok: true, id: input.id });
    expect(await store.commitCoreAnalysis({ ...input, id: randomUUID(), fileId: randomUUID(), locationId: randomUUID() })).toEqual({ ok: true, id: input.id });
    expect(await db.rows('select id from brain.analyses')).toHaveLength(1);
    expect(await db.rows('select * from brain.analysis_files')).toHaveLength(1);
  } finally { await store.close(); await db.drop(); }
});

it('shares a report file between distinct snapshot analyses', async () => {
  const db = await database(), store = postgresStore({ databaseUrl: db.appUrl });
  try {
    const now = clock.now(), content = Buffer.from('{}');
    const base = { bundleId: randomUUID(), localDate: '2026-01-02', timeZone: 'UTC', content, contentSha256: createHash('sha256').update(content).digest('hex'), createdAt: now };
    const snapshots = [{ ...base, id: randomUUID() }, { ...base, id: randomUUID() }];
    const ids: string[] = [];
    for (const snapshot of snapshots) {
      expect(await store.createAnalysisSnapshot(snapshot)).toMatchObject({ ok: true });
      const workId = randomUUID(), token = randomUUID(), id = randomUUID(); ids.push(id);
      expect(await store.addWork({ id: workId, kind: 'health_analysis', targetKind: 'analysis_snapshot', targetId: snapshot.id, createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
      expect(await store.claimSupervisedWork({ now, claimedBy: 'test', kinds: ['health_analysis'], attemptToken: token })).toMatchObject({ ok: true, item: { id: workId } });
      expect(await store.commitCoreAnalysis({ id, fileId: randomUUID(), locationId: randomUUID(), snapshot, output: { status: 'ok', summary: '', report_md: 'report', judgments: [], evidence: [], next_checks: [] }, agent: 'codex', workId, attemptToken: token, now, contentHash: 'sha256:' + 'b'.repeat(64), sizeBytes: 6, location: { storeKind: 'local', ownership: 'brain', locator: 'synthetic' } })).toEqual({ ok: true, id });
    }
    for (const [table, count] of [['analyses', 2], ['analysis_files', 2], ['files', 1], ['file_locations', 1]] as const) expect(await db.rows(`select * from brain.${table}`)).toHaveLength(count);
    const first = await store.readCoreAnalysis(ids[0]!); const second = await store.readCoreAnalysis(ids[1]!);
    expect(first.ok && first.analysis?.fileId).toEqual(second.ok && second.analysis?.fileId);
    expect(first.ok && first.analysis?.fileId).toEqual(expect.any(String));
  } finally { await store.close(); await db.drop(); }
});
