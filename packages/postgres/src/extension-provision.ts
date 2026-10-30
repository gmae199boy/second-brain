import type { PoolClient } from 'pg';
import { createPool } from './connect.js';

/** 클러스터 잠금 아래 확장 자격 증명과 역할을 준비한다. */
export async function provisionExtension(databaseUrl: string, name: string, passwordSource: string | (() => Promise<string>)): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(name) || /^(core|brain|public|pg_)/.test(name)) throw new Error('잘못된 확장 자격 증명');
  const role = `brain_ext_${name}`;
  const adminUrl = new URL(databaseUrl); adminUrl.pathname = '/postgres';
  const lockPool = createPool({ databaseUrl: adminUrl.toString(), lockTimeoutMs: 0, queryTimeoutMs: 0 });
  const lock = await lockPool.connect();
  const pool = createPool({ databaseUrl, lockTimeoutMs: 0, queryTimeoutMs: 0 });
  let client: PoolClient | undefined;
  try {
    await lock.query('select pg_advisory_lock($1)', [4919270912]);
    const password = typeof passwordSource === 'function' ? await passwordSource() : passwordSource;
    if (!/^[a-f0-9]{48}$/.test(password)) throw new Error('잘못된 확장 자격 증명');
    client = await pool.connect();
    await client.query('begin');
    const db = (await client.query<{name: string}>('select current_database() as name')).rows[0]!.name;
    const existing = (await client.query(`select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication,
      shobj_description(oid, 'pg_authid') as marker, exists(select 1 from pg_auth_members where member=pg_roles.oid or roleid=pg_roles.oid) as membership
      from pg_roles where rolname=$1`, [role])).rows[0];
    if (existing && (!existing.rolcanlogin || existing.rolsuper || existing.rolbypassrls || existing.rolcreatedb || existing.rolcreaterole || existing.rolreplication || existing.membership || existing.marker !== `second-brain extension:${db}`)) throw new Error('확장 역할 충돌');
    if (!existing) {
      await client.query(`create role "${role}" login nosuperuser nobypassrls nocreatedb nocreaterole noreplication password '${password}'`);
      await client.query(`comment on role "${role}" is 'second-brain extension:${db.replaceAll("'", "''")}'`);
    }
    {
      const excess = (await client.query(`select exists (
        select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='brain' and c.relkind in ('r','p','v','m','S','f')
          and (case when c.relname='extension_status_public_v1' then
            has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_any_column_privilege($1,c.oid,'INSERT,UPDATE,REFERENCES')
          else has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            or has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') end)) as excess`, [role])).rows[0].excess;
      const functions = (await client.query(`select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='brain' and p.prorettype <> 'pg_catalog.trigger'::regtype and p.oid <> 'brain.attempt_is_current(uuid,uuid)'::regprocedure
        and has_function_privilege($1,p.oid,'EXECUTE')) as excess`, [role])).rows[0].excess;
      const schemas = (await client.query(`select exists (select 1 from pg_namespace n where n.nspname <> $2
        and n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
        and has_schema_privilege($1,n.oid,'CREATE')) as excess`, [role, name])).rows[0].excess;
      if (excess || functions || schemas) throw new Error('확장 역할에 허용되지 않은 권한');
    }
    const foreignAccess = (await client.query(`select exists (select 1 from pg_namespace n
      where n.nspname <> $2 and n.nspname not in ('brain', 'public', 'information_schema')
        and n.nspname not like 'pg_%' and has_schema_privilege($1,n.oid,'USAGE')) as excess`, [role, name])).rows[0].excess;
    if (foreignAccess) throw new Error('확장 역할에 허용되지 않은 schema 권한');
    const schema = (await client.query('select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname=$1', [name])).rows[0];
    if (schema && schema.owner !== 'brain_owner') throw new Error('확장 schema 충돌');
    await client.query(`create schema if not exists "${name}" authorization brain_owner;
      grant usage, create on schema "${name}" to "${role}";
      grant usage on schema brain to "${role}";
      grant execute on function brain.attempt_is_current(uuid, uuid) to "${role}";
      grant all privileges on all tables in schema "${name}" to "${role}";
      grant all privileges on all sequences in schema "${name}" to "${role}";
      grant execute on all functions in schema "${name}" to "${role}";
      alter default privileges for role brain_owner in schema "${name}" grant all on tables to "${role}";
      alter default privileges for role brain_owner in schema "${name}" grant all on sequences to "${role}";
      alter default privileges for role brain_owner in schema "${name}" grant execute on functions to "${role}"`);
    if ((await client.query("select to_regclass('brain.extension_status_public_v1') as view")).rows[0].view) await client.query(`grant select on brain.extension_status_public_v1 to "${role}"`);
    await client.query('commit');
    // 비밀번호가 없거나 바뀐 경우 다른 자격 증명으로 대체하지 않는다.
    const roleUrl = new URL(databaseUrl); roleUrl.searchParams.delete('user'); roleUrl.searchParams.delete('password'); roleUrl.username = role; roleUrl.password = password;
    const verify = createPool({ databaseUrl: roleUrl.toString() });
    try { if ((await verify.query('select current_user as name')).rows[0].name !== role) throw new Error('확장 역할 연결 신원이 다릅니다'); } finally { await verify.end(); }
  } catch (error) { await client?.query('rollback').catch(() => {}); throw error; }
  finally { client?.release(); await pool.end(); await lock.query('select pg_advisory_unlock($1)', [4919270912]).catch(() => {}); lock.release(); await lockPool.end(); }
}
