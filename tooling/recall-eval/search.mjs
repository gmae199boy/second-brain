import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const searchCases = ['search-two', 'search-rephrase', 'search-empty', 'search-disabled', 'search-orphan', 'search-failed', 'search-db-failed', 'search-not-installed', 'search-read-failed'];
const time = '2026-01-01T00:00:00.000Z';
const locator = '{"type":"text","start":0,"end":20}';
const file = '11111111-1111-4111-8111-111111111111';
const extraction = '22222222-2222-4222-8222-222222222222';
const data = {
  'search-two': { question:'대화에서 "수면"에 관해 무슨 결정을 했는지 출처 원문으로 확인해 주세요.', verb:'chunks', queries:['수면'], hit:'수면', id:'chunk-1', text:'수면 시간을 일정하게 유지하기로 했다.' },
  'search-rephrase': { question:'리포트에서 "숙면" 관련 기록을 찾아 주세요. 없으면 동의어 "수면"으로 바꿔 확인해 주세요.', verb:'docs', queries:['숙면','수면'], hit:'수면', id:file, text:'수면 리듬을 일정하게 유지했다.' },
  'search-empty': { question:'리포트에서 "무지개"를 찾고 없으면 "오로라"로 바꿔 확인해 주세요.', verb:'docs', queries:['무지개','오로라'], hit:null },
  'search-orphan': { question:'도구 메모에서 "고아메모"를 찾아 출처 원문을 확인해 주세요.', verb:'tools', queries:['고아메모'], hit:'고아메모', id:'33333333-3333-4333-8333-333333333333', text:'고아메모 원문 내용' },
  'search-failed': { question:'리포트에서 "실패검색"을 찾아 주세요.', verb:'docs', queries:['실패검색'], hit:null, failure:'SEARCH_FAILED' },
  'search-db-failed': { question:'리포트에서 "연결검색"을 찾아 주세요.', verb:'docs', queries:['연결검색'], hit:null, failure:'DB_UNAVAILABLE' },
  'search-not-installed': { question:'Garmin 리포트에서 "미설치자료"를 찾고 없으면 "미설치 자료"로 바꿔 확인해 주세요.', verb:'docs', queries:['미설치자료','미설치 자료'], hit:null, missing:true },
  'search-read-failed': { question:'Garmin 리포트에서 "원문실패"를 찾아 출처 원문을 확인해 주세요.', verb:'docs', queries:['원문실패'], hit:'원문실패', id:file, text:'원문실패 검색 조각', readFailure:'INVALID_ARGUMENT' },
  'search-disabled': { question:'Garmin이 비활성이어도 보존된 "수면" 리포트 원문을 확인해 주세요.', verb:'docs', queries:['수면'], hit:'수면', id:file, text:'수면 리포트는 비활성 상태에도 보존된다.' },
};
const state = name => ({source:'garmin', installed:name !== 'search-not-installed', enabled:name === 'search-not-installed' ? null : name !== 'search-disabled', searchable:name === 'search-not-installed' ? null : true, work_state:'unknown'});
const envelope = (name, value, meta = {}) => ({ok:true,now:time,data:value,warnings:[],meta:{...meta,extensions:[state(name)]}});
const error = (code='USAGE') => ({ok:false,now:time,warnings:[],error:{code,message:code==='USAGE'?'허용되지 않은 평가 명령':'합성 조회 실패',exit_code:code==='USAGE'?2:1}});
const row = item => item.verb === 'tools' ? {kind:'conversation',session:'claude:synthetic',harness:'claude',started_at:time,workspace_id:null,project_id:null,worktree_id:null,tag_source:null,from_at:null,to_at:null,tool_note_id:item.id,message_id:null,tool:'Bash',body:item.text} : item.verb === 'chunks' ? {kind:'conversation',session:'claude:synthetic',harness:'claude',started_at:time,workspace_id:null,project_id:null,worktree_id:null,tag_source:null,from_at:time,to_at:time,chunk_id:item.id,body:item.text} : {kind:'document',file_id:file,display_name:'합성 리포트',chunk_locator:locator,extraction_id:extraction,report_date:'2026-01-01',source:'garmin',source_unreachable:false,body:item.text};
function parse(args) {
  const [ns,verb,...rest] = args; if (!['recall','files','sessions'].includes(ns)) return null;
  const positional = [], opts = {}; for (let i=0;i<rest.length;i++) { const x=rest[i]; if (x.startsWith('--')) { if (Object.hasOwn(opts,x)) return null; if (x==='--json') opts[x]=true; else if (i+1 < rest.length && !rest[i+1].startsWith('--')) opts[x]=rest[++i]; else return null; } else positional.push(x); }
  return {ns,verb,positional,opts};
}
function response(name, args) {
  const item=data[name], parsed=parse(args); if (!parsed || parsed.positional.length !== 1 || parsed.opts['--json'] !== true) return error();
  const {ns,verb,positional:[arg],opts}=parsed;
  if (ns==='recall' && verb===item.verb && item.queries.includes(arg) && Object.keys(opts).every(k=>['--json','--source'].includes(k)) && (item.missing ? opts['--source']==='garmin' : !opts['--source'] || opts['--source']==='garmin')) {
    if (item.failure) return error(item.failure);
    const hit=arg===item.hit; return envelope(name,hit?[row(item)]:[],{count:hit?1:0,has_more:false,...(hit?{}:{hint:'일치하는 결과가 없습니다'})});
  }
  if (ns==='recall' && verb==='expand' && item.verb==='chunks' && arg==='claude:synthetic' && opts['--from']===time && opts['--to']===time && Object.keys(opts).every(k=>['--json','--from','--to'].includes(k))) return envelope(name,[{id:'message-1',occurred_at:time,role:'user',body:item.text}]);
  if (ns==='sessions' && verb==='read' && item.verb==='tools' && arg==='claude:synthetic' && opts['--note']===item.id && Object.keys(opts).every(k=>['--json','--note'].includes(k))) return envelope(name,[{id:item.id,kind:'tool',body:item.text}]);
  if (ns==='files' && verb==='show' && item.verb==='docs' && item.hit && arg===file && opts['--chunk-locator']===locator && opts['--extraction-id']===extraction && Object.keys(opts).every(k=>['--json','--chunk-locator','--extraction-id'].includes(k))) return item.readFailure ? error(item.readFailure) : envelope(name,[{chunk_locator:locator,body:item.text}]);
  return error();
}
export function searchFake(dir,name,args) {
  const result=response(name,args); appendFileSync(join(dir,'calls.jsonl'),JSON.stringify(args)+'\n'); appendFileSync(join(dir,'outputs.jsonl'),JSON.stringify(result)+'\n'); process.stdout.write(JSON.stringify(result)+'\n'); return result.ok?0:result.error.exit_code;
}
export function searchPrompt(name) {
  const instructions = name === 'search-disabled' ? '상태 안내는 원문 인용과 별도 줄에 상태: Garmin 비활성 형식으로 쓰세요.' : '';
  return `이 폴더의 SKILL.md를 읽고 따르세요. ${data[name].question}\nPATH 앞에 이 폴더의 bin을 두고 기억 검색·원문 조회에는 brain만 사용하세요. 대화 기록을 transcript.txt, 최종 답을 report.txt에 쓰세요. 실행 명령은 시간순으로 각각 명령: 줄에 기록하세요. 적중한 경우 report.txt에 출처 식별자와 원문에 근거한 내용을 적으세요. 찾지 못한 경우 결과 없음을 보고하세요. 검색 또는 원문 조회 실패는 오류 코드를 보고하세요. ${instructions}\n`;
}
// Only exempt the local assertion being explicitly denied; inspect every occurrence.
function assertsNoResults(report) {
  const pattern = /(?:검색\s*)?결과(?:가|는|도)?\s*없/g;
  for (const match of report.matchAll(pattern)) {
    const suffix = report.slice(match.index + match[0].length);
    if (!/^(?:다는\s*뜻(?:은|이)?\s*(?:아니|아닙)|다고\s*단정할\s*수\s*없)/.test(suffix)) return true;
  }
  return false;
}
export function verifySearch(dir,name) {
  const errors=[]; let calls=[],outputs=[],report='',transcript='';
  try { calls=readFileSync(join(dir,'calls.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse); outputs=readFileSync(join(dir,'outputs.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse); report=readFileSync(join(dir,'report.txt'),'utf8'); transcript=readFileSync(join(dir,'transcript.txt'),'utf8'); } catch(e) { errors.push(`입력 파일 오류: ${e.message}`); }
  const item=data[name];
  if (!report.trim() || !transcript.trim()) errors.push('보고 또는 대화 기록이 없습니다');
  if (calls.length!==outputs.length || calls.some((call,i)=>!isDeepStrictEqual(outputs[i],response(name,call)) || (!outputs[i]?.ok && outputs[i]?.error?.code !== item.failure && outputs[i]?.error?.code !== item.readFailure))) errors.push('허용되지 않은 호출이나 출력 변조가 있습니다');
  const parsed=calls.map(parse), searches=parsed.map((p,i)=>({p,i})).filter(({p})=>p?.ns==='recall' && p.verb===item.verb);
  if (!isDeepStrictEqual(searches.map(({p})=>p.positional[0]),item.queries)) errors.push('검색어 또는 재질의 순서가 다릅니다');
  if (item.hit) {
    const hitIndex=searches.find(({p})=>p.positional[0]===item.hit)?.i ?? -1;
    const readIndex=parsed.findIndex((p,i)=>i>hitIndex && (item.verb==='chunks' ? p?.ns==='recall' && p.verb==='expand' : item.verb==='tools' ? p?.ns==='sessions' && p.verb==='read' : p?.ns==='files' && p.verb==='show') && (outputs[i]?.ok || outputs[i]?.error?.code===item.readFailure));
    if (hitIndex<0 || !outputs[hitIndex]?.data?.some(r=>(r.chunk_id ?? r.tool_note_id ?? r.file_id)===item.id) || readIndex<0) errors.push('기대 적중 뒤 출처 원문 읽기가 없습니다');
    const messageSource = item.verb==='chunks' && readIndex>=0 && outputs[readIndex]?.ok && outputs[readIndex].data?.some(message => typeof message.id==='string' && message.id && typeof message.occurred_at==='string' && message.occurred_at && report.includes(message.id) && report.includes(message.occurred_at) && report.includes(parsed[readIndex].positional[0]));
    if ((!report.includes(item.id) && !messageSource) || (!item.readFailure && !report.includes(item.text))) errors.push('보고에 실제 출처 식별자 또는 원문이 없습니다');
    if (parsed.some((p,i)=>i<=hitIndex && (p?.verb==='show' || p?.verb==='expand' || (p?.ns==='sessions' && p?.verb==='read')))) errors.push('적중 전에 원문을 읽었습니다');
  } else {
    if (parsed.some(p=>p?.verb==='show' || p?.verb==='expand' || (p?.ns==='sessions' && p?.verb==='read'))) errors.push('0건에서 원문을 읽었습니다');
    if (!item.failure && (!/없|찾지\s*못/.test(report) || /(?:찾았|발견했|확인했)/.test(report))) errors.push('0건 안내가 없거나 허위 성공입니다');
  }
  if (item.failure && (!report.includes(item.failure) || (/0건|기록\s*없|찾지\s*못|발견했|찾았/.test(report) || assertsNoResults(report)))) errors.push('검색 오류를 0건 또는 성공으로 보고했습니다');
  if (item.readFailure && (!report.includes(item.readFailure) || !/원문[^\n]*(?:실패|불가|없)/.test(report) || /원문[^\n]*(?:읽었|확인했|복원했)/.test(report))) errors.push('원문 조회 실패 보고가 다릅니다');
  if (item.missing && (!/미설치|설치되어\s*있지\s*않|설치되지\s*않/.test(report) || !/설치[^\n]*(?:안내|필요|하세|하세요|해\s*주)/.test(report))) errors.push('미설치와 설치 안내가 없습니다');
  if (name==='search-disabled') { const statusLines=report.split('\n').filter(line=>/^\s*상태\s*:/.test(line)); if (statusLines.length!==1 || !/Garmin\s*비활성/.test(statusLines[0]) || /(?:^|[^비])활성(?:화|입니다|상태|됨)/.test(statusLines[0])) errors.push('비활성 상태 안내가 없거나 잘못되었습니다'); }
  if (/\bpsql\b|\bsql\b|\bcurl\b|postgres(?:ql)?:\/\/|\b(?:BRAIN_DATABASE_URL|DATABASE_URL)\b/i.test(transcript)) errors.push('우회 흔적이 있습니다');
  const result={ok:errors.length===0,errors}; writeFileSync(join(dir,'verdict.json'),JSON.stringify(result,null,2)+'\n'); return result;
}
