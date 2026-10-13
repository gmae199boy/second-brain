/**
 * A project is a repository, identified by its normalized git remote.
 * `sessions.ensure` creates the row (find-or-create, Table Contract).
 */
export interface Project {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /**
   * `host/owner/repo`, produced by Core's one normalizing function (AD-12).
   * Idempotency key of the table.
   */
  remoteIdentity: string;
  /** The only column a human changes (Table Contract). */
  workspaceId: string | null;
}
