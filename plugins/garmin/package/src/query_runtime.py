"""Read-only command ABI; no supervisor attempt or configuration file is needed."""
import json
import os
import sys
from uuid import UUID

import psycopg
from garmin_pipeline import store
import query


def run(command, envelope, database_url):
    if not isinstance(envelope, dict) or set(envelope) != {'abi', 'user_id', 'settings', 'input'} or type(envelope['abi']) is not int or envelope['abi'] != 1 or not isinstance(envelope['settings'], dict):
        raise ValueError('invalid envelope')
    user = UUID(envelope['user_id'])
    if str(user) != envelope['user_id']: raise ValueError('invalid user')
    query.validate(command, envelope['input'])
    with psycopg.connect(database_url, autocommit=True, options='-c statement_timeout=10000 -c transaction_timeout=11000') as conn:
        conn.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        if conn.execute('select garmin.native_schema_version()').fetchone()[0] != store.NATIVE_SCHEMA_VERSION:
            raise ValueError('invalid schema')
        return query.execute(conn, user, command, envelope['input'])


def main(command):
    try:
        result = run(command, json.load(sys.stdin), os.environ['BRAIN_DATABASE_URL'])
        print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(',', ':')))
    except Exception:
        raise SystemExit(1)
