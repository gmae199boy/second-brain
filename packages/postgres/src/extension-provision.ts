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
          and (case when c.relname in ('extension_status_public_v1','file_request_results_public_v1','health_catalog_v1') then
            has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_any_column_privilege($1,c.oid,'INSERT,UPDATE,REFERENCES')
          when c.relname in ('channel_requests','channel_legacy_notifications','channel_legacy_deliveries','health_observations','health_authority_rules','file_requests','analyses','analysis_artifacts') then
            has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or
            has_any_column_privilege($1,c.oid,'SELECT,UPDATE,REFERENCES') or exists (
              select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
                and has_column_privilege($1,c.oid,a.attname,'INSERT') and not (a.attname = any (case c.relname
                  when 'channel_requests' then array['id','conversation_id','producer','producer_result_id','purpose','revision','body','created_at','bundle','source_work_item_id','source_attempt_token']
                  when 'health_observations' then array['id','source','dataset','import_batch','original_table','original_key','account','account_confirmed','metric','value','unit','local_date','observed_at','time_zone','time_zone_missing','revision','fetched_at','normalization_version','source_work_item_id','source_attempt_token','value_type','value_text','value_json','catalog_version','activity_id','sub_identity','account_raw','account_encoding','activity_id_raw','activity_id_encoding','sub_identity_raw','sub_identity_encoding','value_text_raw','value_text_encoding','value_json_raw','value_json_encoding','dataset_label','dataset_label_raw','dataset_label_encoding']
                  when 'health_authority_rules' then array['id','source','account','metric','activity_id','date_from','date_to','revision','datasets','source_work_item_id','source_attempt_token','account_raw','account_encoding','activity_id_raw','activity_id_encoding']
                  when 'file_requests' then array['id','source','request_key','dataset','import_batch','locator','sha256','size_bytes','media_type','created_at','source_work_item_id','source_attempt_token']
                  when 'analyses' then array['id','source','dataset','import_batch','original_table','original_key','revision','model','model_missing','created_at','created_at_missing','file_request_id','source_work_item_id','source_attempt_token','report_date','report_date_raw','report_date_encoding','scope','scope_raw','scope_encoding','summary','summary_raw','summary_encoding','judgments','judgments_raw','judgments_encoding','evidence','evidence_raw','evidence_encoding','next_checks','next_checks_raw','next_checks_encoding','report_md','report_md_raw','report_md_encoding','model_raw','model_encoding']
                  when 'analysis_artifacts' then array['id','source','dataset','import_batch','analysis_id','file_request_id','role','source_work_item_id','source_attempt_token']
                  when 'channel_legacy_notifications' then array['id','conversation_id','source','dataset','original_table','original_key','import_batch','local_date','event','detail','at','source_work_item_id','source_attempt_token','local_date_raw','local_date_encoding','event_raw','event_encoding','detail_raw','detail_encoding','dataset_label','dataset_label_raw','dataset_label_encoding']
                  else array['id','conversation_id','source','dataset','original_table','original_key','import_batch','original_id','local_date','kind','event','ok','reason','at','source_work_item_id','source_attempt_token','original_id_raw','original_id_encoding','local_date_raw','local_date_encoding','kind_raw','kind_encoding','event_raw','event_encoding','reason_raw','reason_encoding','dataset_label','dataset_label_raw','dataset_label_encoding'] end)))
          else has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            or has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') end)) as excess`, [role])).rows[0].excess;
      const functions = (await client.query(`select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='brain' and p.prorettype <> 'pg_catalog.trigger'::regtype and p.oid <> 'brain.attempt_is_current(uuid,uuid)'::regprocedure and p.oid is distinct from to_regprocedure('brain.original_utf8(text)') and p.oid is distinct from to_regprocedure('brain.reconcile_import_authority(uuid,text,text,bytea,text,text[],uuid,uuid,boolean)')
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
    // 첫 migration 이후 권한 정책은 각 migration이 소유한다.
    const migrated = Boolean((await client.query(
      'select exists(select 1 from brain.schema_migrations where owner=$1) as present', [name],
    )).rows[0].present);
    await client.query(`create schema if not exists "${name}" authorization brain_owner;
      grant usage on schema "${name}" to "${role}";
      grant usage on schema brain to "${role}";
      grant execute on function brain.attempt_is_current(uuid, uuid) to "${role}"`);
    if (!migrated) {
      await client.query(`grant create on schema "${name}" to "${role}";
        alter default privileges for role brain_owner in schema "${name}" grant all on tables to "${role}";
        alter default privileges for role brain_owner in schema "${name}" grant all on sequences to "${role}";
        alter default privileges for role brain_owner in schema "${name}" grant execute on functions to "${role}"`);
    }
    // 객체별 권한은 migration이 소유한다. 기존 객체에 일괄 GRANT하면
    // 재설치 또는 역할 재생성 시 보안상 REVOKE가 무효화된다.
    if ((await client.query("select to_regclass('brain.extension_status_public_v1') as view")).rows[0].view) await client.query(`grant select on brain.extension_status_public_v1 to "${role}"`);
    if ((await client.query("select to_regclass('brain.channel_legacy_notifications') as table")).rows[0].table) await client.query(`
      grant insert (id,conversation_id,producer,producer_result_id,purpose,revision,body,created_at,source_work_item_id,source_attempt_token) on brain.channel_requests to "${role}";
      grant insert (id,conversation_id,source,dataset,original_table,original_key,import_batch,local_date,event,detail,at,source_work_item_id,source_attempt_token) on brain.channel_legacy_notifications to "${role}";
      grant insert (id,conversation_id,source,dataset,original_table,original_key,import_batch,original_id,local_date,kind,event,ok,reason,at,source_work_item_id,source_attempt_token) on brain.channel_legacy_deliveries to "${role}"`);
    if ((await client.query("select exists(select 1 from information_schema.columns where table_schema='brain' and table_name='channel_requests' and column_name='bundle') as present")).rows[0].present) await client.query(`grant insert (bundle) on brain.channel_requests to "${role}"`);
    if ((await client.query("select to_regclass('brain.file_requests') as table")).rows[0].table) await client.query(`
      grant select on brain.file_request_results_public_v1 to "${role}";
      grant insert (id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token) on brain.health_observations to "${role}";
      grant insert (id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) on brain.file_requests to "${role}";
      grant insert (id,source,dataset,import_batch,original_table,original_key,revision,model,model_missing,created_at,created_at_missing,file_request_id,source_work_item_id,source_attempt_token) on brain.analyses to "${role}"`);
    if ((await client.query("select exists(select 1 from information_schema.columns where table_schema='brain' and table_name='health_observations' and column_name='value_type') as present")).rows[0].present) await client.query(`grant insert (value_type,value_text,value_json,catalog_version,activity_id,sub_identity) on brain.health_observations to "${role}"`);
    if ((await client.query("select to_regclass('brain.health_catalog_v1') as table")).rows[0].table) await client.query(`grant select on brain.health_catalog_v1 to "${role}"`);
    if ((await client.query("select exists(select 1 from information_schema.columns where table_schema='brain' and table_name='health_authority_rules' and column_name='source_work_item_id') as present")).rows[0].present) await client.query(`grant insert (id,source,account,metric,activity_id,date_from,date_to,revision,datasets,source_work_item_id,source_attempt_token) on brain.health_authority_rules to "${role}"`);
    if ((await client.query("select exists(select 1 from information_schema.columns where table_schema='brain' and table_name='health_observations' and column_name='value_json_raw') as present")).rows[0].present) await client.query(`
      grant insert (local_date_raw,local_date_encoding,event_raw,event_encoding,detail_raw,detail_encoding) on brain.channel_legacy_notifications to "${role}";
      grant insert (original_id_raw,original_id_encoding,local_date_raw,local_date_encoding,kind_raw,kind_encoding,event_raw,event_encoding,reason_raw,reason_encoding) on brain.channel_legacy_deliveries to "${role}";
      grant insert (account_raw,account_encoding,activity_id_raw,activity_id_encoding,sub_identity_raw,sub_identity_encoding,value_text_raw,value_text_encoding,value_json_raw,value_json_encoding) on brain.health_observations to "${role}";`);
    if ((await client.query("select to_regprocedure('brain.original_utf8(text)') as fn")).rows[0].fn) await client.query(`grant execute on function brain.original_utf8(text) to "${role}"`);
    if ((await client.query("select exists(select 1 from information_schema.columns where table_schema='brain' and table_name='health_authority_rules' and column_name='account_raw') as present")).rows[0].present) await client.query(`grant insert (account_raw,account_encoding,activity_id_raw,activity_id_encoding) on brain.health_authority_rules to "${role}"`);
    if ((await client.query("select exists(select 1 from information_schema.columns where table_schema='brain' and table_name='health_observations' and column_name='dataset_label') as present")).rows[0].present) await client.query(`
      grant insert (dataset_label,dataset_label_raw,dataset_label_encoding) on brain.health_observations to "${role}";
      grant insert (dataset_label,dataset_label_raw,dataset_label_encoding) on brain.channel_legacy_notifications to "${role}";
      grant insert (dataset_label,dataset_label_raw,dataset_label_encoding) on brain.channel_legacy_deliveries to "${role}";`);
    if ((await client.query("select to_regprocedure('brain.reconcile_import_authority(uuid,text,text,bytea,text,text[],uuid,uuid,boolean)') as fn")).rows[0].fn) await client.query(`grant execute on function brain.reconcile_import_authority(uuid,text,text,bytea,text,text[],uuid,uuid,boolean) to "${role}"`);
    if ((await client.query("select to_regclass('brain.analysis_artifacts') as table")).rows[0].table) await client.query(`
      grant insert (report_date,report_date_raw,report_date_encoding,scope,scope_raw,scope_encoding,summary,summary_raw,summary_encoding,judgments,judgments_raw,judgments_encoding,evidence,evidence_raw,evidence_encoding,next_checks,next_checks_raw,next_checks_encoding,report_md,report_md_raw,report_md_encoding,model_raw,model_encoding) on brain.analyses to "${role}";
      grant insert (id,source,dataset,import_batch,analysis_id,file_request_id,role,source_work_item_id,source_attempt_token) on brain.analysis_artifacts to "${role}"`);
    await client.query('commit');
    // 비밀번호가 없거나 바뀐 경우 다른 자격 증명으로 대체하지 않는다.
    const roleUrl = new URL(databaseUrl); roleUrl.searchParams.delete('user'); roleUrl.searchParams.delete('password'); roleUrl.username = role; roleUrl.password = password;
    const verify = createPool({ databaseUrl: roleUrl.toString() });
    try { if ((await verify.query('select current_user as name')).rows[0].name !== role) throw new Error('확장 역할 연결 신원이 다릅니다'); } finally { await verify.end(); }
  } catch (error) { await client?.query('rollback').catch(() => {}); throw error; }
  finally { client?.release(); await pool.end(); await lock.query('select pg_advisory_unlock($1)', [4919270912]).catch(() => {}); lock.release(); await lockPool.end(); }
}
