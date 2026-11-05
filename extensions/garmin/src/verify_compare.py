"""capture 원본과 확장 소유 반입 장부를 읽기 전용으로 대조한다."""
import hashlib
from decimal import Decimal
from batch_import import VERSION, canonical, contract_fingerprint, encoded
from capture_manifest import ROLES
from preflight import ORDER, account
from raw_codec import dataset_ref, project, restore
from reader import read_snapshot_bytes, SQLiteText, InvalidSQLiteText
from verify_source import read_source, recheck_source
from artifacts import MAX_BYTES, classify, read_relative, scan_log, encode_identity
from artifact_publish import original_bytes
from metadata_codec import encode_metadata

CHECKS = ('source_unchanged','checkpoints','schemas','preserved','mappings','raw','legacy','files','inventory','conflicts')
COUNTS = ('datasets','source_tables','source_rows','preserved_rows','raw_rows','file_requests','conflict_entries','mismatches')

def json_equal(left, right):
    if isinstance(left, bool) or isinstance(right, bool): return type(left) is bool and type(right) is bool and left==right
    if isinstance(left,(int,float,Decimal)) and isinstance(right,(int,float,Decimal)): return Decimal(str(left))==Decimal(str(right))
    if type(left) is not type(right): return False
    if isinstance(left,dict): return left.keys()==right.keys() and all(json_equal(left[k],right[k]) for k in left)
    if isinstance(left,list): return len(left)==len(right) and all(json_equal(a,b) for a,b in zip(left,right))
    return left==right

def original_text(value):
    if isinstance(value, (SQLiteText, InvalidSQLiteText)): return value.encoding, value.raw
    return ('utf-8', value.encode('utf-8')) if isinstance(value, str) else None

def public_projection(details):
    counts = details['counts']
    if any(type(counts.get(k)) is not int or not 0 <= counts[k] <= 9007199254740991 for k in COUNTS): raise ValueError('IMPORT_INVALID')
    return {'counts': {k:counts[k] for k in COUNTS}, 'checks': {k:not bool(details['differences'][k]) for k in CHECKS}}

