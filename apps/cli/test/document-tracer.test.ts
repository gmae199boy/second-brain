import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { expect, it } from 'vitest';
import { maskOutputText, drainQueue, documentExtractHandler, DOCUMENT_EXTRACT_KIND } from 'second_brain';
import { postgresStore } from 'second_brain/postgres';
import { documentReportFixture } from './document-report-fixture.js';

type Next = { ns:string; verb:string; args: Record<string, unknown> };
function nextArgv(next: Next): string[] {
  const args = next.args;
  return [next.ns,next.verb,String(args.file_id),'--chunk-locator',String(args.chunk_locator),
    ...Object.entries(args).filter(([key,value]) => !['file_id','chunk_locator'].includes(key) && value !== undefined && value !== null).flatMap(([key,value]) => [`--${key.replaceAll('_','-')}`,String(value)]), '--json'];
}
// Parse only the already shell-quoted command produced from this synthetic fixture.
function textArgv(line: string): string[] {
  const bytes = execFileSync('/bin/sh', ['-c', `set -- ${line.slice('다음: '.length)}; printf '%s\\0' "$@"`]);
  const words = bytes.toString('utf8').split('\0').filter(Boolean);
  expect(words.shift()).toBe('brain'); return words;
}

it('확장 요청에서 리포트 추출, 출처 검색, SDK와 CLI 원문·다음 호출까지 연결한다', async () => {
  const fixture = await documentReportFixture();
  const { f,store,admin,name,ids,clock,spool,files,sdk } = fixture;
  try {
    const report=Buffer.from('검색 합성 리포트 password=privatefixture\n' + '가나다라마바사😀'.repeat(3000) + '\n끝');
    const graph=Buffer.from('검색 일반 파일');
    const requestId=await fixture.request('report.md','report',report); await fixture.request('graph.md','graph',graph);
    const { imported, extracted } = await fixture.importAndExtract();
    expect(imported.completed).toBe(2); expect(extracted.completed).toBe(2);
    const registered=(await admin.query('select file_id from brain.file_request_results where request_id=$1',[requestId])).rows[0]; expect(registered?.file_id).toBeTruthy();
    const sdkFound=await sdk.recall.docs({query:'검색'}); expect(sdkFound.ok).toBe(true); if (!sdkFound.ok) throw Error('SDK 검색 실패');
    expect(sdkFound.data).toHaveLength(1); const source=sdkFound.data[0]!;
    expect(source).toMatchObject({kind:'document',file_id:registered.file_id,source:name,report_date:'2026-01-02'});
    const output=await f.runDirect(['recall','docs','검색','--json']); expect(output.code).toBe(0);
    expect(output.body.data).toEqual(sdkFound.data); expect(output.stdout).not.toContain('privatefixture');
    const text=await f.runDirect(['recall','docs','검색']); expect(text.code).toBe(0); expect(text.stdout).toContain(source.file_id); expect(text.stdout).not.toContain('privatefixture');
    const sdkRead=await sdk.files.show({file_id:source.file_id,chunk_locator:source.chunk_locator,extraction_id:source.extraction_id,before:0,after:100});
    expect(sdkRead.ok).toBe(true); if (!sdkRead.ok || !sdkRead.meta.next) throw Error('이어 읽기 없음');
    const first=await f.runDirect(['files','show',source.file_id,'--chunk-locator',source.chunk_locator,'--extraction-id',source.extraction_id,'--before','0','--after','100','--json']);
    expect(first.code).toBe(0); expect(first.body.data).toEqual(sdkRead.data); expect(first.stdout).not.toContain('privatefixture');
    let page=first.body; let collected=''; let count=0; let previous=-1;
    while (true) {
      expect(++count).toBeLessThan(30); collected+=page.data.map((r:{body:string})=>r.body).join('');
      if (!page.meta.next) break;
      expect(page.meta.next.args.offset).toBeGreaterThan(previous); previous=page.meta.next.args.offset;
      const next=await f.runDirect(nextArgv(page.meta.next)); expect(next.code).toBe(0); page=next.body;
    }
    expect(count).toBeGreaterThan(1); expect(collected).toEqual(maskOutputText(report.toString('utf8'))); expect(collected).not.toContain('privatefixture');
    const firstText=await f.runDirect(['files','show',source.file_id,'--chunk-locator',source.chunk_locator,'--extraction-id',source.extraction_id,'--before','0','--after','100']);
    const nextLine=firstText.stdout.split('\n').find(line=>line.startsWith('다음: ')); expect(nextLine).toBeTruthy();
    const parsedTextNext=textArgv(nextLine!);
    const secondText=await f.runDirect(parsedTextNext); expect(secondText.code).toBe(0); expect(secondText.stdout).toContain('본문 '); expect(secondText.stdout).not.toEqual(firstText.stdout);
    const secondJson=await f.runDirect([...parsedTextNext,'--json']); expect(secondJson.code).toBe(0); expect(secondText.stdout).toContain(secondJson.body.data[0].body);
    const empty=await f.runDirect(['recall','docs','없는질의','--json']); expect(empty.body).toMatchObject({ok:true,data:[],meta:{hint:expect.any(String)}});
    const originalFirst=first.body.meta.next as Next;
    await admin.query("update brain.document_chunks set body=overlay(body placing '변' from 1 for 1) where extraction_id=$1 and ordinal=0",[source.extraction_id]);
    const contentChanged=await f.runDirect(nextArgv(originalFirst));
    expect(contentChanged.body).toMatchObject({ok:true,meta:{generation_changed:false,hint:expect.any(String)}});
    expect(contentChanged.body.data[0].body.startsWith('변색 합성 리포트')).toBe(true);
    await admin.query("update brain.document_chunks set body=overlay(body placing '검' from 1 for 1) where extraction_id=$1 and ordinal=0",[source.extraction_id]);
    const holder = new pg.Client({connectionString:f.db.url});
    const lockedStore = postgresStore({databaseUrl:f.db.appUrl,lockTimeoutMs:100,queryTimeoutMs:2000});
    try {
      await holder.connect(); await holder.query('begin'); await holder.query('lock table brain.document_chunks in access exclusive mode');
      expect(await lockedStore.searchDocuments({query:'검색',pattern:'%검색%',limit:6})).toMatchObject({ok:false,code:'SEARCH_FAILED'});
    } finally { await holder.query('rollback').catch(()=>{}); await holder.end(); await lockedStore.close(); }
    const unreachable = postgresStore({databaseUrl:'postgresql://brain_app:invalid@127.0.0.1:1/unavailable',connectTimeoutMs:200});
    try { expect(await unreachable.searchDocuments({query:'검색',pattern:'%검색%',limit:6})).toMatchObject({ok:false,code:'DB_UNAVAILABLE'}); } finally { await unreachable.close(); }
    await admin.query('update brain.files set source_unreachable_at=now() where id=$1',[source.file_id]);
    expect((await f.runDirect(['files','show',source.file_id,'--chunk-locator',source.chunk_locator,'--json'])).body.meta.source_unreachable).toBe(true);
    await admin.query('update brain.files set source_unreachable_at=null where id=$1',[source.file_id]);
    for (const status of ['unsupported','failed','too_large'] as const) {
      const file=ids.next(), generation=ids.next();
      await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())',[file,`sha256:${createHash('sha256').update(status).digest('hex')}`]);
      await admin.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at,failed_stage) values ($1,$2,'fixture',1,$3,now(),now(),$4)",[generation,file,status,status === 'failed' ? 'read' : null]);
      const failed=await f.runDirect(['files','show',file,'--chunk-locator',source.chunk_locator,'--json']); expect(failed.body).toMatchObject({ok:false,data:{status}});
    }
    const newWork=ids.next(), later=clock.now();
    expect(await store.addWork({id:newWork,kind:DOCUMENT_EXTRACT_KIND,targetKind:'file',targetId:source.file_id,createdAt:later,nextAttemptAt:later})).toMatchObject({ok:true});
    await drainQueue({store,clock,idGen:ids,spool},{budgetMs:5000,handlers:{[DOCUMENT_EXTRACT_KIND]:documentExtractHandler({store,files,clock,idGen:ids,extractorVersion:'fixture-next'})}});
    const restarted=await f.runDirect(nextArgv(originalFirst)); expect(restarted.code).toBe(0); expect(restarted.body.meta).toMatchObject({generation_changed:true,hint:expect.any(String)});
    expect(first.body.data[0].body.startsWith(restarted.body.data[0].body.slice(0,200))).toBe(true);
    const masked=await f.runDirect(['files','redact',source.file_id,'--yes','--json']); expect(masked.code).toBe(0);
    const after=await f.runDirect(['files','show',source.file_id,'--chunk-locator',source.chunk_locator,'--json']); expect(after.body).toMatchObject({ok:false,data:{status:'redacted'}}); expect(after.stdout).not.toContain('privatefixture');
    expect((await f.runDirect(['recall','docs','검색','--json'])).body.data).toEqual([]);
  } finally { await fixture.close(); }
}, 120000);

