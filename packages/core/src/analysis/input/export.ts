import { binaryCompare } from './compare.js';
import { decodeInputSnapshot } from './snapshot.js';
import { evaluation, selectDayPrevious, selectPredecessors, type AnalysisScope, type InputAnalysisRecord } from './predecessors.js';
import { DAY_COLUMNS, type LegacyRow } from './sources.js';
import { sqliteAverage, sqliteSum } from './legacy-shape.js';

export interface InputFile { path: string; bytes: Uint8Array }
const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(`${JSON.stringify(value,null,2)}\n`);
const unbase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
function aggregate(rows: LegacyRow[], key: (row: LegacyRow) => string): Map<string, LegacyRow[]> {
  const result = new Map<string,LegacyRow[]>();
  for (const row of rows) { const k = key(row); const group = result.get(k) ?? []; group.push(row); result.set(k,group); }
  return new Map([...result].sort(([a],[b]) => binaryCompare(a,b)));
}
const numeric = (row: LegacyRow, key: string) => typeof row[key] === 'number' ? row[key] as number : null;
function sum(rows: LegacyRow[], key: string): number | null {
  return sqliteSum(rows.map(row => numeric(row,key)));
}
export function exportScopeInput(snapshotBytes: Uint8Array, scope: AnalysisScope, sameGraph: InputAnalysisRecord[] = []): InputFile[] {
  const snapshot = decodeInputSnapshot(snapshotBytes), manifest = snapshot.legacyManifest;
  const date = String(manifest.report_date), analyses = [...snapshot.analyses,...sameGraph];
  if (scope === 'day') {
    const files: InputFile[] = Object.entries(snapshot.files).map(([path,bytes]) => ({path,bytes:path === 'profile.md' ? encoder.encode(new TextDecoder().decode(unbase64(bytes)).replace(/\r\n?/g,'\n')) : unbase64(bytes)}));
    const notes = [...(manifest.notes as string[])];
    for (const previousScope of ['day','7d'] as const) {
      const previous = selectDayPrevious(analyses,String(manifest.yesterday),previousScope);
      if (previous) files.push({path:`previous_evaluations/${previousScope}.json`,bytes:json(evaluation(previous))});
      else notes.push(`어제 ${previousScope} 평가가 없다`);
    }
    files.push({path:'manifest.json',bytes:json({...manifest,notes})});
    return files.sort((a,b) => binaryCompare(a.path,b.path));
  }
  const window = (manifest.period_windows as Record<string,{from:string;to:string}>)[scope]!;
  const day = snapshot.values.day_summary.filter(r => String(r.date) >= window.from && String(r.date) <= window.to);
  const workouts = snapshot.values.workout.filter(r => String(r.date) >= window.from && String(r.date) <= window.to).sort((a,b) => Number(a.start_ms)-Number(b.start_ms));
  const workoutById = new Map(workouts.map(w => [w.activity_id,w]));
  const exercises = snapshot.values.exercise_log.filter(e => workoutById.has(e.activity_id)).sort((a,b) => Number(workoutById.get(a.activity_id)!.start_ms) - Number(workoutById.get(b.activity_id)!.start_ms) || binaryCompare(String(a.exercise),String(b.exercise)));
  const info = {scope,report_date:date,from:window.from,to:window.to,actual_days:day.length,months:(manifest.months as string[]).filter(m => m >= window.from.slice(0,7) && m <= window.to.slice(0,7)),partial_date:{date,description:'data_cutoff까지의 부분 값',data_cutoff:manifest.data_cutoff}};
  let values: unknown;
  if (scope !== 'all') values = {day_summary:day,workout:workouts,exercise_log:exercises};
  else {
    const monthRows = [...aggregate(day,r => String(r.date).slice(0,7))].map(([month,rows]) => {
      const result: LegacyRow = {month,days:rows.length};
      for (const col of DAY_COLUMNS.filter(c => !['date','sleep_hr_min_time','drinks_json'].includes(c))) result[col] = snapshot.allowedMeans.includes(col) ? sqliteAverage(rows.map(r => numeric(r,col))) : null;
      return result;
    });
    const workoutRows = [...aggregate(workouts,r => String(r.date).slice(0,7))].map(([month,rows]) => ({month,workouts:rows.length,duration_s:sum(rows,'duration_s')}));
    const exerciseRows = [...aggregate(exercises,r => JSON.stringify([String(workoutById.get(r.activity_id)!.date).slice(0,7),r.exercise]))].map(([key,rows]) => {
      const [month,exercise] = JSON.parse(key) as string[]; const weights = rows.map(r => numeric(r,'max_kg')).filter((n): n is number => n !== null);
      return {month,exercise,max_kg:weights.length ? Math.max(...weights) : null,volume_kg:sum(rows,'volume_kg')};
    }).sort((a,b) => binaryCompare(a.month!,b.month!) || binaryCompare(a.exercise!,b.exercise!));
    values = {months:monthRows,workouts:workoutRows,exercises:exerciseRows};
  }
  const predecessors = selectPredecessors(analyses,scope,window.from,window.to);
  return Object.entries({scope:info,day_values:values,evaluations:predecessors.evaluations.map(evaluation),previous:predecessors.previous ? evaluation(predecessors.previous) : null}).map(([name,value]) => ({path:`period/${scope}/${name}.json`,bytes:json(value)}));
}
