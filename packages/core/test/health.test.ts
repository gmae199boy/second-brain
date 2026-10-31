import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregateHealth, resolveHealth, validateHealthObservation, type HealthAggregation, type HealthAuthority, type HealthMetric, type HealthObservation } from '../src/domain/health.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/health/v1/current.json', import.meta.url), 'utf8')) as { cases: { name: string; rows: HealthObservation[]; versions: number[]; authority: HealthAuthority | null; expected: { current: string | null; reason: string | null; selected: string[]; unselected: string[] } }[]; aggregations: { name: string; metric: string; operation: HealthAggregation; rows: HealthObservation[]; expected?: number | null; error?: string }[] };
const catalog = JSON.parse(readFileSync(new URL('../schemas/health/v1/catalog.json', import.meta.url), 'utf8')) as { version: number; metrics: HealthMetric[] };
const steps = catalog.metrics.find(m => m.metric === 'daily_metric.steps')!;
describe('건강 공유 계약', () => {
  for (const c of fixture.cases) it(c.name, () => {
    const result = resolveHealth(c.rows, c.versions, c.authority);
    expect({ current: result.current?.id ?? null, reason: result.reason, selected: result.selected, unselected: result.unselected }).toEqual(c.expected);
    expect(result.authorityVersion).toBe(c.authority?.version ?? null);
  });
  it('타입과 날짜 배타 및 단위를 검사하고 NULL과 0을 보존한다', () => {
    const row = fixture.cases[0]!.rows[0]!;
    for (const value of [null, 0, -1]) expect(() => validateHealthObservation({ ...row, value }, steps)).not.toThrow();
    for (const bad of [{ ...row, value: '1' }, { ...row, unit: 'g' }, { ...row, instant: '2026-01-01T00:00:00Z' }, { ...row, version: 1.5 }]) expect(() => validateHealthObservation(bad, steps)).toThrow('HEALTH_INVALID_OBSERVATION');
  });
  for (const c of fixture.aggregations) it(c.name, () => {
    const metric = catalog.metrics.find(m => m.metric === c.metric)!;
    const groups = new Map<string, HealthObservation[]>();
    for (const row of c.rows) {
      const key = JSON.stringify([row.source, row.account, row.metric, row.activity, row.subIdentity, row.date, row.instant, row.timezone]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const results = [...groups.values()].map(rows => resolveHealth(rows, [1]));
    if (c.error) expect(() => aggregateHealth(metric, c.operation, results)).toThrow(c.error);
    else expect(aggregateHealth(metric, c.operation, results)).toBe(c.expected);
  });
  it('원본 열 매핑과 배율 및 미확인 단위 정책을 게시한다', () => {
    expect(catalog.version).toBe(1);
    expect(new Set(catalog.metrics.map(m => m.metric)).size).toBe(catalog.metrics.length);
    expect(catalog.metrics.find(m => m.metric === 'day_summary.moderate_min')?.mappings[0]?.factor).toBe(60);
    expect(catalog.metrics.find(m => m.metric === 'exercise_log.max_kg')?.mappings[0]?.factor).toBe(1000);
    expect(catalog.metrics.filter(m => m.unit === 'legacy_unspecified').every(m => m.aggregations.length === 0)).toBe(true);
  });
});
