import { createPool } from './connect.js';

// 로그인과 membership은 보호된 OS 배치가 검증되기 전까지 허용하지 않는다.
const roles = ['brain_protected_supervisor', 'brain_protected_broker', 'brain_protected_worker'] as const;

export async function prepareProtectedRoles(databaseUrl: string): Promise<void> {
  // role은 클러스터 전역이므로 기존 provisioning과 같은 DB 잠금을 쓴다.
  const adminUrl = new URL(databaseUrl); adminUrl.pathname = '/postgres';
  const pool = createPool({ databaseUrl: adminUrl.toString(), lockTimeoutMs: 0, queryTimeoutMs: 0 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [4919270912]);
    for (const role of roles) {
      const existing = (await client.query(`select rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
        shobj_description(oid,'pg_authid') as marker,
        exists(select 1 from pg_auth_members where member=pg_roles.oid or roleid=pg_roles.oid) as membership
        from pg_roles where rolname=$1`, [role])).rows[0];
      if (existing) {
        if (existing.rolcanlogin || existing.rolsuper || existing.rolcreatedb || existing.rolcreaterole || existing.rolreplication || existing.rolbypassrls || existing.membership || existing.marker !== 'second-brain protected role v1') throw new Error('보호 역할 충돌');
      } else {
        await client.query(`create role "${role}" nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
        await client.query(`comment on role "${role}" is 'second-brain protected role v1'`);
      }
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
