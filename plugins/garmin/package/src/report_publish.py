"""Durable, revision-scoped publication through the core file contract."""
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5, uuid7

from artifacts import MAX_BYTES, locator_for, stage
from garmin_pipeline import charts, report, store, training_charts


class RenderUnavailable(Exception):
    pass


class FilesPending(Exception):
    pass


class FilesFailed(Exception):
    pass


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _identity(conn, day, scope, revision):
    return (conn.user_id, conn.connection_id, day.isoformat(), scope, revision)


def _load_scope_measurements(cfg, structured):
    from garmin_pipeline.training_measurements import resolve_snapshot_root, load_training_measurements
    root = resolve_snapshot_root(cfg, structured['snapshot_id'])
    measurements = load_training_measurements(root, structured['scope'])
    expected = structured['range']
    actual = {'start': measurements['current']['from'], 'end': measurements['current']['to'],
              'timezone': measurements['timezone']}
    if (measurements['snapshot_id'] != structured['snapshot_id'] or actual != expected or
            measurements['scope'] != structured['scope'] or
            measurements['data_cutoff'] != structured['data_cutoff'] or
            measurements['schema_version'] != structured['measurements_version'] or
            measurements['profile']['snapshot_id'] != structured['profile_snapshot_id']):
        raise ValueError('graph snapshot identity mismatch')
    return measurements


