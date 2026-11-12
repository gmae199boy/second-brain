import { formatInstant, type SettingsStore } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';
import { ensureWork } from './work.js';
import { randomUUID } from 'node:crypto';
import { lockDriveRetention, recalculateDriveRetention } from './drive-retention.js';

export function postgresSettingsStore(connect: PgConnect): import('@second-brain/core').DriveRetentionSettingsStore {
  const write = async (input: Parameters<SettingsStore['setSetting']>[0], insertOnly: boolean) => {
    const opened = connect();
    if (!opened.ok) return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: opened.message };
    try {
      const instant = formatInstant(input.updatedAt);
      if (!instant.ok) throw new TypeError(instant.message);
      const result = await withWrite(opened.connection, async held => {
        if (Object.hasOwn(input, 'expectedValue')) {
          if (input.key !== 'garmin.analysis_profile' || input.userId === null) return {ok:false as const,code:'DB_UNAVAILABLE' as const,message:'이 설정은 비교 저장을 지원하지 않습니다'};
          // 동시 최초 저장은 INSERT 충돌, 이후 수정은 전체 원본 값 비교로 보호한다.
          const changed = input.expectedValue === null
            ? await sql`insert into brain.settings (user_id,key,value,updated_at) values (${input.userId},${input.key},${input.value},${instant.value}) on conflict (user_id,key) do nothing returning key`.execute(held)
            : await sql`update brain.settings set value=${input.value},updated_at=${instant.value} where user_id is not distinct from ${input.userId}::uuid and key=${input.key} and value=${input.expectedValue} returning key`.execute(held);
          return changed.rows.length ? {ok:true as const} : {ok:false as const,code:'DB_LOCKED' as const,message:'설정이 변경되었습니다. 다시 조회한 뒤 수정하세요'};
        }
        if (input.key === 'drive.keep_local_days') {
          if (!await lockDriveRetention(held)) return {ok:false as const,code:'DB_LOCKED' as const,message:'이전 로컬 삭제 결과를 확인해야 합니다'};
          if(!/^(0|[1-9][0-9]*)$/.test(input.value) || Number(input.value)>100_000_000) throw new Error('보관 기간이 유효하지 않습니다');
          if(insertOnly) await sql`insert into brain.settings (user_id,key,value,updated_at) values (${input.userId},${input.key},${input.value},${instant.value}) on conflict (user_id,key) do nothing`.execute(held);
          else await sql`insert into brain.settings (user_id,key,value,updated_at) values (${input.userId},${input.key},${input.value},${instant.value}) on conflict (user_id,key) do update set value=excluded.value,updated_at=excluded.updated_at`.execute(held);
          await recalculateDriveRetention(held);
          return {ok:true as const};
        }
        if (!insertOnly && input.key === 'drive.watch_folders' && input.userId !== null) {
          // All Drive mutations lock source rows before settings, schedules and work.
          const sources = await sql<{id:string}>`select id from brain.sources where kind='drive' and connected order by id for update`.execute(held);
          const previous = await sql<{value:string;user_id:string|null}>`select user_id::text,value from brain.settings where key=${input.key} and (user_id=${input.userId}::uuid or user_id is null) order by user_id nulls last for update`.execute(held);
          const own=previous.rows.find(row=>row.user_id===input.userId);
          const normalize=(raw:string)=>{try{const parsed:unknown=JSON.parse(raw);return Array.isArray(parsed)&&parsed.every(x=>typeof x==='string')?JSON.stringify([...new Set(parsed)].sort()):raw;}catch{return raw;}};
          const old=normalize(previous.rows[0]?.value ?? '[]');
          if (own && normalize(own.value) === input.value) return;
          // Persist explicit user override even when its effective value matches.
          await sql`insert into brain.settings (user_id,key,value,updated_at) values (${input.userId},${input.key},${input.value},${instant.value}) on conflict (user_id,key) do update set value=excluded.value,updated_at=excluded.updated_at`.execute(held);
          if(old===input.value)return;
          for (const source of sources.rows) {
            await sql`update brain.sources set generation=generation+1,scan_id=null,scan_token=null where id=${source.id}::uuid`.execute(held);
            await sql`update brain.work_items set completed_at=${instant.value}::timestamptz,outcome='cancelled',cancel_requested_at=${instant.value}::timestamptz,claimed_at=null,claim_expires_at=null,claimed_by=null where completed_at is null and kind='source_sync' and target_kind='source' and target_id=${source.id}`.execute(held);
            await ensureWork(held,{id:randomUUID(),kind:'source_sync',targetKind:'source',targetId:source.id,createdAt:input.updatedAt,nextAttemptAt:input.updatedAt});
          }
          return;
        }
        if (insertOnly) await sql`insert into brain.settings (user_id,key,value,updated_at) values (${input.userId},${input.key},${input.value},${instant.value}) on conflict (user_id,key) do nothing`.execute(held);
        else await sql`insert into brain.settings (user_id,key,value,updated_at) values (${input.userId},${input.key},${input.value},${instant.value}) on conflict (user_id,key) do update set value=excluded.value, updated_at=excluded.updated_at`.execute(held);
      });
      return result.ok ? (result.value ?? { ok: true as const }) : result;
    } catch (error) { return databaseFailure(error); }
  };
  const getSettings: SettingsStore['getSettings'] = async ({ keys, userId, includeGlobal = true }) => {
    if (keys.length === 0) return { ok: true, settings: [] };
    const opened = connect();
    if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
    try {
      const read = await sql<{ key: string; value: string; updated_at: string }>`select distinct on (key) key,value,updated_at from brain.settings where key = any(${[...keys]}::text[]) and ((user_id is null and ${includeGlobal}) or user_id = ${userId}::uuid) order by key, user_id nulls last`.execute(opened.connection.db);
      return { ok: true, settings: read.rows.map(row => ({ key: row.key, value: row.value, updatedAt: new Date(row.updated_at) })) };
    } catch (error) { return databaseFailure(error); }
  };
  return {
    getSettings,
    async refreshDriveRetention() {
      const opened=connect();if(!opened.ok)return {ok:false,code:'DB_UNAVAILABLE',message:opened.message};
      const result=await withWrite(opened.connection,async held=>{
        if(!await lockDriveRetention(held))return {ok:false as const,code:'DB_LOCKED' as const,message:'이전 로컬 삭제 결과를 확인해야 합니다'};
        await recalculateDriveRetention(held);return {ok:true as const};
      });return result.ok?result.value:result;
    },
    async getSetting({ key, userId }) {
      const result = await getSettings({ keys: [key], userId });
      return result.ok ? { ok: true, setting: result.settings[0] ?? null } : result;
    },
    setSetting: input => write(input, false),
    insertSetting: input => write(input, true),
  };
}
