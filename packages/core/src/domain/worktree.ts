/**
 * A checkout of a project: (project, working-folder path). The row outlives the
 * folder, so a deleted folder is marked, never removed (AD-12).
 */
export interface Worktree {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `path` (Table Contract). */
  projectId: string;
  path: string;
  /** Filled by drain once the folder is gone; nothing else changes. */
  removedAt: Date | null;
}