def _prepare(cfg, day, scope, revision, revisions=None, *, render_unavailable=False):
    """기간 revision과 같은 C1 snapshot의 그림을 쓰기 잠금 밖에서 고정한다."""
    with store.write_session(cfg) as conn:
        key = _identity(conn, day, scope, revision)
        with store.transaction(conn):
            exists = conn.execute('select 1 from garmin.report_publications where (user_id,connection_id,report_date,scope,revision)=(%s,%s,%s,%s,%s)', key).fetchone()
            if exists:
                return
            row = conn.execute("select report_md,to_jsonb(r)->'structured' from garmin.evaluation_revisions r where (user_id,connection_id,report_date,scope,revision)=(%s,%s,%s,%s,%s)", key).fetchone()
            if row is None:
                raise ValueError('missing evaluation revision')
            structured = row[1] if len(row) > 1 else None
            scoped = isinstance(structured, dict) and structured.get('schema_version') == 'garmin.scope_analysis.v2'
            if scoped and structured['scope'] != scope:
                raise ValueError('graph revision scope mismatch')
            names = [] if scope == 'day' or scoped else conn.execute("select name from garmin.report_publication_items where (user_id,connection_id,report_date,scope,revision)=(%s,%s,%s,'day',%s) and kind='graph' order by name", (key[0],key[1],key[2],revisions['day'])).fetchall()
    if scope == 'day' or scoped:
        try:
            with tempfile.TemporaryDirectory(prefix='garmin-report-') as folder:
                if scoped:
                    measurements = _load_scope_measurements(cfg, structured)
                    graphs = training_charts.render(measurements, Path(folder), cache_dir=cfg.data_dir / '.matplotlib')
                else:
                    graphs = charts.render(cfg, day, Path(folder), strict=True)
                document = report._assemble(row[0], day, graphs)
                if scoped:
                    manifest = next(Path(folder).glob('*-manifest.json')).read_bytes()
                    document += b'\n\n<!-- training-graph-manifest\n' + manifest + b'\n-->\n'
                items = [('report.md', 'report', 'text/markdown', document)]
                for graph in graphs:
                    if Path(graph.name).name != graph.name:
                        raise ValueError('invalid graph name')
                    items.append((graph.name, 'graph', 'image/png', (Path(folder) / graph.name).read_bytes()))
        except (OSError, charts.ChartRenderFailed) as exc:
            if render_unavailable: raise RenderUnavailable() from exc
            raise
    else:
        graphs = [charts.Graph(name, name) for (name,) in names]
        items = [('report.md', 'report', 'text/markdown', report._assemble(row[0], day, graphs))]
    if len({item[0] for item in items}) != len(items) or any(len(item[3]) > MAX_BYTES for item in items):
        raise ValueError('invalid report artifacts')
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            # A second fenced observation protects against a revoked attempt while rendering.
            exists = conn.execute('select 1 from garmin.report_publications where (user_id,connection_id,report_date,scope,revision)=(%s,%s,%s,%s,%s)', key).fetchone()
            if exists:
                return
            conn.execute('insert into garmin.report_publications(user_id,connection_id,report_date,scope,revision) values (%s,%s,%s,%s,%s)', key)
            for name, kind, media, data in items:
                conn.execute('insert into garmin.report_publication_items(user_id,connection_id,report_date,scope,revision,name,kind,media_type,content,request_id) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (*key, name, kind, media, data, uuid7()))


def publish(cfg, day, revisions, env=None):
    env = os.environ if env is None else env
    for scope in ('day', '7d', '30d', 'all'):
        if scope in revisions:
            _prepare(cfg, day, scope, revisions[scope], revisions)
    pending = failed = False
    with store.write_session(cfg) as conn:
        for scope, revision in revisions.items():
            key = _identity(conn, day, scope, revision)
            with store.transaction(conn):
                rows = conn.execute('''select i.name,i.kind,i.media_type,i.content,i.request_id,p.created_at
                    from garmin.report_publication_items i join garmin.report_publications p using(user_id,connection_id,report_date,scope,revision)
                    where (i.user_id,i.connection_id,i.report_date,i.scope,i.revision)=(%s,%s,%s,%s,%s) order by i.name''', key).fetchall()
            for name, kind, media, content, request, created in rows:
                data = bytes(content)
                identity = _json([str(key[0]), str(key[1]), key[2], scope, revision, name])
                dataset = 'report:' + _hash(_json([str(key[0]), str(key[1])]).encode())
                batch = _hash(_json([dataset, key[2], scope, revision]).encode())
                path_hash = _hash(_json(['generated', key[2], scope, revision, name]).encode())
                metadata = _json({'kind': kind, 'report_date': key[2], 'scope': scope, 'original_path_hash': path_hash,
                                  **(training_charts.png_metadata(data) if kind == 'graph' else {})})
                locator = locator_for(dataset, 'report', identity, _hash(data))
                with store.transaction(conn):
                    result = conn.execute('select status,file_id from brain.file_request_results_public_v1 where request_id=%s', (request,)).fetchone()
                if not result or result[0] != 'completed':
                    stage(env['BRAIN_EXTENSION_HOME'], dataset, 'report', identity, data)
                with store.transaction(conn):
                    conn.execute('''insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata)
                        values (%s,'garmin',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)''',
                        (request, identity, dataset, batch, locator, _hash(data), len(data), media, created, env['BRAIN_WORK_ID'], env['BRAIN_ATTEMPT_TOKEN'], metadata))
                    conn.execute('''insert into garmin.evaluation_files(user_id,connection_id,report_date,scope,revision,request_id,kind,original_path_hash)
                        values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict do nothing''', (*key, request, kind, path_hash))
                    if kind == 'graph' and training_charts.scope_from_name(name) is None:
                        for other_scope, other_revision in revisions.items():
                            if other_scope == scope:
                                continue
                            conn.execute('''insert into garmin.evaluation_files(user_id,connection_id,report_date,scope,revision,request_id,kind,original_path_hash)
                                values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict do nothing''',
                                (key[0], key[1], key[2], other_scope, other_revision, request, kind, path_hash))
                    result = conn.execute('select status,file_id from brain.file_request_results_public_v1 where request_id=%s', (request,)).fetchone()
                    if result and result[0] == 'completed' and result[1] is not None:
                        conn.execute('''update garmin.evaluation_files set file_id=%s where (user_id,connection_id,report_date,scope,revision,request_id)=(%s,%s,%s,%s,%s,%s) and (file_id is null or file_id=%s)''', (result[1], *key, request, result[1]))
                        link = conn.execute('''select kind,original_path_hash,file_id from garmin.evaluation_files where (user_id,connection_id,report_date,scope,revision,request_id)=(%s,%s,%s,%s,%s,%s)''', (*key, request)).fetchone()
                        if link != (kind, path_hash, result[1]):
                            raise ValueError('file relation conflict')
                        if kind == 'graph' and training_charts.scope_from_name(name) is None:
                            for other_scope, other_revision in revisions.items():
                                if other_scope == scope:
                                    continue
                                other = (key[0], key[1], key[2], other_scope, other_revision, request)
                                conn.execute('''update garmin.evaluation_files set file_id=%s where (user_id,connection_id,report_date,scope,revision,request_id)=(%s,%s,%s,%s,%s,%s) and (file_id is null or file_id=%s)''', (result[1], *other, result[1]))
                                link = conn.execute('''select kind,original_path_hash,file_id from garmin.evaluation_files where (user_id,connection_id,report_date,scope,revision,request_id)=(%s,%s,%s,%s,%s,%s)''', other).fetchone()
                                if link != (kind, path_hash, result[1]): raise ValueError('file relation conflict')
                    elif result and result[0] == 'failed':
                        failed = True
                    else:
                        pending = True
    if failed:
        raise FilesFailed()
    if pending:
        raise FilesPending()


def revision_key(revisions):
    return _hash(_json([[scope, revisions[scope]] for scope in ('day','7d','30d','all')]).encode())


def publish_bundle_document(cfg, day, revisions, env=None, *, prepare_only=False):
    """Freeze and register the combined document for this exact revision vector."""
    env = os.environ if env is None else env
    version = revision_key(revisions)
    with store.write_session(cfg) as conn:
        key = (conn.user_id, conn.connection_id, day.isoformat(), version)
        with store.transaction(conn):
            saved = conn.execute('select content,request_id,created_at from garmin.report_bundle_files where (user_id,connection_id,report_date,revision_key)=(%s,%s,%s,%s)', key).fetchone()
            if saved is None:
                texts = {}
                for scope in ('day','7d','30d','all'):
                    row = conn.execute('select report_md from garmin.evaluation_revisions where (user_id,connection_id,report_date,scope,revision)=(%s,%s,%s,%s,%s)', (conn.user_id,conn.connection_id,day.isoformat(),scope,revisions[scope])).fetchone()
                    if row is None: raise ValueError('missing evaluation')
                    texts[scope] = row[0]
                graph_names = conn.execute("""select name from garmin.report_publication_items
                    join jsonb_each_text(%s::jsonb) selected on selected.key=scope and selected.value::bigint=revision
                    where (user_id,connection_id,report_date)=(%s,%s,%s) and kind='graph' order by name""",
                    (_json(revisions),conn.user_id,conn.connection_id,day.isoformat())).fetchall()
                text = texts['day'] + '\n\n## 기간 평가\n' + ''.join(f"\n\n### {label}\n\n{texts[scope].rstrip()}" for scope,label in (('7d','7일'),('30d','30일'),('all','전체')))
                graphs = [charts.Graph(name, name) for (name,) in graph_names]
                data = report._assemble(text, day, graphs)
                if len(data) > MAX_BYTES: raise ValueError('report too large')
                request = uuid7()
                saved = conn.execute('insert into garmin.report_bundle_files(user_id,connection_id,report_date,revision_key,day_revision,content,request_id) values (%s,%s,%s,%s,%s,%s,%s) returning content,request_id,created_at', (*key,revisions['day'],data,request)).fetchone()
        if prepare_only: return saved
        data, request, created = bytes(saved[0]), saved[1], saved[2]
        identity = _json([str(conn.user_id),str(conn.connection_id),day.isoformat(),version,'bundle'])
        dataset = 'report:' + _hash(_json([str(conn.user_id),str(conn.connection_id)]).encode())
        batch = _hash(identity.encode())
        path_hash = _hash(_json(['generated',day.isoformat(),version,'report.md']).encode())
        metadata = _json({'kind':'report','report_date':day.isoformat(),'scope':'day','original_path_hash':path_hash})
        locator = locator_for(dataset,'bundle',identity,_hash(data))
        with store.transaction(conn):
            result = conn.execute('select status,file_id from brain.file_request_results_public_v1 where request_id=%s',(request,)).fetchone()
        if not result or result[0] != 'completed': stage(env['BRAIN_EXTENSION_HOME'],dataset,'bundle',identity,data)
        with store.transaction(conn):
            conn.execute("""insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata)
                values (%s,'garmin',%s,%s,%s,%s,%s,%s,'text/markdown',%s,%s,%s,%s::jsonb)""", (request,identity,dataset,batch,locator,_hash(data),len(data),created,env['BRAIN_WORK_ID'],env['BRAIN_ATTEMPT_TOKEN'],metadata))
            conn.execute("""insert into garmin.evaluation_files(user_id,connection_id,report_date,scope,revision,request_id,kind,original_path_hash)
                values (%s,%s,%s,'day',%s,%s,'report',%s) on conflict do nothing""", (conn.user_id,conn.connection_id,day.isoformat(),revisions['day'],request,path_hash))
            result = conn.execute('select status,file_id from brain.file_request_results_public_v1 where request_id=%s',(request,)).fetchone()
            if result and result[0]=='completed' and result[1] is not None:
                conn.execute("update garmin.evaluation_files set file_id=%s where user_id=%s and connection_id=%s and report_date=%s and scope='day' and revision=%s and request_id=%s and (file_id is null or file_id=%s)", (result[1],conn.user_id,conn.connection_id,day.isoformat(),revisions['day'],request,result[1]))
                row=conn.execute("select file_id,original_path_hash from garmin.evaluation_files where user_id=%s and connection_id=%s and report_date=%s and scope='day' and revision=%s and request_id=%s", (conn.user_id,conn.connection_id,day.isoformat(),revisions['day'],request)).fetchone()
                if row != (result[1],path_hash): raise ValueError('file relation conflict')
        if result and result[0]=='failed': raise FilesFailed()
        if not result or result[0]!='completed' or result[1] is None: raise FilesPending()
    return request


PENDING_WAIT_SECONDS = 60
PENDING_POLL_SECONDS = 2


def publish_and_wait(cfg, day, revisions, *, monotonic=time.monotonic, sleep=time.sleep, progress=None):
    """Submit every request first; poll only normal pending outside transactions."""
    if progress is None:
        progress = report._abi_progress if os.environ.get('BRAIN_ABI_VERSION') == '1' else lambda: None
    deadline = monotonic() + PENDING_WAIT_SECONDS
    while True:
        report._assert_attempt_current(cfg)
        pending = False
        try:
            publish(cfg, day, revisions)
        except FilesPending:
            pending = True
        # Submit the combined document even when other requests are pending.
        try:
            document = publish_bundle_document(cfg, day, revisions)
        except FilesPending:
            pending = True
            document = None
        if not pending:
            return document
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise FilesPending()
        progress()
        sleep(min(PENDING_POLL_SECONDS, remaining))


def saved_bundle(cfg, day, revisions, *, completed=True):
    """선택 revision의 게시 완료 파일만 읽는다."""
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            key = (conn.user_id, conn.connection_id, day.isoformat())
            document = conn.execute('''select b.request_id,b.content,b.created_at from garmin.report_bundle_files b
                left join garmin.evaluation_files f on f.request_id=b.request_id and f.user_id=b.user_id
                  and f.connection_id=b.connection_id and f.report_date=b.report_date and f.scope='day' and f.revision=b.day_revision
                where (b.user_id,b.connection_id,b.report_date,b.revision_key)=(%s,%s,%s,%s) and (%s or f.file_id is not null)''',
                (*key, revision_key(revisions), not completed)).fetchone()
            rows = conn.execute('''select i.name,i.request_id,i.content,p.created_at,f.file_id from garmin.report_publication_items i
                join garmin.report_publications p using(user_id,connection_id,report_date,scope,revision)
                join jsonb_each_text(%s::jsonb) selected on selected.key=i.scope and selected.value::bigint=i.revision
                left join garmin.evaluation_files f using(user_id,connection_id,report_date,scope,revision,request_id)
                where (i.user_id,i.connection_id,i.report_date)=(%s,%s,%s)
                  and i.kind='graph' order by i.name''', (_json(revisions), *key)).fetchall()
            if document is None or (completed and any(row[4] is None for row in rows)):
                return None
            return document, rows


def publish_send_copy(cfg, env, name, data, created, identity_parts, media):
    """날짜 target 재발신용 파일 계약: 원본 target의 권한을 넓히지 않고 사본을 게시한다."""
    with store.write_session(cfg) as conn:
        identity = _json(['send-attachments-v1', str(conn.user_id), str(conn.connection_id),
                          env['BRAIN_TARGET_ID'], *identity_parts, name])
        request = uuid5(NAMESPACE_URL, identity)
        dataset = 'report:' + _hash(_json([str(conn.user_id), str(conn.connection_id)]).encode())
        data = bytes(data)
        if len(data) > MAX_BYTES: raise ValueError('report too large')
        locator = locator_for(dataset, 'send', identity, _hash(data))
        with store.transaction(conn):
            result = conn.execute('select status,file_id from brain.file_request_results_public_v1 where request_id=%s', (request,)).fetchone()
        if not result or result[0] != 'completed': stage(env['BRAIN_EXTENSION_HOME'], dataset, 'send', identity, data)
        with store.transaction(conn):
            conn.execute('''insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata)
                values (%s,'garmin',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)''',
                (request, identity, dataset, _hash(identity.encode()), locator, _hash(data), len(data), media, created,
                 env['BRAIN_WORK_ID'], env['BRAIN_ATTEMPT_TOKEN'], _json({'kind':'report' if media=='text/markdown' else 'graph'})))
            result = conn.execute('select status,file_id from brain.file_request_results_public_v1 where request_id=%s', (request,)).fetchone()
        if result and result[0] == 'failed': raise FilesFailed()
        if not result or result[0] != 'completed' or result[1] is None: raise FilesPending()
        return request


def saved_send_attachments(cfg, day, revisions, env):
    bundle = saved_bundle(cfg, day, revisions)
    restored = bundle is None
    if restored:
        # 바이트만 고정한다. 공용 request ID를 날짜 target 일감으로 게시하지 않는다.
        for scope in ('day', '7d', '30d', 'all'):
            _prepare(cfg, day, scope, revisions[scope], revisions, render_unavailable=True)
        publish_bundle_document(cfg, day, revisions, env, prepare_only=True)
        bundle = saved_bundle(cfg, day, revisions, completed=False)
    if bundle is None: raise FilesPending()
    document, rows = bundle
    # core는 발신 일감과 파일 원본 일감의 target 일치를 검증한다.
    # report-send의 날짜 target은 일반 report의 연결 target과 달라 별도 사본이 필요하다.
    parts = [day.isoformat(), revision_key(revisions)]
    deadline = time.monotonic() + PENDING_WAIT_SECONDS
    while True:
        report._assert_attempt_current(cfg)
        pending = False
        photos = []
        try:
            request = publish_send_copy(cfg, env, 'report.md', document[1], document[2], parts, 'text/markdown')
        except FilesPending:
            pending = True
        for name, original, content, created, file_id in rows:
            try:
                photo = publish_send_copy(cfg, env, name, content, created, parts, 'image/png')
                photos.append((name, 'graph', photo))
            except FilesPending:
                pending = True
        if not pending: return request, photos, 'restored' if restored else 'published'
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise FilesPending()
        report._abi_progress()
        time.sleep(min(PENDING_POLL_SECONDS, remaining))
