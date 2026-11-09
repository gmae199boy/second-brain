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
const snapshot = { id, bundleId: id, localDate: '2026-01-01', timeZone: 'UTC', content: new Uint8Array(), contentSha256: 'a'.repeat(64), createdAt: now };
const schedule = { id, kind:'demo', holdGroup:null, targetKind:'session', targetId:id, triggerKind:'once' as const, cronExpr:null, runAt:now, timeZone:null, timeZoneSource:null, intervalSeconds:null, extension:null, scheduleKey:null, userId:id, enabled:true, removedAt:null, triggerUpdatedAt:null, nextRunAt:now, lastRunAt:null, createdAt:now };
const analysisOutput = { status: 'ok' as const, summary: '', report_md: 'report', judgments: [], evidence: [], next_checks: [] };
const calls = {
  deferSourceChangeToReconcile: (s:PostgresStore) => s.deferSourceChangeToReconcile({sourceId:id,generation:1,sourceFileId:id,remoteVersion:'v1',claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:1,now}}),
  deferSourceScanUnreachable: (s:PostgresStore) => s.deferSourceScanUnreachable({sourceId:id,generation:1,scanId:id,sourceFileId:id,remoteVersion:'v1',claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:1,now}}),
  refreshDriveRetention: (s:PostgresStore) => s.refreshDriveRetention(),
  listSourceChangeTasks: (s:PostgresStore) => s.listSourceChangeTasks({sourceId:id,generation:1,claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:1,now}}),
  resolveSourceChangeTask: (s:PostgresStore) => s.resolveSourceChangeTask({sourceId:id,generation:1,sourceFileId:id,remoteVersion:'v1',claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:1,now}}),
  applySourceChanges: (s:PostgresStore) => s.applySourceChanges({sourceId:id,generation:1,expectedCursor:'a',nextCursor:'b',changes:[],claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:1,now}}),
  disableMissingSchedules: (s: PostgresStore) => s.disableMissingSchedules({extension:'testext',userId:id,keys:[]}),
  findScheduleByKey: (s: PostgresStore) => s.findScheduleByKey({extension:'testext',scheduleKey:'key',userId:id}),
  updateSchedule: (s: PostgresStore) => s.updateSchedule({id,expected:schedule,schedule}),
  getWork: (s: PostgresStore) => s.getWork('00000000-0000-4000-8000-000000000001'),
  enqueueExtensionWork: (s: PostgresStore) => s.enqueueExtensionWork({ name: 'testext', version: '1', work: { id: '00000000-0000-7000-8000-000000000001', kind: 'testext.job', targetKind: 'extension', targetId: 'default', createdAt: now, nextAttemptAt: now } }),
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
  removeSchedule: (s) => s.removeSchedule({ id, now }),
  checkHealth: (s) => s.checkHealth(),
  readSchemaMigrationVersions: (s: PostgresStore) => s.readSchemaMigrationVersions!('testext'),
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
  listUnsupportedCarry: s => s.listUnsupportedCarry({extractorVersion:'1',limit:1}),
  commitUnsupportedCarry: s => s.commitUnsupportedCarry({fileId:id,extractorVersion:'1',contentHash:'sha256:'+ 'a'.repeat(64),home:{storeKind:'local',ownership:'brain',locator:'x'},supported:true,workId:id,now}),
  reserveSourceCarry: s => s.reserveSourceCarry({sourceId:id,generation:1,extractorVersion:'v',workId:id,now}),
  hasSourceCarryRun: s => s.hasSourceCarryRun({sourceId:id,generation:1,workId:id}),
  readSourceCarryCheck: s => s.readSourceCarryCheck({sourceFileId:id,remoteVersion:'1',extractorVersion:'v'}),
  markSourceCarryCheck: s => s.markSourceCarryCheck({sourceId:id,generation:1,sourceFileId:id,remoteVersion:'1',extractorVersion:'v',claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:1,now}}),
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
  addSchedule: (s) => s.addSchedule({ id, kind: 'demo', targetKind: 'session', targetId: id, triggerKind: 'once' as const, cronExpr: null, runAt: now, timeZoneSource: null, extension: null, scheduleKey: null, userId: '01940000-0000-7000-8000-00000000000a', enabled: true, removedAt: null, timeZone: null, intervalSeconds: null, nextRunAt: now, lastRunAt: null, createdAt: now }),
  listUserZoneSchedules: s => s.listUserZoneSchedules({ limit: 1 }),
  readSchedule: s => s.readSchedule({ id }),
  rezoneSchedule: s => s.rezoneSchedule({ id, expectedNextRunAt: now, expectedTimeZone: 'UTC', expectedCronExpr:'0 9 * * *', expectedTriggerUpdatedAt:null, timeZone: 'Asia/Seoul', nextRunAt: now }),
  listOccurrences: s => s.listOccurrences({ scheduleId: id }),
  readMissedPolicy: (s) => s.readMissedPolicy({kind:'testext.sync'}),
  listDueSchedules: (s) => s.listDueSchedules({ now, limit: 1 }),
  fireSchedule: (s) => s.fireSchedule({ scheduleId: id, expectedTriggerKind:'once', expectedTimeZone:null, expectedCronExpr:null, expectedNextRunAt: now, nextRunAt: null, work: sampleWorkInput(), occurrences: [{occurrenceAt:now,status:'pending'}], now }),
  getSettings: (s) => s.getSettings({ userId: null, keys: ['timezone'] }),
  getSetting: (s) => s.getSetting({ userId: null, key: 'timezone' }),
  readConversationSnapshot: s => s.readConversationSnapshot(id),
  commitConversationChunks: s => s.commitConversationChunks({ sessionId: id, workId: id, claimedBy: id, now, fingerprint: '', chunks: [] }),
  searchConversationChunks: s => s.searchConversationChunks({ pattern: '%x%' }),
  searchRecall: s => s.searchRecall({ kind: 'chunks', query: 'x', pattern: '%x%', limit: 6 }),
  listChannelStatuses: s => s.listChannelStatuses(),
  readChannelStatus: s => s.readChannelStatus(id),
  resendChannelRequest: s => s.resendChannelRequest({ requestId: id, workId: id, now }),
  insertChannelLegacy: s => s.insertChannelLegacy({type:'notification',id,conversationId:id,source:'test',dataset:'data',originalTable:'notifications',originalKey:'1',importBatch:'batch',localDate:'2026-01-01',event:'event',detail:'',at:now}),
  readChannelLegacy: s => s.readChannelLegacy({type:'notification',dataset:'data',originalTable:'notifications',originalKey:'1'}),
  ensureChannel: s => s.ensureChannel({id,kind:'telegram',botRef:'bot'}),
  ensureChannelConversation: s => s.ensureChannelConversation({ userId: '01940000-0000-7000-8000-00000000000a',id,channelId:id,externalRef:'chat',threadRef:null}),
  createChannelRequest: s => s.createChannelRequest({id,conversationId:id,producer:'test',producerResultId:'result',purpose:'notice',revision:null,text:'text',createdAt:now}),
  readChannelRequest: s => s.readChannelRequest(id),
  listUnhandedChannelRequests: s => s.listUnhandedChannelRequests(),
  handoffChannelRequest: s => s.handoffChannelRequest({requestId:id,workId:id,now}),
  gateChannelAttempt: s => s.gateChannelAttempt({requestId:id,workItemId:id,attemptToken:id,now}),
  recoverChannelAttempt: s => s.recoverChannelAttempt({requestId:id,workItemId:id,attemptToken:id,now}),
  listChannelItemResults: s => s.listChannelItemResults(id),
  recordChannelItemResult: s => s.recordChannelItemResult({requestId:id,workItemId:id,attemptToken:id,index:0,now,result:{outcome:'sent',externalMessageId:null}}),
  finishChannelAttempt: s => s.finishChannelAttempt({requestId:id,workItemId:id,attemptToken:id,now,externalMessageId:'1'}),
  ensureSource: s => s.ensureSource({id,kind:'drive',account:'test',rootId:'root'}),
  invalidateSource: s => s.invalidateSource({id,now}),
  updateSourceFolders: s => s.updateSourceFolders({id,userId:id,folderId:'synthetic',add:true,now}),
  listSources: s => s.listSources(),
  readSource: s => s.readSource(id),
  connectSource: s => s.connectSource({id}),
  disconnectSource: s => s.disconnectSource({id,now}),
  removeSource: s => s.removeSource({id,now}),
  listSourceEntries: s => s.listSourceEntries(id),
  listOutsideSourceNodes: s => s.listOutsideSourceNodes({sourceId:id,generation:1}),
  hasDueSourceWork: s => s.hasDueSourceWork({sourceId:id,syncWorkId:id,now}),
  claimSourceWork: s => s.claimSourceWork({sourceId:id,syncWorkId:id,now,claimedBy:'worker'}),
  readSourceWorkStatus: s => s.readSourceWorkStatus({sourceId:id,syncWorkId:id}),
  prepareSourceBytes: s => s.prepareSourceBytes({sourceId:id,generation:1,sourceFileId:id,remoteVersion:'v',contentHash:'hash',tempKey:'key',claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  renewSourceClaim: s => s.renewSourceClaim({sourceId:id,claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  beginSourceScan: s => s.beginSourceScan({sourceId:id,generation:1,scanId:id,startToken:'token',claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  observeSourceEntry: s => s.observeSourceEntry({sourceId:id,generation:1,scanId:id,entry:{id,remoteId:'r',name:'n',path:'p',mimeType:'text/plain',remoteVersion:'v',sizeBytes:1},claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  finishSourceScan: s => s.finishSourceScan({sourceId:id,generation:1,scanId:id,claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  markSourceUnreachable: s => s.markSourceUnreachable({sourceId:id,generation:1,sourceFileId:id,remoteVersion:'v',claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  markSourceFileOutcome: s => s.markSourceFileOutcome({sourceFileId:id,fileId:id,remoteVersion:'v',status:'unsupported',claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  markSourceFileUnreachable: s => s.markSourceFileUnreachable({sourceFileId:id,fileId:id,remoteVersion:'v',claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  markSourceEntry: s => s.markSourceEntry({sourceId:id,generation:1,sourceFileId:id,remoteVersion:'v',status:'photo',claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  handoffSourceFile: s => s.handoffSourceFile({sourceId:id,generation:1,sourceFileId:id,remoteVersion:'v',fileId:id,contentHash:'sha256:'+'a'.repeat(64),sizeBytes:1,workId:id,claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  listSourceHandoffs: s => s.listSourceHandoffs(id),
  finishSourceAttempt: s => s.finishSourceAttempt({fileId:id,extractionId:id,claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now},outcome:{status:'failed',failedStage:'read',error:'x',mediaType:null}}),
  bindSourceAttempt: s => s.bindSourceAttempt({sourceFileId:id,fileId:id,remoteVersion:'v',tempKey:'test',extractionId:id,claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  recoverSourceAttempt: s => s.recoverSourceAttempt('test',now),
  readSourceAttempt: s => s.readSourceAttempt('test'),
  publishSourceFile: s => s.publishSourceFile({sourceId:id,generation:1,sourceFileId:id,fileId:id,remoteVersion:'v',contentHash:'sha256:'+'a'.repeat(64),extractionId:id,outcome:{status:'ok',mediaType:'text/plain',indexConfigId:id},claim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:0,now}}),
  readSourceDocument: s => s.readSourceDocument!(id),
  searchDocuments: s => s.searchDocuments({query:'test',pattern:'%test%',limit:6}),
  readDocument: s => s.readDocument(id),
  insertSetting: (s) => s.insertSetting({ userId: null, key: 'timezone', value: 'UTC', updatedAt: now }),
  beginExtensionQuiesce: s => s.beginExtensionQuiesce({ name: 'testext', owner: '00000000-0000-4000-8000-000000000000', now }),
  readExtensionQuiesce: s => s.readExtensionQuiesce('testext'),
  endExtensionQuiesce: s => s.endExtensionQuiesce({ name: 'testext', owner: '00000000-0000-4000-8000-000000000000' }),
  setSetting: (s) => s.setSetting({ userId: null, key: 'timezone', value: 'UTC', updatedAt: now }),
  renewDriveMigration: s => s.renewDriveMigration({workId:id,fileId:id,claimedBy:'worker',claimedAt:now,attempts:1,now}),
  readDriveCandidate: s => s.readDriveCandidate(id),
  readDriveIntent: s => s.readDriveIntent(id),
  readDriveLocationRoot: s => s.readDriveLocationRoot(id),
  readDriveLocatorRoot: s => s.readDriveLocatorRoot('a'.repeat(64)),
  ensureDriveRedaction: s => s.ensureDriveRedaction({fileId:id,rootFolderId:'root',workId:id,at:now}),
  beginDriveMigration: s => s.beginDriveMigration({fileId:id,expectedHomeId:id,contentHash:'sha256:'+'a'.repeat(64),rootFolderId:'root',locationId:id,locator:'a'.repeat(64),workId:id,at:now}),
  readDriveRetention: s => s.readDriveRetention(id),
  withDriveLocalDelete: s => s.withDriveLocalDelete({workId:id,localLocationId:id,claimedBy:id,claimedAt:now,attempts:1,now},async()=>null),
  commitDriveMigration: s => s.commitDriveMigration({fileId:id,expectedHomeId:id,contentHash:'sha256:'+'a'.repeat(64),rootFolderId:'root',remoteId:'remote',locationId:id,locator:'a'.repeat(64),workId:id,verifiedAt:now,dueAt:now,migrationClaim:{workId:id,claimedBy:'worker',claimedAt:now,attempts:1,now,nowAtLock:()=>now}}),
} satisfies Record<Exclude<keyof PostgresStore, 'close' | 'imports' | 'driveUploads'>, (store: PostgresStore) => Promise<unknown>>;

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
      expect(Object.keys(store).filter(key => key !== 'close' && key !== 'imports' && key !== 'driveUploads').sort()).toEqual(Object.keys(calls).sort());
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
      expect(await pending, name).toMatchObject({ ok: false, code: ['searchRecall','searchDocuments','readDocument'].includes(name) && kind === 'missing-schema' ? 'SEARCH_FAILED' : 'DB_UNAVAILABLE', message: expect.any(String) });
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
  ['settings', (store: PostgresStore) => store.getSetting({ userId: null, key: 'timezone' })],
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

it('drive deletion journal methods report an unavailable database',async()=>{
 const port=await closedPort(),store=postgresStore({databaseUrl:`postgresql://brain_app:unused@127.0.0.1:${port}/unavailable`});
 try{const identity={rootFolderId:'root',contentHash:'sha256:'+'a'.repeat(64),remoteId:'remote',at:now};expect(await store.driveUploads.checkDelete(identity)).toMatchObject({ok:false});expect(await store.driveUploads.beginDelete(identity)).toMatchObject({ok:false});expect(await store.driveUploads.submitDelete(identity)).toMatchObject({ok:false});expect(await store.driveUploads.markDeleted(identity)).toMatchObject({ok:false});}finally{await store.close();}
});
