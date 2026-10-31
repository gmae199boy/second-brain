/** 출처 중립 건강 관측과 결정 계약. 모든 식별자와 시각은 호출자가 공급한다. */
export type HealthValue = number | string | boolean | null | object;
export type HealthValueType = 'number' | 'text' | 'json';
export type HealthAggregation = 'sum' | 'mean';
export interface HealthMetric {
  metric: string;
  type: HealthValueType;
  unit: string;
  aggregations: HealthAggregation[];
  mappings: { table: string; column: string; factor: number }[];
  basis: string;
  nullMeaning: string;
  meaning: string;
}
export interface HealthObservation {
  id: string; source: string; account: string | null; accountConfirmed: boolean; metric: string;
  activity: string | null; subIdentity: string | null;
  date: string | null; instant: string | null; timezone: string | null;
  dataset: string; fetchedAt: string; revision: string; version: number;
  value: HealthValue; type: HealthValueType; unit: string;
}
export interface HealthAuthority { datasets: string[]; version: number }
export type HealthReason = 'account_unconfirmed' | 'timezone_unconfirmed' | 'dataset_ambiguous' | 'dataset_unselected' | 'revision_ambiguous' | 'value_ambiguous' | 'version_unsupported';
export interface HealthResolution { current: HealthObservation | null; reason: HealthReason | null; selected: string[]; unselected: string[]; authorityVersion: number | null }

export function validateHealthObservation(row: HealthObservation, metric: HealthMetric): void {
  if (row.metric !== metric.metric || row.type !== metric.type || row.unit !== metric.unit || (row.date === null) === (row.instant === null) || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error('HEALTH_INVALID_OBSERVATION');
  const v = row.value;
  if (v !== null && ((row.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) || (row.type === 'text' && typeof v !== 'string') || (row.type === 'json' && (typeof v !== 'object' || v === null)))) throw new Error('HEALTH_INVALID_OBSERVATION');
}

/** 호출자는 같은 논리 키의 행만 전달한다. revision 동률은 버전 선택보다 먼저 검사한다. */
export function resolveHealth(rows: HealthObservation[], supportedVersions: number[], authority: HealthAuthority | null = null): HealthResolution {
  const ordered = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const all = ordered.map(r => r.id);
  const fail = (reason: HealthReason, selected: HealthObservation[] = []): HealthResolution => ({ current: null, reason, selected: selected.map(r => r.id), unselected: ordered.filter(r => !selected.includes(r)).map(r => r.id), authorityVersion: authority?.version ?? null });
  if (!ordered.length) return { current: null, reason: null, selected: [], unselected: [], authorityVersion: authority?.version ?? null };
  if (ordered.some(r => r.account === null || !r.accountConfirmed)) return fail('account_unconfirmed');
  if (ordered.some(r => r.date !== null && r.timezone === null)) return fail('timezone_unconfirmed');
  const datasets = [...new Set(ordered.map(r => r.dataset))];
  let dataset: string | undefined;
  if (authority) dataset = authority.datasets.find(d => datasets.includes(d));
  else if (datasets.length === 1) dataset = datasets[0];
  else return fail('dataset_ambiguous');
  if (!dataset) return fail('dataset_unselected');
  const inDataset = ordered.filter(r => r.dataset === dataset);
  const instant = (value: string): [number, string] => {
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(value);
    if (!match) throw new Error('HEALTH_INVALID_OBSERVATION');
    const seconds = Date.parse(`${match[1]}${match[3]}`);
    if (!Number.isFinite(seconds)) throw new Error('HEALTH_INVALID_OBSERVATION');
    return [seconds, (match[2] ?? '').replace(/0+$/, '')];
  };
  const compare = (a: [number, string], b: [number, string]): number => a[0] - b[0] || a[1].localeCompare(b[1]);
  const instants = inDataset.map(r => instant(r.fetchedAt));
  const latest = instants.reduce((a, b) => compare(a, b) >= 0 ? a : b);
  const observed = inDataset.filter((_, i) => compare(instants[i]!, latest) === 0);
  if (new Set(observed.map(r => r.revision)).size > 1) return fail('revision_ambiguous', observed);
  const supported = observed.filter(r => supportedVersions.includes(r.version));
  if (!supported.length) return fail('version_unsupported', observed);
  const max = Math.max(...supported.map(r => r.version));
  const candidates = supported.filter(r => r.version === max);
  const canonical = (v: HealthValue): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, HealthValue>)[k]!)}`).join(',')}}`;
  };
  if (new Set(candidates.map(r => canonical(r.value))).size > 1) return fail('value_ambiguous', candidates);
  return { current: candidates[0]!, reason: null, selected: candidates.map(r => r.id), unselected: ordered.filter(r => !candidates.includes(r)).map(r => r.id), authorityVersion: authority?.version ?? null };
}

/** [ASSUMPTION] 원본 SQL에서 단위 근거가 없는 지표는 집계하지 않는다. */
export function aggregateHealth(metric: HealthMetric, operation: HealthAggregation, resolutions: HealthResolution[]): number | null {
  if (!metric.aggregations.includes(operation)) throw new Error('HEALTH_AGGREGATION_NOT_ALLOWED');
  const values = resolutions.map(r => r.current).filter((r): r is HealthObservation => r !== null && r.metric === metric.metric && r.type === 'number' && metric.type === 'number' && r.unit === metric.unit).map(r => r.value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return operation === 'sum' ? sum : sum / values.length;
}
