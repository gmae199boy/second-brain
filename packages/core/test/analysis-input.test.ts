import { describe, expect, it } from 'vitest';
import { scrub, truncateSamples, selectDayPrevious, selectPredecessors, type InputAnalysisRecord } from '../src/analysis/input/index.js';

const row = (id: string, reportDate: string, scope: InputAnalysisRecord['scope'], overrides: Partial<InputAnalysisRecord> = {}): InputAnalysisRecord => ({ id, reportDate, scope, source: 'legacy', revision: 1, createdAt: '2026-01-01T00:00:00Z', summary: id, judgments: [], evidence: [], nextChecks: [], ...overrides });
describe('analysis input independent boundaries', () => {
  it('scrubs identifiers recursively and excludes samples at and after cutoff', () => {
    const raw = { userProfilePK: 1, nested: [{ ownerId: 'x', ok: 2 }], stressValuesArray: [[999, 1], [1000, 2], [1001, 3], [], ['1', 4]] };
    expect(truncateSamples('stress_data', scrub(raw), 1000)).toEqual({ nested: [{ ok: 2 }], stressValuesArray: [[999, 1]] });
    expect(raw.stressValuesArray).toHaveLength(5);
  });
  it('selects previous day and 7d using date and priority', () => {
    const rows = [row('legacy','2026-02-01','day'), row('core','2026-02-01','day',{source:'core'}), row('old','2026-01-31','7d'), row('week','2026-02-01','7d')];
    expect(selectDayPrevious(rows,'2026-02-01','day')?.id).toBe('core');
    expect(selectDayPrevious(rows,'2026-02-01','7d')?.id).toBe('week');
    expect(selectDayPrevious(rows,'2026-02-02','7d')).toBeNull();
  });
  it('merges same-graph results for periods and picks the last 30d per month', () => {
    const rows = [row('d1','2026-01-31','day'), row('d2','2026-02-01','day'), row('week','2026-02-01','7d'), row('m1','2026-01-01','30d'), row('m2','2026-01-31','30d'), row('m3','2026-02-01','30d')];
    expect(selectPredecessors(rows,'7d','2026-01-26','2026-02-01').evaluations.map(r => r.id)).toEqual(['d1','d2']);
    expect(selectPredecessors(rows,'30d','2026-01-03','2026-02-01').evaluations.map(r => r.id)).toEqual(['week']);
    expect(selectPredecessors(rows,'all','2026-01-01','2026-02-01').evaluations.map(r => r.id)).toEqual(['m2','m3']);
    expect(selectPredecessors(rows,'all','2026-01-01','2026-02-01').previous).toBeNull();
  });
});

it('uses compensated sums for SQLite-compatible averages', async () => {
  const { sqliteAverage } = await import('../src/analysis/input/legacy-shape.js');
  expect(sqliteAverage([1e16, 1, -1e16])).toBe(1 / 3);
  expect(sqliteAverage([null, null])).toBeNull();
});

it('exports a frozen snapshot with strict workout and sample cutoff', async () => {
  const { buildInputSnapshot, encodeInputSnapshot, exportScopeInput } = await import('../src/analysis/input/index.js');
  const cutoff = Date.parse('2026-02-01T02:00:00Z');
  const metric = (id: string, metric: string, activityId: string, value: number) => ({id,metric,localDate:'2026-02-01',activityId,subIdentity:null,value,factor:1,normalizationVersion:8,aggregations:[],authorityId:null,authorityRevision:null});
  const snapshot = buildInputSnapshot({reportDate:'2026-02-01',firstEver:'2026-02-01',timeZone:'Asia/Seoul',cutoffMs:cutoff,windowFromMs:cutoff-86400000,collectWorkId:'c',artifactsWorkId:'a',collectSnapshotId:'source',collectStatus:'success',finishedAt:null,account:'synthetic',dataset:'synthetic',profilePath:null,raw:[{key:'day/2026-02-01',endpoint:'heart_rates',body:JSON.stringify({heartRateValues:[[cutoff-1,1],[cutoff,2],[cutoff+1,3]],userProfilePK:4})},{key:'activity/1',endpoint:'detail',body:'{"a":1}'},{key:'activity/2',endpoint:'detail',body:'{"a":2}'}],body:[],metrics:[metric('1','activity.start_ms','1',cutoff-1001),metric('2','activity.duration_s','1',1),metric('3','activity.start_ms','2',cutoff-1000),metric('4','activity.duration_s','2',1)],excluded:[],analyses:[],digest:{fileId:'d',location:{storeKind:'local',locator:'x',ownership:'brain'}},graphs:[]},{snapshotId:'snapshot',digest:new TextEncoder().encode('digest'),labels:new TextEncoder().encode('{}')});
  const files = exportScopeInput(encodeInputSnapshot(snapshot),'day');
  const decoded = Object.fromEntries(files.map(f => [f.path,new TextDecoder().decode(f.bytes)]));
  expect(JSON.parse(decoded['days/2026-02-01/heart_rates.json']!)).toEqual({heartRateValues:[[cutoff-1,1]]});
  expect(decoded['activities/1/detail.json']).toBeDefined();
  expect(decoded['activities/2/detail.json']).toBeUndefined();
  expect(JSON.parse(decoded['manifest.json']!)._workout_starts_ms).toEqual([cutoff-1001,cutoff-1000]);
  expect(decoded['digest.json']).toBe('digest');
});

