/** Remove legacy identifier fields recursively from JSON values. */
const SCRUB_PARTS = ['userprofile', 'owner', 'displayname', 'fullname', 'profileimage', 'email', 'userid', 'profileid'];
export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !SCRUB_PARTS.some(part => key.toLowerCase().includes(part))).map(([key, item]) => [key, scrub(item)]));
  return value;
}
/** Today's samples are strictly before the cutoff; malformed samples are omitted. */
export function truncateSamples(endpoint: string, value: unknown, cutoff: number): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value } as Record<string, unknown>;
  const keys = endpoint === 'stress_data' ? ['stressValuesArray', 'bodyBatteryValuesArray'] : endpoint === 'heart_rates' ? ['heartRateValues'] : [];
  for (const key of keys) {
    const samples = result[key];
    if (Array.isArray(samples)) result[key] = samples.filter(row => Array.isArray(row) && (typeof row[0] === 'number' || typeof row[0] === 'bigint') && row[0] < cutoff);
  }
  return result;
}
