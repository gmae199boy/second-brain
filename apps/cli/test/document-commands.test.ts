import { describe, expect, it } from 'vitest';
import { okEnvelope, type DocumentRecallStore, searchDocuments, showDocument } from 'second_brain';
import { recallDocsCommand } from '../src/commands/recall-docs.js';
import { filesShowCommand } from '../src/commands/files-show.js';
import { recallText } from '../src/commands/recall-text.js';
import { validateCommandMeta, selectedCommand, type CommandContext, type DatabaseCommandSpec } from '../src/dispatch.js';

const body = '검색 문서 😀'.repeat(3000);
const locator = JSON.stringify({type:'text',start:0,end:Array.from(body).length});
const store: DocumentRecallStore = {
  async searchDocuments() { return {ok:true,rows:[{kind:'document',file_id:'file-1',display_name:'리포트',chunk_locator:locator,extraction_id:'generation',report_date:'2026-01-01',source:'fixture',source_unreachable:false,body,ordinal:0}],contexts:[{extraction_id:'generation',pieces:[{ordinal:0,chunk_locator:locator,body}]}]}; },
  async readDocument() { return {ok:true,snapshot:{redacted:false,source_unreachable:false,extraction_id:'generation',status:'ok',pieces:[{ordinal:0,chunk_locator:locator,body}]}}; },
};
const clock = { now: () => new Date('2026-01-01T00:00:00Z') };
const brain = { recall: { docs: (input: Parameters<typeof searchDocuments>[1]) => searchDocuments(store,input) }, files: { show: (input: Parameters<typeof showDocument>[1]) => showDocument(store,input) } };
const context = (args: string[], options: Record<string,unknown>): CommandContext => ({ args, options, clock, brain: brain as unknown as CommandContext['brain'], config: undefined, stdin: async () => '', recordHookArrival: async () => {} });
const docs = recallDocsCommand as DatabaseCommandSpec;
const show = filesShowCommand as DatabaseCommandSpec;

describe('리포트 명령', () => {
  it('명령 메타와 검색 출처 및 JSON/text 다음 명령을 보존한다', async () => {
    expect(validateCommandMeta(recallDocsCommand)).toEqual([]); expect(validateCommandMeta(filesShowCommand)).toEqual([]);
    const result = await docs.run(context(['검색'], {})); expect(result.ok).toBe(true); if (!result.ok) return;
    const json = okEnvelope(clock,result.data,result.warnings,result.meta);
    expect(JSON.stringify(json)).toContain('file-1'); expect(result.meta?.next).toMatchObject({ns:'files',verb:'show',args:{file_id:'file-1',chunk_locator:locator}});
    const line = result.text?.find(x => x.startsWith('다음: '));
    expect(line).toContain('brain files show file-1 --chunk-locator '); expect(line).not.toContain('--file-id');
  });
  it('검색 출처와 다음 인자를 show에 전달하면 본문 다음 부분으로 진행한다', async () => {
    const first = await show.run(context(['file-1'], {chunkLocator:locator,extractionId:'generation',before:'0',after:'0'}));
    expect(first.ok).toBe(true); if (!first.ok || !first.meta?.next) throw new Error('next 없음');
    const next = first.meta.next.args;
    const second = await show.run(context([String(next.file_id)], {chunkLocator:next.chunk_locator,extractionId:next.extraction_id,before:String(next.before),after:String(next.after),offset:String(next.offset),fingerprint:next.fingerprint}));
    expect(second.ok).toBe(true); if (!second.ok) return;
    expect(Number(second.meta?.next?.args.offset ?? body.length)).toBeGreaterThan(Number(next.offset));
    expect(recallText([], first.meta).join('\n')).toContain(' --offset ');
    expect((second.data as {body:string}[])[0]?.body.length).toBeGreaterThan(0);
  });
  it('가린 파일 상태를 오류 data로 내보낸다', async () => {
    const failedBrain = { ...brain, files: { show: async () => ({ok:false as const,code:'INVALID_ARGUMENT',message:'가린 파일입니다',status:'redacted'}) } };
    const result = await show.run({ ...context(['file-1'], {chunkLocator:locator}), brain: failedBrain as unknown as CommandContext['brain'] });
    expect(result).toMatchObject({ok:false,data:{status:'redacted'}});
  });
});