it('applies same-graph period predecessors and allowed monthly means', async () => {
  const { encodeInputSnapshot, exportScopeInput } = await import('../src/analysis/input/index.js');
  const source = {manifest:{snapshot_id:'fixed'},legacyManifest:{report_date:'2026-02-01',yesterday:'2026-01-31',notes:[],period_windows:{'7d':{from:'2026-01-26',to:'2026-02-01'},'30d':{from:'2026-01-03',to:'2026-02-01'},all:{from:'2026-01-01',to:'2026-02-01'}},months:['2026-01','2026-02'],data_cutoff:'cutoff'},files:{},values:{day_summary:[{date:'2026-01-31',steps:10,hrv_avg:42},{date:'2026-02-01',steps:20,hrv_avg:70}],workout:[],exercise_log:[]},analyses:[],allowedMeans:['steps']};
  const today = [row('day','2026-02-01','day',{source:'core'}),row('week','2026-02-01','7d',{source:'core'}),row('month','2026-02-01','30d',{source:'core'})];
  const bytes = encodeInputSnapshot(source);
  for (const [scope,id] of [['7d','day'],['30d','week'],['all','month']] as const) {
    const files = exportScopeInput(bytes,scope,today);
    const evaluations = JSON.parse(new TextDecoder().decode(files.find(f => f.path.endsWith('/evaluations.json'))!.bytes));
    expect(evaluations.map((r: {summary:string}) => r.summary)).toEqual([id]);
  }
  const all = exportScopeInput(bytes,'all',today);
  const values = JSON.parse(new TextDecoder().decode(all.find(f => f.path.endsWith('/day_values.json'))!.bytes));
  expect(values.months.map((m:{steps:number;hrv_avg:null})=>[m.steps,m.hrv_avg])).toEqual([[10,null],[20,null]]);
});

it('notes malformed activity identifiers and missing raw values without exporting them', async () => {
  const {buildInputSnapshot,encodeInputSnapshot,exportScopeInput} = await import('../src/analysis/input/index.js');
  const metric = (id:string,metric:string,value:number) => ({id,metric,localDate:'2026-02-01',activityId:'not-a-number',subIdentity:null,value,factor:1,normalizationVersion:8,aggregations:[],authorityId:null,authorityRevision:null});
  const snapshot = buildInputSnapshot({reportDate:'2026-02-01',firstEver:'2026-02-01',timeZone:'UTC',cutoffMs:10000,windowFromMs:0,collectWorkId:'c',artifactsWorkId:'a',collectSnapshotId:'source',collectStatus:'success',finishedAt:null,account:'fixture',dataset:'fixture',profilePath:null,raw:[{key:'day/2026-02-01',endpoint:'stress_data',body:'null'},{key:'day/2026-02-01',endpoint:'../x',body:'{}'},{key:'day/2026-02-01',endpoint:'bad',body:'{'},{key:'activity/not-a-number',endpoint:'activity',body:'{}'}],body:[],metrics:[metric('1','activity.start_ms',500),metric('2','activity.duration_s',1)],excluded:[],analyses:[],digest:{fileId:'d',location:{storeKind:'local',locator:'x',ownership:'brain'}},graphs:[]},{snapshotId:'id',digest:new TextEncoder().encode('{}'),labels:new TextEncoder().encode('{}')});
  const files = exportScopeInput(encodeInputSnapshot(snapshot),'day');
  const manifest = JSON.parse(new TextDecoder().decode(files.find(f=>f.path==='manifest.json')!.bytes));
  expect(manifest.collect.missing).toEqual(['2026-02-01 stress_data']);
  expect(manifest.notes).toEqual(expect.arrayContaining(['원본 endpoint 이름이 잘못됐다','2026-02-01 bad: 원본 JSON이 잘못됐다','운동 ID 모양이 잘못됐다','profile.md 파일이 없거나 읽을 수 없다']));
  expect(files.some(f=>f.path.startsWith('activities/'))).toBe(false);
});

