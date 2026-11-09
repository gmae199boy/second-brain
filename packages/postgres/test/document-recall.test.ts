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

it('external source names and text retain source identity, links and redaction',async()=>{
  const db=await database(true,createIsolatedTestDatabase),admin=new pg.Client({connectionString:db.url}),store=postgresStore({databaseUrl:db.appUrl});
  const source=randomUUID(),first=randomUUID(),second=randomUUID(),photo=randomUUID(),file=randomUUID(),extraction=randomUUID();
  const body='공유 본문 두글자',loc=JSON.stringify({type:'text',start:0,end:Array.from(body).length});
  try {await admin.connect();
    await admin.query("insert into brain.sources(id,kind,account,root_id,generation) values ($1,'drive','synthetic','root',1)",[source]);
    await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())',[file,'sha256:'+'b'.repeat(64)]);
    await admin.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ($1,$2,'test',1,'ok',now(),now())",[extraction,file]);
    await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ($1,$2,0,$3,$4)',[randomUUID(),extraction,body,loc]);await admin.query('update brain.files set current_extraction_id=$1 where id=$2',[extraction,file]);
    await admin.query("insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,file_id,index_status,unreachable,unreachable_at) values ($1,$4,'remote-a','문서.txt','폴더','text/plain','1',$5,'indexed',true,now()),($2,$4,'remote-b','다른문서.txt','폴더','text/plain','1',$5,'indexed',false,null),($3,$4,'remote-photo','사진.jpg','여행','image/jpeg','1',null,'photo',false,null)",[first,second,photo,source,file]);
    const found=await store.searchDocuments({query:'두글자',pattern:'%두글자%',limit:5});expect(found).toMatchObject({ok:true,rows:[{file_id:file,internal_origins:expect.arrayContaining([expect.objectContaining({source_file_id:first,source_unreachable:true}),expect.objectContaining({source_file_id:second,source_unreachable:false})])}]});
    expect(found.ok&&found.rows[0]).toMatchObject({source:'drive',display_name:first<second?'문서.txt':'다른문서.txt',source_unreachable:false});
    await admin.query('update brain.source_files set unreachable=not unreachable,unreachable_at=case when unreachable then null else now() end where id in ($1,$2)',[first,second]);
    const swapped=await store.searchDocuments({query:'두글자',pattern:'%두글자%',limit:5});expect(swapped).toMatchObject({ok:true,rows:[{file_id:file,source_unreachable:false}]});
    await admin.query('update brain.source_files set unreachable=not unreachable,unreachable_at=case when unreachable then null else now() end where id in ($1,$2)',[first,second]);
    expect(await showDocument(store,{source_file_id:first,file_id:file,chunk_locator:loc})).toMatchObject({ok:true,data:[{body}],meta:{source_unreachable:true,source_file:{source_file_id:first}}});
    const names=await searchDocuments(store,{query:'사진'});expect(names).toMatchObject({ok:true,data:[{file_id:null,chunk_locator:null,source_file_id:photo,index_status:'photo'}]});expect(await showDocument(store,{source_file_id:photo})).toMatchObject({ok:true,meta:{source_file:{file_id:null,index_status:'photo'}}});
    for(const value of ['Alias','alias','é','e\u0301']) await admin.query("insert into brain.file_names(id,file_id,name_source,text) values ($1,$2,'attachment_name',$3)",[randomUUID(),file,value]);
    const exact=await store.searchDocuments({query:'Alias',pattern:'%Alias%',limit:2});expect(exact.ok).toBe(true);if(!exact.ok)throw Error('names');
    expect(exact.rows[0]?.names).toEqual(expect.arrayContaining(['Alias','alias','é','e\u0301']));expect(exact.rows[0]?.names).toHaveLength(4);
    await admin.query('begin');await admin.query("set local brain.redacting='on'");await admin.query('update brain.files set redacted_at=now() where id=$1',[file]);await admin.query('commit');
    expect(await searchDocuments(store,{query:'두글자'})).toMatchObject({ok:true,data:[]});expect(await searchDocuments(store,{query:'문서.txt'})).toMatchObject({ok:true,data:[]});expect(await showDocument(store,{source_file_id:first})).toMatchObject({ok:false,status:'not_found'});
  }finally{await store.close();await admin.end();await db.drop();}
});

