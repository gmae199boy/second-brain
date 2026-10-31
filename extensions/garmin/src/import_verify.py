"""감독자가 제공한 private snapshot과 원본 capture를 읽기 전용으로 비교한다."""
import json
from decimal import Decimal
import os
import sys
import sqlite3
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import set_json_loads
from capture_manifest import load_capture
from reports import write_reports
from verify_compare import compare, public_projection, read_core_snapshot


def emit(kind, **values):
    print(json.dumps({'abi': 1, 'type': kind, **values}), flush=True)


def main():
    settings = json.loads(os.environ['BRAIN_SETTINGS_SNAPSHOT'])
    if settings.get('version') != 1 or settings.get('extension') != 'garmin': raise ValueError('IMPORT_INVALID')
    work = str(UUID(os.environ['BRAIN_WORK_ID'])); token = str(UUID(os.environ['BRAIN_ATTEMPT_TOKEN']))
    snapshot = read_core_snapshot(os.environ['BRAIN_EXTENSION_HOME'], os.environ['BRAIN_IMPORT_VERIFICATION_SNAPSHOT'], work, token)
    conversation = settings['values'].get('garmin.legacy_conversation_id')
    if conversation: conversation = str(UUID(conversation))
    names = ('datasets','import_batches','import_mapping','import_conflicts','import_checkpoints','source_schemas','preserved_rows','raw_payloads','import_provenance','authority_provenance','legacy_conversations','artifact_inventory','input_inventory','artifact_relations')
    with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500', row_factory=dict_row) as conn:
        with conn.transaction():
            current = conn.execute('select garmin.attempt_valid(%s::uuid,%s::uuid) as current', (work,token)).fetchone()
            if not current or not current['current']: raise ValueError('IMPORT_INVALID')
        with conn.transaction():
            conn.execute('set transaction read only')
            catalog = [row['definition'] for row in conn.execute('select definition from brain.health_catalog_v1')]
            # 내부 검증 cursor에만 적용해 catalog 및 다른 consumer는 그대로 둔다.
            with conn.cursor() as cursor:
                set_json_loads(lambda data: json.loads(data, parse_float=Decimal), cursor)
                stored = {name: cursor.execute('select * from garmin.' + name).fetchall() for name in names}
        try:
            capture = load_capture(settings['values']['garmin.capture_manifest'], secure=True)
            details = compare(capture, stored, snapshot, catalog, conversation)
            if (lambda final: (final['fingerprint'], final['manifest_token']) != (capture['private']['fingerprint'], capture['private']['manifest_token']))(load_capture(settings['values']['garmin.capture_manifest'], secure=True)['private']):
                details['differences']['source_unchanged'].append('manifest_changed')
                details['counts']['mismatches'] += 1
        except (ValueError, OSError, KeyError, TypeError, UnicodeError, sqlite3.DatabaseError):
            from verify_compare import CHECKS, COUNTS
            details = {'counts': {name: 0 for name in COUNTS}, 'differences': {name: ['input_invalid'] for name in CHECKS}, 'history': {'rerun': '미입증', 'resume': '미입증', 'outbound': '미입증'}}
            details['counts']['mismatches'] = len(CHECKS)
        with conn.transaction():
            current = conn.execute('select garmin.attempt_valid(%s::uuid,%s::uuid) as current', (work,token)).fetchone()
            if not current or not current['current']: raise ValueError('IMPORT_INVALID')
    public = public_projection(details)
    write_reports(os.environ['BRAIN_EXTENSION_HOME'], work, details, public)
    if not all(public['checks'].values()): raise ValueError('EXTENSION_REPORT_NOT_READY')
    emit('result')


try:
    main()
except Exception as exc:
    code = 'EXTENSION_REPORT_NOT_READY' if str(exc) == 'EXTENSION_REPORT_NOT_READY' else 'IMPORT_INVALID'
    emit('error', code=code, retryable=False)
    sys.exit(1)