it('실제 docs와 show의 JSON 및 text 출력과 설정 경고는 최종 8000자 안에 든다', async () => {
  const {readFile,writeFile} = await import('node:fs/promises');
  const {join} = await import('node:path');
  const fixture=await documentReportFixture(); const {f}=fixture;
  try {
    const report=Buffer.from('검색 password=privatefixture\n'+'검색 긴 본문 😀'.repeat(4000));
    await fixture.request('large.md','report',report); await fixture.importAndExtract();
    const found=await f.runDirect(['recall','docs','검색','--json']);
    expect(found.code).toBe(0); const source=found.body.data[0]; expect(source).toBeTruthy();
    const commands=[['recall','docs','검색'],['files','show',source.file_id,'--chunk-locator',source.chunk_locator,'--before','0','--after','100']];
    for (const args of commands) for (const flags of [['--json'],[]]) {
      const output=await f.runDirect([...args,...flags]);
      expect(output.code).toBe(0);
      expect(Array.from(output.stdout+output.stderr).length).toBeLessThanOrEqual(8000);
      expect(output.stdout).not.toContain('privatefixture');
      if (flags.length && args[0] === 'files') expect(output.body.warnings).toContain('RESULT_TRUNCATED');
    }
    const configPath=join(f.home,'config.toml'), original=await readFile(configPath,'utf8');
    try {
      for (const extra of ['unknown_fixture = 1',`unknown_${'x'.repeat(9000)} = 1`]) {
        await writeFile(configPath,`${original}\n${extra}\n`);
        for (const args of commands) for (const flags of [['--json'],[]]) {
          const output=await f.runDirect([...args,...flags]);
          expect(Array.from(output.stdout+output.stderr).length).toBeLessThanOrEqual(8000);
          expect(output.stdout+output.stderr).not.toContain('privatefixture');
          if (flags.length) expect(output.body.warnings).toContain('CONFIG_UNKNOWN_KEY');
          else expect(output.stderr).toContain('경고:');
        }
      }
    } finally { await writeFile(configPath,original); }
  } finally { await fixture.close(); }
},120000);