it('첨부 이름과 본문을 검색하고 같은 내용의 원본은 limit 전에 결합한다', async () => {
  const db=await database(true,createIsolatedTestDatabase),admin=new pg.Client({connectionString:db.url}),store=postgresStore({databaseUrl:db.appUrl});
  const file=randomUUID(), extraction=randomUUID(), source=randomUUID(), first=randomUUID(), second=randomUUID(), location=randomUUID();
  const locator=JSON.stringify({type:'pdf',page:1});
  try {
    await admin.connect();
    await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())',[file,'sha256:'+'d'.repeat(64)]);
    await admin.query("insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ($1,$2,'local','synthetic.pdf','brain',now())",[location,file]);
    await admin.query("insert into brain.file_names(id,file_id,name_source,text) values ($1,$2,'attachment_name','특별 이름.pdf')",[randomUUID(),file]);
    await admin.query("insert into brain.file_names(id,file_id,name_source,text) values ($1,$2,'attachment_name','두번째 별칭.pdf'),($3,$2,'location_path','~/사라진경로.pdf')",[randomUUID(),file,randomUUID()]);
    await admin.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ($1,$2,'test',1,'ok',now(),now())",[extraction,file]);
    await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,page,body,chunk_locator) values ($1,$2,0,1,$3,$4)',[randomUUID(),extraction,'특별 본문',locator]);
    await admin.query('update brain.files set current_extraction_id=$1 where id=$2',[extraction,file]);
    await admin.query("insert into brain.sources(id,kind,account,root_id,generation) values ($1,'drive','fixture','root',1)",[source]);
    await admin.query("insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,file_id,index_status,unreachable,unreachable_at) values ($1,$3,'remote-a','특별.pdf','폴더','application/pdf','1',$4,'indexed',false,null),($2,$3,'remote-b','다른.pdf','폴더','application/pdf','1',$4,'indexed',true,now())",[first,second,source,file]);
    const result=await store.searchDocuments({query:'특별',pattern:'%특별%',limit:2});
    expect(result.ok).toBe(true); if (!result.ok) throw Error('search failed');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.names).toEqual(['두번째 별칭.pdf','특별 이름.pdf']);
    const alias=await store.searchDocuments({query:'두번째',pattern:'%두번째%',limit:2});expect(alias).toMatchObject({ok:true,rows:[{file_id:file,names:['두번째 별칭.pdf','특별 이름.pdf']}]});
    const forbidden=await store.searchDocuments({query:'사라진경로',pattern:'%사라진경로%',limit:2});expect(forbidden).toMatchObject({ok:true,rows:[]});
    expect(result.rows[0]).toMatchObject({file_id:file,chunk_locator:locator,internal_origins:expect.arrayContaining([{kind:'location',location_id:location,store_kind:'local',locator:'synthetic.pdf',ownership:'brain',display_name:'두번째 별칭.pdf',source_unreachable:false},expect.objectContaining({kind:'drive',source_file_id:first,source_unreachable:false}),expect.objectContaining({kind:'drive',source_file_id:second,source_unreachable:true})])});
    expect(result.contexts).toHaveLength(1);
    const published=await searchDocuments(store,{query:'특별',limit:1},undefined,async()=>({ok:true,url:'file:///synthetic.pdf'}));
    expect(published).toMatchObject({ok:true,data:[{file_id:file,origins:expect.arrayContaining([expect.objectContaining({kind:'location',source_url:'file:///synthetic.pdf'}),expect.objectContaining({kind:'drive',source_file_id:first,source_url:'https://drive.google.com/file/d/remote-a/view'}),expect.objectContaining({kind:'drive',source_file_id:second,source_url:'https://drive.google.com/file/d/remote-b/view',source_unreachable:true})])}],meta:{has_more:false}});
    expect(JSON.stringify(published)).not.toContain('internal_origins');expect(JSON.stringify(published)).not.toContain('source_remote_id');
    const secondPage=JSON.stringify({type:'pdf',page:2});await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,page,body,chunk_locator) values ($1,$2,1,2,$3,$4)',[randomUUID(),extraction,'특별 둘째 쪽',secondPage]);
    const limited=await searchDocuments(store,{query:'특별',limit:1},undefined,async()=>({ok:true,url:'file:///synthetic.pdf'}));expect(limited).toMatchObject({ok:true,meta:{has_more:true},data:[{file_id:file}]});
    const both=await searchDocuments(store,{query:'특별',limit:2},undefined,async()=>({ok:true,url:'file:///synthetic.pdf'}));expect(both.ok&&new Set(both.data.map(r=>r.chunk_locator))).toEqual(new Set([locator,secondPage]));
    const name=await store.searchDocuments({query:'이름',pattern:'%이름%',limit:2});
    expect(name.ok && name.rows).toMatchObject([{file_id:file,chunk_locator:null,file_status:'ok'}]);
    await admin.query('begin');await admin.query("set local brain.redacting='on'");await admin.query('update brain.files set redacted_at=now() where id=$1',[file]);await admin.query('commit');
    const hidden=await store.searchDocuments({query:'특별',pattern:'%특별%',limit:2});
    expect(hidden.ok && hidden.rows).toEqual([]);
  } finally { await store.close(); await admin.end(); await db.drop(); }
});

