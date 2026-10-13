/**
 * The single row that says which migration the database is at. Only
 * `setup run` and `setup upgrade` ever change it; every other command reads it
 * and refuses to write on a mismatch (AD-20).
 */
export interface SchemaVersion {
  version: number;
  appliedAt: Date;
}
