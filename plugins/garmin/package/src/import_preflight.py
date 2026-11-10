"""감독된 preflight 진입점. 원본과 대상 계약 표에는 쓰지 않는다."""
import json
import hashlib
import os
import sys
import psycopg
from preflight import analyze, readiness, public_report, classify_files, estimate_candidates
from reports import write_reports
from capture_manifest import load_capture, ROLES
from import_scope import selected_capture, recheck_capture
from role_probe import probe_role, safely


def emit(kind, **values):
    print(json.dumps({'abi': 1, 'type': kind, **values}), flush=True)


def main():
    settings = json.loads(os.environ['BRAIN_SETTINGS_SNAPSHOT'])
    if settings.get('version') != 1 or settings.get('extension') != 'garmin':
        raise ValueError('PREFLIGHT_INVALID')
    manifest = settings['values']['garmin.capture_manifest']
    full_capture = load_capture(manifest, secure=True)
    capture = selected_capture(full_capture)
    def digest(path):
        with path.open('rb') as stream:
            return hashlib.file_digest(stream, 'sha256').hexdigest()
    hashes = {role: digest(path) for role, path in capture['datasets'].items()}
    report = analyze(capture['datasets'], fixed4=capture['private']['version'] == 3)
    if capture['private']['version'] == 3:
        from native_import import validate_sources
        from reader import read_snapshot
        entries = capture['private']['datasets']
        verified = {e['dataset']: {'snapshot': read_snapshot(capture['datasets'][ROLES[e['source']]])} for e in entries}
        validate_sources(entries, verified, fixed4=True)
    recheck_capture(manifest, full_capture)
    after = {role: digest(path) for role, path in capture['datasets'].items()}
    if hashes != after:
        raise ValueError('PREFLIGHT_INVALID')
    metadata = json.loads(os.environ['BRAIN_EXTENSION_READINESS'])
    with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], options='-c statement_timeout=1900 -c lock_timeout=1500') as conn:
        checks = probe_role(conn)
        attempt_rows = safely(conn, 'select garmin.attempt_valid(%s::uuid,%s::uuid)', (os.environ['BRAIN_WORK_ID'], os.environ['BRAIN_ATTEMPT_TOKEN'])) if checks['attempt_execute'] else None
        current = attempt_rows[0][0] if attempt_rows else None
        batch_rows = safely(conn, 'select id,dataset from garmin.import_batches order by id') if checks['batch_select'] else None
        mapping_rows = safely(conn, 'select count(*) from garmin.import_mapping') if checks['mapping_select'] else None
        checks['batch_select'] = batch_rows is not None
        checks['mapping_select'] = mapping_rows is not None
        checkpoint_rows = safely(conn, 'select batch,dataset,source_hash,schema_version,importer_version,manifest_fingerprint,source_role,original_table,original_key,conversation_id from garmin.import_checkpoints order by dataset,batch')
        checkpoints = [{'batch': r[0], 'dataset': r[1], 'source_hash': r[2], 'schema': r[3], 'importer_version': r[4], 'manifest_fingerprint': r[5], 'source_role': r[6], 'table': r[7], 'key': r[8], 'conversation_id': str(r[9]) if r[9] else None} for r in (checkpoint_rows or [])]
        batches = [{'id': row[0], 'dataset': row[1]} for row in batch_rows] if batch_rows is not None else []
        mappings = mapping_rows[0][0] if mapping_rows else None
        ready = readiness(metadata, 'brain_ext_garmin' if all(checks.values()) else '', current, batches)
        ready['catalog'] = checks
        files = classify_files(capture['private']['files'])
        estimates = estimate_candidates(report, files, mappings)
        report.update(file_classification=files, unit_risks=[], capture=capture['private'], readiness=ready, existing_mapping_count=mappings, source_unchanged=True, snapshot_hashes=hashes,
                      estimates=estimates,
                  risks=['원래 NULL의 결측 원인은 복원할 수 없음', '원본 단위와 정규화 버전을 별도로 검증해야 함'],
                      exclusions=[{'category': group, 'count': files['groups'][group], 'reason': reason} for group, reason in [('config', '비밀·기계 설정 제외'), ('unknown', '분류 확인 전 제외')] if files['groups'][group]],
                      checkpoint={'available': checkpoint_rows is not None, 'entries': checkpoints}, publication_reasons=[])
        public = public_report(report, ready)
        if current is False:
            raise ValueError('PREFLIGHT_STALE')
        write_reports(os.environ['BRAIN_EXTENSION_HOME'], os.environ['BRAIN_WORK_ID'], report, public)
        if not ready['ready']:
            raise ValueError('EXTENSION_REPORT_NOT_READY')
    emit('result')


try:
    main()
except Exception as exc:
    code = str(exc) if isinstance(exc, ValueError) and str(exc) in ('PREFLIGHT_INVALID', 'PREFLIGHT_SCHEMA_UNSUPPORTED', 'EXTENSION_REPORT_NOT_READY', 'PREFLIGHT_STALE') else 'PREFLIGHT_INVALID'
    emit('error', code=code, retryable=False)
    sys.exit(1)
