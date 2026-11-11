"""저장된 평가와 게시 파일의 결과 이벤트를 core에 기록한다."""
import hashlib
import json
import os
from garmin_pipeline import report_message, store


def _key(*parts):
    return 'garmin:' + hashlib.sha256(json.dumps(parts, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def _submit(conn, env, event, key, subject_date, revision, summary, document=None, albums=None):
    return conn.execute('select brain.extension_event_emit(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)',
        (env['BRAIN_WORK_ID'], env['BRAIN_ATTEMPT_TOKEN'], event, key, subject_date, revision, summary,
         document, None if albums is None else json.dumps(albums, separators=(',', ':')))).fetchone()[0]


def _attachment_identity(bundle, albums):
    # 게시 사본의 target·UUID 대신 불변 저장 바이트로 결과 구성을 식별한다.
    if bundle is None:
        raise ValueError('missing saved report artifacts')
    document, rows = bundle
    graphs = {name: hashlib.sha256(bytes(content)).hexdigest() for name, _, content, _, _ in rows}
    return [hashlib.sha256(bytes(document[1])).hexdigest(),
            [[(photo['filename'], graphs[photo['filename']]) for photo in album] for album in albums]]


def success(cfg, day, revisions, document, env=None, *, attachment_rows=None, missing_reason=None):
    import report_publish
    env = os.environ if env is None else env
    bundle = None if document is None else report_publish.saved_bundle(cfg, day, revisions, completed=False)
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            summary = report_message.load(conn, day, revisions)
            rows = attachment_rows if attachment_rows is not None else [] if document is None else conn.execute('''select i.name,i.kind,i.request_id from garmin.report_publication_items i
                join garmin.evaluation_files f on (f.user_id,f.connection_id,f.report_date,f.scope,f.revision,f.request_id)=(i.user_id,i.connection_id,i.report_date,i.scope,i.revision,i.request_id)
                where (i.user_id,i.connection_id,i.report_date,i.scope,i.revision)=(%s,%s,%s,%s,%s) and f.file_id is not null order by i.name''',
                (conn.user_id, conn.connection_id, day.isoformat(), 'day', revisions['day'])).fetchall()
            if missing_reason: summary += '\n\n보고서·그래프 없음 (' + missing_reason + ')'
            groups = [[], []]
            for name, kind, request in rows:
                if kind != 'graph': continue
                if len(name) < 2 or not name[:2].isdigit(): raise ValueError('invalid graph name')
                number = int(name[:2])
                if 1 <= number <= 49: index = 0
                elif 50 <= number <= 99: index = 1
                else: raise ValueError('invalid graph group')
                groups[index].append({'request_id': str(request), 'filename': name})
            albums = [group[start:start + 10] for group in groups for start in range(0, len(group), 10)]
            version = _key(report_message.FORMAT_VERSION, *[f'{scope}:{revisions[scope]}' for scope in ('day','7d','30d','all')],
                           'attachments-v2', None if document is None else _attachment_identity(bundle, albums), missing_reason)
            # 새 결과 구성은 새 이벤트이며, 같은 결과의 재시도는 같은 이벤트다.
            identity = _key(str(conn.user_id), str(conn.connection_id), day.isoformat(), 'report', version)
            return _submit(conn, env, 'garmin.report.completed', identity, day.isoformat(),
                           json.dumps(revisions, sort_keys=True, separators=(',', ':')), summary, document,
                           None if document is None else albums)
