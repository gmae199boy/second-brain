import { CLEANUP_TABLES, type CleanupTable, type TableMaintenance } from '@second-brain/core';
import { createPool, databaseFailure, type CreatePoolOptions } from './connect.js';

export function postgresTableMaintenance(options: CreatePoolOptions): TableMaintenance & { close(): Promise<void> } {
  const pool = createPool({ ...options, queryTimeoutMs: 0 });
  return {
    async cleanup(table: CleanupTable) {
      if (!CLEANUP_TABLES.includes(table)) return { ok: false, code: 'TABLE_CLEANUP_REFUSED', message: '정리할 수 없는 표입니다' };
      try {
        const client = await pool.connect();
        try {
          const before = (await client.query<{ relfilenode: number }>('select relfilenode from pg_class where oid=$1::regclass', [`brain.${table}`])).rows[0]?.relfilenode;
          // A rewrite may retain recently dead tuples behind an older MVCC
          // snapshot. PG 18 reports that count in copy_table_data's verbose
          // DETAIL; fail closed when its completion summary cannot be read.
          const retained: (number | null)[] = [];
          const notice = (event: { routine?: string; detail?: string }) => {
            if (event.routine !== 'copy_table_data' || event.detail === undefined) return;
            const count = /^(\d+)\b/u.exec(event.detail);
            retained.push(count === null ? null : Number(count[1]));
          };
          client.on('notice', notice);
          try { await client.query(`vacuum (full, verbose) brain.${table}`); }
          finally { client.off('notice', notice); }
          const after = (await client.query<{ relfilenode: number }>('select relfilenode from pg_class where oid=$1::regclass', [`brain.${table}`])).rows[0]?.relfilenode;
          if (before === undefined || before === after) return { ok: false, code: 'TABLE_CLEANUP_FAILED', message: `${table} 표를 다시 쓰지 못했습니다. MAINTAIN 권한을 확인하세요` };
          await client.query('checkpoint');
          if (retained.length === 0 || retained.some(count => count === null)) {
            return { ok: false, code: 'TABLE_CLEANUP_FAILED', message: `${table} 표의 옛 행 정리를 확인하지 못했습니다` };
          }
          if (retained.some(count => count !== null && count > 0)) {
            return { ok: false, code: 'DB_LOCKED', message: `${table} 표의 옛 행을 읽는 트랜잭션이 끝나기를 기다립니다` };
          }
          return { ok: true };
        } finally { client.release(); }
      } catch (error) { return databaseFailure(error); }
    },
    async close() { await pool.end(); },
  };
}
