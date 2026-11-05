"""Publish neutral native file requests and link only evidenced selected evaluations."""
import hashlib
import json
import os
import psycopg
from datetime import date
from uuid import UUID, uuid7

from artifacts import MAX_BYTES, classify, encode_identity, locator_for, locator_lock, read_relative, stage
from batch_import import canonical, check, encoded, conflict
from native_import import envelope, _native_key
from preflight import account, classify_files
from reader import InvalidSQLiteText, SQLiteText

KIND = 'native_file_v1'
SCOPES = frozenset(('day', '7d', '30d', 'all'))

class FilesPending(Exception): pass
class FilesFailed(Exception): pass

class PlanConflict(ValueError):
    def __init__(self, dataset, key):
        super().__init__('IMPORT_CONFLICT')
        self.dataset, self.key = dataset, key


def _hash(data): return hashlib.sha256(data).hexdigest()


def _path_hash(path):
    if not isinstance(path, str): raise ValueError('IMPORT_INVALID')
    return _hash(path.encode('utf-8', 'surrogatepass'))


def _date_scope(day, scope):
    if day is not None:
        if not isinstance(day, str): raise ValueError('IMPORT_INVALID')
        try:
            if date.fromisoformat(day).isoformat() != day: raise ValueError()
        except ValueError:
            raise ValueError('IMPORT_INVALID') from None
    if scope is not None and (not isinstance(scope, str) or scope not in SCOPES):
        raise ValueError('IMPORT_INVALID')
    return day, scope


def _source_key(table,row): return canonical([encoded(row[k]) for k in table['keys']])


def _bytes(value):
    if isinstance(value,(SQLiteText,InvalidSQLiteText)): return value.raw
    if isinstance(value,str): return value.encode('utf-8')
    raise ValueError('IMPORT_INVALID')


def plan(capture, entries, verified):
    """Read/stage inputs outside DB transactions; candidate keys are provenance only."""
    specs=[]; unassigned=[]
    by_original={e['dataset_label'] or e['dataset']:e for e in entries}
    evaluations={}
    selected_evaluations=set(); seen_evaluations=set()
    for entry in entries:
        dataset=entry['dataset']; table=verified[dataset]['snapshot']['tables'].get('evaluation')
        for row in table['rows'] if table else []:
            key=_source_key(table,row); day,scope=_date_scope(str(row['report_date']),str(row['scope']))
            profile=account(verified[dataset]['snapshot'])
            if not profile['confirmed']: raise ValueError('IMPORT_INVALID')
            selection=(profile['account'],_native_key(table,row))
            if selection not in seen_evaluations:
                selected_evaluations.add((dataset,key)); seen_evaluations.add(selection)
            data=_bytes(row['report_md'])
            if len(data)>MAX_BYTES: raise ValueError('IMPORT_INVALID')
            original_hash=_path_hash(canonical(['evaluation',dataset,key,'report_md']))
            metadata={'kind':'report','report_date':day,'scope':scope,'original_path_hash':original_hash}
            specs.append({'dataset':dataset,'table':'evaluation','key':key,'data':data,'media':'text/markdown',
                          'metadata':metadata,'candidates':[(dataset,key)]})
            evaluations[(dataset,day,scope)]=key
    if capture['private']['version']==1:
        for spec in specs: spec['candidates'] = [c for c in spec['candidates'] if c in selected_evaluations]
        classifications=classify_files(capture['private']['files'])['files']
        for artifact, classification in zip(capture['private']['files'],classifications,strict=True):
            if classification['category'] not in ('report','facts','image'): continue
            data,_=read_relative(capture['private']['root'],artifact['snapshot'],artifact['bytes'])
            if data is None: raise ValueError('IMPORT_INVALID')
            path_hash=_path_hash(artifact['source'])
            category=classification['category']
            source=artifact['source'].lower()
            specs.append({'dataset':None,'table':'unassigned','key':path_hash,'data':data,
                          'media':'image/png' if category=='image' else 'application/json' if source.endswith('.json') else 'text/markdown',
                          'metadata':{'kind':'graph' if category=='image' else 'report','report_date':None,'scope':None,'original_path_hash':path_hash},'candidates':[]})
        return specs,unassigned
    items={(a['dataset'],a['artifact_key']):a for a in capture['private']['files']}
    for artifact in capture['private']['files']:
        category=classify(artifact)
        if category not in ('report','facts','image'): continue
        data,_=read_relative(capture['private']['root'],artifact['snapshot'],artifact['bytes'])
        if data is None: raise ValueError('IMPORT_INVALID')
        entry=by_original[artifact['dataset']]; dataset=entry['dataset']
        day,scope=_date_scope(artifact.get('report_date'),artifact.get('scope'))
        candidates=[]
        if category=='report' and day is not None and scope is not None and (dataset,day,scope) in evaluations:
            candidates.append((dataset,evaluations[(dataset,day,scope)]))
        for relation in artifact.get('relations',[]):
            target=items.get((artifact['dataset'],relation['analysis_key']))
            if target is None or classify(target)!='report': continue
            target_day,target_scope=_date_scope(target.get('report_date'),target.get('scope'))
            if target_day is not None and target_scope is not None and (dataset,target_day,target_scope) in evaluations:
                candidates.append((dataset,evaluations[(dataset,target_day,target_scope)]))
        # A relation may supply metadata only if every evidenced target agrees.
        inferred=set()
        for _,key in candidates:
            inferred.update((d,s) for (ds,d,s),k in evaluations.items() if ds==dataset and k==key)
        if day is None and scope is None and len(inferred)==1: day,scope=next(iter(inferred))
        if inferred and any((day is not None and pair[0] != day) or (scope is not None and pair[1] != scope) for pair in inferred):
            raise PlanConflict(dataset,encode_identity(artifact['artifact_key']))
        kind='graph' if category=='image' else 'report'
        metadata={'kind':kind,'report_date':day,'scope':scope,'original_path_hash':_path_hash(artifact['source'])}
        source=artifact['source'].lower()
        media='image/png' if category=='image' else 'application/json' if source.endswith('.json') else 'text/markdown'
        specs.append({'dataset':dataset,'table':'artifact','key':encode_identity(artifact['artifact_key']),
                      'data':data,'media':media,'metadata':metadata,'candidates':list(dict.fromkeys(candidates))})
    for spec in specs: spec['candidates'] = [c for c in spec['candidates'] if c in selected_evaluations]
    return specs,unassigned


