import { formatInstant, type SettingsStore } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';

export function postgresSettingsStore(connect: PgConnect): SettingsStore {
  const write = async (input: Parameters<SettingsStore['setSetting']>[0], insertOnly: boolean) => {
    const opened = connect();
    if (!opened.ok) return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: opened.message };
    try {
      const instant = formatInstant(input.updatedAt);
      if (!instant.ok) throw new TypeError(instant.message);
      const result = await withWrite(opened.connection, async held => {
        if (insertOnly) await sql`insert into brain.settings (user_id,key,value,updated_at) values (${input.userId},${input.key},${input.value},${instant.value}) on conflict (user_id,key) do nothing`.execute(held);
        else await sql`insert into brain.settings (user_id,key,value,updated_at) values (${input.userId},${input.key},${input.value},${instant.value}) on conflict (user_id,key) do update set value=excluded.value, updated_at=excluded.updated_at`.execute(held);
      });
      return result.ok ? { ok: true as const } : result;
    } catch (error) { return databaseFailure(error); }
  };
  const getSettings: SettingsStore['getSettings'] = async ({ keys, userId }) => {
    if (keys.length === 0) return { ok: true, settings: [] };
    const opened = connect();
    if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
    try {
      const read = await sql<{ key: string; value: string; updated_at: string }>`select distinct on (key) key,value,updated_at from brain.settings where key = any(${[...keys]}::text[]) and (user_id is null or user_id = ${userId}::uuid) order by key, user_id nulls last`.execute(opened.connection.db);
      return { ok: true, settings: read.rows.map(row => ({ key: row.key, value: row.value, updatedAt: new Date(row.updated_at) })) };
    } catch (error) { return databaseFailure(error); }
  };
  return {
    getSettings,
    async getSetting({ key, userId }) {
      const result = await getSettings({ keys: [key], userId });
      return result.ok ? { ok: true, setting: result.settings[0] ?? null } : result;
    },
    setSetting: input => write(input, false),
    insertSetting: input => write(input, true),
  };
}