it('일곱 리터럴 질의가 본문 첨부명 source 이름과 경로의 전수 LIKE oracle과 같다',async()=>{
  const db=await database(true,createIsolatedTestDatabase),admin=new pg.Client({connectionString:db.url}),store=postgresStore({databaseUrl:db.appUrl}),source=randomUUID();
  const queries=['공백 질의','a-b','AND','"따옴표"','%','_','\\'];
  try {
    await admin.connect();
    await admin.query("insert into brain.sources(id,kind,account,root_id,generation) values ($1,'drive','literal-oracle','root',1)",[source]);
    for(let i=0;i<queries.length;i++) {
      const query=queries[i]!,bodyFile=randomUUID(),nameFile=randomUUID(),extraction=randomUUID(),sourceName=randomUUID(),sourcePath=randomUUID(),externalFile=randomUUID(),linkedFile=randomUUID(),linkedExtraction=randomUUID(),linkedNameFile=randomUUID(),linkedPathFile=randomUUID();
      for(const [file,hash] of [[bodyFile,(i*2+20).toString(16)],[nameFile,(i*2+21).toString(16)],[externalFile,(i+60).toString(16)],[linkedFile,(i+80).toString(16)],[linkedNameFile,(i+100).toString(16)],[linkedPathFile,(i+120).toString(16)]] as const) await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())',[file,`sha256:${hash.padStart(64,'0')}`]);
      await admin.query("insert into brain.file_names(id,file_id,name_source,text) values ($1,$2,'attachment_name',$3),($4,$5,'attachment_name',$6)",[randomUUID(),bodyFile,`본문파일${i}`,randomUUID(),nameFile,`이름 ${query}`]);
      await admin.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ($1,$2,'oracle',1,'ok',now(),now())",[extraction,bodyFile]);
      const body=`본문 ${query}`,locator=JSON.stringify({type:'text',start:0,end:Array.from(body).length});
      await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ($1,$2,0,$3,$4)',[randomUUID(),extraction,body,locator]);
      await admin.query('update brain.files set current_extraction_id=$1 where id=$2',[extraction,bodyFile]);
      const body2=`다른 ${query}`,locator2=JSON.stringify({type:'text',start:100,end:100+Array.from(body2).length});
      await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ($1,$2,1,$3,$4)',[randomUUID(),extraction,body2,locator2]);
      const path=`~/외부 ${query}`;
      await admin.query("insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ($1,$2,'local',$3,'external',now())",[randomUUID(),externalFile,path]);
      await admin.query("insert into brain.file_names(id,file_id,name_source,text) values ($1,$2,'location_path',$3)",[randomUUID(),externalFile,path]);
      await admin.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ($1,$2,'oracle',1,'ok',now(),now())",[linkedExtraction,linkedFile]);
      await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ($1,$2,0,$3,$4)',[randomUUID(),linkedExtraction,body,locator]);
      await admin.query('update brain.files set current_extraction_id=$1 where id=$2',[linkedExtraction,linkedFile]);
      await admin.query("insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,file_id,index_status,unreachable) values ($1,$2,$3,$4,$5,'text/plain','1',$6,'indexed',false)",[randomUUID(),source,`linked${i}`,`연결 ${query}`,`연결경로 ${query}`,linkedFile]);
      for(const [file,remote,name,path] of [[linkedNameFile,`linked-name${i}`,`연결이름 ${query}`,'일반경로'],[linkedPathFile,`linked-path${i}`,'일반이름',`연결경로 ${query}`]] as const) await admin.query("insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,file_id,index_status,unreachable) values ($1,$2,$3,$4,$5,'text/plain','1',$6,'pending',false)",[randomUUID(),source,remote,name,path,file]);

      await admin.query("insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,index_status,unreachable) values ($1,$3,$4,$5,'일반','image/jpeg','1','photo',false),($2,$3,$6,'보통',$7,'image/jpeg','1','photo',false)",[sourceName,sourcePath,source,`name${i}`,`이름 ${query}`,`path${i}`,`경로 ${query}`]);
    }
    for(const query of queries) {
      const escaped='%'+query.replace(/[\\%_]/g,'\\$&')+'%';
      const oracle=await admin.query<{identity:string}>(`with hits as (
        select f.id, e.id as extraction_id, c.chunk_locator from brain.files f join brain.document_extractions e on e.id=f.current_extraction_id and e.status='ok' join brain.document_chunks c on c.extraction_id=e.id where lower(c.body) like lower($1) escape '\\'
      ), names as (
        select f.id from brain.files f where (exists(select 1 from brain.file_names n where n.file_id=f.id and lower(n.text) like lower($1) escape '\\') or exists(select 1 from brain.source_files sf where sf.file_id=f.id and (lower(sf.name) like lower($1) escape '\\' or lower(sf.path) like lower($1) escape '\\'))) and not exists(select 1 from hits h where h.id=f.id)
      ) select 'f:'||id::text||':'||extraction_id::text||':'||chunk_locator as identity from hits group by id,extraction_id,chunk_locator
      union all select 'f:'||id::text||':name' from names
      union all select 's:'||sf.id::text||':name' from brain.source_files sf where sf.file_id is null and (lower(sf.name) like lower($1) escape '\\' or lower(sf.path) like lower($1) escape '\\')`,[escaped]);
      const found=await searchDocuments(store,{query,limit:200});expect(found.ok,query).toBe(true);if(!found.ok)throw Error('search failed');
      const actual=found.data.map(r=>r.file_id ? (r.chunk_locator ? `f:${r.file_id}:${r.extraction_id}:${r.chunk_locator}` : `f:${r.file_id}:name`) : `s:${r.source_file_id}:name`).sort();
      expect(actual,query).toEqual(oracle.rows.map(r=>r.identity).sort());
    }
  } finally {await store.close();await admin.end();await db.drop();}
},30000);

