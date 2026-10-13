/**
 * A workspace groups projects and the sessions that belong to no project.
 * Rows are made by a human through `sessions.assign-workspace`; `name` is the
 * idempotency key (Table Contract).
 */
export interface Workspace {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  name: string;
}
