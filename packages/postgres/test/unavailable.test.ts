import pg from 'pg';
import { expect, it } from 'vitest';
import { sampleEnsureSessionInput, sampleSelfUserInput, sampleIngestBatch, sampleWorkInput, sampleFailureInput, sampleTranscriptFileInput, sampleSessionKey, sampleSessionToken } from '@second-brain/core/testing';
import { postgresStore, type PostgresStore } from '../src/index.js';
import { database, clock } from './fixture.js';
import { closedPort } from './closed-port.js';

const now = clock.now();
const id = '01940000-0000-7000-8000-000000000123';
const claim = { id, claimedBy: 'worker' };
const due = { now, kinds: ['document_extract'] };
const calls = {
  findDailySchedule: (s: PostgresStore) => s.findDailySchedule({ kind: 'testext.sync', targetKind: 'extension', targetId: 'testext' }),
  getWork: (s: PostgresStore) => s.getWork('00000000-0000-4000-8000-000000000001'),
  listExtensionInventory: (s: PostgresStore) => s.listExtensionInventory(),
  getExtensionPublicStatus: (s: PostgresStore) => s.getExtensionPublicStatus('testext'),
  setExtensionEnabled: (s: PostgresStore) => s.setExtensionEnabled({ name: 'testext', enabled: false, now }),
  getExtensionInstallProgress: (s: PostgresStore) => s.getExtensionInstallProgress('testext'),
  writeExtensionInstallProgress: (s: PostgresStore) => s.writeExtensionInstallProgress({ expectedRevision: null, progress: { name: 'testext', packageDigest: 'a'.repeat(64), result: null, failedStage: null, lastFailure: null, stages: {}, authWorkId: null, scheduleIds: [] } }),
  recordExtensionPythonEnvironment: (s: PostgresStore) => s.recordExtensionPythonEnvironment({ name: 'testext', status: 'failed', code: 'EXTENSION_UV_NOT_FOUND', checkedAt: now }),
  getExtensionPythonEnvironment: (s: PostgresStore) => s.getExtensionPythonEnvironment('testext'),
  recordExtensionInstall: (s: PostgresStore) => s.recordExtensionInstall({ name: 'testext', version: '1', now }),
  recordExtensionConnection: (s: PostgresStore) => s.recordExtensionConnection({ name: 'testext', status: 'connected', checkedAt: now, code: null, message: null }),
  getExtension: (s: PostgresStore) => s.getExtension('testext'),
  listExtensions: (s: PostgresStore) => s.listExtensions(),
  holdWorkGroup: (s: PostgresStore) => s.holdWorkGroup({ group: 'group', now }),
  releaseWorkGroup: (s: PostgresStore) => s.releaseWorkGroup({ group: 'group' }),
  listWork: (s) => s.listWork({ includeClosed: false, limit: 50 }),
  readModelWorkUsage: (s) => s.readModelWorkUsage({ kinds: [] }),
  listSchedules: (s) => s.listSchedules({ limit: 100 }),
  removeSchedule: (s) => s.removeSchedule({ id }),
  checkHealth: (s) => s.checkHealth(),
  readSchemaVersions: (s) => s.readSchemaVersions(),
  ensureSelfUser: (s) => s.ensureSelfUser(sampleSelfUserInput()),
  readSelfUser: (s) => s.readSelfUser(),
  ensureSession: (s) => s.ensureSession(sampleEnsureSessionInput()),
  findSession: (s) => s.findSession(sampleSessionKey),
  ingest: (s) => s.ingest(sampleIngestBatch()),
  readSession: (s) => s.readSession(sampleSessionToken),
  listStaleSessions: (s) => s.listStaleSessions({ harness: 'demo', parserVersion: '1' }),
  listIdentityCandidates: (s) => s.listIdentityCandidates(),
  countUntaggedSessions: (s) => s.countUntaggedSessions(),
  fillSessionTags: (s) => s.fillSessionTags({ key: sampleSessionKey, checkout: null, firstCwd: null, tagSource: null }),
  redactMessage: (s) => s.redactMessage({ messageId: id, plan: () => { throw new Error('unreachable'); } }),
  addWorkGraph: (s) => s.addWorkGraph({ nodes: [{ ...sampleWorkInput(), after: [] }] }),
  addWork: (s) => s.addWork(sampleWorkInput()),
  hasDueWork: (s) => s.hasDueWork(due),
  claimWork: (s) => s.claimWork({ ...due, claimedBy: 'worker' }),
  completeWork: (s) => s.completeWork({ ...claim, now }),
  retryWork: (s) => s.retryWork({ ...claim, nextAttemptAt: now, lastError: 'retry' }),
  releaseWork: (s) => s.releaseWork(claim),
  recordFailure: (s) => s.recordFailure(sampleFailureInput()),
  listFailures: (s) => s.listFailures({ includeResolved: false }),
  resolveFailures: (s) => s.resolveFailures({ targetKind: 'session', targetId: id, stage: 'ingest', now }),
  listOpenWorkTargets: (s) => s.listOpenWorkTargets({ kind: 'document_extract' }),
  listTranscriptFiles: (s) => s.listTranscriptFiles({ harness: 'demo' }),
  recordTranscriptFile: (s) => s.recordTranscriptFile(sampleTranscriptFileInput()),
  linkAttachments: (s) => s.linkAttachments({ key: sampleSessionKey, attachments: [], linkedAt: now }),
  listMessageAttachments: (s) => s.listMessageAttachments(id),
  listRedactedContentHashes: (s) => s.listRedactedContentHashes(['sha256:' + 'a'.repeat(64)]),
  listMissingFileNames: (s) => s.listMissingFileNames({ limit: 1 }),
  writeFileNames: (s) => s.writeFileNames({ names: [{ id, fileId: id, nameSource: 'attachment_name', text: 'fixture' }] }),
  listFileNames: (s) => s.listFileNames(id),
  readFileLocation: (s) => s.readFileLocation(id),
  listFileLocations: (s) => s.listFileLocations(id),
  markFileLocationDeleted: (s) => s.markFileLocationDeleted({ id, deletedAt: now }),
  readFileSharing: (s) => s.readFileSharing({ fileId: id }),
  redactFile: (s) => s.redactFile({ fileId: id, plan: () => { throw new Error('unreachable'); } }),
  beginExtraction: (s) => s.beginExtraction({ id, fileId: id, extractorVersion: '1', startedAt: now, claim: { workItemId: id, claimedBy: 'worker' } }),
  appendExtractionChunks: (s) => s.appendExtractionChunks({ extractionId: id, chunks: [{ id, ordinal: 0, body: 'piece', page: null, chunkLocator: { type: 'text', start: 0, end: 5 } }] }),
  finishExtraction: (s) => s.finishExtraction({ extractionId: id, finishedAt: now, outcome: { status: 'ok', mediaType: 'text/plain', indexConfigId: null } }),
  setFileSourceUnreachable: (s) => s.setFileSourceUnreachable({ fileId: id, unreachableAt: now }),
  readFileExtractionState: (s) => s.readFileExtractionState(id),
  listFilesAwaitingExtraction: (s) => s.listFilesAwaitingExtraction({ limit: 1 }),
  listFilesWithStaleExtraction: (s) => s.listFilesWithStaleExtraction({ limit: 1, extractorVersion: '1' }),
  listExtractions: (s) => s.listExtractions(id),
  listExtractionChunks: (s) => s.listExtractionChunks(id),
  readWorkAttemptHealth: (s) => s.readWorkAttemptHealth(),
  requestWorkCancel: s => s.requestWorkCancel({ id, now }),
  recordSupervisedProcess: s => s.recordSupervisedProcess({ id, attemptToken: id, pid: 1, pgid: 1, osBootAt: null, osStartedAt: null }),
  listOpenSupervisedAttempts: s => s.listOpenSupervisedAttempts(),
  settleSupervisedAttempt: s => s.settleSupervisedAttempt({ id, attemptToken: id, now, outcome: 'died' }),
  claimSupervisedWork: s => s.claimSupervisedWork({ now, claimedBy: id, kinds: ['process_probe'], attemptToken: id }),
  renewSupervisedLease: s => s.renewSupervisedLease({ id, attemptToken: id, now, progressAt: now }),
  finishSupervisedWork: s => s.finishSupervisedWork({ id, attemptToken: id, now, outcome: 'succeeded' }),
  addSchedule: (s) => s.addSchedule({ id, kind: 'demo', targetKind: 'session', targetId: id, localTime: null, timeZone: null, intervalSeconds: null, nextRunAt: now, lastRunAt: null, createdAt: now }),
  listDailySchedules: s => s.listDailySchedules({ limit: 1 }),
  readSchedule: s => s.readSchedule({ id }),
  rezoneSchedule: s => s.rezoneSchedule({ id, expectedNextRunAt: now, expectedTimeZone: 'UTC', timeZone: 'Asia/Seoul', nextRunAt: now }),
  listScheduleSuccesses: s => s.listScheduleSuccesses({ scheduleId: id }),
  listDueSchedules: (s) => s.listDueSchedules({ now, limit: 1 }),
  fireSchedule: (s) => s.fireSchedule({ scheduleId: id, expectedNextRunAt: now, nextRunAt: null, work: sampleWorkInput(), now }),
  getSettings: (s) => s.getSettings({ keys: ['timezone'] }),
  getSetting: (s) => s.getSetting({ key: 'timezone' }),
  readConversationSnapshot: s => s.readConversationSnapshot(id),
  commitConversationChunks: s => s.commitConversationChunks({ sessionId: id, workId: id, claimedBy: id, now, fingerprint: '', chunks: [] }),
  searchConversationChunks: s => s.searchConversationChunks({ pattern: '%x%' }),
  searchRecall: s => s.searchRecall({ kind: 'chunks', query: 'x', pattern: '%x%', limit: 6 }),
  insertChannelLegacy: s => s.insertChannelLegacy({type:'notification',id,conversationId:id,source:'test',dataset:'data',originalTable:'notifications',originalKey:'1',importBatch:'batch',localDate:'2026-01-01',event:'event',detail:'',at:now}),
  readChannelLegacy: s => s.readChannelLegacy({type:'notification',dataset:'data',originalTable:'notifications',originalKey:'1'}),
  ensureChannel: s => s.ensureChannel({id,kind:'telegram',botRef:'bot'}),
  ensureChannelConversation: s => s.ensureChannelConversation({id,channelId:id,externalRef:'chat',threadRef:null}),
  createChannelRequest: s => s.createChannelRequest({id,conversationId:id,producer:'test',producerResultId:'result',purpose:'notice',revision:null,text:'text',createdAt:now}),
  readChannelRequest: s => s.readChannelRequest(id),
  listUnhandedChannelRequests: s => s.listUnhandedChannelRequests(),
  handoffChannelRequest: s => s.handoffChannelRequest({requestId:id,workId:id,now}),
  gateChannelAttempt: s => s.gateChannelAttempt({requestId:id,workItemId:id,attemptToken:id,now}),
  recoverChannelAttempt: s => s.recoverChannelAttempt({requestId:id,workItemId:id,attemptToken:id,now}),
  finishChannelAttempt: s => s.finishChannelAttempt({requestId:id,workItemId:id,attemptToken:id,now,externalMessageId:'1'}),
  setSetting: (s) => s.setSetting({ key: 'timezone', value: 'UTC', updatedAt: now }),
} satisfies Record<Exclude<keyof PostgresStore, 'close'>, (store: PostgresStore) => Promise<unknown>>;