it('breaks equal-date ties by revision, creation time and ascending id', () => {
  const entries = [row('legacy','2026-01-31','day',{revision:99}),row('older','2026-01-31','day',{source:'core',revision:2,createdAt:'2026-01-01'}),row('z','2026-01-31','day',{source:'core',revision:3,createdAt:'2026-01-02'}),row('b','2026-01-31','day',{source:'core',revision:3,createdAt:'2026-01-03'}),row('a','2026-01-31','day',{source:'core',revision:3,createdAt:'2026-01-03'})];
  expect(selectDayPrevious(entries,'2026-01-31','day')?.id).toBe('a');
});

it('chooses the latest five weekly evaluations and previous strictly before the end', () => {
  const rows = ['01','02','03','04','05','06','07'].map(day => row(day,`2026-01-${day}`,'7d'));
  rows.push(row('future','2026-01-09','7d'),row('current','2026-01-08','30d'),row('prior','2026-01-07','30d'));
  const picked = selectPredecessors(rows,'30d','2025-12-10','2026-01-08');
  expect(picked.evaluations.map(r=>r.id)).toEqual(['07','06','05','04','03']);
  expect(picked.previous?.id).toBe('prior');
});

it('sums compensated values directly and decodes canonical exercise identities', async () => {
  const {sqliteSum} = await import('../src/analysis/input/legacy-shape.js');
  const {pivotMetrics} = await import('../src/analysis/input/sources.js');
  expect(sqliteSum([1e16,1,-1e16])).toBe(1);
  expect(sqliteSum([null,null])).toBeNull();
  const metric = {id:'x',metric:'exercise_log.sets',localDate:'2026-01-01',activityId:'1',subIdentity:JSON.stringify([{type:'integer',value:1},{type:'text',encoding:'utf-8',base64:'7Iqk7L+87Yq4'}]),value:2,factor:1,normalizationVersion:8,aggregations:[],authorityId:null,authorityRevision:null};
  expect(pivotMetrics([metric]).exercise_log[0]?.exercise).toBe('스쿼트');
  expect(pivotMetrics([{...metric,subIdentity:'broken'}]).exercise_log).toEqual([]);
});

it('prefers higher revision even when created earlier and compares mixed timestamp formats', () => {
  const records = [row('high','2026-01-31','day',{source:'core',revision:3,createdAt:'2026-01-01T00:00:00.000Z'}),row('low','2026-01-31','day',{source:'core',revision:2,createdAt:'2026-02-01 12:00:00+00'})];
  expect(selectDayPrevious(records,'2026-01-31','day')?.id).toBe('high');
  expect(selectDayPrevious([row('a','2026-01-31','day',{source:'core',createdAt:'2026-01-01 23:00:00+00'}),row('b','2026-01-31','day',{source:'core',createdAt:'2026-01-01T23:00:00.000Z'})],'2026-01-31','day')?.id).toBe('a');
  expect(selectDayPrevious([row('earlier','2026-01-31','day',{source:'core',createdAt:'2026-01-01 23:00:00+00'}),row('later','2026-01-31','day',{source:'core',createdAt:'2026-01-02T00:00:00.000Z'})],'2026-01-31','day')?.id).toBe('later');
});

it('retains unsafe JSON integer tokens and Python JSON separators', async () => {
  const {parseInputJson,stringifyInputJson,pythonJson} = await import('../src/analysis/input/json.js');
  const value = parseInputJson('{"value":1769911200000000001}');
  expect(stringifyInputJson(value)).toBe('{"value":1769911200000000001}');
  expect(pythonJson([{name:'물',amount:2}])).toBe('[{"name": "물", "amount": 2}]');
});
