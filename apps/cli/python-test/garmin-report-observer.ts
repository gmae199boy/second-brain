/** Owned test database observer for the model-wait barrier in the report integration test. */
export async function openReportTransactions(
  rows: (sql: string) => Promise<Record<string, unknown>[]>,
  extensionRole: string,
): Promise<number> {
  // Role is provisioned by the isolated test fixture, not an arbitrary SQL fragment.
  if (!/^[a-z_][a-z0-9_]*$/.test(extensionRole)) throw new Error('invalid test role');
  const result = await rows(`select count(*)::int as n from pg_stat_activity where datname = current_database() and usename = '${extensionRole}' and pid <> pg_backend_pid() and xact_start is not null`);
  const count = result[0]?.['n'];
  if (typeof count !== 'number') throw new Error('transaction observation unavailable');
  return count;
}