it.each(['refused', 'terminated', 'missing-schema', 'missing-database', 'missing-role', 'authentication'] as const)('every store verb answers DB_UNAVAILABLE when %s', async kind => {
  const db = kind === 'refused' ? undefined : await database();
  const blocker = kind === 'terminated' ? new pg.Client({ connectionString: db!.url }) : undefined;
  const url = new URL(db?.appUrl ?? `postgresql://brain_app:unused@127.0.0.1:${await closedPort()}/unavailable`);
  if (kind === 'missing-database') url.pathname = '/brain_database_that_does_not_exist';
  if (kind === 'missing-role') url.username = 'brain_role_that_does_not_exist';
  if (kind === 'authentication') url.password = 'incorrect-password';
  const stores: PostgresStore[] = [];
  try {
    if (kind === 'missing-schema') await db!.query('drop schema brain cascade');
    if (blocker) {
      await blocker.connect();
      const tables = await db!.rows<{ tablename: string }>("select tablename from pg_tables where schemaname='brain'");
      await blocker.query('begin');
      await blocker.query(`lock table ${tables.map(t => 'brain.' + t.tablename).join(',')} in access exclusive mode`);
    }
    for (const [name, invoke] of Object.entries(calls)) {
      const applicationName = `unavailable-${name}`;
      const store = postgresStore({ databaseUrl: url.toString(), applicationName, connectTimeoutMs: 200, lockTimeoutMs: 5000 });
      stores.push(store);
      expect(Object.keys(store).filter(key => key !== 'close').sort()).toEqual(Object.keys(calls).sort());
      const pending = invoke(store);
      if (blocker) {
        const deadline = Date.now() + 3000;
        let terminated = false;
        while (Date.now() < deadline) {
          const rows = await db!.rows<{ pid: number }>(`select pid from pg_stat_activity where application_name='${applicationName}' and wait_event_type='Lock'`);
          if (rows[0]) { await db!.query(`select pg_terminate_backend(${rows[0].pid})`); terminated = true; break; }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(terminated, `a pending database operation for ${name}`).toBe(true);
      }
      expect(await pending, name).toMatchObject({ ok: false, code: name === 'searchRecall' && kind === 'missing-schema' ? 'SEARCH_FAILED' : 'DB_UNAVAILABLE', message: expect.any(String) });
      await store.close();
    }
  } finally {
    await Promise.all(stores.map(s => s.close()));
    if (blocker) { await blocker.query('rollback'); await blocker.end(); }
    await db?.drop();
  }
});

it.each([
  ['sessions', (store: PostgresStore) => store.findSession(sampleSessionKey)],
  ['settings', (store: PostgresStore) => store.getSetting({ key: 'timezone' })],
  ['schema_migrations', (store: PostgresStore) => store.readSchemaVersions()],
  ['work_items', (store: PostgresStore) => store.checkHealth()],
] as const)('answers DB_UNAVAILABLE when the brain.%s table is absent', async (table, invoke) => {
  const db = await database();
  const store = postgresStore({ databaseUrl: db.appUrl });
  try {
    await db.query(`drop table brain.${table} cascade`);
    expect(await invoke(store)).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  } finally { await store.close(); await db.drop(); }
});
