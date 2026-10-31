"""명시 artifact와 SQLite evaluation을 원형 및 요청 관계로 발행한다."""
from datetime import datetime, timezone
import hashlib
import json
import os
from uuid import uuid7
import psycopg
from artifacts import MAX_BYTES, classify, read_relative, scan_log, stage, locator_for
from analysis_codec import project_analysis
from metadata_codec import encode_metadata, decode_metadata, safe_dumps
from reader import SQLiteText, InvalidSQLiteText


def canon(value): return safe_dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
def digest(data): return hashlib.sha256(data).hexdigest()


def original_bytes(value):
    if isinstance(value, (SQLiteText, InvalidSQLiteText)): return value.raw
    if isinstance(value, str): return value.encode('utf-8')
    raise ValueError('IMPORT_INVALID')


def publish(conn, capture, entries, verified):
    from batch_import import check, conflict, encoded
    by_dataset = {entry['dataset_label'] or entry['dataset']: entry for entry in entries}
    work, token = os.environ['BRAIN_WORK_ID'], os.environ['BRAIN_ATTEMPT_TOKEN']
    def batch_for(entry): return digest(canon([capture['private']['capture_id'], entry['dataset']]).encode())
    def mapped(cur, dataset, table, key, kind, fingerprint, batch):
        cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,6))',(canon([dataset,table,key,kind]),))
        old = cur.execute('select target_id,content_hash,batch from garmin.import_mapping where dataset=%s and original_table=%s and original_key=%s and target_kind=%s',(dataset,table,key,kind)).fetchone()
        if old:
            if old[1] != fingerprint: raise ValueError('ARTIFACT_CONFLICT')
            return old[0], old[2]
        ident = uuid7()
        cur.execute('insert into garmin.import_mapping values (%s,%s,%s,%s,%s,%s,%s)',(dataset,table,key,kind,ident,fingerprint,batch))
        return ident,batch
    def emit_one(entry, key, category, data, metadata, evaluation=None, original_table='artifact'):
        dataset, batch = entry['dataset'], batch_for(entry)
        content_hash = digest(data)
        fingerprint = digest(canon({'hash':content_hash,'category':category,'metadata':metadata,'evaluation':evaluation and {k:encoded(v) for k,v in evaluation.items()}}).encode())
        # 이전 완료 결과는 staging을 다시 만들지 않는다.
        with conn.transaction():
            cur=conn.cursor(); check(cur)
            old=cur.execute("select target_id,content_hash from garmin.import_mapping where dataset=%s and original_table=%s and original_key=%s and target_kind='artifact_file'",(dataset,original_table,key)).fetchone()
            if old and old[1] != fingerprint: raise ValueError('ARTIFACT_CONFLICT')
            status=cur.execute('select status from brain.file_request_results_public_v1 where request_id=%s',(old[0],)).fetchone() if old else None
        locator = locator_for(dataset,original_table,key,content_hash) if status and status[0]=='completed' else stage(os.environ['BRAIN_EXTENSION_HOME'],dataset,original_table,key,data)
        with conn.transaction():
            cur=conn.cursor(); check(cur)
            file_id, file_batch = mapped(cur,dataset,original_table,key,'artifact_file',fingerprint,batch)
            created=cur.execute('select imported_at from garmin.import_batches where id=%s and dataset=%s',(file_batch,dataset)).fetchone()[0]
            media = 'image/png' if category=='image' else 'application/json' if metadata.get('source','').lower().endswith('.json') else 'text/plain' if category=='log' else 'text/markdown'
            cur.execute('''insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token)
             values (%s,'garmin',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(file_id,canon([dataset,original_table,key]),dataset,file_batch,locator,content_hash,len(data),media,created,work,token))
            analysis_id=None
            if category in ('report','facts') or evaluation is not None:
                analysis_id, analysis_batch = mapped(cur,dataset,original_table,key,'artifact_analysis',fingerprint,batch)
                values = evaluation or {k:metadata.get(k) for k in ('report_date','scope','model','created_at')}
                columns=['id','source','dataset','import_batch','original_table','original_key','revision','model_missing','created_at','created_at_missing','file_request_id','source_work_item_id','source_attempt_token']
                created_at = datetime.fromtimestamp(values['created_at']/1000,timezone.utc) if evaluation is not None and values.get('created_at') is not None else (datetime.fromisoformat(values['created_at'].replace('Z','+00:00')) if values.get('created_at') else None)
                args=[analysis_id,'garmin',dataset,analysis_batch,original_table,key,1,values.get('model') is None,created_at,created_at is None,file_id,work,token]
                for name in ('report_date','scope','summary','judgments','evidence','next_checks','report_md','model'):
                    columns.extend((name,name+'_raw',name+'_encoding')); args.extend(project_analysis(values.get(name)))
                cur.execute('insert into brain.analyses ('+','.join(columns)+') values ('+','.join(['%s']*len(args))+')',args)
                relation_id, relation_batch = mapped(cur,dataset,original_table,key,'artifact_primary',fingerprint,batch)
                cur.execute("insert into brain.analysis_artifacts(id,source,dataset,import_batch,analysis_id,file_request_id,role,source_work_item_id,source_attempt_token) values (%s,'garmin',%s,%s,%s,%s,'primary',%s,%s)",(relation_id,dataset,relation_batch,analysis_id,file_id,work,token))
            return file_id,analysis_id,content_hash
    published={}
    if capture['private']['version']==2:
        for artifact in capture['private']['files']:
            entry=by_dataset[artifact['dataset']]; dataset=entry['dataset']; batch=batch_for(entry); key=artifact['artifact_key']
            try:
                category=classify(artifact); reason=None
                data = read_relative(capture['private']['root'],artifact['snapshot'],artifact['bytes'])
                if data is None: reason='too_large'
                elif category=='config': reason='config'
                elif category=='unknown': reason='unknown'
                elif category=='log':
                    try: result=scan_log(data); reason='secret' if result['hasSecrets'] else None
                    except ValueError: reason='scan_failed'
                metadata=dict(artifact)
                if category == 'log' and data is not None and reason != 'scan_failed': metadata['scanner_version']=result['version']
                file_id=analysis_id=None; hashed=digest(data) if data is not None else None
                unlinked = 'no_analysis_reference' if reason is None and category in ('image','input') and not artifact.get('relations',[]) else None
                metadata_display, metadata_raw = encode_metadata(metadata)
                if reason is None: file_id,analysis_id,hashed=emit_one(entry,key,category,data,metadata)
                with conn.transaction():
                    cur=conn.cursor(); check(cur)
                    cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,7))',(canon([dataset,key]),))
                    old=cur.execute('select category,content_hash,size_bytes,request_id,analysis_id,exclusion_reason,unlinked_reason,metadata,metadata_raw,batch from garmin.artifact_inventory where dataset=%s and artifact_key=%s',(dataset,key)).fetchone()
                    value=(category,hashed,artifact['bytes'],file_id,analysis_id,reason,unlinked,metadata)
                    if old and (*old[:7],decode_metadata(old[7],old[8])) != value: raise ValueError('ARTIFACT_CONFLICT')
                    if not old: cur.execute('insert into garmin.artifact_inventory(dataset,artifact_key,batch,category,content_hash,size_bytes,request_id,analysis_id,exclusion_reason,unlinked_reason,metadata,metadata_raw) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)',(dataset,key,batch,category,hashed,artifact['bytes'],file_id,analysis_id,reason,unlinked,canon(metadata_display),metadata_raw))
                published[(artifact['dataset'],key)]=(file_id,analysis_id)
            except (ValueError,psycopg.errors.RaiseException,psycopg.errors.UniqueViolation) as exc:
                if str(exc) in ('ARTIFACT_CONFLICT','IMPORT_CONFLICT') or isinstance(exc,(psycopg.errors.RaiseException,psycopg.errors.UniqueViolation)): conflict(conn,dataset,batch,'artifact',key,'artifact_mismatch')
                raise
        for artifact in capture['private']['files']:
            entry=by_dataset[artifact['dataset']]; dataset=entry['dataset']; batch=batch_for(entry); key=artifact['artifact_key']; file_id,_=published[(artifact['dataset'],key)]
            for relation in artifact.get('relations',[]):
                _,analysis_id=published[(artifact['dataset'],relation['analysis_key'])]
                reason = 'source_excluded' if file_id is None else 'analysis_unavailable' if analysis_id is None else None
                with conn.transaction():
                    cur=conn.cursor(); check(cur)
                    cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,8))',(canon([dataset,key,relation['analysis_key'],relation['role']]),))
                    prior=cur.execute('select request_id,analysis_id,reason from garmin.artifact_relations where dataset=%s and artifact_key=%s and analysis_key=%s and role=%s',(dataset,key,relation['analysis_key'],relation['role'])).fetchone()
                    mismatch = bool(prior and prior != (file_id,analysis_id,reason))
                    if not prior: cur.execute('insert into garmin.artifact_relations values (%s,%s,%s,%s,%s,%s,%s)',(dataset,key,relation['analysis_key'],relation['role'],file_id,analysis_id,reason))
                if mismatch: conflict(conn,dataset,batch,'artifact_relation',canon([key,relation['analysis_key'],relation['role']]),'relation_mismatch')
                if reason is not None: continue
                rel_key=canon([key,relation['analysis_key'],relation['role']]); fingerprint=digest(rel_key.encode())
                try:
                    with conn.transaction():
                        cur=conn.cursor(); check(cur); rel_id,rel_batch=mapped(cur,dataset,'artifact_relation',rel_key,'relation',fingerprint,batch)
                        cur.execute('insert into brain.analysis_artifacts(id,source,dataset,import_batch,analysis_id,file_request_id,role,source_work_item_id,source_attempt_token) values (%s,\'garmin\',%s,%s,%s,%s,%s,%s,%s)',(rel_id,dataset,rel_batch,analysis_id,file_id,relation['role'],work,token))
                except (ValueError,psycopg.errors.RaiseException,psycopg.errors.UniqueViolation): conflict(conn,dataset,batch,'artifact_relation',rel_key,'relation_mismatch')
    for entry in entries:
        dataset=entry['dataset']; batch=batch_for(entry)
        table=verified[dataset]['snapshot']['tables'].get('evaluation')
        if table:
            for row in table['rows']:
                key=canon([encoded(row[k]) for k in table['keys']]); data=original_bytes(row['report_md'])
                if len(data)>MAX_BYTES:
                    inventory_key='evaluation:' + key
                    metadata={'original_table':'evaluation','original_key':key}
                    with conn.transaction():
                        cur=conn.cursor(); check(cur)
                        cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,7))',(canon([dataset,inventory_key]),))
                        old=cur.execute('select category,content_hash,size_bytes,request_id,analysis_id,exclusion_reason,metadata from garmin.artifact_inventory where dataset=%s and artifact_key=%s',(dataset,inventory_key)).fetchone()
                        mismatch=bool(old and old != ('report',digest(data),len(data),None,None,'too_large',metadata))
                        if not old: cur.execute("insert into garmin.artifact_inventory(dataset,artifact_key,batch,category,content_hash,size_bytes,exclusion_reason,metadata) values (%s,%s,%s,'report',%s,%s,'too_large',%s::jsonb)",(dataset,inventory_key,batch,digest(data),len(data),canon(metadata)))
                    if mismatch: conflict(conn,dataset,batch,'evaluation',key,'evaluation_mismatch')
                    continue
                try: emit_one(entry,key,'report',data,{'source':'evaluation.md'},evaluation=row,original_table='evaluation')
                except (ValueError,psycopg.errors.RaiseException,psycopg.errors.UniqueViolation): conflict(conn,dataset,batch,'evaluation',key,'evaluation_mismatch')
        for category in ('body','profile','inbox'):
            item=next((x for x in capture['private']['inventory'] if x['dataset']==(entry['dataset_label'] or dataset) and x['category']==category),None)
            state=item['state'] if item else 'unknown'
            metadata={'fields':item['metadata'],'source_files':[{'artifact_key':k,'request_id':str(published[((entry['dataset_label'] or dataset),k)][0]) if published[((entry['dataset_label'] or dataset),k)][0] else None} for k in item['source_files']]} if item else None
            with conn.transaction():
                cur=conn.cursor(); check(cur)
                cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,9))',(canon([dataset,category]),))
                metadata_display, metadata_raw = encode_metadata(metadata)
                old=cur.execute('select batch,state,metadata,metadata_raw from garmin.input_inventory where dataset=%s and category=%s',(dataset,category)).fetchone()
                mismatch = bool(old and (old[1],decode_metadata(old[2],old[3])) != (state,metadata))
                if not old: cur.execute('insert into garmin.input_inventory(dataset,batch,category,state,metadata,metadata_raw) values (%s,%s,%s,%s,%s::jsonb,%s)',(dataset,batch,category,state,canon(metadata_display) if metadata_display is not None else None,metadata_raw))
            if mismatch: conflict(conn,dataset,batch,'input_inventory',category,'inventory_mismatch')
