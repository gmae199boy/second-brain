"""Supervised, network-free publication of artifacts from a collect result."""
from datetime import date, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import time

import psycopg
import artifact_inputs
import body_runtime
import collect
import collect_settings
import collect_store
import digest
import labels
import normalize_runtime
import runtime_files


def run(env=None, connect=psycopg.connect):
    env = os.environ if env is None else env
    pattern = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    if (env.get('BRAIN_ABI_VERSION') != '1' or env.get('BRAIN_WORK_KIND') != 'garmin.artifacts'
        or env.get('BRAIN_TARGET_KIND') != 'extension' or not env.get('BRAIN_TARGET_ID')
        or not all(re.fullmatch(pattern, env.get(k, '')) for k in ('BRAIN_WORK_ID', 'BRAIN_ATTEMPT_TOKEN'))
        or not re.fullmatch(r'[1-9][0-9]{0,8}', env.get('BRAIN_RUN_GENERATION', ''))
        or not re.match(r'^postgres(?:ql)?://', env.get('BRAIN_DATABASE_URL', ''))):
        raise ValueError('ARTIFACT_INVALID')
    work, token = env['BRAIN_WORK_ID'], env['BRAIN_ATTEMPT_TOKEN']
    home = Path(env['BRAIN_EXTENSION_HOME'])
    collect_settings.decode(env.get('BRAIN_SETTINGS_SNAPSHOT'), require_timezone=True)
    with connect(env['BRAIN_DATABASE_URL'], autocommit=True, options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500') as conn:
        rows = conn.execute('select id,kind,target_kind,target_id,result_summary,previous_result from brain.extension_predecessor_results(%s,%s)', (work,token)).fetchall()
        parents = [r for r in rows if r[1] in ('garmin.collect','garmin.collect_retry','garmin.collect_recent')]
        if len(parents) != 1 or not isinstance(parents[0][4], dict):
            raise ValueError('ARTIFACT_COLLECT_REQUIRED')
        parent, _, target_kind, target_id, result, previous = parents[0]
        if result.get('status') not in ('success','noop') or type(result.get('cutoff_ms')) is not int:
            raise ValueError('ARTIFACT_COLLECT_REQUIRED')
        from zoneinfo import ZoneInfo
        zone = result['timezone']
        ZoneInfo(zone)
        report_day = date.fromisoformat(result['local_date'])
        cutoff = datetime.fromtimestamp(result['cutoff_ms']/1000, ZoneInfo(zone)).isoformat(timespec='milliseconds')
        account = target_id if target_kind == 'account' else collect_store.target_account(conn,target_kind,target_id)
        if account is None:
            raise ValueError('ARTIFACT_COLLECT_REQUIRED')
        measurements, provenance = body_runtime.ingest(conn,str(home),account,work,token,report_day)
        collect.boundary('수집 snapshot 읽기')
        snapshot = collect_store.artifact_snapshot(conn,account,result['snapshot_id'],parent)
        raw = snapshot['raw']
        previous_cutoff = previous.get('cutoff_ms') if isinstance(previous,dict) and type(previous.get('cutoff_ms')) is int else None
        days,activities,workouts,starts,notes = artifact_inputs.prepare(raw,report_day,result['cutoff_ms'],zone,previous_cutoff)
        label_bytes = labels.load_bytes()
        manifest = {'report_date':report_day.isoformat(),'yesterday':(report_day-timedelta(days=1)).isoformat(),
                    'baseline_days':[(report_day-timedelta(days=i)).isoformat() for i in range(7,0,-1)],
                    'timezone':zone,'data_cutoff':cutoff,'workouts':workouts,'_workout_starts_ms':starts,
                    'weekday':'월화수목금토일'[report_day.weekday()],'notes':notes,'collect':result}
        document = digest.build(manifest,days,activities,labels.load(label_bytes),measurements)
        data = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
        revision_input = {'digest_sha256':hashlib.sha256(data).hexdigest(), 'raw':collect_store.raw_fingerprint(raw),
                          'labels_sha256':hashlib.sha256(label_bytes).hexdigest(), 'body_sources':provenance,
                          'previous_cutoff_ms':previous_cutoff}
        revision = hashlib.sha256(json.dumps(revision_input,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()
        meta = {'collect_result_id':str(parent),'cutoff_ms':result['cutoff_ms'],'timezone':zone,
                'local_date':report_day.isoformat(),'revision':revision,'kind':'digest'}
        collect.boundary('날짜 건강 요약 발행')
        _, failed = normalize_runtime.rebuild(conn,account,work,token,zone,collect.boundary)
        if failed:
            raise ValueError('ARTIFACT_NORMALIZE_FAILED')
        file_id, status = runtime_files.request(conn,str(home),account,work,token,'digest',str(parent),data,meta,result['cutoff_ms'])
        while status != 'completed':
            if status == 'failed':
                raise ValueError('ARTIFACT_FILE_FAILED')
            collect.boundary('파일 등록 확인 대기')
            time.sleep(1)
            with collect_store._write(conn,account,work,token) as (cur,_):
                row = cur.execute('select status from brain.file_request_results_public_v1 where request_id=%s',(file_id,)).fetchone()
                status = row[0] if row else 'pending'
        collect.emit('result', summary=json.dumps({'status':'success','request_id':str(file_id),'revision':revision},separators=(',',':')))


def main():
    signal.signal(signal.SIGTERM,collect._stop)
    signal.signal(signal.SIGINT,collect._stop)
    try:
        run()
    except (psycopg.OperationalError, psycopg.errors.LockNotAvailable, psycopg.errors.QueryCanceled, psycopg.errors.SerializationFailure, psycopg.errors.DeadlockDetected):
        collect.emit('error',code='ARTIFACT_DB_RETRY',retryable=True)
        return 1
    except Exception as exc:
        if isinstance(exc,ValueError) and str(exc) == 'COLLECT_RAW_CHANGED':
            collect.emit('error',code='ARTIFACT_DB_RETRY',retryable=True)
            return 1
        allowed = ('ARTIFACT_INVALID','ARTIFACT_COLLECT_REQUIRED','ARTIFACT_BODY_PENDING','ARTIFACT_NORMALIZE_FAILED','ARTIFACT_FILE_FAILED','COLLECT_INVALID_ATTEMPT','COLLECT_STOPPED')
        code = str(exc) if isinstance(exc,ValueError) and str(exc) in allowed else 'ARTIFACT_INVALID'
        collect.emit('error',code=code,retryable=code == 'ARTIFACT_BODY_PENDING')
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
