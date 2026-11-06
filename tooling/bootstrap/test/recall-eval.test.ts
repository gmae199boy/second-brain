import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../recall-eval/eval.mjs', import.meta.url));
const fixtures = JSON.parse(readFileSync(fileURLToPath(new URL('../../recall-eval/health-cases.json',import.meta.url)),'utf8')) as {cases:{id:string;command:string;input:Record<string,string>;expected:Record<string,unknown>}[]};
const names = ['sum','mean','all-null','zero','dst-yesterday','daily','workout','exercise','not-installed','disabled','command-error'];
// 고정 호출 재생은 판정기 자기시험이며 실제 에이전트 평가가 아니다.
it.each(names)('%s 판정기 양성 및 음성 자기시험', name => {
  const parent = mkdtempSync(join(tmpdir(),'recall-eval-')), dir = join(parent,'case');
  try {
    execFileSync(process.execPath,[script,'prepare',name,dir]);
    expect(readFileSync(join(dir,'prompt.md'),'utf8')).toContain('현지 날짜 계산에는 시간대 데이터베이스 도구를 사용할 수 있습니다');
    const item = fixtures.cases.find(c => c.id === (['not-installed','disabled','command-error'].includes(name) ? 'sum' : name))!;
    const run = (args:string[]) => spawnSync(join(dir,'bin/brain'),args,{encoding:'utf8'});
    const status = ['ext','status','garmin','--json'];
    expect(run(status).status).toBe(0);
    if (!['not-installed','disabled'].includes(name)) {
      if (name === 'daily') expect(run(['guide','schema','ext.garmin','period-summary','--json']).status).toBe(0);
      for (const args of [['config','get','garmin.connection_id','--json'],['config','get','garmin.timezone','--json'],['guide','schema','ext.garmin',item.command,'--json']]) expect(run(args).status).toBe(0);
      const result = run(['ext','garmin',item.command,'--input',JSON.stringify(item.input),'--json']);
      expect(result.status).toBe(name === 'command-error' ? 1 : 0);
    }
    const data = ['not-installed','disabled','command-error'].includes(name) ? null : item.expected;
    writeFileSync(join(dir,'result-report.json'),JSON.stringify(data));
    const transcript = name === 'dst-yesterday' ? '명령: TZ=America/New_York date -r 1773030600 +%F\n명령: brain ext garmin period-summary --input ... --json\n' : '가짜 brain 호출 기록';
    writeFileSync(join(dir,'transcript.txt'),transcript);
    const fields = name === 'daily' ? (data!.rows as {date:string;value:number|null;unit:string}[]).map(row => `${row.date}: ${String(row.value)} ${row.unit}`).join('\n') : data ? Object.entries({...data,timezone:item.input.timezone}).map(([key,value])=>`${key}: ${String(value)}`).join('\n') : '';
    const notice = ({'all-null':'값이 모두 비어 있음(0 아님)','zero':'기록 0건','not-installed':'미설치: Garmin 조회 명령이 없습니다','disabled':'비활성: Garmin 조회 명령을 쓸 수 없습니다','command-error':'오류 EXTENSION_COMMAND_FAILED'} as Record<string,string>)[name] ?? '조회 결과';
    const report = `${notice}\n${fields}\n`; writeFileSync(join(dir,'report.txt'),report);
    const verify = () => spawnSync(process.execPath,[script,'verify',dir],{encoding:'utf8'});
    const good = verify(); expect(good.status, good.stdout + good.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir,'verdict.json'),'utf8')).ok).toBe(true);
    if (name === 'sum') {
      writeFileSync(join(dir,'result-report.json'),JSON.stringify({...data,value:999}));
      expect(verify().status).toBe(1);
      writeFileSync(join(dir,'result-report.json'),JSON.stringify(data));
      writeFileSync(join(dir,'transcript.txt'),"명령: psql -c 'select 1'\n");
      expect(verify().status).toBe(1);
      writeFileSync(join(dir,'transcript.txt'),transcript);
      const callsPath = join(dir,'calls.jsonl'), outputsPath = join(dir,'outputs.jsonl');
      const calls = readFileSync(callsPath,'utf8').trim().split('\n'), outputs = readFileSync(outputsPath,'utf8').trim().split('\n');
      const reorder = (indices:number[]) => { writeFileSync(callsPath,indices.map(i=>calls[i]).join('\n')+'\n'); writeFileSync(outputsPath,indices.map(i=>outputs[i]).join('\n')+'\n'); };
      reorder([4,0,1,2,3]); expect(verify().status).toBe(1);
      reorder([0,4,1,2,3]); expect(verify().status).toBe(1);
      reorder([0,1,2,3,4]);
      run(['config','set','garmin.timezone','UTC','--json']); expect(verify().status).toBe(1);
      reorder([0,1,2,3,4]);
    }
    if (name === 'daily') {
      writeFileSync(join(dir,'report.txt'),report.split('\n').reverse().join('\n'));
      expect(verify().status).toBe(0);
      writeFileSync(join(dir,'report.txt'),report + '2026-01-01: 10 count\n');
      expect(verify().status).toBe(1);
      writeFileSync(join(dir,'report.txt'),report.replace('2026-01-02: null count','2026-01-02: 0 count'));
      expect(verify().status).toBe(1);
      writeFileSync(join(dir,'report.txt'),report + '2026-01-04: 99 count\n');
      expect(verify().status).toBe(1);
      writeFileSync(join(dir,'report.txt'),report);
      const invalid = run(['ext','garmin','daily-values','--input',JSON.stringify({...item.input,start_date:'2026-01-02'}),'--json']);
      expect(JSON.parse(invalid.stdout).error.code).toBe('EXTENSION_COMMAND_INPUT_INVALID');
      expect(verify().status).toBe(1);
    } else if (data) {
      writeFileSync(join(dir,'report.txt'),report.replace(`value: ${String(data.value)}`,'value: 999'));
      expect(verify().status).toBe(1);
      if (name === 'all-null') {
        writeFileSync(join(dir,'report.txt'),report.replace('value: null','value: 0'));
        expect(verify().status).toBe(1);
        writeFileSync(join(dir,'report.txt'),report + '값은 0입니다.\n');
        expect(verify().status).toBe(1);
      }
      writeFileSync(join(dir,'report.txt'),report);
    }
    if (name === 'workout') {
      const {activity_type: _activityType, ...input} = item.input;
      const invalid = run(['ext','garmin','period-summary','--input',JSON.stringify(input),'--json']);
      expect(JSON.parse(invalid.stdout).error.code).toBe('EXTENSION_COMMAND_INPUT_INVALID');
      expect(verify().status).toBe(1);
    }
    if (name === 'exercise') {
      expect(readFileSync(join(dir,'prompt.md'),'utf8')).toContain(item.input.exercise);
      const {exercise: _exercise, ...input} = item.input;
      const invalid = run(['ext','garmin','period-summary','--input',JSON.stringify(input),'--json']);
      expect(JSON.parse(invalid.stdout).error.code).toBe('EXTENSION_COMMAND_INPUT_INVALID');
      expect(verify().status).toBe(1);
    }
    if (name === 'command-error') {
      writeFileSync(join(dir,'report.txt'),'기록 0건');
      expect(verify().status).toBe(1);
      expect(JSON.parse(readFileSync(join(dir,'verdict.json'),'utf8')).ok).toBe(false);
      writeFileSync(join(dir,'report.txt'),report);
    }
    if (name === 'not-installed') {
      writeFileSync(join(dir,'report.txt'),'미설치'); expect(verify().status).toBe(1);
      writeFileSync(join(dir,'report.txt'),report);
      writeFileSync(join(dir,'report.txt'),'설치되어 있습니다'); expect(verify().status).toBe(1);
      writeFileSync(join(dir,'report.txt'),report);
      expect(run(['ext','garmin','period-summary','--input',JSON.stringify(item.input),'--json']).status).toBe(2);
      expect(verify().status).toBe(1);
    }
    if (name === 'dst-yesterday') {
      writeFileSync(join(dir,'transcript.txt'),'명령: brain ext garmin period-summary --input ... --json\n');
      expect(verify().status).toBe(1);
      writeFileSync(join(dir,'transcript.txt'),transcript);
      const input = {...item.input,start_date:'2026-03-07',end_date:'2026-03-07'};
      const invalid = run(['ext','garmin','period-summary','--input',JSON.stringify(input),'--json']);
      expect(JSON.parse(invalid.stdout).error.code).toBe('EXTENSION_COMMAND_INPUT_INVALID');
      expect(run(['ext','garmin','period-summary','--input',JSON.stringify(item.input),'--json']).status).toBe(0);
      expect(verify().status).toBe(1);
    }
  } finally { rmSync(parent,{recursive:true,force:true}); }
},30000);

