import { expect, it } from 'vitest';
import { extensionMetadata, withExtensionMetadata } from '../src/recall/extension-metadata.js';
import { extensionPublicProjection } from '../src/extensions/public-projection.js';
import { errorEnvelope, okEnvelope } from '../src/envelope.js';
import { fixedClock } from '../src/testing/index.js';

it('공개 사실의 우선순위와 미설치·비활성 검색 가능성을 투영한다', () => {
  const absent = extensionPublicProjection('absent', null, null, 0, 0);
  expect(extensionMetadata(absent)).toEqual({ source:'absent', installed:false, enabled:null, searchable:null, work_state:'unknown' });
  const status = { ...absent, installed:true, enabled:false, replacementRequired:true, quiesced:true, interruptedWorkCount:2, heldScheduleCount:3 };
  expect(extensionMetadata(status)).toMatchObject({ searchable:true, enabled:false, work_state:'replacement_required' });
  expect(extensionMetadata({ ...status, replacementRequired:false }).work_state).toBe('quiesced');
  expect(extensionMetadata({ ...status, replacementRequired:false, quiesced:false }).work_state).toBe('interrupted');
  expect(extensionMetadata({ ...status, replacementRequired:false, quiesced:false, interruptedWorkCount:0 }).work_state).toBe('held');
  expect(extensionMetadata({ ...absent, installResult:'failed' }).work_state).toBe('failed');
  expect(extensionMetadata({ ...absent, stages:{login:{status:'pending',code:null,at:'2026-01-01T00:00:00Z'}} }).work_state).toBe('pending');
});

it('inventory·명시 source를 정렬하고 실패를 미설치로 바꾸지 않으며 오류를 우선한다', async () => {
  const store = { listExtensionInventory: async () => ({ok:true as const,names:['z','a']}), getExtensionPublicStatus: async (name:string) => ({ok:true as const,status:extensionPublicProjection(name,null,null,0,0)}) };
  const result = await withExtensionMetadata(store, {ok:true as const,data:[],meta:{hint:'없음'}}, ['a','b']);
  expect((result.meta as import('../src/envelope.js').EnvelopeMeta | undefined)?.extensions?.map(x=>x.source)).toEqual(['a','b','z']);
  const failed = { ...store, getExtensionPublicStatus: async () => ({ok:false as const,code:'DB_UNAVAILABLE' as const,message:'연결 실패'}) };
  expect(await withExtensionMetadata(failed,{ok:true as const,data:[]})).toMatchObject({ok:false,code:'DB_UNAVAILABLE'});
  expect(await withExtensionMetadata(failed,{ok:false as const,code:'SEARCH_FAILED',message:'검색 실패'})).toMatchObject({ok:false,code:'SEARCH_FAILED'});
});

it('성공과 실패 봉투 모두 metadata를 마스킹해 보존한다', () => {
  const clock = fixedClock(new Date('2026-01-01T00:00:00Z'));
  const meta = { extensions:[{source:'password=secret',installed:true,enabled:false,searchable:true,work_state:'held' as const}] };
  for (const result of [okEnvelope(clock, [], [], meta), errorEnvelope(clock, {code:'SEARCH_FAILED',message:'실패',meta})]) {
    expect(JSON.stringify(result)).not.toContain('secret'); expect(result.meta?.extensions?.[0]?.work_state).toBe('held');
  }
});

it('SDK 검색은 빈 배열과 명시 source를 유지하고 검색 실패와 연결 실패를 구별한다', async () => {
  const { createBrain } = await import('../src/brain.js');
  const { fakeCron, memoryStore, memorySchemaStore, memorySpool, memoryFileStore, memoryRepositories, memoryTranscriptReader, sequenceIdGen, manualTime } = await import('../src/testing/index.js');
  const store = memoryStore(); const clock = manualTime(new Date('2026-01-01T00:00:00Z')).clock;
  const deps = { cron:fakeCron, store:{...store,...memorySchemaStore({version:9})}, schemaVersions:{core:9}, clock, idGen:sequenceIdGen({timestampMs:0}), spool:memorySpool(), files:memoryFileStore(), parsers:[], transcripts:memoryTranscriptReader(), repositories:memoryRepositories(), machine:'test' };
  const result = await createBrain(deps).recall.docs({query:'없음',sources:['missing']});
  expect(result).toMatchObject({ok:true,data:[],meta:{extensions:[{source:'missing',installed:false,enabled:null,searchable:null}]}});
  expect(await createBrain(deps).recall.chunks({query:'없음',sources:['missing']})).toMatchObject({ok:true,data:[],meta:{extensions:[{source:'missing',installed:false}]}});
  expect(await createBrain(deps).recall.tools({query:'없음',sources:['missing']})).toMatchObject({ok:true,data:[],meta:{extensions:[{source:'missing',installed:false}]}});
  const body = '합성 리포트'; const locator=JSON.stringify({type:'text',start:0,end:Array.from(body).length});
  const document = {kind:'document' as const,file_id:'file-1',display_name:'report',chunk_locator:locator,extraction_id:'gen-1',report_date:null,source:'resultonly',source_unreachable:false,body};
  const resultOnly = {...deps,store:{...deps.store,searchDocuments:async () => ({ok:true as const,rows:[{...document,ordinal:0}],contexts:[{extraction_id:document.extraction_id,pieces:[{ordinal:0,chunk_locator:locator,body}]}]})}};
  expect(await resultOnly.store.listExtensionInventory()).toEqual({ok:true,names:[]});
  const found = await createBrain(resultOnly).recall.docs({query:'합성'});
  expect(found).toMatchObject({ok:true,data:[document],meta:{extensions:[{source:'resultonly',installed:false,enabled:null,searchable:null,work_state:'unknown'}]}});
  const broken = {...deps,store:{...deps.store,searchDocuments:async () => ({ok:false as const,code:'SEARCH_FAILED' as const,message:'검색 실패'})}};
  expect(await createBrain(broken).recall.docs({query:'수면',sources:['missing']})).toMatchObject({ok:false,code:'SEARCH_FAILED',meta:{extensions:[{source:'missing'}]}});
  const unavailable = {...deps,store:{...deps.store,listExtensionInventory:async () => ({ok:false as const,code:'DB_UNAVAILABLE' as const,message:'연결 실패'})}};
  expect(await createBrain(unavailable).recall.docs({query:'없음'})).toMatchObject({ok:false,code:'DB_UNAVAILABLE'});
});
