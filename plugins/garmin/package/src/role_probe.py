"""확장 역할의 필수 권한과 최소 권한을 읽기 전용으로 확인한다."""
import psycopg

REQUIRED_INSERTS = {
    'channel_requests': 'id conversation_id producer producer_result_id purpose revision body created_at bundle source_work_item_id source_attempt_token',
    'channel_legacy_notifications': 'id conversation_id source dataset original_table original_key import_batch local_date event detail at source_work_item_id source_attempt_token local_date_raw local_date_encoding event_raw event_encoding detail_raw detail_encoding dataset_label dataset_label_raw dataset_label_encoding',
    'channel_legacy_deliveries': 'id conversation_id source dataset original_table original_key import_batch original_id local_date kind event ok reason at source_work_item_id source_attempt_token original_id_raw original_id_encoding local_date_raw local_date_encoding kind_raw kind_encoding event_raw event_encoding reason_raw reason_encoding dataset_label dataset_label_raw dataset_label_encoding',
    'file_requests': 'id source request_key dataset import_batch locator sha256 size_bytes media_type created_at source_work_item_id source_attempt_token metadata',
}
REQUIRED_INSERTS = {name: frozenset(columns.split()) for name, columns in REQUIRED_INSERTS.items()}
VIEWS = frozenset(('extension_status_public_v1', 'file_request_results_public_v1'))


def safely(conn, query, args=(), default=None):
    """실패한 probe가 바깥 트랜잭션을 오염시키지 않게 한다."""
    try:
        with conn.transaction():
            return conn.execute(query, args).fetchall()
    except psycopg.Error:
        return default


def probe_role(conn):
    checks = {'identity': False, 'role_safe': False, 'membership_absent': False, 'schema_ready': False,
              'required_inserts': False, 'required_views': False, 'no_excess_tables': False,
              'no_excess_functions': False, 'no_excess_schemas': False, 'attempt_execute': False,
              'original_codec_execute': False, 'predecessor_execute': False,
              'mapping_select': False, 'batch_select': False}
    roles = safely(conn, """select current_user, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication,
        shobj_description(oid,'pg_authid') = 'second-brain extension:' || current_database(),
        exists(select 1 from pg_auth_members where member=pg_roles.oid or roleid=pg_roles.oid)
        from pg_roles where rolname=current_user""")
    if roles:
        role, login, superuser, bypass, createdb, createrole, replication, marker, member = roles[0]
        checks['identity'] = role == 'brain_ext_garmin' and marker is True
        checks['role_safe'] = bool(login and not any((superuser, bypass, createdb, createrole, replication)))
        checks['membership_absent'] = not member
    schemas = safely(conn, """select coalesce(has_schema_privilege(current_user,to_regnamespace('brain'),'USAGE'),false),
      coalesce(has_schema_privilege(current_user,to_regnamespace('garmin'),'USAGE'),false) and coalesce(has_schema_privilege(current_user,to_regnamespace('garmin'),'CREATE'),false),
      exists(select 1 from pg_namespace n where n.nspname <> 'garmin' and n.nspname not like 'pg_%%' and n.nspname <> 'information_schema' and has_schema_privilege(current_user,n.oid,'CREATE')),
      exists(select 1 from pg_namespace n where n.nspname <> 'garmin' and n.nspname not in ('brain','public','information_schema') and n.nspname not like 'pg_%%' and has_schema_privilege(current_user,n.oid,'USAGE'))""")
    if schemas:
        brain, own, create_excess, usage_excess = schemas[0]
        checks['schema_ready'] = brain and own
        checks['no_excess_schemas'] = not (create_excess or usage_excess)
    attempt = safely(conn, "select coalesce(has_function_privilege(current_user,to_regprocedure('brain.attempt_is_current(uuid,uuid)'),'EXECUTE'),false)")
    checks['attempt_execute'] = bool(attempt and attempt[0][0])
    predecessor = safely(conn, "select coalesce(has_function_privilege(current_user,to_regprocedure('brain.extension_predecessor_results(uuid,uuid)'),'EXECUTE'),false)")
    checks['predecessor_execute'] = bool(predecessor and predecessor[0][0])
    helpers = safely(conn, """select coalesce(has_function_privilege(current_user,to_regprocedure('brain.original_utf8(text)'),'EXECUTE'),false)""")
    if helpers:
        checks['original_codec_execute'] = helpers[0][0]
    objects = safely(conn, """select c.relname,
       has_table_privilege(current_user,c.oid,'SELECT'),
       has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
       has_any_column_privilege(current_user,c.oid,'SELECT'),
       has_any_column_privilege(current_user,c.oid,'UPDATE,REFERENCES'),
       array(select a.attname from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and has_column_privilege(current_user,c.oid,a.attname,'INSERT'))
       from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='brain' and c.relkind in ('r','p','v','m','S','f')""")
    if objects is not None:
        by_name = {r[0]: r for r in objects}
        checks['required_views'] = all(name in by_name and by_name[name][1] for name in VIEWS)
        checks['required_inserts'] = all(name in by_name and required <= set(by_name[name][5]) for name, required in REQUIRED_INSERTS.items())
        checks['no_excess_tables'] = all(not write and not modify and (name in VIEWS or not select and not select_col) and set(insert_cols) <= REQUIRED_INSERTS.get(name, frozenset()) for name, select, write, select_col, modify, insert_cols in objects)
    functions = safely(conn, """select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='brain' and p.prorettype <> 'pg_catalog.trigger'::regtype
       and p.oid is distinct from to_regprocedure('brain.attempt_is_current(uuid,uuid)') and p.oid is distinct from to_regprocedure('brain.original_utf8(text)') and p.oid is distinct from to_regprocedure('brain.extension_predecessor_results(uuid,uuid)') and p.oid is distinct from to_regprocedure('brain.extension_channel_publish(uuid,uuid,uuid,text,text,text,text,uuid,jsonb)')
       and has_function_privilege(current_user,p.oid,'EXECUTE'))""")
    checks['no_excess_functions'] = bool(functions is not None and not functions[0][0])
    own = safely(conn, """select coalesce(has_table_privilege(current_user,to_regclass('garmin.import_mapping'),'SELECT'),false),
      coalesce(has_table_privilege(current_user,to_regclass('garmin.import_batches'),'SELECT'),false)""")
    if own:
        checks['mapping_select'], checks['batch_select'] = own[0]
    return checks