it('여러 문서 위치를 JSON과 텍스트에서 각각 보존한다', async () => {
  const pages = [
    {ordinal:0,chunk_locator:JSON.stringify({type:'pdf',page:1}),body:'첫 페이지'},
    {ordinal:1,chunk_locator:JSON.stringify({type:'pdf',page:2}),body:'둘째 페이지'},
    {ordinal:2,chunk_locator:JSON.stringify({type:'docx',block:1}),body:'첫 블록'},
  ];
  const source: DocumentRecallStore = { ...store, async readDocument() { return {ok:true,snapshot:{redacted:false,source_unreachable:false,extraction_id:'generation',status:'ok',pieces:pages}}; } };
  const custom = { ...brain, files:{ show:(input:Parameters<typeof showDocument>[1])=>showDocument(source,input) } };
  const result=await show.run({...context(['file-1'],{chunkLocator:pages[0]!.chunk_locator,before:'0',after:'2'}),brain:custom as unknown as CommandContext['brain']});
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.data).toEqual(pages.map(({chunk_locator,body})=>({chunk_locator,body})));
  for (const page of pages) expect(result.text?.some(line=>line.includes(page.chunk_locator) && line.includes(page.body))).toBe(true);
  const envelope=okEnvelope(clock,result.data,result.warnings,result.meta);
  expect(envelope.data).toEqual(result.data);
});

it('source-only files show exposes status and a safe Drive link without a locator',async()=>{
  const source:DocumentRecallStore={...store,async readSourceDocument(){return {ok:true,source:{source_file_id:'source-1',file_id:null,display_name:'사진.jpg',source_path:'합성',source_remote_id:'remote-id',source:'drive',index_status:'photo',source_unreachable:false,current_version:'1',completed_version:null,stale:false}};}};
  const custom={...brain,files:{show:(input:Parameters<typeof showDocument>[1])=>showDocument(source,input)}};
  const result=await show.run({...context([],{sourceFileId:'source-1'}),brain:custom as unknown as CommandContext['brain']});
  expect(result).toMatchObject({ok:true,meta:{source_file:{file_id:null,index_status:'photo',source_url:'https://drive.google.com/file/d/remote-id/view'}}});expect(result.ok&&result.text?.join('\n')).toContain('remote-id');expect(result.ok&&result.text?.join('\n')).not.toContain('chunk_locator');
  expect(recallText([],{next:{ns:'files',verb:'show',args:{source_file_id:'source-1'}}}).join('\n')).toContain('brain files show --source-file-id source-1');
});

it('guide probe sees the optional positional file and source-specific option',()=>{expect(filesShowCommand.arguments).toEqual(['[fileId]']);expect(filesShowCommand.options?.map(option=>option.flags)).toContain('--source-file-id <id>');expect(selectedCommand([filesShowCommand],['files','show','--source-file-id','synthetic'])).toBe(filesShowCommand);});

it('첨부 이름의 file ID만으로 show에 실제 색인 상태를 표시한다',async()=>{
  const pending:DocumentRecallStore={...store,async readDocument(){return {ok:true,snapshot:{redacted:false,source_unreachable:false,extraction_id:null,status:'unsupported',pieces:[]}};}};
  const custom={...brain,files:{show:(input:Parameters<typeof showDocument>[1])=>showDocument(pending,input)}};
  const result=await show.run({...context(['file-1'],{}),brain:custom as unknown as CommandContext['brain']});
  expect(result).toMatchObject({ok:true,meta:{file_status:'unsupported'}});
  expect(result.ok&&result.text?.join('\n')).toContain('unsupported');
});
