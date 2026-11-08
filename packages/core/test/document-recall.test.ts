import { describe, expect, it } from 'vitest';
import { searchDocuments, showDocument, type DocumentRecallStore, type DocumentRow, type DocumentSnapshot } from '../src/index.js';

const locator = (start: number, end: number) => JSON.stringify({ type: 'text', start, end });
const row = { kind: 'document', file_id: 'file-1', display_name: 'report', chunk_locator: locator(0, 5), extraction_id: 'old', report_date: '2026-01-01', source: 'fixture', source_unreachable: false, body: '검색 내용' } satisfies DocumentRow;
const snapshot: DocumentSnapshot = { redacted: false, source_unreachable: false, extraction_id: 'new', status: 'ok', pieces: [
  { ordinal: 0, chunk_locator: locator(0, 6), body: '가나다라마바' },
  { ordinal: 1, chunk_locator: locator(4, 10), body: '마바사아자차' },
] };
function store(rows: DocumentRow[] = [row], value: DocumentSnapshot | null = snapshot): DocumentRecallStore {
  return { async searchDocuments() { const mapped = rows.map((r,i) => { const chunk_locator = locator(0, Array.from(r.body).length); return { ...r, extraction_id: `${r.extraction_id}-${i}`, chunk_locator, ordinal:0 }; }); return { ok: true, rows: mapped, contexts: mapped.map(r => ({ extraction_id:r.extraction_id, pieces:[{ ordinal:0, chunk_locator:r.chunk_locator, body:r.body }] })) }; }, async readDocument() { return { ok: true, snapshot: value }; } };
}
describe('문서 검색과 원문 계약', () => {
  it('가림 후 크기 제한과 원문 출처를 보존한다', async () => {
    const result = await searchDocuments(store([{ ...row, body: '검색 password=secret ' + '가'.repeat(9000) }]), { query: '검색' });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.warnings).toContain('RESULT_TRUNCATED');
    expect(JSON.stringify(result)).not.toContain('password=secret');
    expect(result.meta.next).toMatchObject({ ns: 'files', verb: 'show', args: { file_id: row.file_id, chunk_locator: locator(0, Array.from('검색 password=secret ' + '가'.repeat(9000)).length) } });
    expect(Array.from(JSON.stringify(result)).length).toBeLessThanOrEqual(8000);
  });
  it('limit+1과 빈 결과 및 저장소 오류를 구별한다', async () => {
    const result = await searchDocuments(store(Array.from({ length: 6 }, () => row)), { query: '검색' });
    expect(result.ok && result.meta.has_more).toBe(true);
    expect(await searchDocuments(store([]), { query: '없음' })).toMatchObject({ ok: true, data: [], meta: { hint: expect.any(String) } });
    const failed: DocumentRecallStore = { ...store(), async searchDocuments() { return { ok: false, code: 'SEARCH_FAILED', message: 'fixture' }; } };
    expect(await searchDocuments(failed, { query: '검색' })).toMatchObject({ ok: false, code: 'SEARCH_FAILED' });
  });
  it('현재 세대에서 겹치는 위치와 문맥을 읽고 텍스트 중복을 제거한다', async () => {
    const result = await showDocument(store(), { file_id: 'file-1', chunk_locator: locator(5, 8), extraction_id: 'old' });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.meta.generation_changed).toBe(true);
    expect(result.data.map(r => r.body).join('')).toBe('가나다라마바사아자차');
  });
  it('가린 파일, 미추출과 없는 위치를 구별한다', async () => {
    expect(await showDocument(store([], { ...snapshot, redacted: true }), { file_id: 'file-1', chunk_locator: locator(0, 6) })).toMatchObject({ ok: false, status: 'redacted' });
    for (const status of ['unsupported', 'failed', 'too_large', 'pending'] as const) expect(await showDocument(store([], { ...snapshot, extraction_id: null, status }), { file_id: 'file-1', chunk_locator: locator(0, 6) })).toMatchObject({ ok: false, status });
    expect(await showDocument(store(), { file_id: 'file-1', chunk_locator: locator(50, 60) })).toMatchObject({ ok: false, status: 'location_not_found' });
    expect(await showDocument(store(), { file_id: 'file-1', chunk_locator: '{ invalid' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  });
  it('원본을 못 읽어도 유효한 추출은 사용한다', async () => {
    const result = await showDocument(store([], { ...snapshot, source_unreachable: true }), { file_id: 'file-1', chunk_locator: locator(0, 6) });
    expect(result.ok && result.meta.source_unreachable).toBe(true);
  });
});

it('분할 경계에 걸친 비밀도 원문 출력에서 가린다', async () => {
  const value: DocumentSnapshot = { ...snapshot, pieces: [
    { ordinal: 0, chunk_locator: locator(0, 9), body: 'password=' },
    { ordinal: 1, chunk_locator: locator(9, 15), body: 'secret' },
  ] };
  const result = await showDocument(store([], value), { file_id: 'file-1', chunk_locator: locator(0, 9) });
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).not.toContain('password=secret');
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('긴 원문은 next를 그대로 사용해 반복 없이 모두 이어 읽는다', async () => {
  const body = '가나다😀'.repeat(5000) + ' password=endingsecret 끝';
  const end = Array.from(body).length;
  const data: DocumentSnapshot = { ...snapshot, extraction_id: 'current', pieces: [{ ordinal: 0, chunk_locator: locator(0, end), body }] };
  const source = store([], data);
  let input = { file_id: 'file-1', chunk_locator: locator(0, end), extraction_id: 'current', before: 0, after: 0, offset: 0 };
  let output = ''; let pages = 0; let previous = -1;
  for (;;) {
    expect(++pages).toBeLessThan(20);
    const page = await showDocument(source, input); expect(page.ok).toBe(true); if (!page.ok) break;
    output += page.data.map(r => r.body).join('');
    if (!page.meta.next) break;
    const args = page.meta.next.args as typeof input;
    expect(args.offset).toBeGreaterThan(previous); previous = args.offset; input = args;
  }
  expect(pages).toBeGreaterThan(1);
  expect(output).not.toContain('endingsecret');
  expect(output).toBe(body.replace('password=endingsecret', 'password=[REDACTED:password]'));
  expect(await showDocument(store([], { ...data, extraction_id: 'different' }), input)).toMatchObject({ ok:true, meta:{ generation_changed:true, hint: expect.any(String) } });
  const changed = await showDocument(store([], { ...data, pieces: [{ ...data.pieces[0]!, body: body.replace('가나다','바나다') }] }), input);
  expect(changed).toMatchObject({ ok:true, meta:{ hint: expect.any(String) } });
  if (changed.ok) expect(changed.data[0]?.body.startsWith('바나다😀')).toBe(true);
  expect(await showDocument(store([], { ...data, pieces: [{ ...data.pieces[0]!, body: body.replace('endingsecret','alterdsecret') }] }), input)).toMatchObject({ ok:true, meta:{ hint: expect.any(String) } });
  expect(await showDocument(source, { ...input, fingerprint: 'bad' })).toMatchObject({ok:false,code:'INVALID_ARGUMENT'});
});

it('선택 바깥의 비밀 문맥을 사용하고 내부 문맥을 결과에 실지 않는다', async () => {
  const pieces = [
    { ordinal:0, chunk_locator:locator(0,9), body:'password=' },
    { ordinal:1, chunk_locator:locator(9,18), body:'Secret123' },
  ];
  const document: DocumentRecallStore = {
    async searchDocuments() { return {ok:true,rows:[{ ...row, chunk_locator:pieces[1]!.chunk_locator, body:pieces[1]!.body, ordinal:1 }],contexts:[{extraction_id:row.extraction_id,pieces}]}; },
    async readDocument() { return {ok:true,snapshot:{...snapshot,extraction_id:'old',pieces}}; },
  };
  const found = await searchDocuments(document,{query:'Secret123'});
  expect(found.ok).toBe(true); if (!found.ok) return;
  expect(found.data[0]!.body).toContain('[REDACTED:password]');
  expect(JSON.stringify(found)).not.toContain('Secret123');
  expect(JSON.stringify(found)).not.toContain('password=');
  expect(found.data[0]).not.toHaveProperty('context');
  const shown = await showDocument(document,{file_id:'file-1',chunk_locator:pieces[1]!.chunk_locator,before:0,after:0});
  expect(shown.ok).toBe(true); expect(JSON.stringify(shown)).not.toContain('Secret123');
});

it('서로 떨어진 텍스트와 페이지 출처를 별도 결과로 보존한다', async () => {
  const p = (value: unknown) => JSON.stringify(value);
  const pieces = [
    {ordinal:0,chunk_locator:locator(0,3),body:'앞쪽문'},
    {ordinal:1,chunk_locator:locator(10,13),body:'뒤쪽문'},
    {ordinal:2,chunk_locator:p({type:'pdf',page:1}),body:'첫 페이지'},
    {ordinal:3,chunk_locator:p({type:'pdf',page:2}),body:'둘 페이지'},
    {ordinal:4,chunk_locator:p({type:'docx',block:1}),body:'첫 블록'},
  ];
  const source = store([], {...snapshot,pieces});
  const shown = await showDocument(source,{file_id:'file-1',chunk_locator:locator(0,3),before:0,after:4});
  expect(shown.ok).toBe(true); if (!shown.ok) return;
  expect(shown.data.map(r => r.chunk_locator)).toEqual(pieces.map(r=>r.chunk_locator));
  expect(shown.data.map(r => r.body)).toEqual(pieces.map(r=>r.body));
});

it('SDK 실패 메시지의 비밀을 가린다', async () => {
  const failing: DocumentRecallStore = {
    async searchDocuments() { return {ok:false,code:'SEARCH_FAILED',message:'password=Secret123'}; },
    async readDocument() { return {ok:false,code:'DB_UNAVAILABLE',message:'password=Secret123'}; },
  };
  expect(JSON.stringify(await searchDocuments(failing,{query:'검색'}))).not.toContain('Secret123');
  expect(JSON.stringify(await showDocument(failing,{file_id:'file-1',chunk_locator:locator(0,3)}))).not.toContain('Secret123');
});

it('PDF 페이지와 영역 및 DOCX 블록을 선택하고 소실된 위치를 거부한다', async () => {
  const p = (value: unknown) => JSON.stringify(value);
  const pieces = [
    {ordinal:0,chunk_locator:p({type:'pdf',page:1,bbox:[0,0,0.4,0.4]}),body:'페이지1 왼쪽'},
    {ordinal:1,chunk_locator:p({type:'pdf',page:1,bbox:[0.6,0.6,1,1]}),body:'페이지1 오른쪽'},
    {ordinal:2,chunk_locator:p({type:'pdf',page:2}),body:'페이지2'},
    {ordinal:3,chunk_locator:p({type:'docx',block:1}),body:'블록1'},
    {ordinal:4,chunk_locator:p({type:'docx',block:2}),body:'블록2'},
  ];
  const source=store([], {...snapshot,pieces});
  const left=await showDocument(source,{file_id:'file-1',chunk_locator:p({type:'pdf',page:1,bbox:[0.1,0.1,0.2,0.2]}),before:0,after:0});
  expect(left.ok && left.data).toEqual([{chunk_locator:pieces[0]!.chunk_locator,body:'페이지1 왼쪽'}]);
  const page2=await showDocument(source,{file_id:'file-1',chunk_locator:p({type:'pdf',page:2}),before:0,after:0});
  expect(page2.ok && page2.data).toEqual([{chunk_locator:pieces[2]!.chunk_locator,body:'페이지2'}]);
  const block2=await showDocument(source,{file_id:'file-1',chunk_locator:p({type:'docx',block:2}),before:0,after:0,extraction_id:'old'});
  expect(block2.ok && block2.data).toEqual([{chunk_locator:pieces[4]!.chunk_locator,body:'블록2'}]);
  expect(block2.ok && block2.meta.generation_changed).toBe(true);
  const removed=store([], {...snapshot,pieces:pieces.slice(0,4)});
  expect(await showDocument(removed,{file_id:'file-1',chunk_locator:p({type:'docx',block:2}),extraction_id:'old'})).toMatchObject({ok:false,status:'location_not_found'});
  expect(await showDocument(source,{file_id:'file-1',chunk_locator:p({type:'pdf',page:3}),before:0,after:0})).toMatchObject({ok:false,status:'location_not_found'});
});

it('긴 비연속 문서의 각 출력과 이어 읽기가 정확한 locator를 유지한다', async () => {
  const left='앞'.repeat(12000), right='뒤'.repeat(12000);
  const pieces=[{ordinal:0,chunk_locator:locator(0,12000),body:left},{ordinal:1,chunk_locator:locator(20000,32000),body:right}];
  const source=store([], {...snapshot,extraction_id:'generation',pieces});
  let input={file_id:'file-1',chunk_locator:pieces[0]!.chunk_locator,extraction_id:'generation',before:0,after:1,offset:0};
  const output=new Map<string,string>(); let last=-1; let pages=0;
  for (;;) {
    expect(++pages).toBeLessThan(20);
    const result=await showDocument(source,input); expect(result.ok).toBe(true); if (!result.ok) throw Error('show failed');
    for (const part of result.data) output.set(part.chunk_locator,(output.get(part.chunk_locator) ?? '')+part.body);
    if (!result.meta.next) break;
    const next=result.meta.next.args as typeof input; expect(next.offset).toBeGreaterThan(last); last=next.offset; input=next;
  }
  expect(pages).toBeGreaterThan(2);
  expect([...output.entries()]).toEqual([[pieces[0]!.chunk_locator,left],[pieces[1]!.chunk_locator,right]]);
});


it('같은 세대의 검색 행은 문맥을 한 번 복원하고 저장 문맥 오류를 검색 실패로 반환한다', async () => {
  let reads = 0;
  const pieces = [{ ordinal:0, chunk_locator:locator(0,9), get body() { reads++; return 'password='; } },
    { ordinal:1, chunk_locator:locator(9,18), get body() { reads++; return 'Secret123'; } }];
  const source: DocumentRecallStore = {
    async searchDocuments() { return {ok:true, rows:Array.from({length:20}, () => ({...row, chunk_locator:pieces[1]!.chunk_locator, body:'Secret123', ordinal:1})), contexts:[{extraction_id:row.extraction_id,pieces}]}; },
    async readDocument() { return {ok:true,snapshot:null}; },
  };
  const result = await searchDocuments(source,{query:'Secret123',limit:20});
  expect(result.ok).toBe(true);
  expect(reads).toBe(2);
  expect(JSON.stringify(result)).not.toContain('Secret123');
  const broken: DocumentRecallStore = {...source, async searchDocuments() { return {ok:true, rows:[{...row,ordinal:0}], contexts:[]}; }};
  expect(await searchDocuments(broken,{query:'검색'})).toMatchObject({ok:false,code:'SEARCH_FAILED'});
  expect(await showDocument(store([], {...snapshot,pieces:[{ordinal:0,chunk_locator:locator(0,5),body:'bad'}]}),{file_id:'file-1',chunk_locator:locator(0,5)})).toMatchObject({ok:false,code:'SEARCH_FAILED'});
});

it('원문 창에서 하나의 비밀 표식을 한 번만 출력하고 역방향 그룹을 보존한다', async () => {
  const pieces = [{ordinal:0,chunk_locator:locator(0,9),body:'password='},{ordinal:1,chunk_locator:locator(9,18),body:'Secret123'},
    {ordinal:2,chunk_locator:locator(30,33),body:'끝문장'},{ordinal:3,chunk_locator:locator(0,3),body:'새문장'}];
  const result = await showDocument(store([], {...snapshot,pieces}),{file_id:'file-1',chunk_locator:locator(30,33),before:2,after:1});
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.data.map(r=>r.body).join('')).toBe('password=[REDACTED:password]끝문장새문장');
});


it('중간 위치의 before 1은 바로 앞 조각만 포함한다', async () => {
  const pieces = ['첫째','둘째','셋째','넷째'].map((body,ordinal) => ({ordinal,chunk_locator:locator(ordinal*10,ordinal*10+2),body}));
  const result = await showDocument(store([], {...snapshot,pieces}),{file_id:'file-1',chunk_locator:pieces[2]!.chunk_locator,before:1,after:0});
  expect(result.ok && result.data).toEqual(pieces.slice(1,3).map(({chunk_locator,body})=>({chunk_locator,body})));
});

it('memoryStore 실제 추출의 현재 세대, 출처, 가림과 순위를 지킨다', async () => {
  const {memoryStore,sequenceIdGen,sampleSelfUserInput,sampleEnsureSessionInput,sampleIngestBatch} = await import('../src/testing/index.js');
  const {brainLocator,contentHashOfBytes,DOCUMENT_EXTRACT_KIND,planFileRedaction} = await import('../src/index.js');
  const ids=sequenceIdGen({timestampMs:1770000000000,start:5000});
  const first=ids.next(), second=ids.next(), ordinary=ids.next();
  const requests=[{fileId:first,source:'older',reportDate:'2025-01-01',createdAt:'2025-01-01',id:'a'},
    {fileId:first,source:'latest',reportDate:'2025-01-02',createdAt:'2025-01-02',id:'b'},
    {fileId:second,source:'newer',reportDate:'2026-01-01',createdAt:'2026-01-01',id:'c'}];
  const memory=memoryStore({reportRequests:requests}), now=new Date('2026-03-04T05:06:07Z');
  expect((await memory.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
  expect((await memory.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
  const batch=sampleIngestBatch(), message=batch.messages[0]!;
  const attachments=[first,second,ordinary].map((id,ordinal)=>{
    const bytes=Uint8Array.of(ordinal+1), hash=contentHashOfBytes(bytes);
    return {id:ids.next(),harnessMessageId:message.harnessMessageId,ordinal,sourceKind:'file' as const,sourceRef:`report-${ordinal}`,displayName:`report-${ordinal}.md`,file:{id,contentHash:hash,sizeBytes:1,location:{id:ids.next(),storeKind:'local' as const,ownership:'brain' as const,locator:brainLocator(hash.slice(7),bytes)},external:null}};
  });
  expect((await memory.ingest({...batch,attachments})).ok).toBe(true);
  async function generation(fileId:string, bodies:string[]) {
    const work=ids.next(); expect((await memory.addWork({id:work,kind:DOCUMENT_EXTRACT_KIND,targetKind:'file',targetId:fileId,createdAt:now,nextAttemptAt:now})).ok).toBe(true);
    const claimed=await memory.claimWork({now,kinds:[DOCUMENT_EXTRACT_KIND],claimedBy:'fixture'}); if (!claimed.ok || !claimed.item) throw Error('claim');
    const claim={workItemId:claimed.item.id,claimedBy:'fixture'};
    const extractionId=ids.next(); expect((await memory.beginExtraction({id:extractionId,fileId,extractorVersion:'fixture',startedAt:now,claim})).ok).toBe(true);
    let start=0; const chunks=bodies.map((body,ordinal)=>{const end=start+Array.from(body).length; const chunk={id:ids.next(),ordinal,body,chunkLocator:{type:'text' as const,start,end},page:null}; start=end; return chunk;});
    expect((await memory.appendExtractionChunks({extractionId,chunks})).ok).toBe(true);
    expect((await memory.finishExtraction({extractionId,finishedAt:now,outcome:{status:'ok',mediaType:'text/plain',indexConfigId:null}})).ok).toBe(true);
    expect((await memory.completeWork({id:work,claimedBy:'fixture',now})).ok).toBe(true);
    return extractionId;
  }
  await generation(first,['이전 검색']);
  const current=await generation(first,['검색 검색 password=','Secret123']);
  await generation(second,['검색 한 번']); await generation(ordinary,['검색 검색 검색']);
  const raw=await memory.searchDocuments({query:'검색',pattern:'%검색%',limit:10});
  expect(raw.ok).toBe(true); if (!raw.ok) throw Error('search');
  expect(raw.rows.map(r=>r.file_id)).toEqual([first,second]);
  expect(raw.rows[0]).toMatchObject({source:'latest',extraction_id:current,report_date:'2025-01-02'});
  expect(raw.contexts).toHaveLength(2);
  const found=await searchDocuments(memory,{query:'Secret123'});
  expect(found.ok && found.data[0]?.body).toContain('[REDACTED:password]');
  expect(JSON.stringify(found)).not.toContain('Secret123');
  const masked=await memory.redactFile({fileId:first,plan:state=>planFileRedaction(state,{clock:{now:()=>now},idGen:ids})});
  expect(masked.ok).toBe(true);
  const after=await searchDocuments(memory,{query:'검색'}); expect(after.ok && after.data.map(r=>r.file_id)).toEqual([second]);
  expect(await showDocument(memory,{file_id:first,chunk_locator:locator(0,2)})).toMatchObject({ok:false,status:'redacted'});
});

it('기본 문맥은 가운데 조각과 앞뒤 두 조각만 반환한다', async () => {
  const pieces = ['가','나','다','라','마','바','사'].map((body, ordinal) => ({
    ordinal, chunk_locator: locator(ordinal * 10, ordinal * 10 + 1), body,
  }));
  const result = await showDocument(store([], { ...snapshot, pieces }), {
    file_id: 'file-1', chunk_locator: locator(30, 31),
  });
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.data).toEqual([
    { chunk_locator: locator(10, 11), body: '나' },
    { chunk_locator: locator(20, 21), body: '다' },
    { chunk_locator: locator(30, 31), body: '라' },
    { chunk_locator: locator(40, 41), body: '마' },
    { chunk_locator: locator(50, 51), body: '바' },
  ]);
});