def compare(capture, stored, file_results, conversation, *, preserve_artifacts=False):
    differences={k:[] for k in CHECKS}; counts={k:0 for k in COUNTS}
    def fail(group, detail): differences[group].append(detail)
    def find(name, **fields): return [r for r in stored[name] if all(str(r.get(k)) == str(v) for k,v in fields.items())]
    entries=sorted(capture['private']['datasets'],key=lambda e:ORDER.index(ROLES[e['source']])); counts['datasets']=len(entries)
    fingerprint=contract_fingerprint(capture['private']['fingerprint']); wanted=set(); legacy_wanted=set(); raw_wanted=set(); batches={}; snapshots={}
    for entry in entries:
        original=entry['dataset']; dataset=dataset_ref(original); path=capture['datasets'][ROLES[entry['source']]]
        data, digest, token=read_source(path,reject_wal=True); source=read_snapshot_bytes(data); snapshots[dataset]=source
        batch=hashlib.sha256(canonical([capture['private']['capture_id'],dataset]).encode()).hexdigest(); batches[dataset]=batch
        cp=find('import_checkpoints',dataset=dataset,batch=batch)
        expected={'source_hash':digest,'schema_version':source['schema'],'importer_version':VERSION,'manifest_fingerprint':fingerprint,'source_role':entry['source']}
        if cp and cp[0]['source_hash'] != digest: fail('source_unchanged',[dataset,'checkpoint_hash'])
        if len(cp)!=1 or any(cp[0].get(k)!=v for k,v in expected.items()) or (conversation is not None and (str(cp[0]['conversation_id']) if cp and cp[0]['conversation_id'] else None)!=conversation) or len(find('import_batches',dataset=dataset,id=batch))!=1: fail('checkpoints',[dataset])
        acct=account(source); ds=find('datasets',dataset=dataset); label=original if original!=dataset else None
        if len(ds)!=1 or ds[0]['account_confirmed']!=acct['confirmed'] or restore(ds[0]['account'],ds[0]['account_raw'],ds[0]['account_encoding'])!=acct['account'] or restore(ds[0]['dataset_label'],ds[0]['dataset_label_raw'],ds[0]['dataset_label_encoding'])!=label: fail('preserved',[dataset,'account'])
        counts['source_tables']+=len(source['tables']); last=None
        for schema in find('source_schemas',dataset=dataset):
            if schema['original_table'] not in source['tables']: fail('schemas',[dataset,schema['original_table'],'extra'])
        for name in sorted(source['tables'],key=lambda n:(n!='run',n)):
            table=source['tables'][name]; schema=find('source_schemas',dataset=dataset,original_table=name)
            if not table['keys'] or len(schema)!=1 or schema[0]['schema_version']!=source['schema'] or not json_equal(schema[0]['columns_json'],table['column_metadata']) or not json_equal(schema[0]['keys_json'],table['keys']): fail('schemas',[dataset,name]); continue
            counts['source_rows']+=len(table['rows'])
            for row in sorted(table['rows'],key=lambda r:canonical([encoded(r[k]) for k in table['keys']])):
                key=canonical([encoded(row[k]) for k in table['keys']]); last=(name,key); payload={k:encoded(v) for k,v in row.items()}; hashed=hashlib.sha256(canonical(payload).encode()).hexdigest(); wanted.add((dataset,name,key))
                mapping=find('import_mapping',dataset=dataset,original_table=name,original_key=key,target_kind='preserved'); target=find('preserved_rows',dataset=dataset,original_table=name,original_key=key)
                if len(mapping)!=1 or mapping[0]['content_hash']!=hashed: fail('mappings',[dataset,name,key])
                if len(target)!=1 or len(mapping)!=1 or str(target[0]['id'])!=str(mapping[0]['target_id']) or not json_equal(target[0]['values_json'],payload): fail('preserved',[dataset,name,key])
                if target:
                    expected_parent=None
                    if name=='fetch_error' and row.get('run_id') is not None:
                        parent=find('import_mapping',dataset=dataset,original_table='run',original_key=canonical([encoded(row['run_id'])]),target_kind='preserved')
                        if len(parent)!=1: fail('preserved',[dataset,name,key,'parent'])
                        else: expected_parent=str(parent[0]['target_id'])
                    actual_parent=str(target[0]['run_id']) if target[0]['run_id'] is not None else None
                    if actual_parent!=expected_parent: fail('preserved',[dataset,name,key,'parent'])
                if conversation is not None and name in ('notification','delivery'):
                    legacy_wanted.add((dataset,name,key))
                    legacy=find('import_mapping',dataset=dataset,original_table=name,original_key=key,target_kind='legacy')
                    conv=find('legacy_conversations',dataset=dataset,original_table=name,original_key=key)
                    if len(legacy)!=1 or legacy[0]['content_hash']!=hashed or len(conv)!=1 or str(conv[0]['conversation_id'])!=conversation: fail('legacy',[dataset,name,key])
                if name=='raw_response':
                    rid=canonical([encoded(row[k]) for k in ('scope','key','endpoint')]); raw_wanted.add((dataset,rid)); found=[v for v in stored['raw_payloads'] if v['dataset']==dataset and all(restore(v[f],v[f+'_raw'],v[f+'_encoding'])==value for f,value in [('scope',row['scope']),('original_key',row['key']),('endpoint',row['endpoint'])])]; counts['raw_rows']+=1
                    if len(found)!=1 or found[0]['raw_identity']!=rid or any(original_text(restore(found[0][f],found[0][f+'_raw'],found[0][f+'_encoding']))!=original_text(v) for f,v in [('account',acct['account']),('scope',row['scope']),('original_key',row['key']),('endpoint',row['endpoint']),('library_version',row['library_version']),('body',row['raw'])]) or found[0]['fetched_at_ms']!=row['fetched_at'] or found[0]['checked_at_ms']!=row['checked_at']: fail('raw',[dataset,key])
        if cp and (cp[0]['original_table'],cp[0]['original_key']) != (last or (None,None)): fail('checkpoints',[dataset,'position'])
        recheck_source(path,(digest,token))
    counts['preserved_rows']=len(wanted)
    all_preserved={(r['dataset'],r['original_table'],r['original_key']) for r in stored['import_mapping'] if r['target_kind']=='preserved'}
    current_preserved={(r['dataset'],r['original_table'],r['original_key']) for r in stored['import_mapping'] if r['target_kind']=='preserved' and batches.get(r['dataset'])==r['batch']}
    for r in stored['preserved_rows']:
        identity=(r['dataset'],r['original_table'],r['original_key'])
        if r['dataset'] in batches and (identity in current_preserved or identity not in all_preserved) and identity not in wanted: fail('preserved',[*identity,'extra'])
    legacy_targets=set()
    for r in stored['import_mapping']:
        if r['dataset'] not in batches or r['batch']!=batches[r['dataset']]: continue
        identity=(r['dataset'],r['original_table'],r['original_key'])
        if r['target_kind']=='preserved' and identity not in wanted: fail('mappings',[*identity,'extra'])
        if r['target_kind']=='legacy':
            if conversation is not None and identity not in legacy_wanted: fail('legacy',[*identity,'extra'])
            target=(r['batch'],str(r['target_id']))
            if target in legacy_targets: fail('legacy',[*identity,'duplicate'])
            legacy_targets.add(target)
    for r in stored['raw_payloads']:
        if r['dataset'] in batches and r['batch']==batches[r['dataset']] and (r['dataset'],r['raw_identity']) not in raw_wanted: fail('raw',[r['dataset'],'extra'])
    # Native verification is separate; this opt-in checks historical publication.
    if preserve_artifacts:
        results={str(r['request_id']):r for r in file_results}
        expected_files=set(); expected_file_keys=set(); expected_inventory=set(); expected_links=set(); published={}
        def metadata_equal(row, value):
            display,raw=encode_metadata(value)
            return json_equal(row['metadata'],display) and (bytes(row['metadata_raw']) if row['metadata_raw'] is not None else None)==raw
        def expected_file(dataset,table,key,category,data,metadata,evaluation=None):
            expected_file_keys.add((dataset,table,key))
            hashed=hashlib.sha256(data).hexdigest()
            fp=hashlib.sha256(canonical({'hash':hashed,'category':category,'metadata':metadata,'evaluation':evaluation and {k:encoded(v) for k,v in evaluation.items()}}).encode()).hexdigest()
            rows=find('import_mapping',dataset=dataset,original_table=table,original_key=key,target_kind='artifact_file')
            if len(rows)!=1 or rows[0]['content_hash']!=fp: fail('files',[dataset,table,key,'mapping']); return None
            request=str(rows[0]['target_id'])
            if request in expected_files: fail('files',[dataset,table,key,'duplicate'])
            expected_files.add(request); result=results.get(request)
            if not result or result['status']!='completed' or result['file_id'] is None: fail('files',[dataset,table,key,'result'])
            return request
        for artifact in capture['private']['files']:
            data,hashed=read_relative(capture['private']['root'],artifact['snapshot'],artifact['bytes'])
            if capture['private']['version']==1: continue
            dataset=dataset_ref(artifact['dataset']); key=encode_identity(artifact['artifact_key']); category=classify(artifact); reason=None
            if data is None: reason='too_large'
            elif category=='config': reason='config'
            elif category=='unknown': reason='unknown'
            elif category=='log':
                try: scanned=scan_log(data); reason='secret' if scanned['hasSecrets'] else None
                except ValueError: reason='scan_failed'
            metadata=dict(artifact)
            if category=='log' and data is not None and reason!='scan_failed': metadata['scanner_version']=scanned['version']
            unlinked='no_analysis_reference' if reason is None and category in ('image','input') and not artifact.get('relations',[]) else None
            request=expected_file(dataset,'artifact',key,category,data,metadata) if reason is None else None
            expected_inventory.add((dataset,'artifact',key))
            rows=find('artifact_inventory',dataset=dataset,original_table='artifact',artifact_key=key)
            published[(artifact['dataset'],artifact['artifact_key'])]=(request,str(rows[0]['analysis_id']) if len(rows)==1 and rows[0]['analysis_id'] else None)
            if rows and rows[0]['content_hash']!=hashed: fail('source_unchanged',[dataset,key,'artifact_hash'])
            if len(rows)!=1 or (rows[0]['category'],rows[0]['content_hash'],rows[0]['size_bytes'],rows[0]['exclusion_reason'],rows[0]['unlinked_reason'])!=(category,hashed,artifact['bytes'],reason,unlinked) or not metadata_equal(rows[0],metadata) or (str(rows[0]['request_id']) if rows[0]['request_id'] else None)!=request: fail('inventory',[dataset,key])
        if capture['private']['version']==2:
            for artifact in capture['private']['files']:
                dataset=dataset_ref(artifact['dataset']); key=encode_identity(artifact['artifact_key']); request,_=published[(artifact['dataset'],artifact['artifact_key'])]
                for relation in artifact.get('relations',[]):
                    target=encode_identity(relation['analysis_key']); role=relation['role']; expected_links.add((dataset,key,target,role))
                    rows=find('artifact_relations',dataset=dataset,artifact_key=key,analysis_key=target,role=role)
                    _,analysis_id=published[(artifact['dataset'],relation['analysis_key'])]
                    reason='source_excluded' if request is None else 'analysis_unavailable' if analysis_id is None else None
                    if len(rows)!=1 or (str(rows[0]['request_id']) if rows[0]['request_id'] else None)!=request or (str(rows[0]['analysis_id']) if rows[0]['analysis_id'] else None)!=analysis_id or rows[0]['reason']!=reason: fail('inventory',[dataset,key,target,role])
        for entry in entries:
            dataset=dataset_ref(entry['dataset']); table=snapshots[dataset]['tables'].get('evaluation')
            if table:
                for row in table['rows']:
                    key=canonical([encoded(row[k]) for k in table['keys']]); data=original_bytes(row['report_md'])
                    if len(data)<=MAX_BYTES: expected_file(dataset,'evaluation',key,'report',data,{'source':'evaluation.md'},row)
                    else:
                        invkey='evaluation:'+key; expected_inventory.add((dataset,'evaluation',invkey)); rows=find('artifact_inventory',dataset=dataset,original_table='evaluation',artifact_key=invkey)
                        if len(rows)!=1 or rows[0]['content_hash']!=hashlib.sha256(data).hexdigest() or rows[0]['size_bytes']!=len(data) or rows[0]['exclusion_reason']!='too_large' or rows[0]['request_id'] is not None or rows[0]['analysis_id'] is not None or rows[0]['unlinked_reason'] is not None or not metadata_equal(rows[0],{'original_table':'evaluation','original_key':key}): fail('inventory',[dataset,invkey])
            for category in ('body','profile','inbox'):
                item=next((x for x in capture['private']['inventory'] if x['dataset']==entry['dataset'] and x['category']==category),None)
                state=item['state'] if item else 'unknown'
                metadata={'fields':item['metadata'],'source_files':[{'artifact_key':k,'request_id':published[(entry['dataset'],k)][0]} for k in item['source_files']]} if item else None
                rows=find('input_inventory',dataset=dataset,category=category)
                if len(rows)!=1 or rows[0]['state']!=state or not metadata_equal(rows[0],metadata): fail('inventory',[dataset,category])
        for row in stored['artifact_inventory']:
            identity=(row['dataset'],row['original_table'],row['artifact_key'])
            if batches.get(row['dataset'])==row['batch'] and identity not in expected_inventory: fail('inventory',[*identity,'extra'])
        for row in stored['artifact_relations']:
            identity=(row['dataset'],row['artifact_key'],row['analysis_key'],row['role'])
            if ((row['dataset'],'artifact',row['artifact_key']) in expected_inventory or (row['dataset'],'artifact',row['analysis_key']) in expected_inventory or (row['request_id'] and str(row['request_id']) in expected_files)) and identity not in expected_links: fail('inventory',[*identity,'extra'])
        for row in stored['import_mapping']:
            if row['target_kind']=='artifact_file' and batches.get(row['dataset'])==row['batch'] and (row['dataset'],row['original_table'],row['original_key']) not in expected_file_keys: fail('files',[row['dataset'],row['original_table'],row['original_key'],'extra'])
        counts['file_requests']=len(expected_files)
    for r in stored['import_conflicts']:
        if batches.get(r['dataset'])==r['batch']: counts['conflict_entries']+=1; fail('conflicts',[r['dataset'],r['reason']])
    counts['mismatches']=sum(len(v) for v in differences.values())
    return {'counts':counts,'differences':differences,'history':{'legacy':'core 이력 직접 조회 미제공','files':'공개 요청 상태와 file_id만 대조'}}
