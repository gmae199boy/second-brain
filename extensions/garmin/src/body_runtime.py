"""Ingest validated body sidecars through core's durable file handoff."""
import hashlib
import json
import os
import secrets
from pathlib import Path
import time
from contextlib import contextmanager

import body
import collect
import collect_store
import runtime_files
from artifacts import read_relative


def _wait(conn, account, work, token, request_id, status):
    while status != 'completed':
        if status == 'failed':
            raise ValueError('ARTIFACT_FILE_FAILED')
        collect.boundary('체성분 원본 등록 확인 대기')
        time.sleep(1)
        with collect_store._write(conn, account, work, token) as (cur, _):
            row = cur.execute('select status from brain.file_request_results_public_v1 where request_id=%s', (request_id,)).fetchone()
            status = row[0] if row else 'pending'


def _stored_name(relative, content_hash, mtime_ns):
    return content_hash + '-' + hashlib.sha256((relative + ':' + str(mtime_ns)).encode('utf-8')).hexdigest()[:16]


def _recover_move(home, relative, content_hash, size, mtime_ns):
    """Recover a move interrupted after its no-overwrite quarantine rename."""
    directory = Path(home) / 'inbox' / 'inbody' / 'processed'
    name = _stored_name(relative,content_hash,mtime_ns)
    final = 'inbox/inbody/processed/' + name
    try:
        data, hashed = read_relative(home,final,size)
        if data is not None and hashed == content_hash and os.stat(Path(home)/final,follow_symlinks=False).st_mtime_ns == mtime_ns: return final
        raise ValueError('BODY_CHANGED')
    except FileNotFoundError:
        pass
    fd = os.open(directory,os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        prefix = '.pending-' + name + '-'
        matches = [entry for entry in os.listdir(fd) if entry.startswith(prefix)]
        for pending in matches:
            path = 'inbox/inbody/processed/' + pending
            try: data, hashed = read_relative(home,path,size)
            except (OSError,ValueError): continue
            if data is None or hashed != content_hash or os.stat(pending,dir_fd=fd,follow_symlinks=False).st_mtime_ns != mtime_ns: continue
            try: os.link(pending,name,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False)
            except FileExistsError:
                existing, existing_hash = read_relative(home,final,size)
                if existing != data or existing_hash != content_hash: raise ValueError('BODY_CHANGED')
            os.unlink(pending,dir_fd=fd); os.fsync(fd)
            return final
    finally:
        os.close(fd)
    raise ValueError('BODY_CHANGED')


def _move(home, relative, expected):
    """Quarantine atomically, verify the moved inode, then publish without overwrite."""
    name = relative.split('/')[-1]
    root = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        inbox = os.open('inbox', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        try: source = os.open('inbody', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=inbox)
        finally: os.close(inbox)
        try:
            try: os.mkdir('processed', 0o700, dir_fd=source)
            except FileExistsError: pass
            target = os.open('processed', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=source)
            try:
                try: data, identity = body.read_source(home,relative)
                except FileNotFoundError: return _recover_move(home,relative,expected['sha256'],expected['size'],expected['mtime_ns'])
                if identity != expected: raise ValueError('BODY_CHANGED')
                stored = _stored_name(relative,expected['sha256'],expected['mtime_ns'])
                pending = '.pending-' + stored + '-' + secrets.token_hex(16)
                # A random private destination avoids replacing an existing file.
                if pending in os.listdir(target): raise ValueError('BODY_CHANGED')
                os.rename(name,pending,src_dir_fd=source,dst_dir_fd=target)
                os.fsync(source); os.fsync(target)
                try:
                    moved = os.stat(pending,dir_fd=target,follow_symlinks=False)
                    moved_data, moved_hash = read_relative(home,'inbox/inbody/processed/' + pending,expected['size'])
                    if (moved.st_dev,moved.st_ino,moved.st_size,moved.st_mtime_ns,moved_hash) != (expected['device'],expected['inode'],expected['size'],expected['mtime_ns'],expected['sha256']) or moved_data != data:
                        raise ValueError('BODY_CHANGED')
                except (ValueError,OSError):
                    # Never overwrite a replacement at the original name. If one
                    # exists, retain the quarantined bytes for recovery.
                    try:
                        os.link(pending,name,src_dir_fd=target,dst_dir_fd=source,follow_symlinks=False)
                        os.unlink(pending,dir_fd=target)
                        os.fsync(source); os.fsync(target)
                    except FileExistsError: pass
                    raise ValueError('BODY_CHANGED') from None
                try: os.link(pending,stored,src_dir_fd=target,dst_dir_fd=target,follow_symlinks=False)
                except FileExistsError:
                    existing, hashed = read_relative(home,'inbox/inbody/processed/' + stored,expected['size'])
                    if existing != data or hashed != expected['sha256']: raise ValueError('BODY_CHANGED')
                os.unlink(pending,dir_fd=target); os.fsync(target)
                return 'inbox/inbody/processed/' + stored
            finally: os.close(target)
        finally: os.close(source)
    finally: os.close(root)


@contextmanager
def _inbox_lock(conn, account, work, token):
    # All accounts share one extension inbox, so its source files have one mover.
    lock_key = 'garmin-body-inbox'
    acquired = False
    try:
        while not acquired:
            collect.boundary('체성분 처리 순서 대기')
            with collect_store._write(conn,account,work,token) as (cur,_):
                acquired = cur.execute('select pg_try_advisory_lock(hashtextextended(%s,32))',(lock_key,)).fetchone()[0]
            if not acquired: time.sleep(0.25)
        yield
    finally:
        if acquired:
            with conn.transaction():
                conn.execute('select pg_advisory_unlock(hashtextextended(%s,32))',(lock_key,))


def ingest(conn, home, account, work, token, today):
    with _inbox_lock(conn,account,work,token):
        return _ingest(conn,home,account,work,token,today)


def _ingest(conn, home, account, work, token, today, rescan=True):
    directory = Path(home) / 'inbox' / 'inbody'
    if not directory.exists():
        with collect_store._write(conn,account,work,token) as (cur,_):
            rows=cur.execute('select sidecar,field_sources from garmin.body_measurements where dataset=%s order by measured_on',(collect_store.dataset_for(account),)).fetchall()
            return [row[0] for row in rows], [row[1] for row in rows]
    if directory.is_symlink() or not directory.is_dir(): raise ValueError('BODY_INVALID')
    try:
        with os.scandir(directory) as entries:
            names = [entry.name for entry in sorted((entry for entry in entries if not entry.name.startswith('.') and entry.name.endswith('.json') and entry.is_file(follow_symlinks=False)), key=lambda entry: (entry.stat(follow_symlinks=False).st_mtime_ns,entry.name))]
    except OSError:
        raise ValueError('ARTIFACT_BODY_PENDING') from None
    dataset = collect_store.dataset_for(account)
    changed = False
    recovered_replacement = False

    def evidence(doc, document_hash):
        stamps, observed = set(), {}
        valid, transient = True, False
        for relative in doc['source_files']:
            if len(relative.split('/')) != 3 or relative.split('/')[:2] != ['inbox','inbody']:
                return False, {}, False
            collect.boundary('체성분 원본 확인')
            with collect_store._write(conn,account,work,token) as (cur,_):
                recorded = cur.execute('''select s.mtime_ns from garmin.body_sources s
                    join garmin.body_documents d on d.dataset=s.dataset and d.fingerprint=s.fingerprint
                    where s.dataset=%s and s.source_path=%s and (s.processed_path is not null or d.document_hash=%s)''',
                    (dataset,relative,document_hash)).fetchall()
            stamps.update(row[0] for row in recorded)
            try:
                _, identity = body.read_source(home,relative)
                stamps.add(identity['mtime_ns'])
                observed[relative] = identity
            except FileNotFoundError:
                if not recorded: valid = False; transient = True
            except (ValueError,OSError) as exc:
                valid = False
                if isinstance(exc,OSError) or str(exc) == 'BODY_CHANGED': transient = True
        return valid and all(stamp in stamps for stamp in doc['value_mtime_ns'].values()), observed, transient
    # Completed sidecars stay in the inbox as durable input records. If a new
    # sidecar reuses an image name, only its newest valid claimant may treat a
    # reappearing source as a new occurrence.
    latest_claim = {}
    for candidate in names:
        collect.boundary('체성분 입력 목록 확인')
        try:
            candidate_data, _ = body.read_source(home,'inbox/inbody/' + candidate)
            candidate_doc = body.parse(candidate_data)
            if candidate_doc['measured_on'] > today.isoformat(): continue
            valid, observed, transient = evidence(candidate_doc,hashlib.sha256(candidate_data).hexdigest())
            changed = changed or transient
            if not valid: continue
            for relative, identity in observed.items():
                if identity['mtime_ns'] in candidate_doc['value_mtime_ns'].values(): latest_claim[relative] = candidate
        except (ValueError,OSError) as exc:
            if isinstance(exc,OSError) or str(exc) == 'BODY_CHANGED': changed = True
            continue
    for name in names:
        collect.boundary('체성분 측정 확인')
        try:
            data, _ = body.read_source(home,'inbox/inbody/' + name)
            doc = body.parse(data)
            if doc['measured_on'] > today.isoformat(): raise ValueError('BODY_INVALID')
            if any(len(s.split('/')) != 3 or s.split('/')[:2] != ['inbox','inbody'] for s in doc['source_files']): raise ValueError('BODY_INVALID')
        except (ValueError, OSError) as exc:
            if isinstance(exc,OSError) or str(exc) == 'BODY_CHANGED': changed = True
            continue
        document_hash = hashlib.sha256(data).hexdigest()
        valid_sources, observed, transient = evidence(doc,document_hash)
        changed = changed or transient
        if not valid_sources: continue
        with collect_store._write(conn,account,work,token) as (cur,_):
            rows = cur.execute('select fingerprint,completed from garmin.body_documents where dataset=%s and document_hash=%s order by fingerprint',(dataset,document_hash)).fetchall()
        pending = [row[0] for row in rows if not row[1]]
        if len(pending) > 1: raise ValueError('ARTIFACT_BODY_PENDING')
        if pending:
            fingerprint = pending[0]
        elif rows:
            # A completed sidecar may be supplied again with a new source at
            # the same path. Distinguish the occurrence without duplicating an
            # unchanged core file request.
            present = []
            for relative in doc['source_files']:
                if latest_claim.get(relative) != name: continue
                try:
                    _, identity = body.read_source(home,relative)
                    present.append([relative,identity['sha256'],identity['mtime_ns'],identity['device'],identity['inode'],identity['ctime_ns']])
                except FileNotFoundError: pass
                except (ValueError,OSError): changed = True
            if not present: continue
            fingerprint = hashlib.sha256(json.dumps([document_hash,present],ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()
            if any(row[0] == fingerprint and row[1] for row in rows): continue
        else:
            fingerprint = document_hash
        with collect_store._write(conn,account,work,token) as (cur,_):
            cur.execute('insert into garmin.body_documents(dataset,fingerprint,document_hash,measured_on) values (%s,%s,%s,%s) on conflict do nothing',(dataset,fingerprint,document_hash,doc['measured_on']))
        sources = []
        try:
            for relative in doc['source_files']:
                with collect_store._write(conn,account,work,token) as (cur,_):
                    prior = cur.execute('select content_hash,mtime_ns,request_id,processed_path,source_size from garmin.body_sources where dataset=%s and fingerprint=%s and source_path=%s',(dataset,fingerprint,relative)).fetchone()
                if prior and prior[3]:
                    sources.append((relative,prior[1],str(prior[2]),None))
                    continue
                if prior and not prior[3]:
                    # The prior occurrence may already have moved before its
                    # ledger update, even if a new file now occupies the path.
                    try:
                        saved = _recover_move(home,relative,prior[0],prior[4],prior[1])
                    except (FileNotFoundError,ValueError):
                        saved = None
                    if saved:
                        with collect_store._write(conn,account,work,token) as (cur,_):
                            cur.execute('update garmin.body_sources set processed_path=%s where dataset=%s and fingerprint=%s and source_path=%s',(saved,dataset,fingerprint,relative))
                        sources.append((relative,prior[1],str(prior[2]),None))
                        if relative in observed: recovered_replacement = True
                        continue
                try:
                    content, identity = body.read_source(home,relative)
                except FileNotFoundError:
                    if not prior:
                        with collect_store._write(conn,account,work,token) as (cur,_):
                            matches = cur.execute('select distinct content_hash,mtime_ns,request_id,processed_path,source_size from garmin.body_sources where dataset=%s and source_path=%s and processed_path is not null',(dataset,relative)).fetchall()
                        matches = [r for r in matches if r[1] in doc['value_mtime_ns'].values()]
                        if len(matches) != 1: raise ValueError('BODY_CHANGED')
                        prior = matches[0]
                    saved = prior[3] or _recover_move(home,relative,prior[0],prior[4],prior[1])
                    restored, hashed = read_relative(home,saved,prior[4])
                    if restored is None or hashed != prior[0]: raise ValueError('BODY_CHANGED')
                    with collect_store._write(conn,account,work,token) as (cur,_):
                        cur.execute('insert into garmin.body_sources(dataset,fingerprint,source_path,content_hash,mtime_ns,request_id,source_size,processed_path) values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict(dataset,fingerprint,source_path) do update set processed_path=excluded.processed_path',
                                    (dataset,fingerprint,relative,prior[0],prior[1],prior[2],prior[4],saved))
                    sources.append((relative,prior[1],str(prior[2]),None))
                    continue
                if relative in observed and identity != observed[relative]: raise ValueError('BODY_CHANGED')
                if prior and (prior[0],prior[1]) != (identity['sha256'],identity['mtime_ns']): raise ValueError('BODY_CHANGED')
                meta = {'kind':'body_source','source_path':relative,'mtime_ns':identity['mtime_ns']}
                request_id,status = runtime_files.request(conn,home,account,work,token,'body_source',relative,content,meta,identity['mtime_ns']//1000000)
                if prior and str(prior[2]) != str(request_id): raise ValueError('BODY_CHANGED')
                with collect_store._write(conn,account,work,token) as (cur,_):
                    cur.execute('insert into garmin.body_sources(dataset,fingerprint,source_path,content_hash,mtime_ns,request_id,source_size) values (%s,%s,%s,%s,%s,%s,%s) on conflict do nothing',(dataset,fingerprint,relative,identity['sha256'],identity['mtime_ns'],request_id,identity['size']))
                    saved = cur.execute('select content_hash,mtime_ns,request_id,source_size from garmin.body_sources where dataset=%s and fingerprint=%s and source_path=%s',(dataset,fingerprint,relative)).fetchone()
                    if saved != (identity['sha256'],identity['mtime_ns'],request_id,identity['size']): raise ValueError('BODY_CHANGED')
                _wait(conn,account,work,token,request_id,status)
                sources.append((relative,identity['mtime_ns'],str(request_id),identity))
            field_sources = {key:[request_id for _,stamp,request_id,_ in sources if stamp==mtime] for key,mtime in doc['value_mtime_ns'].items()}
            if any(not ids for ids in field_sources.values()): raise ValueError('BODY_INVALID')
            with collect_store._write(conn,account,work,token) as (cur,_):
                cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,31))',(dataset,))
                old = cur.execute('select sidecar,field_sources from garmin.body_measurements where dataset=%s and measured_on=%s',(dataset,doc['measured_on'])).fetchone()
                merged, provenance = body.merge_with_provenance(old[0] if old else None,old[1] if old else {},doc,field_sources)
                cur.execute('''insert into garmin.body_measurements(dataset,measured_on,sidecar,field_sources) values (%s,%s,%s::jsonb,%s::jsonb)
                    on conflict(dataset,measured_on) do update set sidecar=excluded.sidecar,field_sources=excluded.field_sources''',
                    (dataset,doc['measured_on'],json.dumps(merged,ensure_ascii=False),json.dumps(provenance)))
            for relative,_,_,identity in sources:
                if identity is None: continue
                collect.boundary('체성분 원본 이동')
                with collect_store._write(conn,account,work,token): pass
                processed = _move(home,relative,identity)
                with collect_store._write(conn,account,work,token) as (cur,_):
                    cur.execute('update garmin.body_sources set processed_path=%s where dataset=%s and fingerprint=%s and source_path=%s',(processed,dataset,fingerprint,relative))
            with collect_store._write(conn,account,work,token) as (cur,_):
                cur.execute('update garmin.body_documents set completed=true where dataset=%s and fingerprint=%s',(dataset,fingerprint))
        except (ValueError, OSError) as exc:
            if str(exc) in ('COLLECT_STOPPED','COLLECT_INVALID_ATTEMPT','ARTIFACT_FILE_FAILED'): raise
            if isinstance(exc,OSError) or str(exc) == 'BODY_CHANGED': changed = True
            # Invalid inputs cannot erase measurements already accepted from others.
            continue
    if changed: raise ValueError('ARTIFACT_BODY_PENDING')
    if recovered_replacement and rescan:
        return _ingest(conn,home,account,work,token,today,rescan=False)
    with collect_store._write(conn,account,work,token) as (cur,_):
        rows=cur.execute('select sidecar,field_sources from garmin.body_measurements where dataset=%s order by measured_on',(dataset,)).fetchall()
        return [row[0] for row in rows], [row[1] for row in rows]