// 고정 호출 재생은 판정기 자기시험이며 실제 에이전트 행동 평가가 아니다.
it.each(['search-two','search-rephrase','search-empty','search-disabled'])('%s 검색 판정기 양성 및 음성 자기시험', name => {
  const parent = mkdtempSync(join(tmpdir(),'recall-search-eval-')), dir = join(parent,'case');
  try {
    execFileSync(process.execPath,[script,'prepare',name,dir]);
    const run = (args:string[]) => spawnSync(join(dir,'bin/brain'),args,{encoding:'utf8'});
    const query = (verb:string,value:string) => run(['recall',verb,value,'--source','garmin','--json']);
    if (name === 'search-rephrase') expect(query('docs','숙면').status).toBe(0);
    if (name === 'search-empty') {
      expect(query('docs','무지개').status).toBe(0); expect(query('docs','오로라').status).toBe(0);
    } else {
      const result = query(name === 'search-two' ? 'chunks' : 'docs','수면'); expect(result.status).toBe(0);
      const found = JSON.parse(result.stdout).data[0];
      const read = name === 'search-two' ? run(['recall','expand',found.session,'--from',found.from_at,'--to',found.to_at,'--json']) : run(['files','show',found.file_id,'--chunk-locator',found.chunk_locator,'--extraction-id',found.extraction_id,'--json']);
      expect(read.status).toBe(0);
      writeFileSync(join(dir,'report.txt'),`${name === 'search-disabled' ? '상태: Garmin 비활성\n' : ''}출처 ${found.chunk_id ?? found.file_id}\n${JSON.parse(read.stdout).data[0].body}\n`);
    }
    if (name === 'search-empty') writeFileSync(join(dir,'report.txt'),'검색 결과가 없습니다.');
    writeFileSync(join(dir,'transcript.txt'),'명령: brain 검색 및 원문 조회\n');
    const verify = () => spawnSync(process.execPath,[script,'verify',dir],{encoding:'utf8'});
    expect(verify().status).toBe(0);
    const report = readFileSync(join(dir,'report.txt'),'utf8');
    writeFileSync(join(dir,'report.txt'), name === 'search-empty' ? '원문을 발견했습니다.' : '출처와 원문을 확인했습니다.');
    expect(verify().status).toBe(1); writeFileSync(join(dir,'report.txt'),report);
    const callsPath=join(dir,'calls.jsonl'), outputsPath=join(dir,'outputs.jsonl');
    const calls=readFileSync(callsPath,'utf8'), outputs=readFileSync(outputsPath,'utf8');
    if (name !== 'search-empty') {
      writeFileSync(callsPath,calls.trim().split('\n').slice(0,-1).join('\n')+'\n'); writeFileSync(outputsPath,outputs.trim().split('\n').slice(0,-1).join('\n')+'\n');
      expect(verify().status).toBe(1); writeFileSync(callsPath,calls); writeFileSync(outputsPath,outputs);
    }
    writeFileSync(outputsPath,outputs.replace('"ok":true','"ok":false')); expect(verify().status).toBe(1); writeFileSync(outputsPath,outputs);
    writeFileSync(join(dir,'transcript.txt'),'명령: psql -c select\n'); expect(verify().status).toBe(1);
    writeFileSync(join(dir,'transcript.txt'),'명령: brain 검색 및 원문 조회\n');
    if (name === 'search-disabled') { writeFileSync(join(dir,'report.txt'),report.replace('상태: Garmin 비활성','상태: Garmin 활성입니다')); expect(verify().status).toBe(1); writeFileSync(join(dir,'report.txt'),report.replace('상태: Garmin 비활성\n','')); expect(verify().status).toBe(1); }
    if (name === 'search-rephrase' || name === 'search-disabled') {
      const read=JSON.parse(calls.trim().split('\n').at(-1)!) as string[];
      const index=read.indexOf('--extraction-id');
      expect(index).toBeGreaterThan(0);
      expect(run([...read.slice(0,index),...read.slice(index+2)]).status).toBe(2); expect(verify().status).toBe(1);
      writeFileSync(callsPath,calls); writeFileSync(outputsPath,outputs);
      const forged=[...read]; forged[index+1]='33333333-3333-4333-8333-333333333333';
      expect(run(forged).status).toBe(2); expect(verify().status).toBe(1);
      writeFileSync(callsPath,calls); writeFileSync(outputsPath,outputs);
    }
    if (name === 'search-two') {
      const expanded = JSON.parse(outputs.trim().split('\n').at(-1)!).data[0];
      const sourceReport = `출처 claude:synthetic ${expanded.id} ${expanded.occurred_at}\n${expanded.body}`;
      writeFileSync(join(dir,'report.txt'),sourceReport); expect(verify().status).toBe(0);
      for (const [actual, forged] of [[expanded.id,'message-forged'],['claude:synthetic','claude:forged'],[expanded.occurred_at,'2025-01-01T00:00:00.000Z']]) {
        writeFileSync(join(dir,'report.txt'),sourceReport.replace(actual,forged)); expect(verify().status).toBe(1);
      }
      writeFileSync(join(dir,'report.txt'),report);
    }
    if (name === 'search-two') { run(['recall','expand','claude:forged','--from','2026-01-01T00:00:00.000Z','--to','2026-01-01T00:00:00.000Z','--json']); expect(verify().status).toBe(1); }
    if (name === 'search-rephrase') { const entries=calls.trim().split('\n'); const results=outputs.trim().split('\n'); writeFileSync(callsPath,[entries[1],entries[0],entries[2]].join('\n')+'\n'); writeFileSync(outputsPath,[results[1],results[0],results[2]].join('\n')+'\n'); expect(verify().status).toBe(1); }
  } finally { rmSync(parent,{recursive:true,force:true}); }
},30000);