def _fingerprint(spec):
    return _hash(canonical({'hash':_hash(spec['data']),'size':len(spec['data']),'media':spec['media'],
                            'metadata':spec['metadata'],'candidates':spec['candidates']}).encode())


def _batch(capture,dataset): return _hash(canonical([capture['private']['capture_id'],dataset]).encode())


def _account_map(conn,settings,entries,verified):
    user,timezone=envelope(settings); result={}
    with conn.transaction():
        cur=conn.cursor(); check(cur)
        for entry in entries:
            dataset=entry['dataset']; info=account(verified[dataset]['snapshot'])
            if not info['confirmed']: raise ValueError('IMPORT_INVALID')
            cur.execute('select connection_id,timezone from garmin.account_connections where user_id=%s and external_identity=%s',(user,info['account']))
            row=cur.fetchone()
            if not row or row[1]!=timezone: raise ValueError('IMPORT_CONFLICT')
            result[dataset]=row[0]
        check(cur)
    return user,result


def _selected(cur,user,connections,candidate):
    dataset,key=candidate
    cur.execute("select native_key from garmin.native_import_mapping where dataset=%s and original_table='evaluation' and original_key=%s and user_id=%s and connection_id=%s",(dataset,key,user,connections[dataset]))
    row=cur.fetchone()
    if row is None: return None
    native_key=json.loads(row[0])
    if len(native_key)!=2: raise ValueError('IMPORT_INVALID')
    # Source SQLite key order is authoritative; locate its column order upstream.
    return native_key


def publish(conn,capture,entries,verified,settings):
    user,connections=_account_map(conn,settings,entries,verified)
    try:
        specs,unassigned=plan(capture,entries,verified)
    except PlanConflict as exc:
        batch=_batch(capture,exc.dataset)
        # Planning performs no writes; finish this fenced lookup before the
        # independent conflict transaction. Preserve an existing request's batch.
        with conn.transaction():
            cur=conn.cursor(); check(cur)
            old=cur.execute('select target_id,content_hash,batch from garmin.import_mapping where dataset=%s and original_table=%s and original_key=%s and target_kind=%s',
                            (exc.dataset,'artifact',exc.key,KIND)).fetchone()
            if old: batch=old[2]
            check(cur)
        conflict(conn,exc.dataset,batch,'artifact',exc.key,'native_file_conflict')
    for spec in specs:
        _publish_one(conn,capture,verified,user,connections,spec)
    # All requests are processed even when some are pending.
    pending=failed=False
    with conn.transaction():
        cur=conn.cursor(); check(cur)
        for spec in specs:
            old=_mapping(cur,capture,user,spec)
            status=cur.execute('select status,file_id from brain.file_request_results_public_v1 where request_id=%s',(old[0],)).fetchone()
            if not status or status[0] in ('pending','processing'): pending=True
            elif status[0]=='failed': failed=True
            elif status[0]!='completed' or status[1] is None: raise ValueError('IMPORT_CONFLICT')
            elif not _finalize_links(cur,user,connections,verified,spec,old[0],status[1]):
                pending=True
        check(cur)
    if failed: raise FilesFailed()
    if pending: raise FilesPending()



