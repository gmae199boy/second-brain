import {expect,it} from 'vitest';
import {searchDocuments,showDocument,type SourceEntry} from '../src/index.js';
import {memoryStore} from '../src/testing/index.js';
const source:SourceEntry={id:'019a0000-0000-7000-8000-000000000101',sourceId:'019a0000-0000-7000-8000-000000000102',remoteId:'synthetic-remote',name:'사진 한강.jpg',path:'여행/서울',mimeType:'image/jpeg',remoteVersion:'1',sizeBytes:12,fileId:null,indexStatus:'photo',unreachable:false,unreachableAt:null,completedVersion:null,completedHash:null,seenScan:null};
it('name-only source is searchable and show returns status and link without invented IDs',async()=>{const store=memoryStore({sourceEntries:[source]});const found=await searchDocuments(store,{query:'한강'});expect(found).toMatchObject({ok:true,data:[{file_id:null,source_file_id:source.id,chunk_locator:null,extraction_id:null,index_status:'photo',source_url:'https://drive.google.com/file/d/synthetic-remote/view'}]});const shown=await showDocument(store,{source_file_id:source.id});expect(shown).toMatchObject({ok:true,data:[],meta:{source_file:{source_file_id:source.id,file_id:null,index_status:'photo',source_url:'https://drive.google.com/file/d/synthetic-remote/view'}}});expect(JSON.stringify(shown)).not.toContain('chunk_locator');});
it('source warning is per source and output masks names and path secrets',async()=>{const hidden={...source,name:'password=secretvalue 사진',path:'token=supersecret',remoteVersion:'password=secretversion',unreachable:true,unreachableAt:new Date()};const store=memoryStore({sourceEntries:[hidden]});const found=await searchDocuments(store,{query:'사진'});expect(found).toMatchObject({ok:true,data:[{source_unreachable:true,warning:'FILE_SOURCE_UNREACHABLE'}]});expect(JSON.stringify(found)).not.toContain('secretvalue');expect(JSON.stringify(found)).not.toContain('secretversion');const shown=await showDocument(store,{source_file_id:hidden.id});expect(shown).toMatchObject({ok:true,meta:{source_unreachable:true}});expect(JSON.stringify(shown)).not.toContain('supersecret');expect(JSON.stringify(shown)).not.toContain('secretvalue');});
it('invalid remote identifiers and mismatched file identities cannot produce a link',async()=>{const store=memoryStore({sourceEntries:[{...source,remoteId:'bad/id'}]});expect(await showDocument(store,{source_file_id:source.id})).toMatchObject({ok:false});expect(await searchDocuments(store,{query:'한강'})).toMatchObject({ok:true,data:[]});const good=memoryStore({sourceEntries:[source]});expect(await showDocument(good,{source_file_id:source.id,file_id:'invented',chunk_locator:'{}'})).toMatchObject({ok:false});});
it('source body show continuation keeps source identity and its own access warning',async()=>{
  const text='한강 두글자 '.repeat(2000),loc=JSON.stringify({type:'text',start:0,end:Array.from(text).length});
  const store:import('../src/index.js').DocumentRecallStore={async searchDocuments(){return {ok:true,rows:[],contexts:[]};},async readDocument(){return {ok:true,snapshot:{redacted:false,source_unreachable:false,extraction_id:'generation',status:'ok',pieces:[{ordinal:0,chunk_locator:loc,body:text}]}};},async readSourceDocument(){return {ok:true,source:{source_file_id:source.id,file_id:'file-1',display_name:source.name,source_path:source.path,source_remote_id:source.remoteId,source:'drive',index_status:'indexed',source_unreachable:true,current_version:'2',completed_version:'1',stale:true}};}};
  const first=await showDocument(store,{source_file_id:source.id,file_id:'file-1',chunk_locator:loc,before:0,after:0});expect(first.ok).toBe(true);if(!first.ok||!first.meta.next)throw Error('next missing');expect(first.meta).toMatchObject({source_unreachable:true,source_file:{source_file_id:source.id,current_version:'2',completed_version:'1',stale:true},next:{args:{source_file_id:source.id}}});
  const args=first.meta.next.args;const second=await showDocument(store,{source_file_id:String(args.source_file_id),file_id:String(args.file_id),chunk_locator:String(args.chunk_locator),extraction_id:String(args.extraction_id),before:0,after:0,offset:Number(args.offset),fingerprint:String(args.fingerprint)});expect(second.ok).toBe(true);if(second.ok)expect(second.meta).toMatchObject({source_unreachable:true,source_file:{current_version:'2',completed_version:'1',stale:true}});
});
it('저장소는 내용 없는 서로 다른 source 정체성을 합치지 않고 상태를 보존한다',async()=>{
  const other={...source,id:'019a0000-0000-7000-8000-000000000103',remoteId:'other',name:'사진 두번째',indexStatus:'too_large' as const,unreachable:true,unreachableAt:new Date()};
  const store=memoryStore({sourceEntries:[source,other]});
  const result=await store.searchDocuments({query:'사진',pattern:'%사진%',limit:5});
  expect(result.ok).toBe(true);if(!result.ok)throw Error('search failed');
  expect(result.rows).toHaveLength(2);
  expect(result.rows.map(r=>r.source_file_id)).toEqual([source.id,other.id]);
  expect(result.rows[1]?.internal_origins).toMatchObject([{kind:'drive',source_file_id:other.id,index_status:'too_large',source_unreachable:true}]);
});
it('memoryStore 일곱 리터럴 이름과 경로를 독립 부분문자열 oracle과 비교한다',async()=>{
 const queries=['공백 질의','a-b','AND','"따옴표"','%','_','\\'];
 const entries=queries.flatMap((query,i)=>[
  {...source,id:`name-${i}`,remoteId:`name-${i}`,name:`이름 ${query}`,path:'일반'},
  {...source,id:`path-${i}`,remoteId:`path-${i}`,name:'일반',path:`경로 ${query}`},
 ]);
 const store=memoryStore({sourceEntries:entries});
 for(const query of queries){
  const expected=entries.filter(e=>[e.name,e.path].some(v=>v.toLowerCase().includes(query.toLowerCase()))).map(e=>e.id).sort();
  const result=await searchDocuments(store,{query,limit:200});expect(result.ok).toBe(true);if(!result.ok)throw Error('search');
  expect(result.data.map(r=>r.source_file_id).sort()).toEqual(expected);
 }
});

it('비공개 패턴 원본과 고아 원본은 limit 이전에 제외한다',async()=>{
 const secret='sk-ABCDEFGHIJKLMNOPQRST',store=memoryStore({sourceEntries:[
  {...source,id:'a-hidden',remoteId:secret,name:'공통'},
  {...source,id:'b-orphan',remoteId:'valid-orphan',name:'공통',fileId:'missing-file'},
  {...source,id:'c-valid',remoteId:'valid-id',name:'공통'},
 ]});
 const found=await searchDocuments(store,{query:'공통',limit:1});
 expect(found).toMatchObject({ok:true,data:[{file_id:null,source_file_id:'c-valid'}],meta:{has_more:false}});
 expect(JSON.stringify(found)).not.toContain(secret);
 const empty=await searchDocuments(memoryStore({sourceEntries:[{...source,remoteId:secret}]}),{query:'사진'});expect(empty).toMatchObject({ok:true,data:[]});
});
