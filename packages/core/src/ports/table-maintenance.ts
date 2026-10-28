import type { CleanupTable } from '../maintenance/table-cleanup-work.js';

/** Rewrite one table and checkpoint outside any write transaction. */
export interface TableMaintenance {
  cleanup(table: CleanupTable): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}
