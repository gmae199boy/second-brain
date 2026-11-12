"""저장된 평가와 게시 파일의 결과 이벤트를 core에 기록한다."""
import hashlib
import json
import os
from garmin_pipeline import report_message, store


def _key(*parts):
    return 'garmin:' + hashlib.sha256(json.dumps(parts, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def _submit(conn, env, event, key, subject_date, revision, summary, document=None, albums=None, *, messages=None, intent=None):
    if messages is not None:
        return conn.execute('select brain.extension_event_emit_v2(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s)',
            (env['BRAIN_WORK_ID'], env['BRAIN_ATTEMPT_TOKEN'], event, key, subject_date, revision, summary,
             document, None if albums is None else json.dumps(albums, separators=(',', ':')),
             json.dumps(messages, ensure_ascii=False, separators=(',', ':')), intent)).fetchone()[0]
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


def success(cfg, day, revisions, document, env=None, *, attachment_rows=None, missing_reason=None, intent=None):
    import report_publish
    env = os.environ if env is None else env
    bundle = None if document is None else report_publish.saved_bundle(cfg, day, revisions, completed=False)
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            manifest = report_message.load_messages(conn, day, revisions)
            messages = report_message.delivery_messages(manifest, missing_reason)
            if intent is not None and messages is None:
                # 구 schema 강제 재발신도 저장 평문을 그대로 사용한다.
                from garmin_pipeline.report_message import MARKUP_PREFIX
                plain = manifest['summary']
                if plain.startswith(MARKUP_PREFIX):
                    import re
                    plain = '\n'.join(re.sub(r'^- ', '• ', re.sub(r'^#{1,2} ', '', line)).replace('**', '') for line in plain[len(MARKUP_PREFIX):].split('\n'))
                messages = [{'itemId': 'summary:legacy', 'text': plain}]
            summary = manifest.get('summary') or f'Garmin 운동 리포트 · {day.isoformat()} · 4개 기간'
            rows = attachment_rows if attachment_rows is not None else [] if document is None else conn.execute('''select i.name,i.kind,i.request_id from garmin.report_publication_items i
                join garmin.evaluation_files f on (f.user_id,f.connection_id,f.report_date,f.scope,f.revision,f.request_id)=(i.user_id,i.connection_id,i.report_date,i.scope,i.revision,i.request_id)
                where (i.user_id,i.connection_id,i.report_date,i.scope,i.revision)=(%s,%s,%s,%s,%s) and f.file_id is not null order by i.name''',
                (conn.user_id, conn.connection_id, day.isoformat(), 'day', revisions['day'])).fetchall()
            if missing_reason: summary += '\n\n보고서·그래프 없음 (' + missing_reason + ')'
            # 신규 scope 접두어는 scope 순서를 보존한다. 과거 이름은 그대로 정렬한다.
            graphs = sorted((row for row in rows if row[1] == 'graph'), key=lambda row: row[0])
            albums = []
            group = []
            group_key = None
            for name, kind, request in graphs:
                if len(name) < 2 or not name[:2].isdigit(): raise ValueError('invalid graph name')
                key = name.split('-', 2)[:2] if '-' in name else ['legacy', 'exercise' if int(name[:2]) < 50 else 'recovery']
                if group and (key != group_key or len(group) == 10):
                    albums.append(group)
                    group = []
                group_key = key
                group.append({'request_id': str(request), 'filename': name})
            if group: albums.append(group)
            version = _key(manifest['format'], manifest, messages, *[f'{scope}:{revisions[scope]}' for scope in ('day','7d','30d','all')],
                           'attachments-v2', None if document is None else _attachment_identity(bundle, albums), missing_reason)
            # 새 결과 구성은 새 이벤트이며, 같은 결과의 재시도는 같은 이벤트다.
            identity = _key(str(conn.user_id), str(conn.connection_id), day.isoformat(), 'report', version)
            return _submit(conn, env, 'garmin.report.completed', identity, day.isoformat(),
                           json.dumps(revisions, sort_keys=True, separators=(',', ':')), summary, document,
                           None if document is None else albums, messages=messages, intent=intent)


def failure(cfg, day, scopes, env=None):
    """성공한 평가 본문을 보내지 않고 같은 구독에 단일 실패 안내를 남긴다."""
    env = os.environ if env is None else env
    failed = [scope for scope in report_message.SCOPES if scope in scopes]
    labels = {'day': '1일', '7d': '7일', '30d': '30일', 'all': '전체'}
    text = (f'Garmin 리포트 · {day.isoformat()}\n' + '·'.join(labels[scope] for scope in failed)
            + ' 분석이 최초 실행과 최대 5회 재시도 후에도 실패했습니다. 성공한 기간 결과는 저장했습니다. 완성된 리포트는 발송하지 않았습니다.')
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            key = _key(str(conn.user_id), str(conn.connection_id), day.isoformat(), 'report-failed-v2', env['BRAIN_WORK_ID'])
            return _submit(conn, env, 'garmin.report.completed', key, day.isoformat(), None, text,
                           messages=[{'itemId': 'failure', 'text': text}])
