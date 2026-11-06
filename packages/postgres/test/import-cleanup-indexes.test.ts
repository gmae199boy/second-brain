import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { postgresStore } from '../src/index.js';
import { database } from './fixture.js';

it('인덱스와 정리 후보 순서, 공유 위치 보호 및 500개 제한을 지킨다', async () => {
 const db=await database(), client=new pg.Client({connectionString:db.url}), store=postgresStore({databaseUrl:db.appUrl});
 try {
  await client.connect();
  const indexes=await client.query("select indexname,indexdef from pg_indexes where schemaname='brain' and indexname = any($1::text[]) order by indexname",[['file_requests_source_locator_idx','file_import_cleanup_open_idx']]);
  expect(indexes.rows).toEqual([
   {indexname:'file_import_cleanup_open_idx',indexdef:'CREATE INDEX file_import_cleanup_open_idx ON brain.file_import_cleanup USING btree (request_id) WHERE (cleaned_at IS NULL)'},
   {indexname:'file_requests_source_locator_idx',indexdef:'CREATE INDEX file_requests_source_locator_idx ON brain.file_requests USING btree (source, locator)'},
  ]);
  await client.query(`set session_replication_role=replica;
   insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at) values('00000000-0000-0000-0000-000000000001','synthetic','core','synthetic','synthetic',now(),now());
   insert into brain.files(id,content_hash,size_bytes,first_seen_at) select md5(i::text)::uuid,'sha256:'||repeat(md5(i::text),2),1,now() from generate_series(1,501)i;
   insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) select md5(i::text)::uuid,'synthetic',i::text,'d','b','path/'||i,repeat('a',64),1,'text/plain',now(),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001' from generate_series(1,501)i;
   insert into brain.file_request_results(request_id,file_id,finished_at) select id,id,now() from brain.file_requests;
   insert into brain.file_import_cleanup(request_id,cleaned_at) select id,now() from brain.file_requests;
   set session_replication_role=origin;`);
  expect(await store.imports.listImportCleanups()).toEqual({ok:true,ids:[]});
  await client.query('update brain.file_import_cleanup set cleaned_at=null where request_id in (select id from brain.file_requests order by id limit 3)');
  const first=(await client.query('select id from brain.file_requests order by id limit 3')).rows.map(row=>row.id);
  expect(await store.imports.listImportCleanups()).toEqual({ok:true,ids:first});
  await client.query('set session_replication_role=replica');
  await client.query("update brain.file_requests set locator='shared' where id=any($1::uuid[])",[first]);
  await client.query("update brain.file_request_results set file_id=null,error_code='FAILED' where request_id=$1",[first[0]]);
  await client.query('set session_replication_role=origin');
  expect(await store.imports.listImportCleanups()).toEqual({ok:true,ids:[]});
  const remove=vi.fn(); expect(await store.imports.cleanupImport({requestId:first[1],now:new Date(),remove})).toEqual({ok:true,cleaned:false}); expect(remove).not.toHaveBeenCalled();
  // 결과 행이 없는 공유 요청도 같은 출처의 다른 후보를 차단한다.
  await client.query('set session_replication_role=replica');
  await client.query('delete from brain.file_request_results where request_id=$1',[first[0]]);
  await client.query('set session_replication_role=origin');
  expect(await store.imports.listImportCleanups()).toEqual({ok:true,ids:[]});
  expect(await store.imports.cleanupImport({requestId:first[1],now:new Date(),remove})).toEqual({ok:true,cleaned:false}); expect(remove).not.toHaveBeenCalled();
  // locator가 같아도 다른 출처의 미완료 요청은 차단하지 않는다.
  await client.query('set session_replication_role=replica');
  await client.query("update brain.file_requests set source='other' where id=$1",[first[0]]);
  await client.query('set session_replication_role=origin');
  expect(await store.imports.listImportCleanups()).toEqual({ok:true,ids:first.slice(1)});
  // 같은 출처로 되돌린 뒤 완료하면 나머지 후보가 다시 나타나고 삭제된다.
  await client.query('set session_replication_role=replica');
  await client.query("update brain.file_requests set source='synthetic' where id=$1",[first[0]]);
  await client.query('insert into brain.file_request_results(request_id,file_id,finished_at) values($1,$1,now())',[first[0]]);
  await client.query('set session_replication_role=origin');
  expect(await store.imports.listImportCleanups()).toEqual({ok:true,ids:first});
  expect(await store.imports.cleanupImport({requestId:first[1],now:new Date(),remove})).toEqual({ok:true,cleaned:true});
  expect(remove).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith('synthetic','shared');
  expect(await store.imports.listImportCleanups()).toEqual({ok:true,ids:[]});
  await client.query(`set session_replication_role=replica; update brain.file_requests set locator='path/'||request_key; update brain.file_request_results set file_id=request_id,error_code=null; update brain.file_import_cleanup set cleaned_at=null; set session_replication_role=origin`);
  const ids=(await client.query('select id from brain.file_requests order by id limit 500')).rows.map(row=>row.id);
  expect(await store.imports.listImportCleanups()).toEqual({ok:true,ids});
 } finally { await store.close(); await client.end(); await db.drop(); }
},30000);
