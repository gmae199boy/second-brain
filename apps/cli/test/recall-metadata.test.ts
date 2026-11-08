import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { documentReportFixture } from './document-report-fixture.js';
import { runPgCommand } from './pg-home.js';
import pg from 'pg';
import { CONVERSATION_CHUNK_INDEX_CONFIG_ID } from 'second_brain';
import { sampleEnsureSessionInput, sampleIngestBatch } from 'second_brain/testing';

it('CLI와 MCP는 비활성 확장의 보존 리포트를 찾고 출처 원문 및 빈 결과를 구별한다', async () => {
  const fixture=await documentReportFixture(); const {f,admin,name,store,sdk}=fixture;
  try {
    const request=await fixture.request('synthetic.md','report',Buffer.from('수면 합성 리포트 원문 --help -h')); await fixture.importAndExtract();
    const file=(await admin.query('select file_id from brain.file_request_results where request_id=$1',[request])).rows[0].file_id;
    const session=sampleEnsureSessionInput(); expect((await store.ensureSession(session)).ok).toBe(true);
    const batch=sampleIngestBatch(), messageId='00000000-0000-4000-8000-000000000101', noteId='00000000-0000-4000-8000-000000000102', chunkId='00000000-0000-4000-8000-000000000103';
    const at=new Date('2026-01-02T04:00:00.000Z'), text='합성 --help -h 검색';
    batch.messages=[{...batch.messages[0]!,id:messageId,harnessMessageId:'literal-options',body:text,occurredAt:at}];
    batch.toolNotes=[{...batch.toolNotes[0]!,id:noteId,harnessMessageId:'literal-options',target:text}]; batch.attachments=[];
    expect((await store.ingest(batch)).ok).toBe(true);
    await admin.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) values ($1,$2,$3,$4,$4,0,$5)',[chunkId,session.id,CONVERSATION_CHUNK_INDEX_CONFIG_ID,at,text]);
    await admin.query('update brain.extensions set enabled=false where name=$1',[name]);
    const search=await f.runDirect(['recall','docs','수면','--source',`${name},missing`,'--json']);
    expect(search.body).toMatchObject({ok:true,data:[{file_id:file,source:name}],meta:{extensions:[{source:'missing',installed:false,enabled:null,searchable:null},{source:name,installed:true,enabled:false,searchable:true}]}});
    const source=search.body.data[0];
    const read=await f.runDirect(['files','show',source.file_id,'--chunk-locator',source.chunk_locator,'--extraction-id',source.extraction_id,'--json']);
    expect(read.body.ok).toBe(true); expect(read.body.data.map((r:{body:string})=>r.body).join('')).toContain('수면 합성 리포트 원문');
    const empty=await f.runDirect(['recall','docs','없는합성어','--source',name,'--json']);
    expect(empty.body).toMatchObject({ok:true,data:[],meta:{hint:expect.any(String),extensions:[{source:name,enabled:false}]}});
    const holder=new pg.Client({connectionString:f.db.url});
    try {
      await holder.connect(); await holder.query('begin'); await holder.query('lock table brain.document_chunks in access exclusive mode');
      const locked=await f.runDirect(['recall','docs','수면','--source',name,'--json']);
      expect(locked.body).toMatchObject({ok:false,error:{code:'SEARCH_FAILED'}});
    } finally { await holder.query('rollback').catch(()=>{}); await holder.end(); }
    const absent=await runPgCommand(['recall','docs','수면','--json'],{...f.env,BRAIN_DATABASE_URL:'postgresql://brain_app:invalid@127.0.0.1:1/unavailable'});
    expect(JSON.parse(absent.stdout)).toMatchObject({ok:false,error:{code:'DB_UNAVAILABLE'}});
    const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/bin.js',import.meta.url)),'mcp','serve'],{env:f.env,stdio:['pipe','pipe','pipe']});
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    try {
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');
      const listed=JSON.parse((await lines.next()).value!);
      for (const verb of ['chunks','tools','docs']) expect(listed.result.tools.some((tool:{name:string})=>tool.name===`recall_${verb}`)).toBe(true);
      for (const query of ['--help','-h']) for (const verb of ['chunks','tools','docs'] as const) {
        const expectedId=verb==='chunks'?chunkId:verb==='tools'?noteId:file;
        const sdkResult=await sdk.recall[verb]({query,sources:[name]});
        expect(sdkResult.ok).toBe(true); if (!sdkResult.ok) throw Error(sdkResult.message);
        const resultId=(row:{chunk_id?:string;tool_note_id?:string;file_id?:string|null})=>row.chunk_id ?? row.tool_note_id ?? row.file_id ?? undefined;
        expect(sdkResult.data.map(resultId)).toEqual([expectedId]);
        const cli=await f.runDirect(['recall',verb,'--source',name,'--json','--',query]);
        expect(cli.body.ok).toBe(true); expect(cli.body.data.map(resultId)).toEqual([expectedId]);
        child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:`recall_${verb}`,arguments:{query,source:name}}})+'\n');
        const mcp=JSON.parse(JSON.parse((await lines.next()).value!).result.content[0].text);
        expect(mcp.ok).toBe(true); expect(mcp.data.map(resultId)).toEqual([expectedId]);
        expect(mcp.data).toEqual(cli.body.data); expect(mcp.data).toEqual(sdkResult.data);
        expect(mcp.meta.extensions).toEqual(cli.body.meta.extensions); expect(mcp.meta.extensions).toEqual(expect.arrayContaining([expect.objectContaining({source:name,installed:true,enabled:false,searchable:true})]));
      }
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'recall_docs',arguments:{query:'수면',source:`${name},missing`}}})+'\n');
      const reply=JSON.parse((await lines.next()).value!); const mcp=JSON.parse(reply.result.content[0].text);
      expect(mcp.data).toEqual(search.body.data); expect(mcp.meta.extensions).toEqual(search.body.meta.extensions);
    } finally { child.stdin.end(); await new Promise(resolve=>child.once('close',resolve)); }
  } finally { await fixture.close(); }
},120000);
