"""Hand saved evaluations and completed files to the core channel contract."""
import hashlib
import json
import os
from uuid import UUID
from garmin_pipeline import errors, ports, report, store


def _key(*parts):
    return 'garmin:' + hashlib.sha256(json.dumps(parts, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def _conversation(env):
    values = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'])['values']
    value = values['garmin.channel_conversation_id']
    parsed = UUID(value)
    if str(parsed) != value:
        raise ValueError('invalid channel conversation')
    return parsed


def _submit(conn, env, conversation, key, purpose, revision, summary, document=None, albums=None):
    return conn.execute('select brain.extension_channel_publish(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)',
        (env['BRAIN_WORK_ID'], env['BRAIN_ATTEMPT_TOKEN'], conversation, key, purpose, revision, summary,
         document, None if albums is None else json.dumps(albums, separators=(',', ':')))).fetchone()[0]


def success(cfg, day, revisions, document, env=None):
    env = os.environ if env is None else env
    conversation = _conversation(env)
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            summaries = {}
            for scope in ('day', '7d', '30d', 'all'):
                row = conn.execute('''select summary from garmin.evaluation_revisions where
                    (user_id,connection_id,report_date,scope,revision)=(%s,%s,%s,%s,%s)''',
                    (conn.user_id, conn.connection_id, day.isoformat(), scope, revisions[scope])).fetchone()
                if row is None: raise ValueError('missing evaluation')
                summaries[scope] = ' '.join(row[0].split())
            summary = report._combined_summary(summaries['day'], [f'{label}: {summaries[scope]}' for scope, label in (('7d','7일'),('30d','30일'),('all','전체'))])
            rows = conn.execute('''select i.name,i.kind,i.request_id from garmin.report_publication_items i
                join garmin.evaluation_files f on (f.user_id,f.connection_id,f.report_date,f.scope,f.revision,f.request_id)=(i.user_id,i.connection_id,i.report_date,i.scope,i.revision,i.request_id)
                where (i.user_id,i.connection_id,i.report_date,i.scope,i.revision)=(%s,%s,%s,%s,%s) and f.file_id is not null order by i.name''',
                (conn.user_id, conn.connection_id, day.isoformat(), 'day', revisions['day'])).fetchall()
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
            identity = _key(str(conn.user_id), str(conn.connection_id), day.isoformat(), 'report')
            version = _key(*[f'{scope}:{revisions[scope]}' for scope in ('day','7d','30d','all')])
            _submit(conn, env, conversation, identity, 'report', version, summary, document, albums)


def failure(cfg, day, env=None):
    env = os.environ if env is None else env
    conversation = _conversation(env)
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            key = _key(str(conn.user_id), str(conn.connection_id), day.isoformat(), 'report_failed')
            text = ports.notice_text(day, errors.NotifyEvent.REPORT_FAILED, 'analysis_failed')
            _submit(conn, env, conversation, key, 'report_failed', None, text)
