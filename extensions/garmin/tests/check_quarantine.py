"""명시된 임시 PostgreSQL 포트에서만 보호 권한을 검증한다."""
from pathlib import Path
import sys
import psycopg

if len(sys.argv) != 2 or not sys.argv[1].isdigit():
    raise SystemExit('격리 fixture 포트가 필요합니다')
conn = psycopg.connect(host='127.0.0.1', port=int(sys.argv[1]), dbname='brain_quarantine_fixture',
                       user='postgres', password='fixture-only', autocommit=True)
assert conn.execute('select current_database()').fetchone()[0] == 'brain_quarantine_fixture'
assert not conn.execute("select exists(select 1 from pg_namespace where nspname='garmin')").fetchone()[0]
root = Path(__file__).resolve().parents[1]
conn.execute('create role brain_owner nologin')
conn.execute('create role brain_app login')
conn.execute('create role brain_ext_garmin login')
conn.execute('create schema brain authorization brain_owner')
conn.execute('create schema garmin authorization brain_owner')
conn.execute('grant usage on schema garmin to brain_app,brain_ext_garmin')
conn.execute('create table brain.work_items(id uuid primary key,kind text,target_kind text,target_id text,attempts bigint,cancel_requested_at timestamptz,hold_group text,schedule_id uuid)')
conn.execute('create table brain.work_hold_groups(name text primary key)')
conn.execute('create function brain.attempt_is_current(uuid,uuid) returns boolean language sql as $$select true$$')
conn.execute('set role brain_owner')
conn.execute('alter default privileges in schema garmin grant all on tables to brain_ext_garmin')
conn.execute('alter default privileges in schema garmin grant execute on functions to brain_ext_garmin')
conn.execute((root / 'migrations/0007_account_protection.sql').read_text())
conn.execute((root / 'protected-migrations/0008_protection_quarantine.sql').read_text())
conn.execute('create table garmin.future_fixture(id integer)')
conn.execute('create function garmin.future_fixture() returns integer language sql as $$select 1$$')
conn.execute('reset role')
for role in ('brain_app', 'brain_ext_garmin', 'public'):
    for table in ('account_protection', 'account_binding', 'external_call_intent', 'admission_holder', 'auth_success_evidence', 'future_fixture'):
        for privilege in ('INSERT', 'UPDATE', 'DELETE'):
            assert not conn.execute('select has_table_privilege(%s,%s,%s)', (role, 'garmin.' + table, privilege)).fetchone()[0], (role, table, privilege)
    for fn in ('garmin.reserve_work_admission(uuid,uuid,bigint,text,text)', 'garmin.finish_external_call(uuid,uuid,bigint,text,bigint,uuid,text)', 'garmin.future_fixture()'):
        assert not conn.execute('select has_function_privilege(%s,%s,%s)', (role, fn, 'EXECUTE')).fetchone()[0], (role, fn)
    assert not conn.execute('select has_schema_privilege(%s,%s,%s)', (role, 'garmin', 'CREATE')).fetchone()[0]
assert conn.execute("select has_table_privilege('brain_app','garmin.public_attention_v1','SELECT')").fetchone()[0]
print('격리 보호 권한 검사 통과')
conn.close()