it('동일 세대와 locator의 여러 일치 조각은 한 hit로 묶고 서로 다른 위치는 보존한다',async()=>{
  const db=await database(true,createIsolatedTestDatabase),admin=new pg.Client({connectionString:db.url}),store=postgresStore({databaseUrl:db.appUrl});
  const file=randomUUID(),extraction=randomUUID(),source=randomUUID(),sf=randomUUID(),one=JSON.stringify({type:'pdf',page:1}),two=JSON.stringify({type:'pdf',page:2});
  try {await admin.connect();
    await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())',[file,'sha256:'+'e'.repeat(64)]);
    await admin.query("insert into brain.sources(id,kind,account,root_id,generation) values ($1,'drive','grouped','root',1)",[source]);
    await admin.query("insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,file_id,index_status,unreachable) values ($1,$2,'valid','원격문서.pdf','','application/pdf','1',$3,'indexed',false)",[sf,source,file]);
    await admin.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ($1,$2,'test',1,'ok',now(),now())",[extraction,file]);
    for(const [ordinal,body,loc,page] of [[0,'공통 첫 조각',one,1],[1,'공통 둘째 조각',one,1],[2,'공통 다른 쪽',two,2]] as const)await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,page,body,chunk_locator) values ($1,$2,$3,$4,$5,$6)',[randomUUID(),extraction,ordinal,page,body,loc]);
    await admin.query('update brain.files set current_extraction_id=$1 where id=$2',[extraction,file]);
    const found=await searchDocuments(store,{query:'공통',limit:2});expect(found.ok).toBe(true);if(!found.ok)throw Error('search');
    expect(found.meta.has_more).toBe(false);expect(found.data).toHaveLength(2);
    const first=found.data.find(r=>r.chunk_locator===one);expect(first).toMatchObject({source:'drive',display_name:'원격문서.pdf'});expect(first?.body).toContain('공통 첫 조각');expect(first?.body).toContain('공통 둘째 조각');expect(found.data.some(r=>r.chunk_locator===two)).toBe(true);
    await admin.query("update brain.source_files set remote_id='bad/id' where id=$1",[sf]);
    const invalid=await store.searchDocuments({query:'공통',pattern:'%공통%',limit:10});expect(invalid).toMatchObject({ok:true,rows:[]});
    const orphanFile=randomUUID(),orphanExtraction=randomUUID();await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())',[orphanFile,'sha256:'+'f'.repeat(64)]);await admin.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ($1,$2,'test',1,'ok',now(),now())",[orphanExtraction,orphanFile]);await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,page,body,chunk_locator) values ($1,$2,0,1,$3,$4)',[randomUUID(),orphanExtraction,'공통 고아',one]);await admin.query('update brain.files set current_extraction_id=$1 where id=$2',[orphanExtraction,orphanFile]);
    const orphan=await store.searchDocuments({query:'공통',pattern:'%공통%',limit:10});expect(orphan).toMatchObject({ok:true,rows:[]});
  }finally{await store.close();await admin.end();await db.drop();}
},30000);

