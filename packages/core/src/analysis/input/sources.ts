import { pythonJson } from './json.js';
import { binaryCompare } from './compare.js';
import type { InputAnalysisRecord } from './predecessors.js';
import type { FileLocation } from '../../domain/file.js';

export interface InputMetric {
  id: string; metric: string; localDate: string | null; activityId: string | null; subIdentity: string | null;
  value: number | string | object | null; valueJsonRaw?: string | null; factor: number; normalizationVersion: number;
  aggregations: string[]; authorityId: string | null; authorityRevision: number | null;
}
export interface InputRaw { key: string; endpoint: string; body: string }
export interface InputExcluded { metric: string; localDate: string | null; activityId: string | null; subIdentity: string | null; reason: string; ids: string[] }
export interface AnalysisInputSources {
  reportDate: string; firstEver: string; timeZone: string; cutoffMs: number; windowFromMs: number;
  collectWorkId: string; artifactsWorkId: string; collectSnapshotId: string; collectStatus: string; finishedAt: string | null; account: string; dataset: string; profilePath: string | null;
  raw: InputRaw[]; body: { measuredOn: string; sidecar: unknown }[]; metrics: InputMetric[]; excluded: InputExcluded[];
  analyses: InputAnalysisRecord[]; digest: { fileId: string; location: FileLocation }; graphs: { requestId: string; role: string; name: string }[];
}
export const DAY_COLUMNS = ['date','sleep_total_s','sleep_deep_s','sleep_light_s','sleep_rem_s','sleep_awake_s','sleep_score','sleep_hr_min','sleep_hr_min_time','hrv_avg','spo2_avg','spo2_min','resp_avg','wake_bb','bb_high','bb_low','bb_charged','bb_drained','stress_avg','stress_high_s','steps','active_kcal','moderate_min','vigorous_min','resting_hr','weight_kg','drinks_json'] as const;
export const WORKOUT_COLUMNS = ['activity_id','date','type','start_ms','duration_s','hr_avg','hr_max','zone1_s','zone2_s','zone3_s','zone4_s','zone5_s','bb_change','session_no'] as const;
export const EXERCISE_COLUMNS = ['activity_id','exercise','sets','reps','max_kg','volume_kg','set_peak_hr_avg','rest_drop_avg'] as const;
export type LegacyRow = Record<string, unknown>;
export interface LegacyValues { day_summary: LegacyRow[]; workout: LegacyRow[]; exercise_log: LegacyRow[] }
function exerciseName(identity: string): string | null {
  try {
    const key = JSON.parse(identity);
    if (!Array.isArray(key) || key.length !== 2 || !key[1] || key[1].type !== 'text') return null;
    const part = key[1];
    if (typeof part.value === 'string') return part.value;
    if (typeof part.base64 !== 'string' || !['utf-8','utf-16le','utf-16be'].includes(part.encoding)) return null;
    const raw = atob(part.base64);
    if (btoa(raw) !== part.base64) return null;
    return new TextDecoder(part.encoding, { fatal:true }).decode(Uint8Array.from(raw, c => c.charCodeAt(0)));
  } catch { return null; }
}
/** Pivot only current observations, undoing the catalog mapping factor. */
export function pivotMetrics(metrics: readonly InputMetric[]): LegacyValues {
  const days = new Map<string, LegacyRow>(), workouts = new Map<string, LegacyRow>(), exercises = new Map<string, LegacyRow>();
  for (const metric of metrics) {
    const [table, column] = metric.metric.split('.');
    let map: Map<string, LegacyRow>, key: string, columns: readonly string[], identity: LegacyRow;
    if (table === 'day_summary' && metric.localDate) { map = days; key = metric.localDate; columns = DAY_COLUMNS; identity = { date: metric.localDate }; }
    else if (table === 'workout' && metric.activityId && metric.localDate) { map = workouts; key = metric.activityId; columns = WORKOUT_COLUMNS; identity = { activity_id: Number(metric.activityId), date: metric.localDate }; }
    else if (table === 'exercise_log' && metric.activityId && metric.subIdentity) { const exercise = exerciseName(metric.subIdentity); if (exercise === null) continue; map = exercises; key = JSON.stringify([metric.activityId,exercise]); columns = EXERCISE_COLUMNS; identity = { activity_id: Number(metric.activityId), exercise }; }
    else continue;
    if (!column || !columns.includes(column)) continue;
    let row = map.get(key);
    if (!row) { row = Object.fromEntries(columns.map(name => [name, identity[name] ?? null])); map.set(key,row); }
    row[column] = typeof metric.value === 'number' ? metric.value / metric.factor : column === 'drinks_json' && metric.value !== null ? (metric.valueJsonRaw ?? pythonJson(metric.value)) : metric.value;
  }
  return { day_summary: [...days.values()].sort((a,b) => binaryCompare(String(a.date),String(b.date))), workout: [...workouts.values()].sort((a,b) => Number(a.start_ms)-Number(b.start_ms)), exercise_log: [...exercises.values()] };
}
