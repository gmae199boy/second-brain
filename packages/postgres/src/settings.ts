import { formatInstant, type SettingsStore } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';

export function postgresSettingsStore(connect: PgConnect): SettingsStore {
  return {
    async getSettings({ keys }) {
      if (keys.length === 0) return { ok: true, settings: [] };
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const read = await sql<{ key: string; value: string; updated_at: string }>`select key, value, updated_at from brain.settings where key = any(${[...keys]}::text[])`.execute(opened.connection.db);
        return { ok: true, settings: read.rows.map(row => ({ key: row.key, value: row.value, updatedAt: new Date(row.updated_at) })) };
      } catch (error) { return databaseFailure(error); }
    },
    async getSetting({ key }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const read = await sql<{ key: string; value: string; updated_at: string }>`select key, value, updated_at from brain.settings where key=${key}`.execute(opened.connection.db);
        const row = read.rows[0];
        return { ok: true, setting: row === undefined ? null : { key: row.key, value: row.value, updatedAt: new Date(row.updated_at) } };
      } catch (error) { return databaseFailure(error); }
    },
    async setSetting(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const instant = formatInstant(input.updatedAt);
        if (!instant.ok) throw new TypeError(instant.message);
        const result = await withWrite(opened.connection, async held => {
          await sql`insert into brain.settings (key,value,updated_at) values (${input.key},${input.value},${instant.value})
            on conflict (key) do update set value=excluded.value, updated_at=excluded.updated_at`.execute(held);
        });
        return result.ok ? { ok: true } : result;
      } catch (error) { return databaseFailure(error); }
    },
  };
}
