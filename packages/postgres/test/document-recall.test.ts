import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createIsolatedTestDatabase } from '@second-brain/test-db';
import { searchDocuments, showDocument } from '@second-brain/core';
import { database } from './fixture.js';
import { postgresStore } from '../src/index.js';

it('리포트 요청의 최신 provenance와 현재 추출만 검색한다', async () => {
  const db = await database(true, createIsolatedTestDatabase);
  const admin = new pg.Client({ connectionString: db.url });
  const store = postgresStore({ databaseUrl: db.appUrl });
  const file = randomUUID(), other = randomUUID(), ordinary = randomUUID(), old = randomUUID(), current = randomUUID(), work = randomUUID(), token = randomUUID();
  const loc = JSON.stringify({ type:'text', start:0, end:8 });
  try {
    await admin.connect();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('fixture','1',now(),true,now())");
    await admin.query("insert into brain.extension_work_kinds(extension_name,kind) values ('fixture','fixture.import')");
    await admin.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values ($1,'fixture.import','import','fixture',now(),now(),'supervised',now(),now()+interval '10 minutes','test')", [work]);
    await admin.query("insert into brain.work_attempts(token,work_item_id,started_at,incarnation) values ($1,$2,now(),'test')", [token,work]);
    await admin.query('update brain.work_items set current_attempt_token=$1 where id=$2', [token,work]);
    for (const [id, hash] of [[file,'a'],[other,'b'],[ordinary,'c']]) await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())', [id, `sha256:${hash!.repeat(64)}`]);
    for (const [id, target, attempt] of [[old,file,1],[current,file,2],[randomUUID(),other,1],[randomUUID(),ordinary,1]] as const) {
      await admin.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ($1,$2,'fixture',$3,'ok',now(),now())", [id,target,attempt]);
      const body = attempt === 1 && target === file ? '이전 검색' : '현재 검색 내용';
      const location = JSON.stringify({type:'text',start:0,end:Array.from(body).length});
      await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ($1,$2,0,$3,$4)', [randomUUID(),id,body,location]);
      await admin.query('update brain.files set current_extraction_id=$1 where id=$2', [id,target]);
    }
    for (const [key, kind, date, target] of [['one','report','2026-01-01',file],['two','report','invalid',file],['graph','graph','2026-01-03',other]] as const) {
      const request = randomUUID();
      await admin.query("insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata) values ($1,'fixture',$2,'d','b',$2,$3,1,'text/markdown',now(),$4,$5,$6::jsonb)", [request,key,'a'.repeat(64),work,token,JSON.stringify({kind,report_date:date})]);
      await admin.query('insert into brain.file_request_results(request_id,file_id,finished_at) values ($1,$2,now())', [request,target]);
      if (key === 'one') await admin.query('select pg_sleep(0.001)');
    }
    await admin.query("insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata) values ($1,'fixture','pending','d','b','pending',$2,1,'text/plain',now(),$3,$4,$5::jsonb)", [randomUUID(),'c'.repeat(64),work,token,JSON.stringify({kind:'report'})]);
    const found = await searchDocuments(store, { query:'검색' });
    expect(found.ok).toBe(true); if (!found.ok) return;
    expect(found.data).toHaveLength(1);
    expect(found.data[0]).toMatchObject({file_id:file, extraction_id:current, report_date:null, source:'fixture', display_name:`report:${file}`});
    expect(found.data[0]!.body).toBe('현재 검색 내용');
    const read = await showDocument(store, {file_id:file,chunk_locator:loc,extraction_id:old});
    expect(read).toMatchObject({ok:true,meta:{generation_changed:true}});
    const prefix = JSON.stringify({type:'text',start:8,end:17});
    const tail = JSON.stringify({type:'text',start:17,end:26});
    await admin.query("insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ($1,$2,1,'password=',$3),($4,$2,2,'Secret123',$5)",[randomUUID(),current,prefix,randomUUID(),tail]);
    const secret = await searchDocuments(store,{query:'Secret123'});
    expect(secret.ok && secret.data[0]?.body).toContain('[REDACTED:password]');
    expect(JSON.stringify(secret)).not.toContain('Secret123');
    expect(JSON.stringify(secret)).not.toContain('password=');
    const literals = ['문자 % 표시','문자 _ 표시','문자 \\ 표시','MiXeD 문장'];
    const literalLocations: string[] = [], literalIds: string[] = []; let cursor=100;
    for (let i=0; i<literals.length; i++) {
      const body=literals[i]!; const end=cursor+Array.from(body).length;
      const location=JSON.stringify({type:'text',start:cursor,end}); literalLocations.push(location);
      const chunkId=randomUUID(); literalIds.push(chunkId);
      await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ($1,$2,$3,$4,$5)',[chunkId,current,10+i,body,location]); cursor=end+10;
    }
    for (const [query,index] of [['%',0],['_',1],['\\',2],['mixed',3]] as const) {
      const literal=await searchDocuments(store,{query});
      expect(literal.ok).toBe(true); if (!literal.ok) throw Error('literal search failed');
      expect(literal.data.map(r=>r.chunk_locator)).toEqual([literalLocations[index]]);
      const matchedIds=(await admin.query('select id from brain.document_chunks where extraction_id=$1 and chunk_locator=any($2::text[])',[current,literal.data.map(r=>r.chunk_locator)])).rows.map(r=>r.id);
      expect(matchedIds).toEqual([literalIds[index]]);
    }
    const raw = await store.searchDocuments({query:'문자',pattern:'%문자%',limit:10});
    expect(raw.ok).toBe(true); if (!raw.ok) throw Error('raw search failed');
    expect(raw.rows).toHaveLength(3);
    expect(raw.contexts).toHaveLength(1);
    expect(raw.contexts[0]!.extraction_id).toBe(current);
    expect(raw.contexts[0]!.pieces).toHaveLength(7);
    expect(raw.rows.every(r => !('context' in r))).toBe(true);
    const upper=await searchDocuments(store,{query:'문자'});
    expect(upper.ok && new Set(upper.data.map(r=>r.chunk_locator))).toEqual(new Set(literalLocations.slice(0,3)));
    const newRequest=randomUUID();
    await admin.query("insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata) values ($1,'fixture','valid','d','b','valid',$2,1,'text/plain',now(),$3,$4,$5::jsonb)",[newRequest,'c'.repeat(64),work,token,JSON.stringify({kind:'report',report_date:'2026-01-01'})]);
    await admin.query('insert into brain.file_request_results(request_id,file_id,finished_at) values ($1,$2,now())',[newRequest,ordinary]);
    await admin.query("insert into brain.file_names(id,file_id,name_source,text,text_raw) values ($1,$2,'attachment_name',$3,$4)",[randomUUID(),ordinary,'a�b',Buffer.from([97,0,98])]);
    const sorted = await searchDocuments(store,{query:'검색',limit:1});
    expect(sorted.ok && sorted.data[0]).toMatchObject({file_id:ordinary,report_date:'2026-01-01',display_name:'a\0b'});
    await admin.query("update brain.document_chunks set body='검색 검색 내용', chunk_locator=$1 where extraction_id=$2 and ordinal=0",[JSON.stringify({type:'text',start:0,end:8}),current]);
    const frequencyFirst = await searchDocuments(store,{query:'검색',limit:1});
    expect(frequencyFirst.ok && frequencyFirst.data[0]?.file_id).toBe(file);
    const rawRank = await store.searchDocuments({query:'검색',pattern:'%검색%',limit:2});
    expect(rawRank.ok && rawRank.rows.map(r=>r.file_id)).toEqual([file,ordinary]);


  } finally { await store.close(); await admin.end(); await db.drop(); }
}, 30000);
