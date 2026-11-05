/** Validate only package-local filenames. The migration runner still verifies
 * applied history and checksums against the database under its own lock. */
export function validateMigrationNames(entries: readonly string[]): string[] {
  const sql = entries.filter(name => name.endsWith('.sql'));
  if (sql.some(name => !/^\d{4}_.+\.sql$/.test(name))) throw new Error('invalid migration filename');
  const names = [...sql].sort();
  if (names.length === 0 || names.some((name, index) => Number(name.slice(0, 4)) !== index + 1)) throw new Error('missing or duplicate migration number');
  return names;
}
