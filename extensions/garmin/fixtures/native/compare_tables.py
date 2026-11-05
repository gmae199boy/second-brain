"""Independent schema-16 SQLite versus native PG row/NULL comparison."""
import json
import hashlib
from batch_import import canonical
import os
import sqlite3
import sys
from uuid import UUID
import psycopg

with sqlite3.connect(sys.argv[1]) as source, psycopg.connect(os.environ['BRAIN_DATABASE_URL']) as dest:
    user=UUID(os.environ['BRAIN_USER_ID'])
    connection=dest.execute('select connection_id from garmin.account_connections where user_id=%s and external_identity=%s',(user,os.environ['BRAIN_ACCOUNT'])).fetchone()[0]
    names=[r[0] for r in source.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]
    expected_names={'activity','activity_hr_sample','auth_event','body_battery_sample','daily_metric','day_summary','delivery','evaluation','exercise_log','exercise_set','fetch_error','hr_sample','meta','normalize_result','notification','raw_response','run','stress_bb_sample','workout'}
    assert set(names)==expected_names, 'unexpected native table inventory'
    for name in names:
        assert name.replace('_','').isalnum()
        info=list(source.execute('pragma table_info("'+name+'")'))
        columns=[r[1] for r in info]
        keys=[r[1] for r in sorted(info,key=lambda r:r[5]) if r[5]]
        if name=='notification': keys=['local_date','event']
        assert keys, f'missing natural key: {name}'
        assert all(c.replace('_','').isalnum() for c in columns)
        fields=','.join('"'+c+'"' for c in columns)
        expected=source.execute('select '+fields+' from "'+name+'"').fetchall()
        assert expected, f'empty source table: {name}'
        key_indexes=[columns.index(key) for key in keys]
        assert len({tuple(row[i] for i in key_indexes) for row in expected})==len(expected), f'duplicate key: {name}'
        actual=dest.execute('select '+fields+' from garmin."'+name+'" where user_id=%s and connection_id=%s',(user,connection)).fetchall()
        ordered=lambda rows: sorted((json.dumps(row,sort_keys=True,ensure_ascii=False) for row in rows))
        assert ordered(actual)==ordered(expected), f'table mismatch: {name}'
    source_order=source.execute('select rowid from exercise_log order by rowid').fetchall()
    order=dest.execute('select source_order,source_dataset,source_batch,source_rowid from garmin.exercise_log_order where user_id=%s and connection_id=%s order by source_order',(user,connection)).fetchall()
    batch=hashlib.sha256(canonical(['native-synthetic-v1','synthetic-D2']).encode()).hexdigest()
    assert order==[(index,'synthetic-D2',batch,rowid[0]) for index,rowid in enumerate(source_order,1)]
print('synthetic native tables equal')
