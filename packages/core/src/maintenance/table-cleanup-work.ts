import type { AddWorkInput } from '../ports/store.js';
import type { TableMaintenance } from '../ports/table-maintenance.js';
import type { WorkHandler } from '../queue/drain.js';

export const TABLE_CLEANUP_KIND = 'table_cleanup';
export const TABLE_TARGET_KIND = 'table';
export const CLEANUP_TABLES = ['messages', 'tool_notes', 'chunks', 'document_chunks', 'document_extractions', 'file_names', 'file_metadata'] as const;
export type CleanupTable = typeof CLEANUP_TABLES[number];
export function tableCleanupWork(input: { id: string; table: CleanupTable; at: Date }): AddWorkInput {
  return { id: input.id, kind: TABLE_CLEANUP_KIND, targetKind: TABLE_TARGET_KIND,
    targetId: input.table, createdAt: input.at, nextAttemptAt: input.at };
}
export function tableCleanupHandler({ maintenance }: { maintenance: TableMaintenance }): WorkHandler {
  return async item => {
    if (item.targetKind !== TABLE_TARGET_KIND || !CLEANUP_TABLES.includes(item.targetId as CleanupTable)) {
      return { ok: false, code: 'TABLE_CLEANUP_REFUSED', message: '정리할 수 없는 표입니다', retryable: false };
    }
    const result = await maintenance.cleanup(item.targetId as CleanupTable);
    if (!result.ok) {
      // This connection's failure is a failed maintenance attempt, not a
      // failure to write the queue. Back off without stopping other work.
      return { ...result, code: result.code === 'DB_LOCKED' ? 'TABLE_CLEANUP_WAITING' : 'TABLE_CLEANUP_FAILED', retryable: true };
    }
    return { ok: true };
  };
}