it.each(['search-orphan','search-failed','search-db-failed','search-not-installed','search-read-failed'])('%s 검색 예외 행동 판정기 양성 및 음성 자기시험', name => {
  const parent=mkdtempSync(join(tmpdir(),'recall-exception-')), dir=join(parent,'case');
  try {
    execFileSync(process.execPath,[script,'prepare',name,dir]);
    const run=(args:string[])=>spawnSync(join(dir,'bin/brain'),args,{encoding:'utf8'});
    const params:Record<string,{verb:string;query:string}>={ 'search-orphan':{verb:'tools',query:'고아메모'}, 'search-failed':{verb:'docs',query:'실패검색'}, 'search-db-failed':{verb:'docs',query:'연결검색'}, 'search-not-installed':{verb:'docs',query:'미설치자료'}, 'search-read-failed':{verb:'docs',query:'원문실패'} };
    const item=params[name]!; const found=run(['recall',item.verb,item.query,'--source','garmin','--json']);
    const body=JSON.parse(found.stdout); let report:string;
    if (name==='search-orphan') {
      expect(body.data[0]).toMatchObject({tool_note_id:'33333333-3333-4333-8333-333333333333',message_id:null,from_at:null});
      const source=body.data[0]; const read=run(['sessions','read',source.session,'--note',source.tool_note_id,'--json']);
      expect(read.status).toBe(0); report=`출처 ${source.tool_note_id}\n${JSON.parse(read.stdout).data[0].body}`;
    } else if (name==='search-read-failed') {
      const source=body.data[0]; const read=run(['files','show',source.file_id,'--chunk-locator',source.chunk_locator,'--extraction-id',source.extraction_id,'--json']);
      expect(read.status).toBe(1); report=`출처 ${source.file_id}\n원문 조회 실패: INVALID_ARGUMENT`;
    } else if (name==='search-not-installed') {
      expect(body.data).toEqual([]); expect(body.meta.extensions[0].installed).toBe(false);
      const retry=run(['recall','docs','미설치 자료','--source','garmin','--json']);
      expect(retry.status).toBe(0); expect(JSON.parse(retry.stdout).data).toEqual([]); expect(JSON.parse(retry.stdout).meta.extensions[0].installed).toBe(false);
      report='검색 결과가 없습니다. Garmin 미설치이므로 설치가 필요합니다.';
    }
    else { expect(found.status).toBe(1); report=`검색 오류 ${body.error.code}: 검색에 실패하여 결과를 확인할 수 없습니다.`; }
    writeFileSync(join(dir,'report.txt'),report); writeFileSync(join(dir,'transcript.txt'),'명령: brain 조회\n');
    const verify=()=>spawnSync(process.execPath,[script,'verify',dir],{encoding:'utf8'});
    expect(verify().status).toBe(0);
    const bad=name==='search-not-installed'?'검색 결과가 없습니다.':name==='search-orphan'?'도구 메모가 없습니다.':name==='search-read-failed'?`출처 ${body.data[0].file_id}\n원문을 확인했습니다.`:'기록 0건';
    writeFileSync(join(dir,'report.txt'),bad); expect(verify().status).toBe(1); writeFileSync(join(dir,'report.txt'),report);
    if (name==='search-failed' || name==='search-db-failed') {
      for (const explanation of ['검색 결과가 없다는 뜻은 아닙니다.', '검색 결과가 없다고 단정할 수 없습니다.']) {
        const qualified = `검색 오류 ${body.error.code}: ${explanation} 오류로 결과를 확인할 수 없습니다.`;
        writeFileSync(join(dir,'report.txt'),qualified); expect(verify().status).toBe(0);
        writeFileSync(join(dir,'report.txt'),`${qualified} 검색 결과가 없습니다.`); expect(verify().status).toBe(1);
        writeFileSync(join(dir,'report.txt'),`검색 오류 ${body.error.code}: 검색 결과가 없습니다. ${explanation}`); expect(verify().status).toBe(1);
      }
      writeFileSync(join(dir,'report.txt'),`검색 오류 ${body.error.code}\n검색 결과가 없습니다.`); expect(verify().status).toBe(1);
      writeFileSync(join(dir,'report.txt'),report); expect(verify().status).toBe(0);
    }
    if (name==='search-not-installed') {
      const callsPath=join(dir,'calls.jsonl'), outputsPath=join(dir,'outputs.jsonl');
      const calls=readFileSync(callsPath,'utf8'), outputs=readFileSync(outputsPath,'utf8');
      expect(run(['recall','docs','허용밖','--source','garmin','--json']).status).toBe(2); expect(verify().status).toBe(1);
      writeFileSync(callsPath,calls); writeFileSync(outputsPath,outputs);
      writeFileSync(outputsPath,outputs.replace('"ok":true','"ok":false')); expect(verify().status).toBe(1);
      writeFileSync(outputsPath,outputs);
    }
    if (name==='search-orphan') {
      const callsPath=join(dir,'calls.jsonl'), outputsPath=join(dir,'outputs.jsonl');
      const calls=readFileSync(callsPath,'utf8'), outputs=readFileSync(outputsPath,'utf8');
      expect(run(['sessions','read','claude:synthetic','--note','wrong-id','--json']).status).toBe(2); expect(verify().status).toBe(1);
      writeFileSync(callsPath,calls); writeFileSync(outputsPath,outputs);
      expect(run(['recall','expand','claude:synthetic','--from','2026-01-01T00:00:00.000Z','--to','2026-01-01T00:00:00.000Z','--json']).status).toBe(2); expect(verify().status).toBe(1);
    }
  } finally { rmSync(parent,{recursive:true,force:true}); }
},30000);


it('EXPLAIN 정리 복합 오류의 원인과 cause를 가려 보존한다', async () => {
  const helper = new URL('../../recall-eval/explain-error.mjs', import.meta.url).href;
  const { serializeError } = await import(helper);
  const db = new Error('DB 삭제 실패 postgres://secret@localhost/db', { cause: new Error('연결 실패 /Users/example/private') });
  const container = new Error('컨테이너 삭제 실패 /Users/example/docker');
  const error = new AggregateError([db, container], '정리 실패', { cause: new Error('상위 원인 postgres://token@host/db') });
  const record = serializeError(error);
  expect(record).toEqual({ message:'정리 실패', errors:[
    { message:'DB 삭제 실패 [REDACTED-URL]', cause:{ message:'연결 실패 ~/private' } },
    { message:'컨테이너 삭제 실패 ~/docker' },
  ], cause:{ message:'상위 원인 [REDACTED-URL]' } });
  expect(JSON.stringify(record)).not.toMatch(/secret|token|\/Users\/example/);
});
