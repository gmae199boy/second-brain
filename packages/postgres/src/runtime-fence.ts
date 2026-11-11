import { createPool } from './connect.js';

export interface RuntimeRoleState { oid: number; name: string; login: boolean }
export interface RuntimeFenceState { system: string; database: string; databaseOid: number; roles: RuntimeRoleState[] }
/** 전용 cluster에서만 런타임 접속을 차단한다. 관리자 접속은 유지한다. */
export async function runtimeDatabaseFence(databaseUrl: string) {
  const pool = createPool({ databaseUrl, lockTimeoutMs: 5000, queryTimeoutMs: 10000 });
  const client = await pool.connect().catch(async error => { await pool.end(); throw error; });
  const identity = async () => {
    const row = (await client.query<{ system: string; database: string; oid: number; owner: string }>(`select (pg_control_system()).system_identifier::text as system, current_database() as database, oid::int as oid, pg_get_userbyid(datdba) as owner from pg_database where datname=current_database()`)).rows[0]!;
    if (row.owner !== 'brain_owner') throw new Error('설치가 소유한 DB인지 확인할 수 없습니다');
    const others = await client.query(`select datname from pg_database where not datistemplate and datname not in ('postgres', current_database())`);
    if (others.rowCount) throw new Error('전용 PostgreSQL cluster가 아닙니다. 다른 DB를 변경하지 않고 갱신을 중단했습니다');
    return row;
  };
  const validate = async (state: RuntimeFenceState) => {
    const id = await identity();
    if (id.system !== state.system || id.database !== state.database || id.oid !== state.databaseOid || !Array.isArray(state.roles) || !state.roles.length) throw new Error('런타임 정지 기록의 DB 신원이 다릅니다');
    const extensions = await client.query("select rolname, shobj_description(oid,'pg_authid') as marker from pg_roles where rolname ~ '^brain_ext_'");
    if (extensions.rows.some(row => row.marker !== `second-brain extension:${id.database}` || !state.roles.some(role => role.name === row.rolname))) throw new Error('확장 런타임 역할 소유권을 확인할 수 없습니다');
    for (const role of state.roles) {
      if (!Number.isSafeInteger(role.oid) || typeof role.login !== 'boolean' || !/^(brain_app|brain_ext_[a-z][a-z0-9_]{0,30})$/.test(role.name)) throw new Error('런타임 정지 기록의 역할이 올바르지 않습니다');
      const row = (await client.query(`select oid::int, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, exists(select 1 from pg_auth_members where member=pg_roles.oid or roleid=pg_roles.oid) as membership, shobj_description(oid,'pg_authid') as marker from pg_roles where rolname=$1`, [role.name])).rows[0];
      if (!row || row.oid !== role.oid || row.rolsuper || row.rolcreaterole || row.rolcreatedb || row.rolreplication || row.rolbypassrls || row.membership || (role.name !== 'brain_app' && row.marker !== `second-brain extension:${id.database}`)) throw new Error('런타임 역할 소유권을 확인할 수 없습니다');
    }
  };
  return {
    async snapshot(): Promise<RuntimeFenceState> {
      const id = await identity();
      const roles = (await client.query<{ oid: number; name: string; login: boolean }>(`select oid::int, rolname as name, rolcanlogin as login from pg_roles where rolname='brain_app' or (rolname ~ '^brain_ext_[a-z][a-z0-9_]{0,30}$' and shobj_description(oid,'pg_authid')=$1) order by rolname`, [`second-brain extension:${id.database}`])).rows;
      const state = { system: id.system, database: id.database, databaseOid: id.oid, roles };
      await validate(state); return state;
    },
    async block(state: RuntimeFenceState): Promise<void> {
      await validate(state);
      const roles = state.roles.map(role => role.name);
      const foreign = await client.query('select 1 from pg_stat_activity where usename=any($1::text[]) and datname<>current_database()', [roles]);
      if (foreign.rowCount) throw new Error('다른 DB에서 런타임 역할이 사용 중입니다');
      for (const role of state.roles) await client.query(`alter role "${role.name}" nologin`);
      await client.query('select pg_terminate_backend(pid,5000) from pg_stat_activity where datname=current_database() and usename=any($1::text[]) and pid<>pg_backend_pid()', [roles]);
      const active = await client.query('select 1 from pg_stat_activity where datname=current_database() and usename=any($1::text[])', [roles]);
      if (active.rowCount) throw new Error('이전 런타임 DB 접속이 남아 있습니다');
    },
    async restore(state: RuntimeFenceState): Promise<void> {
      await validate(state);
      for (const role of state.roles) await client.query(`alter role "${role.name}" ${role.login ? 'login' : 'nologin'}`);
    },
    async close() { client.release(); await pool.end(); },
  };
}

/** 종료된 리더가 남긴 고아도 추적할 수 있도록 durable process group 신원을 읽는다. */
export async function runtimeProcessGroups(databaseUrl: string): Promise<{ pgid: number; osBootAt: Date | null; osStartedAt: Date | null }[]> {
  const pool = createPool({ databaseUrl });
  try {
    if (!(await pool.query("select to_regclass('brain.work_attempts') as table")).rows[0]?.table) return [];
    const rows = (await pool.query('select distinct pgid,os_boot_at,os_started_at from brain.work_attempts where pgid is not null')).rows;
    return rows.map(row => ({ pgid: row.pgid, osBootAt: row.os_boot_at ? new Date(row.os_boot_at) : null, osStartedAt: row.os_started_at ? new Date(row.os_started_at) : null }));
  } finally { await pool.end(); }
}
