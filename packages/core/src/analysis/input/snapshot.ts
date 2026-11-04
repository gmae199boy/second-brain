import { parseInputJson, stringifyInputJson } from './json.js';
import { binaryCompare } from './compare.js';
import type { AnalysisInputSources, LegacyValues } from './sources.js';
import { pivotMetrics } from './sources.js';
import type { InputAnalysisRecord } from './predecessors.js';
import { scrub, truncateSamples } from './scrub.js';
import { contentHashOfBytes } from '../../domain/file.js';

export interface InputSnapshot {
  manifest: Record<string, unknown>;
  legacyManifest: Record<string, unknown>;
  files: Record<string, string>;
  values: LegacyValues;
  analyses: InputAnalysisRecord[];
  allowedMeans: string[];
}
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0,10);
function localTime(ms: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'}).formatToParts(ms).map(p => [p.type,p.value]));
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName!.replace('GMT','');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(((ms % 1000) + 1000) % 1000).padStart(3,'0')}${offset}`;
}
const encoder = new TextEncoder(), decoder = new TextDecoder();
const jsonBytes = (value: unknown) => encoder.encode(`${stringifyInputJson(value,2)}\n`);
const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,v]) => [key,canonical(v)]));
  return value;
}
export function encodeInputSnapshot(snapshot: InputSnapshot): Uint8Array { return encoder.encode(JSON.stringify(canonical(snapshot))); }
export function decodeInputSnapshot(bytes: Uint8Array): InputSnapshot { return JSON.parse(decoder.decode(bytes)) as InputSnapshot; }
function bodyValid(value: unknown, date: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string,unknown>;
  if (Object.keys(v).sort().join(',') !== ['schema_version','measured_on','values','value_mtime_ns','source_files'].sort().join(',') || v.schema_version !== 1 || v.measured_on !== date) return false;
  if (!v.values || typeof v.values !== 'object' || Array.isArray(v.values) || !v.value_mtime_ns || typeof v.value_mtime_ns !== 'object' || Array.isArray(v.value_mtime_ns)) return false;
  const values = v.values as Record<string,unknown>, times = v.value_mtime_ns as Record<string,unknown>;
  const limits: Record<string,number> = {weight_kg:500,skeletal_muscle_mass_kg:300,body_fat_mass_kg:300,body_fat_percent:100,bmi:200,total_body_water_l:300,protein_kg:100,minerals_kg:50,basal_metabolic_rate_kcal:10000,visceral_fat_level:100,inbody_score:200};
  const keys = Object.keys(values);
  if (!keys.length || keys.sort().join(',') !== Object.keys(times).sort().join(',')) return false;
  if (keys.some(k => !Object.hasOwn(limits,k) || typeof values[k] !== 'number' || !Number.isFinite(values[k]) || (values[k] as number) < 0 || (values[k] as number) > limits[k]! || (['basal_metabolic_rate_kcal','visceral_fat_level','inbody_score'].includes(k) && !Number.isInteger(values[k])) || !((typeof times[k] === 'bigint' && (times[k] as bigint) >= 0n) || (Number.isInteger(times[k]) && (times[k] as number) >= 0)))) return false;
  return Array.isArray(v.source_files) && v.source_files.length > 0 && v.source_files.every(x => typeof x === 'string' && x.length > 0) && new Set(v.source_files).size === v.source_files.length;
}
export function buildInputSnapshot(s: AnalysisInputSources, files: { digest: Uint8Array; labels: Uint8Array; profile?: Uint8Array; previousReport?: Uint8Array; snapshotId: string }): InputSnapshot {
  const date = s.reportDate, yesterday = addDays(date,-1), first = addDays(date,-30), notes = ['리포트 날짜의 stress_data·heart_rates는 data_cutoff 전 샘플만 담는다.','리포트 날짜의 user_summary·body_battery는 하루가 끝나지 않아 넣지 않았다.'];
  const days: Record<string,Record<string,unknown>> = {}, missing: string[] = [], output: Record<string,string> = {};
  const put = (path: string, bytes: Uint8Array) => { output[path] = base64(bytes); };
  const dayRaw = s.raw.filter(r => r.key.startsWith('day/')).map(r => ({...r,key:r.key.slice(4)})).sort((a,b) => binaryCompare(a.key,b.key) || binaryCompare(a.endpoint,b.endpoint));
  const firstEver = s.firstEver;
  for (const raw of dayRaw.filter(r => r.key >= first && r.key <= date)) {
    if (raw.key === date && ['user_summary','body_battery'].includes(raw.endpoint)) continue;
    let value: unknown;
    try { value = scrub(parseInputJson(raw.body)); } catch { notes.push(`${raw.key} ${raw.endpoint}: 원본 JSON이 잘못됐다`); continue; }
    if (raw.key === date) value = truncateSamples(raw.endpoint,value,s.cutoffMs);
    if (value === null && !['activities_by_date','training_readiness'].includes(raw.endpoint) && [date,yesterday].includes(raw.key)) missing.push(`${raw.key} ${raw.endpoint}`);
    if (raw.endpoint.includes('/') || raw.endpoint === '.' || raw.endpoint === '..') { notes.push('원본 endpoint 이름이 잘못됐다'); continue; }
    (days[raw.key] ??= {})[raw.endpoint] = value;
    put(`days/${raw.key}/${raw.endpoint}.json`,jsonBytes(value));
  }
  const activity = new Map<string,{start?:number;duration?:number;date?:string}>();
  for (const metric of s.metrics.filter(m => m.metric.startsWith('activity.') && m.activityId && m.localDate && m.localDate >= first && m.localDate <= date)) {
    const row = activity.get(metric.activityId!) ?? {date:metric.localDate!};
    if (metric.metric === 'activity.start_ms' && typeof metric.value === 'number') row.start = metric.value / metric.factor;
    if (metric.metric === 'activity.duration_s' && typeof metric.value === 'number') row.duration = metric.value / metric.factor;
    activity.set(metric.activityId!,row);
  }
  const ordered = [...activity].filter(([,v]) => v.start !== undefined && v.start < s.cutoffMs).sort((a,b) => a[1].start! - b[1].start! || (Number(a[0]) - Number(b[0])) || binaryCompare(a[0],b[0]));
  const starts = ordered.map(([,v]) => v.start!), workouts: string[] = [];
  for (const [id,row] of ordered) {
    if (row.duration === undefined || row.start! + row.duration * 1000 >= s.cutoffMs) continue;
    if (!/^\d+$/.test(id)) { notes.push('운동 ID 모양이 잘못됐다'); continue; }
    for (const raw of s.raw.filter(r => r.key === `activity/${id}`)) {
      if (raw.endpoint.includes('/') || raw.endpoint === '.' || raw.endpoint === '..') continue;
      try { put(`activities/${id}/${raw.endpoint}.json`,jsonBytes(scrub(parseInputJson(raw.body)))); } catch { notes.push(`운동 ${id} ${raw.endpoint}: 원본 JSON이 잘못됐다`); }
    }
    if (row.start! >= s.windowFromMs) workouts.push(id);
  }
  const body: string[] = [];
  for (const row of [...s.body].filter(r => r.measuredOn <= date).sort((a,b) => binaryCompare(a.measuredOn,b.measuredOn))) {
    const sidecar = typeof row.sidecar === 'string' ? parseInputJson(row.sidecar) : row.sidecar;
    if (!bodyValid(sidecar,row.measuredOn)) { notes.push(`body/${row.measuredOn}.json: 무효 사이드카를 제외했다`); continue; }
    const path = `body/${row.measuredOn}.json`; body.push(path); put(path,jsonBytes(scrub(sidecar)));
  }
  put('labels/exercise_types_ko.json',jsonBytes(JSON.parse(decoder.decode(files.labels))));
  put('digest.json',files.digest);
  if (files.profile) put('profile.md',files.profile); else notes.push('profile.md 파일이 없거나 읽을 수 없다');
  if (files.previousReport) put('previous_report.md',files.previousReport);
  const periodWindows = {'7d':{from:addDays(date,-6),to:date},'30d':{from:addDays(date,-29),to:date},all:{from:firstEver,to:date}};
  const months: string[] = []; for (let current = `${firstEver.slice(0,7)}-01`; current <= date; ) { months.push(current.slice(0,7)); const d = new Date(`${current}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth()+1); current = d.toISOString().slice(0,10); }
  const legacyManifest = {report_date:date,weekday:'일월화수목금토'[new Date(`${date}T00:00:00Z`).getUTCDay()],timezone:s.timeZone,yesterday,sleep_night:{from:yesterday,to:date,file:`days/${date}/sleep_data.json`},workout_window:{from:localTime(s.windowFromMs,s.timeZone),to:localTime(s.cutoffMs,s.timeZone)},workouts,_workout_starts_ms:starts,baseline_days:Array.from({length:7},(_,i) => addDays(date,i-7)),history_days:Object.keys(days).sort(),period_windows:periodWindows,months,collect:{status:s.collectStatus,detail:'',finished_at:s.finishedAt,missing},data_cutoff:localTime(s.cutoffMs,s.timeZone),previous_report:files.previousReport ? 'previous_report.md' : null,body,notes};
  const authority = [...new Map(s.metrics.filter(m => m.authorityId).map(m => [m.authorityId!,{id:m.authorityId,revision:m.authorityRevision}])).values()].sort((a,b) => binaryCompare(a.id!,b.id!));
  const manifest = {version:'analysis-input/1',snapshot_id:files.snapshotId,account:s.account,report_date:date,timezone:s.timeZone,cutoff_ms:s.cutoffMs,workout_window:{from:s.windowFromMs,to:s.cutoffMs},collect_work_id:s.collectWorkId,artifacts_work_id:s.artifactsWorkId,collect_snapshot_id:s.collectSnapshotId,catalog_version:1,normalization_versions:[...new Set(s.metrics.map(m => m.normalizationVersion))].sort((a,b)=>a-b),current_ids:s.metrics.map(m=>m.id).sort(),authority,excluded:s.excluded.map(e=>({metric:e.metric,local_date:e.localDate,activity_id:e.activityId,sub_identity:e.subIdentity,reason:e.reason,ids:e.ids})),digest:{file_id:s.digest.fileId,sha256:contentHashOfBytes(files.digest).slice(7)},graphs:s.graphs,body:{dataset:s.dataset,files:body},profile:files.profile ? {sha256:contentHashOfBytes(files.profile).slice(7)} : null,labels:{sha256:contentHashOfBytes(files.labels).slice(7)},predecessors:s.analyses.map(a=>a.id).sort()};
  return {manifest,legacyManifest,files:output,values:pivotMetrics(s.metrics),analyses:s.analyses,allowedMeans:s.metrics.filter(m => m.metric.startsWith('day_summary.') && m.aggregations.includes('mean')).map(m=>m.metric.slice(12))};
}
