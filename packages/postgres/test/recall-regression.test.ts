import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createIsolatedTestDatabase } from '@second-brain/test-db';
import { CONVERSATION_CHUNK_INDEX_CONFIG_ID, searchDocuments, searchRecall, showDocument } from '@second-brain/core';
import { sampleEnsureSessionInput, sampleIngestBatch, sampleSelfUserInput } from '@second-brain/core/testing';
import { database } from './fixture.js';
import { postgresStore } from '../src/index.js';

// Each case has one explicitly fixed fixture id per target; NFC and NFD are intentionally distinct.
const cases = [
  ['수면','수면 숙면 회복'], ['운동량','운동량 기록'], ['공백 띄움','공백 띄움 기록'], ['a-b','기호 a-b 기록'],
  ['AND','논리 AND 기록'], ['"인용"','기호 "인용" 기록'], ['%','백분율 % 표시'], ['_','밑줄 _ 표시'],
  ['\\','역슬래시 \\ 표시'], ['가','NFC 가 기록'], ['가','NFD 가 기록'],
] as const;
const id = (group:number, index:number) => `00000000-0000-400${group}-8000-${String(index+1).padStart(12,'0')}`;
const literal = (q:string) => '%' + [...q].map(c => ['%','_','\\'].includes(c) ? '\\' + c : c).join('') + '%';

it('세 검색 대상의 문자·재질의 fixture는 고정 id 및 독립 전수 LIKE와 같고 출처 원문을 복원한다', async () => {
  const db=await database(true,createIsolatedTestDatabase); const store=postgresStore({databaseUrl:db.appUrl}); const client=new pg.Client({connectionString:db.url});
  try {
    await client.connect();
    expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
    expect((await store.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
    const session=sampleEnsureSessionInput().id;
    await client.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('fixture','1',now(),false,now())");
    await client.query("insert into brain.extension_work_kinds(extension_name,kind) values ('fixture','fixture.import')");
    const work=randomUUID(), token=randomUUID();
    await client.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values ($1,'fixture.import','import','fixture',now(),now(),'supervised',now(),now()+interval '10 minutes','fixture')",[work]);
    await client.query("insert into brain.work_attempts(token,work_item_id,started_at,incarnation) values ($1,$2,now(),'fixture')",[token,work]); await client.query('update brain.work_items set current_attempt_token=$1 where id=$2',[token,work]);
    for (let i=0;i<cases.length;i++) {
      const body=cases[i]![1], at=new Date(Date.UTC(2026,0,1,0,0,i)); const batch=sampleIngestBatch();
      batch.messages=[{...batch.messages[0]!,id:id(1,i),harnessMessageId:`fixture-${i}`,body,occurredAt:at}];
      batch.toolNotes=[{...batch.toolNotes[0]!,id:id(2,i),harnessMessageId:`fixture-${i}`,target:body}]; batch.attachments=[];
      expect((await store.ingest(batch)).ok).toBe(true);
      await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,body,part) values ($1,$2,$3,$4,$4,$5,0)',[id(3,i),session,CONVERSATION_CHUNK_INDEX_CONFIG_ID,at,body]);
      const file=id(4,i), extraction=id(5,i), request=id(6,i), chunk=id(7,i), loc=JSON.stringify({type:'text',start:0,end:Array.from(body).length});
      await client.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())',[file,`sha256:${String(i+1).padStart(64,'0')}`]);
      await client.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ($1,$2,'fixture',1,'ok',now(),now())",[extraction,file]);
      await client.query('insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ($1,$2,0,$3,$4)',[chunk,extraction,body,loc]); await client.query('update brain.files set current_extraction_id=$1 where id=$2',[extraction,file]);
      await client.query("insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata) values ($1,'fixture',$2,'d','b',$2,$3,1,'text/markdown',now(),$4,$5,$6::jsonb)",[request,`r${i}`,String(i+1).padStart(64,'0'),work,token,JSON.stringify({kind:'report',report_date:'2026-01-01'})]);
      await client.query('insert into brain.file_request_results(request_id,file_id,finished_at) values ($1,$2,now())',[request,file]);
    }
    for (let i=0;i<cases.length;i++) {
      const query=cases[i]![0], pattern=literal(query);
      for (const [kind,table,col,group] of [['chunks','chunks','body',3],['tools','tool_notes','target',2]] as const) {
        const expected=(await client.query<{id:string}>(`select id from brain.${table} where lower(${col}) like lower($1) escape '\\' order by id`,[pattern])).rows.map(r=>r.id);
        expect(expected).toEqual([id(group,i)]);
        const result=await searchRecall(store,kind,{query,limit:200}); expect(result.ok).toBe(true); if (!result.ok) throw Error(result.message);
        expect(result.data.map(r => kind==='chunks' ? r.chunk_id : r.tool_note_id).sort()).toEqual(expected);
        const source=result.data[0]!; const original=await store.readSession(source.session); expect(original.ok).toBe(true); if (!original.ok) throw Error(original.message);
        if (kind==='chunks') expect(original.messages.find(m=>m.occurredAt.toISOString()===source.from_at)?.body).toBe(cases[i]![1]);
        else expect(original.toolNotes.find(n=>n.id===source.tool_note_id)?.target).toBe(cases[i]![1]);
      }
      const oracle=(await client.query<{file_id:string}>("select e.file_id from brain.document_chunks c join brain.document_extractions e on e.id=c.extraction_id where lower(c.body) like lower($1) escape '\\' order by e.file_id",[pattern])).rows.map(r=>r.file_id);
      expect(oracle).toEqual([id(4,i)]);
      const found=await searchDocuments(store,{query,limit:200}); expect(found.ok).toBe(true); if (!found.ok) throw Error(found.message);
      expect(found.data.map(r=>r.file_id).sort()).toEqual(oracle);
      const source=found.data[0]!; const original=await showDocument(store,{file_id:source.file_id,chunk_locator:source.chunk_locator,extraction_id:source.extraction_id,before:0,after:0});
      expect(original.ok && original.data.map(r=>r.body).join('')).toBe(cases[i]![1]);
    }
    for (const query of ['수면','숙면']) { const result=await searchDocuments(store,{query}); expect(result.ok && result.data.map(r=>r.file_id)).toEqual([id(4,0)]); }
    expect(await searchDocuments(store,{query:'일치하지않음'})).toMatchObject({ok:true,data:[],meta:{hint:expect.any(String)}});
  } finally { await client.end(); await store.close(); await db.drop(); }
},120000);
