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