def _finalize_links(cur,user,connections,verified,spec,request,file_id):
    """Bind the observed result and verify precisely the evidenced links."""
    expected=set()
    for candidate in spec['candidates']:
        native_key=_selected(cur,user,connections,candidate)
        if native_key is None: continue
        table=verified[candidate[0]]['snapshot']['tables']['evaluation']
        values=dict(zip(table['keys'],native_key,strict=True))
        expected.add((connections[candidate[0]],values['report_date'],values['scope'],1,
                      spec['metadata']['kind'],spec['metadata']['original_path_hash'],file_id))
    cur.execute('update garmin.evaluation_files set file_id=%s where user_id=%s and request_id=%s and (file_id is null or file_id=%s)',(file_id,user,request,file_id))
    cur.execute('select connection_id,report_date,scope,revision,kind,original_path_hash,file_id from garmin.evaluation_files where user_id=%s and request_id=%s',(user,request))
    return set(cur.fetchall())==expected

def _identity(capture,user,spec):
    capture_hash=_hash(str(capture['private']['capture_id']).encode())
    if spec['dataset'] is None:
        dataset='capture-unassigned:'+_hash(canonical([str(user),capture_hash]).encode())
        return dataset, 'capture-unassigned:'+capture_hash
    return spec['dataset'], _batch(capture,spec['dataset'])


def _mapping(cur,capture,user,spec):
    if spec['dataset'] is None:
        return cur.execute('select request_id,content_hash,request_batch,created_at from garmin.unassigned_file_requests where user_id=%s and capture_hash=%s and path_hash=%s',(user,_hash(str(capture['private']['capture_id']).encode()),spec['key'])).fetchone()
    return cur.execute('select target_id,content_hash,batch from garmin.import_mapping where dataset=%s and original_table=%s and original_key=%s and target_kind=%s',(spec['dataset'],spec['table'],spec['key'],KIND)).fetchone()