it('공개 불가 원본은 limit 전에 제외하고 정상 동반 원본과 고아 파일을 구별한다',async()=>{
 const db=await database(true,createIsolatedTestDatabase),admin=new pg.Client({connectionString:db.url}),store=postgresStore({databaseUrl:db.appUrl});
 const source=randomUUID(),mixed=randomUUID(),orphan=randomUUID(),generation=randomUUID(),orphanGeneration=randomUUID();
 const secret='sk-ABCDEFGHIJKLMNOPQRST',secret2='sk-ABCDEFGHIJKLMNOPQRSTUV',secret3='sk-ABCDEFGHIJKLMNOPQRSTUVWX';
 const body='공통 본문',locator=JSON.stringify({type:'text',start:0,end:Array.from(body).length});
 try{await admin.connect();
  await admin.query("insert into brain.sources(id,kind,account,root_id,generation) values ($1,'drive','safe-filter','root',1)",[source]);
  for(const [id,hash] of [[mixed,'a'],[orphan,'b']] as const)await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())',[id,'sha256:'+hash.repeat(64)]);
  for(const [id,file] of [[generation,mixed],[orphanGeneration,orphan]] as const){await admin.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ($1,$2,'safe',1,'ok',now(),now())",[id,file]);await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ($1,$2,0,$3,$4)',[randomUUID(),id,body,locator]);await admin.query('update brain.files set current_extraction_id=$1 where id=$2',[id,file]);}
  const bad='00000000-0000-4000-8000-000000000001',good='00000000-0000-4000-8000-000000000002';
  await admin.query("insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,file_id,index_status,unreachable) values ($1,$5,$6,'이름검색','경로','text/plain','1',null,'pending',false),($2,$5,'valid-only','이름검색','경로','text/plain','1',null,'pending',false),($3,$5,$7,'동반이름','경로','text/plain','1',$8,'indexed',false),($4,$5,$9,'고아이름','경로','text/plain','1',$10,'indexed',false)",[bad,good,randomUUID(),randomUUID(),source,secret,secret2,mixed,secret3,orphan]);
  const goodMixed=randomUUID();await admin.query("insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,file_id,index_status,unreachable) values ($1,$2,'valid-mixed','동반이름','경로','text/plain','1',$3,'indexed',false)",[goodMixed,source,mixed]);
  const names=await searchDocuments(store,{query:'이름검색',limit:1});expect(names).toMatchObject({ok:true,data:[{source_file_id:good}],meta:{has_more:false}});
  const mixedBody=await searchDocuments(store,{query:'공통',limit:1});expect(mixedBody).toMatchObject({ok:true,data:[{file_id:mixed,origins:[expect.objectContaining({source_file_id:goodMixed})]}],meta:{has_more:false}});
  const mixedName=await searchDocuments(store,{query:'동반이름',limit:1});expect(mixedName).toMatchObject({ok:true,data:[{file_id:mixed,source_file_id:goodMixed}]});
  expect(JSON.stringify([names,mixedBody,mixedName])).not.toContain('sk-ABCDEFGHIJKLMNOPQRST');
  await admin.query('delete from brain.source_files where id=$1',[goodMixed]);
  expect(await searchDocuments(store,{query:'공통'})).toMatchObject({ok:true,data:[]});
  expect(await searchDocuments(store,{query:'고아이름'})).toMatchObject({ok:true,data:[]});
  await admin.query("insert into brain.file_names(id,file_id,name_source,text) values ($1,$2,'attachment_name','보존 첨부')",[randomUUID(),orphan]);
  expect(await searchDocuments(store,{query:'공통'})).toMatchObject({ok:true,data:[{file_id:orphan,source:'attachment',origins:[]}]});
 }finally{await store.close();await admin.end();await db.drop();}
},30000);

