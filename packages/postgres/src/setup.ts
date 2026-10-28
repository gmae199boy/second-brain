import { createPool, describe, type ConnectionOptions } from './connect.js';
export interface PrepareDatabaseOptions extends ConnectionOptions { appPassword: string; databaseName?: string }
export type PrepareDatabaseResult = { ok: true; databaseUrl: string } | { ok: false; code: 'DB_UNAVAILABLE'; message: string };
/** Administrative preparation only. Runtime never imports or calls this path. */
export async function prepareDatabase(options: PrepareDatabaseOptions): Promise<PrepareDatabaseResult> {
  const name = options.databaseName ?? 'brain';
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return { ok: false, code: 'DB_UNAVAILABLE', message: '잘못된 데이터베이스 이름입니다' };
  // Advisory locks are database-scoped; all cluster role changes use postgres.
  const adminUrl = new URL(options.databaseUrl); adminUrl.pathname = '/postgres';
  const pool = createPool({ ...options, databaseUrl: adminUrl.toString() });
  try {
    const client = await pool.connect();
    try {
      // Roles are cluster-wide, so preparation of unrelated test databases also serializes.
      await client.query('select pg_advisory_lock($1)', [4919270912]);
      try {
        await client.query(`do $$ begin
          if not exists(select from pg_roles where rolname='brain_owner') then create role brain_owner nologin; end if;
          if not exists(select from pg_roles where rolname='brain_app') then create role brain_app login; end if;
        end $$`);
        const password = options.appPassword.replaceAll("'", "''");
        await client.query(`alter role brain_app password '${password}'`);
        const exists = await client.query('select 1 from pg_database where datname=$1', [name]);
        if (exists.rows.length === 0) await client.query(`create database "${name}" owner brain_owner`);
      } finally { await client.query('select pg_advisory_unlock($1)', [4919270912]); }
    } finally { client.release(); }
  } catch (error) { return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) }; }
  finally { await pool.end().catch(() => {}); }
  const url = new URL(options.databaseUrl); url.pathname = `/${name}`;
  const target = createPool({ ...options, databaseUrl: url.toString() });
  try {
    await target.query(`create extension if not exists pg_trgm;
      create schema if not exists brain authorization brain_owner;
      revoke create on schema public from public;
      grant usage on schema brain to brain_app;
      set role brain_owner;
      create table if not exists brain.schema_migrations (
        owner text not null, version integer not null check(version > 0), name text not null,
        checksum text not null, applied_at timestamptz not null, primary key(owner,version));
      grant select on brain.schema_migrations to brain_app;
      alter default privileges in schema brain grant select, insert, update, delete on tables to brain_app;
      reset role;`);
    return { ok: true, databaseUrl: url.toString() };
  } catch (error) { return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) }; }
  finally { await target.end().catch(() => {}); }
}
