#!/usr/bin/env node
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = JSON.parse(readFileSync(join(root, 'tooling/recall-eval/health-cases.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'extensions/garmin/manifest.json'), 'utf8'));
export const cases = ['sum', 'mean', 'all-null', 'zero', 'dst-yesterday', 'daily', 'workout', 'exercise', 'not-installed', 'disabled', 'command-error'];
const commands = Object.fromEntries(manifest.commands.map(command => [command.name, command]));
const ajv = new Ajv();
const validators = Object.fromEntries(['period-summary', 'daily-values'].map(name => [name, ajv.compile(commands[name].input_schema)]));
const sample = name => fixture.cases.find(item => item.id === (['not-installed', 'disabled', 'command-error'].includes(name) ? 'sum' : name));
const now = '2026-03-09T04:30:00Z';
const envelope = (data, code) => ({ok: !code, now, warnings: [], ...(code ? {error:{code, message:'평가용 오류', exit_code: code === 'USAGE' ? 2 : 1}} : {data})});
const equal = isDeepStrictEqual;
const status = ['ext','status','garmin','--json'];
const guide = command => ['guide','schema','ext.garmin',command,'--json'];
const config = key => ['config','get',`garmin.${key}`,'--json'];
function parseCall(args) {
  if (args.length !== 6 || args[0] !== 'ext' || args[1] !== 'garmin' || !validators[args[2]] || args[3] !== '--input' || args[5] !== '--json') return null;
  try { return {command:args[2], input:JSON.parse(args[4])}; } catch { return {command:args[2], input:null}; }
}
export function fake(dir, args) {
  const name = readFileSync(join(dir,'case'),'utf8').trim();
  if (!cases.includes(name)) throw Error('알 수 없는 사례');
  const item = sample(name); let result;
  if (equal(args,status)) result = envelope({name:'garmin',installed:name !== 'not-installed',enabled:!['not-installed','disabled'].includes(name)});
  else if (equal(args,config('connection_id'))) result = envelope({key:'garmin.connection_id',value:item.input.connection_id,source:'user'});
  else if (equal(args,config('timezone'))) result = envelope({key:'garmin.timezone',value:item.input.timezone,source:'user'});
  else if (['period-summary','daily-values'].some(command => equal(args,guide(command)))) { const command = commands[args[3]]; result = envelope({commands:[{ns:'ext.garmin',verb:command.name,input_schema:command.input_schema,output_schema:command.output_schema}]}); }
  else if (args[0] === 'ext' && args[1] === 'garmin') {
    const call = parseCall(args);
    if (['not-installed','disabled'].includes(name)) result = envelope(null,'USAGE');
    else if (!call || !validators[call.command](call.input) || call.command !== item.command || !equal(call.input,item.input)) result = envelope(null,'EXTENSION_COMMAND_INPUT_INVALID');
    else if (name === 'command-error') result = envelope(null,'EXTENSION_COMMAND_FAILED');
    else result = envelope(item.expected);
  } else result = envelope(null,'USAGE');
  appendFileSync(join(dir,'calls.jsonl'),JSON.stringify(args)+'\n');
  appendFileSync(join(dir,'outputs.jsonl'),JSON.stringify(result)+'\n');
  process.stdout.write(JSON.stringify(result)+'\n');
  return result.ok ? 0 : result.error.exit_code;
}
export function prepare(name, dir) {
  if (!cases.includes(name)) throw Error('알 수 없는 사례');
  dir = resolve(dir); if (existsSync(dir)) throw Error('새 디렉터리를 지정해야 합니다');
  mkdirSync(join(dir,'bin'),{recursive:true});
  writeFileSync(join(dir,'case'),name+'\n');
  for (const file of ['calls.jsonl','outputs.jsonl']) writeFileSync(join(dir,file),'');
  copyFileSync(join(root,'plugin/skills/recall/SKILL.md'),join(dir,'SKILL.md'));
  writeFileSync(join(dir,'package.json'),'{"type":"module"}\n');
  writeFileSync(join(dir,'bin/brain'),`#!/usr/bin/env node\nimport { fake } from ${JSON.stringify(import.meta.url)};\nimport { dirname, resolve } from 'node:path';\nprocess.exitCode = fake(resolve(dirname(process.argv[1]), '..'), process.argv.slice(2));\n`); chmodSync(join(dir,'bin/brain'),0o755);
  const item = sample(name);
  const question = name === 'exercise' ? `${item.input.start_date}부터 ${item.input.end_date}까지 ${item.input.exercise} 반복 횟수 합계를 알려 주세요.` : name === 'daily' ? `${item.input.start_date}부터 ${item.input.end_date}까지 날짜별 걸음 수를 알려 주세요.` : name === 'workout' ? `${item.input.start_date}부터 ${item.input.end_date}까지 ${item.input.activity_type} 운동 시간 합계를 알려 주세요.` : name === 'dst-yesterday' ? '현재 시각은 2026-03-09T04:30:00Z입니다. 어제 걸음 수 합계를 알려 주세요.' : `${item.input.start_date}부터 ${item.input.end_date}까지 걸음 수 ${item.input.aggregation === 'mean' ? '평균' : '합계'}를 알려 주세요.`;
  const outputInstructions = name === 'daily' ? '마지막 daily-values 응답의 data를 result-report.json에 그대로 쓰고 실패하면 null을 쓰세요. report.txt에 각 행을 YYYY-MM-DD: <value 또는 null> <unit> 형식의 줄로 쓰세요.' : '마지막 period-summary 응답의 data를 result-report.json에 그대로 쓰고 응답이 없거나 실패하면 null을 쓰세요. 값이 있거나 null 결과인 경우 보고에 value:, unit:, observed_count:, null_count:, start_date:, end_date:, timezone: 줄을 각각 쓰세요.';
  writeFileSync(join(dir,'prompt.md'),`이 폴더의 SKILL.md를 읽고 따르세요. ${question}\nPATH 앞에 이 폴더의 bin을 두고 건강 데이터 조회에는 brain만 사용하세요. 현지 날짜 계산에는 시간대 데이터베이스 도구를 사용할 수 있습니다. 대화 기록을 transcript.txt, 최종 답을 report.txt에 쓰세요. 실행한 명령은 시간순으로 각각 명령: 줄에 기록하세요. ${outputInstructions}\n`);
  return dir;
}
export function verify(dir) {
  dir = resolve(dir); const errors = []; let name, calls = [], outputs = [], report = '', transcript = '', structured;
  try {
    name = readFileSync(join(dir,'case'),'utf8').trim(); if (!cases.includes(name)) throw Error('알 수 없는 사례');
    calls = readFileSync(join(dir,'calls.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
    outputs = readFileSync(join(dir,'outputs.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
    report = readFileSync(join(dir,'report.txt'),'utf8'); transcript = readFileSync(join(dir,'transcript.txt'),'utf8');
    structured = JSON.parse(readFileSync(join(dir,'result-report.json'),'utf8'));
  } catch (error) { errors.push(`입력 파일 오류: ${error.message}`); }
  if (name && cases.includes(name)) {
    const item = sample(name); const unavailable = ['not-installed','disabled'].includes(name);
    const has = expected => calls.some(call => equal(call,expected));
    if (calls.length !== outputs.length) errors.push('호출과 출력 수가 다릅니다');
    if (!has(status)) errors.push('상태 조회가 없습니다');
    const statusIndex = calls.findIndex(call => equal(call,status));
    if (statusIndex < 0 || !outputs[statusIndex]?.ok || outputs[statusIndex].data?.installed !== (name !== 'not-installed') || outputs[statusIndex].data?.enabled !== !unavailable) errors.push('상태 응답이 다릅니다');
    const extCalls = calls.map((call,index) => ({call,index})).filter(x => x.call[0] === 'ext' && x.call[1] === 'garmin');
    const summaries = extCalls.filter(x => x.call[2] === item.command);
    const allowed = call => equal(call,status) || equal(call,config('connection_id')) || equal(call,config('timezone')) || equal(call,guide(item.command)) || (item.command === 'daily-values' && equal(call,guide('period-summary'))) || (!unavailable && parseCall(call)?.command === item.command);
    if (calls.some(call => !allowed(call))) errors.push('허용하지 않은 brain 호출이 있습니다');
    if (unavailable && extCalls.length) errors.push('미설치·비활성에서 조회했습니다');
    if (!unavailable) {
      if (extCalls.some(({call}) => { const parsed = parseCall(call); return !parsed || parsed.command !== item.command || !equal(parsed.input,item.input); })) errors.push('조회 명령 또는 입력이 사례와 다릅니다');
      for (const {index} of extCalls) for (const expected of [config('connection_id'),config('timezone'),guide(item.command)]) {
        if (!calls.some((call, i) => i < index && equal(call,expected) && outputs[i]?.ok === true)) errors.push(`조회 전 성공한 필수 호출 누락: ${expected.slice(0,4).join(' ')}`);
      }
      if (!summaries.some(x => { const parsed = parseCall(x.call); return parsed && equal(parsed.input,item.input) && outputs[x.index]?.ok === (name !== 'command-error'); })) errors.push('기대 조회 입력 또는 출력이 없습니다');
    }
    const lastSummary = summaries.at(-1);
    if (!unavailable && (!lastSummary || !equal(parseCall(lastSummary.call)?.input,item.input) || outputs[lastSummary.index]?.ok !== (name !== 'command-error'))) errors.push('마지막 조회 입력 또는 출력이 다릅니다');
    if (statusIndex >= 0 && calls.some((call, index) => index < statusIndex && (call[0] === 'config' || (call[0] === 'ext' && call[1] === 'garmin')))) errors.push('상태 확인 전에 조회했습니다');
    const last = lastSummary ? outputs[lastSummary.index]?.data ?? null : null;
    if (!equal(structured,last)) errors.push('마지막 조회 결과와 구조화 보고가 다릅니다');
    if (last !== null && name === 'daily') {
      const rows = report.split('\n').map(line => line.trim()).filter(line => /^\d{4}-\d{2}-\d{2}:/.test(line));
      const expectedRows = last.rows.map(row => `${row.date}: ${String(row.value)} ${row.unit}`);
      const dates = rows.map(row => row.slice(0, 10));
      if (new Set(dates).size !== dates.length || !equal(rows.sort(), expectedRows.sort())) errors.push('일별 보고 행이 다릅니다');
    } else if (last !== null) {
      for (const [key,value] of Object.entries({...last, timezone:item.input.timezone})) {
        const lines = report.split('\n').filter(line => line.trim().startsWith(`${key}:`));
        if (lines.length !== 1 || lines[0].trim().slice(key.length+1).trim() !== String(value)) errors.push(`${key} 보고가 다릅니다`);
      }
    }
    if (!report.trim() || !transcript.trim()) errors.push('보고 또는 대화 기록이 없습니다');
    if (name === 'zero' && !/0건/.test(report)) errors.push('0건 안내가 없습니다');
    if (name === 'all-null' && (!/비어|값\s*없/.test(report) || !/0\s*아님|0이\s*아니/.test(report) || /(?:value\s*:\s*0\b|(?:값|걸음\s*수)\s*(?:은|는|이|가|:)?\s*0(?:\s|$|[,.건]|입니다|이다|이에요|이라고))/im.test(report))) errors.push('전부 NULL 안내가 다릅니다');
    if (name === 'dst-yesterday') {
      const lines = transcript.split('\n');
      const firstQuery = lines.findIndex(line => /^\s*명령:.*\bbrain\s+ext\s+garmin\b/.test(line));
      const timezoneTool = lines.findIndex(line => /^\s*명령:/.test(line) && /America\/New_York/.test(line) && /\b(?:date|node|python(?:3(?:\.\d+)?)?)\b/.test(line));
      if (timezoneTool < 0 || firstQuery < 0 || timezoneTool >= firstQuery) errors.push('조회 전 시간대 도구 실행 증거가 없습니다');
    }
    if (name === 'not-installed' && !/미설치|설치되어\s*있지\s*않|설치되지\s*않/.test(report)) errors.push('미설치 안내가 없습니다');
    if (name === 'disabled' && !/비활성/.test(report)) errors.push('비활성 안내가 없습니다');
    if (unavailable && !/명령[^\n]*(?:없|쓸\s*수\s*없)|(?:없|쓸\s*수\s*없)[^\n]*명령/.test(report)) errors.push('명령 부재 안내가 없습니다');
    if (name === 'command-error' && (!report.includes('EXTENSION_COMMAND_FAILED') || /0건/.test(report))) errors.push('명령 오류 안내가 다릅니다');
    if (/\bpsql\b|\bsql\b|\bcurl\b|postgres(?:ql)?:\/\/|\b(?:BRAIN_DATABASE_URL|DATABASE_URL)\b/i.test(transcript)) errors.push('우회 흔적이 있습니다');
  }
  const result = {ok:errors.length === 0,errors};
  writeFileSync(join(dir,'verdict.json'),JSON.stringify(result,null,2)+'\n'); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action,...args] = process.argv.slice(2);
    if (action === 'prepare' && args.length === 2) console.log(prepare(args[0],args[1]));
    else if (action === 'verify' && args.length === 1) { const result = verify(args[0]); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1; }
    else throw Error('prepare <case> <새 폴더> 또는 verify <폴더>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
