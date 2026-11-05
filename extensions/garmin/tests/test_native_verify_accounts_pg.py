"""Native verifier account scoping on isolated PG; execution deferred to 21.8.

The fixture owns the database, including immutable raw rows and work attempts.
These checks establish explicit query scoping, not multi-user authorization.
"""
import hashlib
import json
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
import native_import as native
from batch_import import canonical, contract_fingerprint
from contract import BY_VERSION

DAY = '2026-01-01'


class NativeVerifyAccountsPGTest(unittest.TestCase):
    def test_three_accounts_same_native_keys_and_independent_corruption(self):
        work, token, other_user = uuid4(), uuid4(), uuid4()
        accounts = []
        with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN'], autocommit=True) as owner:
            user = owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            owner.execute('insert into brain.users(id,name,is_self,created_at) values (%s,%s,0,now())', (other_user,'synthetic-native-verify'))
            owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values (%s,'garmin.import','synthetic',%s,now(),now(),'supervised',now(),now()+interval '1 hour','fixture')", (work,str(work)))
            owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())', (token,work))
            owner.execute('update brain.work_items set current_attempt_token=%s where id=%s', (token,work))
            for index, uid in enumerate((user,user,other_user),1):
                connection, namespace = uuid4(), uuid4().hex
                profile, dataset, capture_id = 'profile-'+namespace, 'dataset-'+namespace, 'capture-'+namespace
                fingerprint='manifest-'+namespace
                owner.execute("insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values (%s,%s,%s,'UTC')", (uid,connection,profile))
                owner.execute('insert into garmin.datasets(dataset,account,account_confirmed) values (%s,%s,true)', (dataset,profile))
                batch=hashlib.sha256(canonical([capture_id,dataset]).encode()).hexdigest()
                owner.execute('insert into garmin.import_batches(id,dataset,imported_at) values (%s,%s,now())', (batch,dataset))
                tables={name:{'columns':columns[:], 'keys':[], 'rows':[], 'rowids':[]}
                        for name,columns in BY_VERSION[16].items()}
                def set_row(name, keys, values, rowid=1):
                    columns=tables[name]['columns']
                    row={column:values.get(column) for column in columns}
                    tables[name].update(keys=keys,rows=[row],rowids=[rowid])
                set_row('raw_response',['scope','key','endpoint'],{'scope':'day','key':DAY,'endpoint':'user_summary',
                    'raw':json.dumps({'userProfileId':profile,'synthetic':index}),
                    'fetched_at':1,'checked_at':1,'library_version':'synthetic'})
                set_row('daily_metric',['day_key'],{'day_key':DAY,'steps':index*100})
                set_row('workout',['activity_id'],{'activity_id':77,'date':DAY,'type':'strength','session_no':index})
                set_row('exercise_log',['activity_id','exercise'],{'activity_id':77,'exercise':'squat','sets':index},17)
                capture={'private':{'capture_id':capture_id,'fingerprint':fingerprint}}
                copied={'private':{'capture_id':capture_id,'fingerprint':contract_fingerprint(fingerprint)}}
                verified={dataset:{'sha256':'synthetic-'+namespace,'snapshot':{'schema':16,'tables':tables}}}
                accounts.append({'user':uid,'connection':connection,'profile':profile,'dataset':dataset,
                    'batch':batch,'capture':capture,'copy_capture':copied,'entries':[{'dataset':dataset}],
                    'verified':verified,'settings':{'user_id':str(uid),'values':{'garmin.timezone':'UTC'}},'steps':index*100})
            self.assertEqual(len({a['dataset'] for a in accounts}),3)
            with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN'],autocommit=True) as ext:
                self.assertTrue(ext.execute('select garmin.attempt_valid(%s,%s)',(work,token)).fetchone()[0])
                def envelope(account):
                    return patch.dict(os.environ,{'BRAIN_USER_ID':str(account['user']),'BRAIN_ACCOUNT':account['profile'],
                        'BRAIN_WORK_ID':str(work),'BRAIN_ATTEMPT_TOKEN':str(token)},clear=False)
                def verify(account):
                    with envelope(account), ext.transaction():
                        ext.execute('set transaction isolation level repeatable read read only')
                        return native.verify(ext,account['capture'],account['entries'],account['verified'],account['settings'])
                for account in accounts:
                    with envelope(account):
                        native.copy(ext,account['copy_capture'],account['entries'],account['verified'],account['settings'])
                for account in accounts:
                    self.assertTrue(verify(account))
                    args=(account['user'],account['connection'])
                    self.assertEqual(owner.execute('select day_key,steps from garmin.daily_metric where user_id=%s and connection_id=%s',args).fetchall(),[(DAY,account['steps'])])
                    self.assertEqual(owner.execute('select activity_id,exercise,source_order,source_dataset,source_batch,source_rowid from garmin.exercise_log_order where user_id=%s and connection_id=%s',args).fetchall(),[(77,'squat',1,account['dataset'],account['batch'],17)])
                    self.assertEqual(owner.execute('select completed from garmin.native_import_checkpoints where user_id=%s and connection_id=%s and batch=%s',(*args,account['batch'])).fetchone(),(True,))
                    self.assertEqual(owner.execute('select count(*) from garmin.native_import_mapping where user_id=%s and connection_id=%s and dataset=%s',(*args,account['dataset'])).fetchone()[0],4)
                # Each account is both the tamper target and an unaffected observer.
                # The mutable projection and its mapping are changed independently.
                for target in accounts:
                    with self.subTest(target=target['dataset'], corruption='native'):
                        args=(target['user'],target['connection'],DAY)
                        owner.execute('update garmin.daily_metric set steps=steps+1 where user_id=%s and connection_id=%s and day_key=%s',args)
                        try:
                            for observer in accounts:
                                self.assertEqual(verify(observer),observer is not target)
                        finally:
                            owner.execute('update garmin.daily_metric set steps=%s where user_id=%s and connection_id=%s and day_key=%s',(target['steps'],*args))
                        self.assertTrue(verify(target))
                    with self.subTest(target=target['dataset'], corruption='mapping'):
                        args=(target['dataset'],target['user'],target['connection'])
                        original=owner.execute("select content_hash from garmin.native_import_mapping where dataset=%s and user_id=%s and connection_id=%s and original_table='daily_metric'",args).fetchone()[0]
                        owner.execute("update garmin.native_import_mapping set content_hash='synthetic-tamper' where dataset=%s and user_id=%s and connection_id=%s and original_table='daily_metric'",args)
                        try:
                            for observer in accounts:
                                self.assertEqual(verify(observer),observer is not target)
                        finally:
                            owner.execute("update garmin.native_import_mapping set content_hash=%s where dataset=%s and user_id=%s and connection_id=%s and original_table='daily_metric'",(original,*args))
                        self.assertTrue(verify(target))
                self.assertTrue(all(verify(account) for account in accounts))
