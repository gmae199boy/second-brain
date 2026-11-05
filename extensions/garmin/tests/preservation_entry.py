"""Test-only supervised adapter for the preservation primitives; never installed in production."""
import hashlib
from decimal import Decimal
import json
import os
import sqlite3
import sys
from pathlib import Path
from uuid import UUID

import psycopg
from psycopg.rows import dict_row, tuple_row
from psycopg.types.json import set_json_loads

from batch_import import VERSION, canonical, check, conflict, contract_fingerprint, ingest
from capture_manifest import ROLES, load_capture
from preflight import ORDER
from raw_codec import dataset_ref
from role_probe import probe_role


def emit(kind, **values):
    print(json.dumps({'abi': 1, 'type': kind, **values}), flush=True)


def main():
    settings = json.loads(os.environ['BRAIN_SETTINGS_SNAPSHOT'])
    if settings.get('version') != 1 or settings.get('extension') != 'garmin':
        raise ValueError('IMPORT_INVALID')
    if UUID(settings['user_id']) != UUID(os.environ['BRAIN_USER_ID']):
        raise ValueError('IMPORT_INVALID')
    if settings['values'].get('garmin.timezone') != 'Asia/Seoul':
        raise ValueError('IMPORT_INVALID')
    conversation = settings['values'].get('garmin.legacy_conversation_id')
    if conversation is not None: conversation = str(UUID(conversation))
    options = '-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500'
    if Path(__file__).name == 'import_verify.py':
        from reports import write_reports
        from verify_compare import compare, public_projection
        names = ('datasets', 'import_batches', 'import_mapping', 'import_conflicts', 'import_checkpoints',
                 'source_schemas', 'preserved_rows', 'raw_payloads', 'legacy_conversations',
                 'artifact_inventory', 'artifact_relations', 'input_inventory')
        with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], options=options, row_factory=dict_row) as conn:
            with conn.transaction():
                check(conn.cursor(row_factory=tuple_row))
            with conn.transaction():
                conn.execute('set transaction isolation level repeatable read read only')
                with conn.cursor() as cursor:
                    set_json_loads(lambda data: json.loads(data, parse_float=Decimal), cursor)
                    stored = {name: cursor.execute('select * from garmin.' + name).fetchall() for name in names}
                    results = cursor.execute('select * from brain.file_request_results_public_v1').fetchall()
            try:
                capture = load_capture(settings['values']['garmin.capture_manifest'], secure=True)
                details = compare(capture, stored, results, conversation, preserve_artifacts=True)
                final = load_capture(settings['values']['garmin.capture_manifest'], secure=True)['private']
                if (final['fingerprint'], final['manifest_token']) != (capture['private']['fingerprint'], capture['private']['manifest_token']):
                    details['differences']['source_unchanged'].append('manifest_changed')
                    details['counts']['mismatches'] += 1
            except (ValueError, OSError, KeyError, TypeError, UnicodeError, sqlite3.DatabaseError):
                from verify_compare import CHECKS, COUNTS
                details = {'counts': {name: 0 for name in COUNTS}, 'differences': {name: ['input_invalid'] for name in CHECKS}, 'history': {}}
                details['counts']['mismatches'] = len(CHECKS)
            with conn.transaction(): check(conn.cursor(row_factory=tuple_row))
        public = public_projection(details)
        write_reports(os.environ['BRAIN_EXTENSION_HOME'], os.environ['BRAIN_WORK_ID'], details, public)
        if not all(public['checks'].values()): raise ValueError('EXTENSION_REPORT_NOT_READY')
    else:
        capture = load_capture(settings['values']['garmin.capture_manifest'])
        entries = sorted(capture['private']['datasets'], key=lambda e: ORDER.index(ROLES[e['source']]))
        entries = [{**entry, 'dataset': dataset_ref(entry['dataset']),
                    'dataset_label': entry['dataset'] if dataset_ref(entry['dataset']) != entry['dataset'] else None}
                   for entry in entries]
        from artifact_publish import publish
        capture['private']['fingerprint'] = contract_fingerprint(capture['private']['fingerprint'])
        with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], options=options) as conn:
            with conn.transaction():
                check(conn.cursor())
                if not all(probe_role(conn).values()): raise ValueError('IMPORT_INVALID')
            # Check every prior source before ingest can change any preservation row.
            for entry in entries:
                dataset = entry['dataset']
                path = capture['datasets'][ROLES[entry['source']]]
                batch = hashlib.sha256(canonical([capture['private']['capture_id'], dataset]).encode()).hexdigest()
                with conn.transaction():
                    cur = conn.cursor(); check(cur)
                    old = cur.execute('select source_hash,importer_version,manifest_fingerprint,source_role,conversation_id from garmin.import_checkpoints where batch=%s and dataset=%s', (batch, dataset)).fetchone()
                if path.with_name(path.name + '-wal').exists():
                    if old: conflict(conn, dataset, batch, None, None, 'wal_present')
                    raise ValueError('IMPORT_INVALID')
                with path.open('rb') as source: digest = hashlib.file_digest(source, 'sha256').hexdigest()
                if old and (old[:4] != (digest, VERSION, capture['private']['fingerprint'], entry['source']) or (str(old[4]) if old[4] else None) != conversation):
                    conflict(conn, dataset, batch, None, None, 'checkpoint_mismatch')
            verified = {e['dataset']: ingest(conn, capture, e, UUID(conversation) if conversation else None, native_mode=False) for e in entries}
            publish(conn, capture, entries, verified)
            from reports import write_reports
            from metadata_codec import decode_metadata
            from artifacts import decode_identity
            with conn.transaction():
                cur = conn.cursor(); check(cur)
                artifact_rows = cur.execute('select dataset,artifact_key,category,exclusion_reason,request_id,analysis_id,metadata,metadata_raw,unlinked_reason,original_table from garmin.artifact_inventory order by dataset,original_table,artifact_key').fetchall()
                inventory_rows = cur.execute('select dataset,category,state,metadata,metadata_raw from garmin.input_inventory order by dataset,category').fetchall()
                relation_rows = cur.execute('select dataset,artifact_key,analysis_key,role,request_id,analysis_id,reason from garmin.artifact_relations order by dataset,artifact_key,analysis_key,role').fetchall()
            private = {'artifacts': [{'dataset': r[0], 'key': decode_identity(r[1]), 'category': r[2], 'reason': r[3], 'request_id': str(r[4]) if r[4] else None, 'analysis_id': str(r[5]) if r[5] else None, 'metadata': decode_metadata(r[6], r[7]), 'unlinked_reason': r[8], 'original_table': r[9]} for r in artifact_rows],
                       'inventory': [{'dataset': r[0], 'category': r[1], 'state': r[2], 'metadata': decode_metadata(r[3], r[4])} for r in inventory_rows],
                       'relations': [{'dataset': r[0], 'artifact_key': decode_identity(r[1]), 'analysis_key': decode_identity(r[2]), 'role': r[3], 'request_id': str(r[4]) if r[4] else None, 'analysis_id': str(r[5]) if r[5] else None, 'reason': r[6]} for r in relation_rows],
                       'unassigned_files': [{'source': f['source'], 'reason': 'unknown_provenance'} for f in capture['private']['files']] if capture['private']['version'] == 1 else []}
            public = {'counts': {'artifacts': len(artifact_rows), 'excluded': sum(1 for r in artifact_rows if r[3]), 'unlinked': len({(r[0], r[1]) for r in relation_rows if r[6] and r[4] is not None} | {(r[0], r[1]) for r in artifact_rows if r[8]}), 'unassigned': len(private['unassigned_files'])}}
            write_reports(os.environ['BRAIN_EXTENSION_HOME'], os.environ['BRAIN_WORK_ID'], private, public)
    emit('result')


try:
    main()
except Exception as exc:
    code = str(exc) if str(exc) in ('IMPORT_CONFLICT', 'EXTENSION_REPORT_NOT_READY') else 'IMPORT_INVALID'
    state = getattr(exc, 'sqlstate', None)
    retryable = (state is None and isinstance(exc, psycopg.OperationalError)) or state in ('40001', '40P01', '55P03', '57014', '25P04', '57P01', '57P02', '57P03') or bool(state and state.startswith('08'))
    emit('error', code=code, retryable=retryable)
    sys.exit(1)