it('source 적격성 읽기와 후보 조회는 같은 repeatable-read snapshot이며 실패를 전파한다',async()=>{
 const {Kysely,PostgresDialect}=await import('kysely');
 const {postgresRecallStore}=await import('../src/recall.js');
 const db=await database(true,createIsolatedTestDatabase),admin=new pg.Client({connectionString:db.url}),pool=new pg.Pool({connectionString:db.appUrl,max:1});
 const source=randomUUID(),entry=randomUUID();let calls=0,changed=false,fail=false;
 const sqlDb=new Kysely<Record<string,never>>({dialect:new PostgresDialect({pool}),plugins:[{
  transformQuery(args){return args.node;},
  async transformResult(args){
   calls++;
   if(calls===2){if(fail)throw Object.assign(new Error('synthetic selection failure'),{code:'08006'});await admin.query("update brain.source_files set remote_id='sk-ABCDEFGHIJKLMNOPQRST',name='바뀐이름' where id=$1",[entry]);changed=true;}
   return args.result;
  },
 }]});
 const store=postgresRecallStore(()=>({ok:true,connection:{db:sqlDb}}));
 try{await admin.connect();await admin.query("insert into brain.sources(id,kind,account,root_id,generation) values ($1,'drive','snapshot','root',1)",[source]);await admin.query("insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,index_status,unreachable) values ($1,$2,'valid-id','원래이름','경로','image/jpeg','1','photo',false)",[entry,source]);
  const found=await searchDocuments(store,{query:'원래이름'});expect(changed).toBe(true);expect(found).toMatchObject({ok:true,data:[{source_file_id:entry,display_name:'원래이름',source_url:'https://drive.google.com/file/d/valid-id/view'}]});
  calls=0;fail=true;expect(await store.searchDocuments({query:'원래이름',pattern:'%원래이름%',limit:2})).toMatchObject({ok:false,code:'DB_UNAVAILABLE'});
 }finally{await sqlDb.destroy();await admin.end();await db.drop();}
},30000);