def _publish_one(conn,capture,verified,user,connections,spec):
    dataset,batch=_identity(capture,user,spec); fingerprint=_fingerprint(spec)
    request_batch=batch
    try:
        identity=canonical([dataset,spec['table'],spec['key']]); storage_table='native_'+spec['table']
        locator=locator_for(dataset,storage_table,spec['key'],_hash(spec['data']))
        with locator_lock(conn,locator):
            with conn.transaction():
                cur=conn.cursor(); check(cur)
                old=_mapping(cur,capture,user,spec)
                if old: request_batch=old[2]
                if old and old[1]!=fingerprint: raise ValueError('IMPORT_CONFLICT')
                state=cur.execute('select status,file_id from brain.file_request_results_public_v1 where request_id=%s',(old[0],)).fetchone() if old else None
                check(cur)
            if not state or state[0]!='completed':
                stage(os.environ['BRAIN_EXTENSION_HOME'],dataset,storage_table,spec['key'],spec['data'])
            with conn.transaction():
                cur=conn.cursor(); check(cur)
                cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,6))',(canonical([identity,KIND]),))
                old=_mapping(cur,capture,user,spec)
                if old: request_batch=old[2]
                if old and old[1]!=fingerprint: raise ValueError('IMPORT_CONFLICT')
                request,request_batch=(old[0],old[2]) if old else (uuid7(),batch)
                if spec['dataset'] is None:
                    if not old:
                        cur.execute('insert into garmin.unassigned_file_requests(user_id,capture_hash,path_hash,request_id,content_hash,request_batch) values (%s,%s,%s,%s,%s,%s)',(user,_hash(str(capture['private']['capture_id']).encode()),spec['key'],request,fingerprint,request_batch))
                        old=_mapping(cur,capture,user,spec)
                    created=old[3]
                else:
                    if not old:
                        cur.execute('insert into garmin.import_mapping values (%s,%s,%s,%s,%s,%s,%s)',(dataset,spec['table'],spec['key'],KIND,request,fingerprint,batch))
                    created=cur.execute('select imported_at from garmin.import_batches where id=%s and dataset=%s',(request_batch,dataset)).fetchone()[0]
                try:
                    cur.execute('''insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata)
                        values (%s,'garmin',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)''',
                        (request,canonical([KIND,dataset,spec['table'],spec['key']]),dataset,request_batch,locator,_hash(spec['data']),len(spec['data']),spec['media'],created,os.environ['BRAIN_WORK_ID'],os.environ['BRAIN_ATTEMPT_TOKEN'],canonical(spec['metadata'])))
                except psycopg.errors.RaiseException:
                    # Core reconciles an existing request and rejects a different contract.
                    raise ValueError('IMPORT_CONFLICT') from None
                for candidate in spec['candidates']:
                    native_key=_selected(cur,user,connections,candidate)
                    if native_key is None: continue
                    table=verified[candidate[0]]['snapshot']['tables']['evaluation']
                    values=dict(zip(table['keys'],native_key,strict=True)); day,scope=values['report_date'],values['scope']
                    cur.execute('''insert into garmin.evaluation_files(user_id,connection_id,report_date,scope,revision,request_id,kind,original_path_hash)
                        values (%s,%s,%s,%s,1,%s,%s,%s) on conflict do nothing''',(user,connections[candidate[0]],day,scope,request,spec['metadata']['kind'],spec['metadata']['original_path_hash']))
                    cur.execute('''select kind,original_path_hash,file_id from garmin.evaluation_files where user_id=%s and connection_id=%s and report_date=%s and scope=%s and revision=1 and request_id=%s''',(user,connections[candidate[0]],day,scope,request))
                    link=cur.fetchone()
                    if not link or link[:2]!=(spec['metadata']['kind'],spec['metadata']['original_path_hash']): raise ValueError('IMPORT_CONFLICT')
                check(cur)
            with conn.transaction():
                cur=conn.cursor(); check(cur)
                status=cur.execute('select status,file_id from brain.file_request_results_public_v1 where request_id=%s',(request,)).fetchone()
                if status and status[0]=='completed' and status[1] is not None:
                    cur.execute('update garmin.evaluation_files set file_id=%s where user_id=%s and request_id=%s and (file_id is null or file_id=%s)',(status[1],user,request,status[1]))
                    cur.execute('select count(*) from garmin.evaluation_files where user_id=%s and request_id=%s and file_id is distinct from %s',(user,request,status[1]))
                    if cur.fetchone()[0]: raise ValueError('IMPORT_CONFLICT')
                check(cur)
    except ValueError as exc:
        if str(exc) != 'IMPORT_CONFLICT': raise
        conflict(conn,dataset,request_batch,spec['table'],spec['key'],'native_file_conflict')


def verify(conn,capture,entries,verified,settings,planned=None):
    """Check the same request fingerprint, result, and selected revision links."""
    from psycopg.rows import tuple_row
    user,timezone=envelope(settings); specs = planned if planned is not None else plan(capture,entries,verified)[0]; connections={}
    cur=conn.cursor(row_factory=tuple_row)
    for entry in entries:
        dataset=entry['dataset']; info=account(verified[dataset]['snapshot'])
        if not info['confirmed']: return False,len(specs)
        cur.execute('select connection_id,timezone from garmin.account_connections where user_id=%s and external_identity=%s',(user,info['account']))
        row=cur.fetchone()
        if not row or row[1]!=timezone: return False,len(specs)
        connections[dataset]=row[0]
    for spec in specs:
        mapping=_mapping(cur,capture,user,spec)
        if not mapping or mapping[1]!=_fingerprint(spec): return False,len(specs)
        request=mapping[0]
        cur.execute('select status,file_id from brain.file_request_results_public_v1 where request_id=%s',(request,))
        result=cur.fetchone()
        if not result or result[0]!='completed' or result[1] is None: return False,len(specs)
        expected=set()
        for candidate in spec['candidates']:
            native_key=_selected(cur,user,connections,candidate)
            if native_key is None: continue
            table=verified[candidate[0]]['snapshot']['tables']['evaluation']
            values=dict(zip(table['keys'],native_key,strict=True))
            expected.add((connections[candidate[0]],values['report_date'],values['scope'],1,
                          spec['metadata']['kind'],spec['metadata']['original_path_hash'],result[1]))
        cur.execute('select connection_id,report_date,scope,revision,kind,original_path_hash,file_id from garmin.evaluation_files where user_id=%s and request_id=%s',(user,request))
        if set(cur.fetchall())!=expected: return False,len(specs)
    return True,len(specs)
