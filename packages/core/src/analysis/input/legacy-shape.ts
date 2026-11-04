/** SQLite's compensated summation for AVG (Kahan–Babuska–Neumaier). */
export function sqliteSum(values: readonly (number | null)[]): number | null {
  let sum = 0, error = 0, count = 0;
  for (const value of values) {
    if (value === null) continue;
    const next = sum + value;
    error += Math.abs(sum) > Math.abs(value) ? (sum - next) + value : (value - next) + sum;
    sum = next; count++;
  }
  if (!count) return null;
  return sum + error;
}

export function sqliteAverage(values: readonly (number | null)[]): number | null {
  const sum = sqliteSum(values), count = values.filter(value => value !== null).length;
  return sum === null ? null : sum / count;
}
